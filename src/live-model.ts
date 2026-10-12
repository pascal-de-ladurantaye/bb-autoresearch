// The live view's model, shared by the server (recording, view building) and
// the frontend (applying realtime deltas). Pure: no I/O, no store, safe in
// the frontend bundle.
//
// Contract (docs/release-notes.md, "v0.2.0: live view, part 1"):
// every state change the Live view shows is a timestamped row in `events`
// (candidate.stage, worker.phase, measure.started/progress/finished,
// candidate.verdict, best.promoted, idea.added/status). Realtime deltas are a
// throttled projection of those rows, and `replaySkeleton` rebuilds the same
// state from the rows alone at any time t, which is what a replay needs.
import { bandProgress, type BandPoint, type MeasureBand } from "./band.ts";
import { compoundOne, verdictCause, type MetricInfo, type NoiseClass } from "./present.ts";

/** Pipeline stages a candidate moves through (mirrors db/schema.ts CANDIDATE_STAGES). */
export type Stage = "submitted" | "gating" | "queued" | "measuring" | "confirming" | "promoting" | "decided";

// ------------------------------------------------------------ worker phases

export const WORKER_PHASES = ["starting", "reading", "editing", "testing", "waiting", "measuring", "verdict", "refining", "finishing", "done"] as const;
export type WorkerPhase = (typeof WORKER_PHASES)[number];

/** What the agent is doing, from its thread's tool items. */
export type Activity = "reading" | "editing" | "testing";

/** Words and glyphs (BB icon names) for each phase: state is always in words and shapes, never color alone. */
export const PHASE_INFO: Record<WorkerPhase, { label: string; icon: string; step: number }> = {
  starting: { label: "starting", icon: "Clock", step: 0 },
  reading: { label: "reading the code", icon: "Eye", step: 1 },
  editing: { label: "editing", icon: "Edit", step: 2 },
  testing: { label: "testing locally", icon: "Beaker", step: 3 },
  waiting: { label: "waiting for the bench", icon: "TimeSchedule", step: 4 },
  measuring: { label: "being measured", icon: "ChartColumn", step: 5 },
  verdict: { label: "verdict received", icon: "Mail", step: 6 },
  refining: { label: "refining", icon: "Repeat", step: 2 },
  finishing: { label: "finishing", icon: "Sent", step: 7 },
  done: { label: "done", icon: "Check", step: 8 },
};

/**
 * The header's worker count against the target W: live workers include
 * finishing ones (they still hold a slot), and W can drop below the live
 * count when think and eval times change; nobody is stopped for it, so the
 * text says what happens instead. "2 workers \u00b7 target 2",
 * "2 workers + 1 finishing \u00b7 target 2", "3 workers \u00b7 target now 2 (no new worker until fewer)".
 */
export function workerCountText(phases: readonly WorkerPhase[], target: number): string {
  const finishing = phases.filter((p) => p === "finishing").length;
  const working = phases.length - finishing;
  const head = `${working} worker${working === 1 ? "" : "s"}${finishing ? ` + ${finishing} finishing` : ""}`;
  return phases.length > target ? `${head} \u00b7 target now ${target} (no new worker until fewer)` : `${head} \u00b7 target ${target}`;
}

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * The shared bench queue, next first: queued candidates and (single-machine
 * mode) candidates waiting to run their tests on the bench, by when each
 * started waiting. The one place its order is decided, so the lanes, the
 * cards, the bench strip, the Overview and the badges agree on positions.
 */
export function benchQueueOrder<T extends { id: number; queuedAt: number | null; submittedAt: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.queuedAt ?? a.submittedAt) - (b.queuedAt ?? b.submittedAt) || a.id - b.id);
}

/** A candidate's place in the bench queue (1 = next), or null when it isn't in it. */
export function queuePosition(queue: readonly number[], n: number | null): number | null {
  if (n === null) return null;
  const i = queue.indexOf(n);
  return i < 0 ? null : i + 1;
}

/** The steps a lane's progress dots show, in order. */
export const PHASE_STEPS: readonly WorkerPhase[] = ["reading", "editing", "testing", "waiting", "measuring", "verdict"];

export interface PhaseInput {
  state: "spawning" | "active" | "finishing" | "finished" | "abandoned" | "failed";
  activity: Activity | null;
  /** When the activity was last seen (thread item time). */
  activityAt: number | null;
  /** The worker's most recent candidate, if any. */
  latest: { stage: Stage; reportedAt: number | null } | null;
}

/**
 * A worker's phase from plugin state: the thread row, its latest candidate,
 * and the activity seen in its thread's tool items. Never from transcripts.
 */
export function deriveWorkerPhase(i: PhaseInput): WorkerPhase {
  if (i.state === "spawning") return "starting";
  if (i.state === "finishing") return "finishing";
  if (i.state !== "active") return "done";
  const c = i.latest;
  if (c && c.stage !== "decided") return c.stage === "submitted" || c.stage === "gating" || c.stage === "queued" ? "waiting" : "measuring";
  if (c) {
    // The verdict is in. Activity after it was delivered means the worker is refining.
    if (c.reportedAt !== null && i.activityAt !== null && i.activityAt > c.reportedAt) return "refining";
    return "verdict";
  }
  return i.activity ?? "reading";
}

/** Phases that only differ by activity (rate-limited when recorded, so a worker flipping between reading and testing doesn't flood events). */
export function activityOnly(from: WorkerPhase | null, to: WorkerPhase): boolean {
  const a = new Set<WorkerPhase>(["reading", "editing", "testing"]);
  return from !== null && a.has(from) && a.has(to);
}

// ------------------------------------------------------- activity from items

/** One tool item of a worker's thread (item/started), reduced to what classification needs. */
export interface ActivityItem {
  kind: string;
  command?: string | null;
  tool?: string | null;
}

const READ_ONLY_COMMAND = /^(?:cat|less|more|head|tail|ls|ll|tree|pwd|rg|grep|egrep|ag|find|fd|wc|file|stat|du|which|type|echo|printf|nl|sed\s+-n|awk|git\s+(?:log|show|diff|status|blame|grep|ls-files|rev-parse|branch))\b/u;

/** Shell commands that write files: in-place edits, patches, redirects into a file, scripts that write. */
const WRITES_FILES = /\b(?:apply_patch|patch\s+-p|sed\s+-i|perl\s+-p?i|tee\s)|(?:^|[^>&0-9])>{1,2}\s*(?!\/dev\/null|&)[\w./-]+|\.write(?:_text)?\(|open\([^)]*['"][wa]\+?['"]/u;

function unwrapShell(command: string): string {
  let c = command.trim();
  const wrapped = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/u.exec(c);
  if (wrapped) c = wrapped[2]!.trim();
  // Leading `cd dir &&` doesn't say what the command does.
  c = c.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/u, "");
  return c;
}

/** What a tool item says the agent is doing; null when it says nothing (messages, reasoning, plugin tools). */
export function classifyItem(item: ActivityItem): Activity | null {
  switch (item.kind) {
    case "fileChange":
      return "editing";
    case "fileRead":
    case "search":
    case "webSearch":
    case "webFetch":
    case "imageView":
      return "reading";
    case "commandExecution": {
      const c = unwrapShell(item.command ?? "");
      if (!c) return null;
      // Agents often edit through the shell (sed -i, heredocs, scripts that write files).
      if (WRITES_FILES.test(c)) return "editing";
      // A compound command is as strong as its strongest part: `cat x; python3 test.py` runs code.
      const parts = c.split(/\s*(?:&&|\|\||;|\||\n)\s*/u).map((x) => unwrapShell(x)).filter(Boolean);
      return parts.length && parts.every((x) => READ_ONLY_COMMAND.test(x)) ? "reading" : "testing";
    }
    case "toolCall": {
      const t = (item.tool ?? "").toLowerCase();
      if (!t || t.startsWith("study_") || t.includes("study_")) return null;
      if (/edit|write|patch|apply|replace|create/u.test(t)) return "editing";
      if (/bash|shell|exec|run|terminal/u.test(t)) return "testing";
      if (/read|grep|glob|search|find|list|ls|view|open/u.test(t)) return "reading";
      return null;
    }
    default:
      return null;
  }
}

/** The activity a batch of items ends on (the latest item that says something). */
export function latestActivity(items: readonly ActivityItem[]): Activity | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const a = classifyItem(items[i]!);
    if (a) return a;
  }
  return null;
}

// --------------------------------------------------------- pipeline columns

export const COLUMNS = ["submitted", "gates", "queue", "bench", "verdict", "promoted"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_INFO: Record<Column, { label: string; icon: string }> = {
  submitted: { label: "Submitted", icon: "Sent" },
  gates: { label: "Tests", icon: "Beaker" },
  queue: { label: "Queue", icon: "Layers" },
  bench: { label: "Bench", icon: "ChartColumn" },
  verdict: { label: "Verdict", icon: "Target" },
  promoted: { label: "Promoted", icon: "Star" },
};

/** Which column a candidate card sits in. A win is decided only once it is promoted onto best. */
export function columnOf(stage: Stage, verdict: string | null): Column {
  switch (stage) {
    case "submitted":
      return "submitted";
    case "gating":
      return "gates";
    case "queued":
      return "queue";
    case "measuring":
    case "confirming":
    case "promoting":
      return "bench";
    default:
      return verdict === "win" ? "promoted" : "verdict";
  }
}

export const STAGE_LABEL: Record<Stage, string> = {
  submitted: "submitted",
  gating: "tests running",
  queued: "queued",
  measuring: "measuring",
  confirming: "confirming",
  promoting: "promoting",
  decided: "decided",
};

/**
 * A candidate in the Tests stage in words: its tests are running, or (in
 * single-machine mode) it waits for the bench lock to run them. The card,
 * the lane and the bench queue say the same thing.
 */
export function gatingText(queueTests: readonly number[] | undefined, n: number): string {
  return queueTests?.includes(n) ? "waiting for the bench to run tests" : "tests running";
}

/** A stage in words for one candidate (the Tests stage depends on whether it holds the bench yet). */
export function stageText(stage: Stage, queueTests: readonly number[] | undefined, n: number): string {
  return stage === "gating" ? gatingText(queueTests, n) : STAGE_LABEL[stage];
}

// --------------------------------------------------------------- the view

export interface LiveWorker {
  /** threads.id: stable from the spawn on (the BB thread id arrives later). */
  key: number;
  threadId: string | null;
  ideaId: number | null;
  ideaTitle: string;
  theme: string;
  phase: WorkerPhase;
  phaseAt: number;
  spawnedAt: number;
  submissions: number;
  maxSubmissions: number;
  /** Its latest candidate, and that candidate's stage. */
  candidate: number | null;
  candidateStage: Stage | null;
  /** Position in the bench queue (1 = next) while its candidate waits there. */
  queuePosition: number | null;
  /** The last action, a short sanitized label ("editing src/toy.py"), as recorded by the last worker.action event. */
  action: { label: string; at: number } | null;
}

export interface Pairs {
  run: "measure" | "confirm";
  done: number;
  of: number;
}

export interface LiveCard {
  n: number;
  ideaId: number | null;
  ideaTitle: string;
  workerKey: number | null;
  stage: Stage;
  column: Column;
  stageAt: number;
  verdict: string | null;
  /** Better is positive, in the metric's own terms; text once known. */
  effect: number | null;
  effectText: string | null;
  /**
   * Why the verdict isn't the primary metric's own ("lost on guardrail mem_kb
   * (27.6% worse)", a failed gate, the scope, a conflict); null when the
   * primary metric decided it. Shown instead of the effect, so a loss never
   * reads like a win.
   */
  cause: string | null;
  hostId: string | null;
  pairs: Pairs | null;
  rebases: number;
  submittedAt: number;
  decidedAt: number | null;
}

export interface LiveBenchHost {
  hostId: string;
  name: string;
  status: "online" | "offline" | "unknown";
  healthOk: boolean | null;
  /** Why there is no health result: checks are off in the spec, or (replay) the study predates recorded health events. */
  healthRecord?: "off" | "missing" | null;
  deferredUntil: number | null;
  current:
    | { kind: "measure"; n: number; stage: Stage; pairs: Pairs | null; startedAt: number }
    | { kind: "drift"; startedAt: number | null }
    /** Single-machine mode: a candidate's gates hold this host's bench lock. */
    | { kind: "gate"; n: number; startedAt: number }
    | null;
  /** Share of the recent window the bench lock was held (all studies on this lock), or null before any running time. */
  utilization: number | null;
  windowSeconds: number;
  /** A remote machine lent by a bench provider: provider, shape, lifecycle state, expiry, rotation (live view only). */
  remote?: { provider: string; slot: string; cores: number; state: string; stateText: string; expiresAt: number | null; rotation: string | null; noiseFloor: number | null; mde: number | null } | null;
}

export interface LiveIdea {
  id: number;
  title: string;
  theme: string;
  pinned: boolean;
  source: string;
  /** Why the scheduler can't pick it yet (theme cap, repeats a lost idea); null when it is in pick order. */
  blocked: string | null;
}

export type FeedTone = "win" | "lose" | "warn" | "info" | "best";

export interface LiveFeedItem {
  /** The event id it comes from. */
  id: number;
  at: number;
  candidate: number | null;
  text: string;
  tone: FeedTone;
}

export interface LiveView {
  studyId: string;
  slug: string;
  state: string;
  statusLine: string;
  metric: MetricInfo;
  /** The oracle's noise class: noisy measurements count pairs, deterministic and expensive ones count runs. */
  noise: NoiseClass;
  /** Server time when built (elapsed timers use the offset to the client clock). */
  now: number;
  /** Deltas at or below this event id are already in the view. */
  lastEventId: number;
  studyThreadId: string | null;
  best: {
    text: string | null;
    n: number | null;
    /** When the current best was decided. */
    at: number | null;
    /** Best vs base, better is positive (the header counts up to it when best moves). */
    value: number | null;
    /** When best last moved (the best.promoted event). */
    movedAt: number | null;
    /** Best vs base after each promotion (the trajectory sparkline). */
    history: Array<{ at: number; n: number; value: number }>;
    /** Lanes that rebase on their next submission because best moved (live workers other than the winner's). */
    rebases: number[];
    /** Segments the headline spans (every promotion compounds into it); absent: 1. */
    segments?: number;
    /** Raw values base → best: the study's, or this segment's when the headline spans several ("this segment 3.62 → 2.04 s"). */
    raw?: string | null;
  };
  /** `workers` counts live workers, finishing ones included (`finishing` of them); `targetWorkers` is W. */
  counts: { candidates: number; maxCandidates: number; workers: number; finishing?: number; targetWorkers: number; queue: number };
  workers: LiveWorker[];
  /** In-flight candidates and the most recent decided ones. */
  cards: LiveCard[];
  /** The shared bench queue, next first (candidate numbers). In single-machine mode it includes candidates waiting to run their tests. */
  queue: number[];
  /** Candidates in `queue` that wait to run their tests on the bench (single-machine mode). */
  queueTests?: number[];
  /** Single-machine mode (gates hold the bench lock), with what it does in words; null when off. */
  singleMachine?: { text: string; quietBench: boolean } | null;
  bench: LiveBenchHost[];
  ideas: { next: LiveIdea[]; total: number };
  feed: LiveFeedItem[];
  /** CI bands of the measurements on the bench, and of ones that just ended (BAND_LINGER_MS). */
  bands: MeasureBand[];
}

/** How long a finished measurement's band stays on screen (its decision marked). */
export const BAND_LINGER_MS = 30_000;
/** How long lanes say "best moved: rebases on next submit". */
export const REBASE_NOTICE_MS = 6_000;

/**
 * Progress of a measurement in words, per noise class: noisy measurements
 * count pairs ("pair 3 of ≤12": the sequential test may stop early),
 * deterministic ones are one run each side ("running best", "running the
 * candidate", "run 1 of 1"), expensive ones count runs ("run 2 of ≤4": a
 * screening run, then confirmation runs if it looks promising).
 * `spoken` for labels, `short` for chips, `run` to name the confirmation.
 */
export function progressText(p: Pairs, noise: NoiseClass = "noisy", opts: { short?: boolean; spoken?: boolean; run?: boolean; band?: MeasureBand | null } = {}): string {
  if (noise === "deterministic") {
    if (opts.short) return `${Math.min(1, p.done)}/1`;
    const b = opts.band?.kind === "deterministic" ? opts.band : null;
    if (b && !b.value) return b.best ? "running the candidate" : "running best";
    return p.done >= 1 ? "run 1 of 1 done" : "run 1 of 1";
  }
  if (noise === "expensive") {
    const of = Math.max(1, p.of);
    const at = Math.min(of, p.done + 1);
    if (opts.short) return `${at}/${of}`;
    const label = opts.run && p.run === "confirm" ? "confirmation run" : "run";
    return `${label} ${at}${of > 1 ? (opts.spoken ? ` of up to ${of}` : ` of ≤${of}`) : " of 1"}`;
  }
  if (opts.short) return `${p.done}${p.of > 1 ? `/${p.of}` : ""}`;
  const of = p.of > 1 ? (opts.spoken ? ` of up to ${p.of}` : ` of ≤${p.of}`) : "";
  // Before the first pair is done there is nothing to count: say what runs ("pair 0" reads like a bug).
  if (p.done <= 0) return `${opts.run && p.run === "confirm" ? "confirmation: " : ""}first pair${of} running`;
  return `${opts.run && p.run === "confirm" ? "confirmation " : ""}pair ${p.done}${of}`;
}

/** Pair progress, at least as far as the band got (bands follow samples, progress events are coarse). */
export function mergeProgress(pairs: Pairs | null, band: MeasureBand | null | undefined): Pairs | null {
  const b = band ? bandProgress(band) : null;
  if (!b) return pairs;
  if (!pairs) return null;
  if (b.run !== pairs.run) return b.run === "confirm" && pairs.run === "measure" ? { run: "confirm", done: b.done, of: pairs.of } : pairs;
  return b.done > pairs.done ? { ...pairs, done: Math.min(b.done, pairs.of || b.done) } : pairs;
}

// ------------------------------------------------------------ realtime deltas

/** Realtime channel for live deltas (the "study-changed" signal still asks other pages to refetch). */
export const LIVE_CHANNEL = "study-live";

/** A delta: ids and small numbers only; the data itself comes from RPC. `id` is the event id, `t` its time. */
export type LiveDelta =
  | { k: "stage"; id: number; t: number; c: number; to: Stage; v?: string }
  | { k: "phase"; id: number; t: number; w: number; to: WorkerPhase; c?: number | null }
  | { k: "pair"; id: number; t: number; c: number; run: "measure" | "confirm"; i: number; of: number }
  | { k: "verdict"; id: number; t: number; c: number; v: string; e: number | null; why?: string }
  | { k: "best"; id: number; t: number; c: number }
  | { k: "idea"; id: number; t: number; i: number; to: string }
  /** A worker's last action changed (a short sanitized label). */
  | { k: "action"; id: number; t: number; w: number; a: string }
  /** A new point of a measurement's CI band (no event: bands come from samples). Applied whatever the snapshot's event id. */
  | { k: "band"; id: number; t: number; c: number; run: "measure" | "confirm"; p: BandPoint };

export interface LiveDeltaMessage {
  /** The study id. */
  s: string;
  d: LiveDelta[];
  /** Too much changed at once: refetch instead of applying. */
  refetch?: boolean;
}

/** The coalescing key: within one throttle window only the latest delta per key is sent. */
export function deltaKey(d: LiveDelta): string {
  switch (d.k) {
    case "phase":
      return `phase:${d.w}`;
    case "best":
      return "best";
    case "idea":
      return `idea:${d.i}`;
    case "action":
      return `action:${d.w}`;
    case "band":
      return `band:${d.c}:${d.run}:${d.p.n}`;
    default:
      return `${d.k}:${d.c}`;
  }
}

export interface EventLike {
  id: number;
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The delta an event row projects to, or null when the live view doesn't show it directly. */
export function deltaFromEvent(e: EventLike): LiveDelta | null {
  const d = e.data;
  switch (e.kind) {
    case "candidate.stage": {
      const c = num(d.n);
      const to = str(d.to) as Stage | null;
      if (c === null || !to) return null;
      return { k: "stage", id: e.id, t: e.at, c, to, ...(str(d.verdict) ? { v: str(d.verdict)! } : {}) };
    }
    case "worker.phase": {
      const w = num(d.worker);
      const to = str(d.to) as WorkerPhase | null;
      if (w === null || !to) return null;
      return { k: "phase", id: e.id, t: e.at, w, to, c: num(d.candidate) };
    }
    case "measure.progress": {
      const c = num(d.n);
      const i = num(d.pairs);
      const of = num(d.of);
      if (c === null || i === null || of === null) return null;
      return { k: "pair", id: e.id, t: e.at, c, run: d.run === "confirm" ? "confirm" : "measure", i, of };
    }
    case "candidate.verdict": {
      const c = num(d.n);
      const v = str(d.verdict);
      if (c === null || !v) return null;
      const why = verdictCause(v, d.reasons);
      return { k: "verdict", id: e.id, t: e.at, c, v, e: num(d.effect), ...(why ? { why: why.slice(0, 120) } : {}) };
    }
    case "best.promoted": {
      const c = num(d.n);
      return c === null ? null : { k: "best", id: e.id, t: e.at, c };
    }
    case "idea.added":
      return num(d.idea) === null ? null : { k: "idea", id: e.id, t: e.at, i: num(d.idea)!, to: "queued" };
    case "worker.action": {
      const w = num(d.worker);
      const a = str(d.label);
      return w === null || !a ? null : { k: "action", id: e.id, t: e.at, w, a };
    }
    case "idea.status":
      return num(d.idea) === null || !str(d.to) ? null : { k: "idea", id: e.id, t: e.at, i: num(d.idea)!, to: str(d.to)! };
    default:
      return null;
  }
}

/**
 * Apply a delta message to a view, locally. Returns the new view and whether
 * something needs a refetch (a candidate, worker or idea the view doesn't
 * know yet, a new best, or an overflow). Pure; the input view is not mutated.
 */
export function applyDeltas(view: LiveView, msg: LiveDeltaMessage, effectText?: (effect: number | null) => string | null): { view: LiveView; refetch: boolean } {
  if (msg.s !== view.studyId) return { view, refetch: false };
  if (msg.refetch) return { view, refetch: true };
  let refetch = false;
  let cards = view.cards;
  let workers = view.workers;
  let ideas = view.ideas;
  let lastEventId = view.lastEventId;
  const card = (n: number, fn: (c: LiveCard) => LiveCard): boolean => {
    const i = cards.findIndex((c) => c.n === n);
    if (i < 0) return false;
    if (cards === view.cards) cards = [...cards];
    cards[i] = fn(cards[i]!);
    return true;
  };
  let bands = view.bands;
  for (const d of [...msg.d].sort((a, b) => a.id - b.id)) {
    if (d.k === "band") {
      // Bands come from samples, not events: a point is idempotent by its pair number.
      const i = bands.findIndex((b) => b.n === d.c);
      if (i < 0 || bands[i]!.kind !== "noisy") {
        refetch = true;
        continue;
      }
      const b = bands[i] as Extract<MeasureBand, { kind: "noisy" }>;
      const runs = [...b.runs];
      let r = runs.findIndex((x) => x.run === d.run);
      if (r < 0) {
        runs.push({ run: d.run, points: [], gr: {} });
        r = runs.length - 1;
      }
      const pts = [...runs[r]!.points];
      const at = pts.findIndex((p) => p.n === d.p.n);
      if (at >= 0) pts[at] = d.p;
      else if (d.p.n === pts.length + 1) pts.push(d.p);
      else {
        refetch = true;
        continue;
      }
      runs[r] = { ...runs[r]!, points: pts };
      if (bands === view.bands) bands = [...bands];
      const nb = { ...b, runs };
      bands[i] = nb;
      card(d.c, (c) => ({ ...c, pairs: mergeProgress(c.pairs, nb) }));
      continue;
    }
    if (d.id <= view.lastEventId) continue;
    lastEventId = Math.max(lastEventId, d.id);
    switch (d.k) {
      case "stage": {
        const ok = card(d.c, (c) => ({
          ...c,
          stage: d.to,
          stageAt: d.t,
          column: columnOf(d.to, d.v ?? c.verdict),
          verdict: d.v ?? (d.to === "decided" ? c.verdict : null),
          // Back to tests or the queue: the old measurement no longer counts.
          pairs: d.to === "gating" || d.to === "queued" ? null : d.to === "confirming" ? { run: "confirm", done: 0, of: c.pairs?.of ?? 0 } : c.pairs,
        }));
        if (!ok) refetch = true;
        else if (d.to === "decided" || d.to === "queued") refetch = true; // queue order and the verdict's effect come from the server
        break;
      }
      case "pair": {
        if (!card(d.c, (c) => ({ ...c, pairs: { run: d.run, done: d.i, of: d.of } }))) refetch = true;
        break;
      }
      case "verdict": {
        const ok = card(d.c, (c) => ({ ...c, verdict: d.v, effect: d.e, effectText: effectText ? effectText(d.e) : c.effectText, cause: d.why ?? null, column: c.stage === "decided" ? columnOf("decided", d.v) : c.column }));
        if (!ok) refetch = true;
        break;
      }
      case "phase": {
        const i = workers.findIndex((w) => w.key === d.w);
        if (i < 0) {
          if (d.to !== "done") refetch = true;
          break;
        }
        if (d.to === "done") {
          workers = workers.filter((w) => w.key !== d.w);
          break;
        }
        if (workers === view.workers) workers = [...workers];
        workers[i] = { ...workers[i]!, phase: d.to, phaseAt: d.t, ...(d.c !== undefined && d.c !== null ? { candidate: d.c } : {}) };
        break;
      }
      case "best":
        refetch = true;
        break;
      case "action": {
        const i = workers.findIndex((w) => w.key === d.w);
        if (i < 0) break;
        if (workers === view.workers) workers = [...workers];
        workers[i] = { ...workers[i]!, action: { label: d.a, at: d.t } };
        break;
      }
      case "idea": {
        const known = ideas.next.some((x) => x.id === d.i);
        if (d.to !== "queued" && known) ideas = { next: ideas.next.filter((x) => x.id !== d.i), total: Math.max(0, ideas.total - 1) };
        else if (d.to === "queued" && !known) refetch = true;
        break;
      }
    }
  }
  // The bench strip follows its card's pair progress.
  let bench = view.bench;
  if (cards !== view.cards) {
    bench = view.bench.map((h) => {
      if (h.current?.kind !== "measure") return h;
      const cur = h.current;
      const c = cards.find((x) => x.n === cur.n);
      return c && c.pairs !== cur.pairs && (c.stage === "measuring" || c.stage === "confirming" || c.stage === "promoting") ? { ...h, current: { ...cur, stage: c.stage, pairs: c.pairs } } : h;
    });
  }
  return { view: { ...view, cards, workers, ideas, lastEventId, bands, bench }, refetch };
}

// ---------------------------------------------------------------- replay

/** The state a Live view shows, reduced to what events must reproduce. */
export interface LiveSkeleton {
  /** Live workers (not done) by threads.id. */
  workers: Record<number, { phase: WorkerPhase; idea: number | null }>;
  candidates: Record<number, { stage: Stage; verdict: string | null; pairs: Pairs | null }>;
  /** Candidate number on best, or null at the segment base. */
  best: number | null;
  /** Queued idea ids, ascending. */
  queuedIdeas: number[];
  /** Bench host → the candidate it is measuring. */
  benchCurrent: Record<string, number>;
}

/** Event kinds replay reads. */
export const REPLAY_KINDS = [
  "candidate.stage",
  "candidate.verdict",
  "worker.phase",
  "measure.started",
  "measure.progress",
  "measure.finished",
  "measure.restarted",
  "candidate.requeued",
  "best.promoted",
  "idea.added",
  "idea.status",
  "worker.action",
] as const;

/** A bench host's health in words (the bench strip, live and replay). */
export function benchHealthText(h: Pick<LiveBenchHost, "status" | "deferredUntil" | "healthOk" | "healthRecord">): string {
  if (h.status === "offline") return "offline";
  if (h.deferredUntil) return "waiting for the machine to calm down";
  if (h.healthOk === false) return "unhealthy";
  if (h.healthOk) return "healthy";
  if (h.healthRecord === "off") return "health checks off";
  if (h.healthRecord === "missing") return "health not recorded";
  return "not checked yet";
}

/**
 * Pair progress of one candidate from its events (measure.started resets,
 * measure.progress/finished advance, confirming starts the confirmation run,
 * a restart or requeue clears). Shared by replay and the live view so both
 * show the same numbers.
 */
export function reducePairs(prev: Pairs | null, e: EventLike): Pairs | null {
  const d = e.data;
  switch (e.kind) {
    case "measure.started":
      return { run: "measure", done: 0, of: num(d.of) ?? 0 };
    case "measure.progress":
      return { run: d.run === "confirm" ? "confirm" : "measure", done: num(d.pairs) ?? prev?.done ?? 0, of: num(d.of) ?? prev?.of ?? 0 };
    case "measure.finished":
      return prev ? { ...prev, done: num(d.pairs) ?? prev.done } : null;
    case "candidate.stage":
      if (d.to === "confirming") return { run: "confirm", done: 0, of: prev?.of ?? 0 };
      if (d.to === "gating" || d.to === "queued") return null;
      return prev;
    case "measure.restarted":
    case "candidate.requeued":
      return null;
    default:
      return prev;
  }
}

/** Rebuild the skeleton from event rows (id order) up to time `until`. */
export function replaySkeleton(events: readonly EventLike[], until = Number.POSITIVE_INFINITY): LiveSkeleton {
  const s: LiveSkeleton = { workers: {}, candidates: {}, best: null, queuedIdeas: [], benchCurrent: {} };
  const byId = new Map<number, number>(); // candidate id → n
  const host = new Map<number, string>(); // candidate n → bench host
  const queued = new Set<number>();
  for (const e of events) {
    if (e.at > until) break;
    const d = e.data;
    const n = num(d.n) ?? (num(d.candidate) !== null ? byId.get(num(d.candidate)!) ?? null : null);
    if (num(d.candidate) !== null && num(d.n) !== null) byId.set(num(d.candidate)!, num(d.n)!);
    switch (e.kind) {
      case "candidate.stage": {
        if (n === null) break;
        const prev = s.candidates[n];
        s.candidates[n] = { stage: d.to as Stage, verdict: str(d.verdict) ?? (d.to === "decided" ? prev?.verdict ?? null : null), pairs: reducePairs(prev?.pairs ?? null, e) };
        break;
      }
      case "candidate.verdict":
        if (n !== null && s.candidates[n]) s.candidates[n] = { ...s.candidates[n]!, verdict: str(d.verdict) };
        break;
      case "measure.started":
        if (n !== null) {
          if (str(d.host)) host.set(n, str(d.host)!);
          if (s.candidates[n]) s.candidates[n] = { ...s.candidates[n]!, pairs: reducePairs(s.candidates[n]!.pairs, e) };
        }
        break;
      case "measure.progress":
      case "measure.finished":
      case "measure.restarted":
      case "candidate.requeued":
        if (n !== null && s.candidates[n]) s.candidates[n] = { ...s.candidates[n]!, pairs: reducePairs(s.candidates[n]!.pairs, e) };
        break;
      case "worker.phase": {
        const w = num(d.worker);
        if (w === null) break;
        if (d.to === "done") delete s.workers[w];
        else s.workers[w] = { phase: d.to as WorkerPhase, idea: num(d.idea) };
        break;
      }
      case "best.promoted":
        if (num(d.n) !== null) s.best = num(d.n);
        break;
      case "idea.added":
        if (num(d.idea) !== null) queued.add(num(d.idea)!);
        break;
      case "idea.status":
        if (num(d.idea) !== null) {
          if (d.to === "queued") queued.add(num(d.idea)!);
          else queued.delete(num(d.idea)!);
        }
        break;
    }
  }
  s.queuedIdeas = [...queued].sort((a, b) => a - b);
  for (const [n, c] of Object.entries(s.candidates)) {
    const h = host.get(Number(n));
    if (h && (c.stage === "measuring" || c.stage === "confirming")) s.benchCurrent[h] = Number(n);
  }
  return s;
}

// ------------------------------------------------- shared by live and replay

/** The bench utilization window. */
export const UTILIZATION_WINDOW_S = 600;

/** Lanes that rebase on their next submission when best moves: live workers other than the winner's, past spawning and not finishing. */
export function rebaseLanes(workers: ReadonlyArray<Pick<LiveWorker, "key" | "phase">>, winnerKey: number | null): number[] {
  return workers.filter((w) => w.key !== winnerKey && w.phase !== "starting" && w.phase !== "finishing" && w.phase !== "done").map((w) => w.key);
}

/** Best vs base after each promotion, compounded in decision order. */
export function bestHistory(wins: ReadonlyArray<{ n: number; at: number; effect: number }>, direction: "lower" | "higher"): Array<{ at: number; n: number; value: number }> {
  let acc = 0;
  return wins.map((w) => {
    acc = compoundOne(acc, w.effect, direction);
    return { at: w.at, n: w.n, value: acc };
  });
}

/** Which measurements show a band: the ones on the bench, and ones that ended within BAND_LINGER_MS. */
export function bandShown(stage: Stage, decidedAt: number | null, now: number): boolean {
  if (stage === "measuring" || stage === "confirming" || stage === "promoting") return true;
  return stage === "decided" && decidedAt !== null && now - decidedAt <= BAND_LINGER_MS;
}

/** How busy a bench host was over the window: its intervals clipped to [max(window start, running since), now]. */
export function utilization(intervals: ReadonlyArray<{ start: number; end: number | null }>, now: number, runningFrom: number | null): { utilization: number | null; windowSeconds: number } {
  const windowStart = now - UTILIZATION_WINDOW_S * 1000;
  const from = Math.max(windowStart, runningFrom ?? windowStart);
  const span = Math.max(0, now - from);
  let busy = 0;
  for (const i of intervals) busy += Math.max(0, Math.min(i.end ?? now, now) - Math.max(i.start, from));
  return { utilization: span >= 5000 ? Math.min(1, busy / span) : null, windowSeconds: Math.round(span / 1000) };
}

