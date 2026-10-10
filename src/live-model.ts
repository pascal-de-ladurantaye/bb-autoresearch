// The live view's model, shared by the server (recording, view building) and
// the frontend (applying realtime deltas). Pure: no I/O, no store, safe in
// the frontend bundle.
//
// Contract (docs/design.md, "Implementation notes: live view (part 1)"):
// every state change the Live view shows is a timestamped row in `events`
// (candidate.stage, worker.phase, measure.started/progress/finished,
// candidate.verdict, best.promoted, idea.added/status). Realtime deltas are a
// throttled projection of those rows, and `replaySkeleton` rebuilds the same
// state from the rows alone at any time t, which is what a replay needs.
import type { MetricInfo } from "./present.ts";

/** Pipeline stages a candidate moves through (mirrors db/schema.ts CANDIDATE_STAGES). */
export type Stage = "submitted" | "gating" | "queued" | "measuring" | "confirming" | "promoting" | "decided";

// ------------------------------------------------------------ worker phases

export const WORKER_PHASES = ["starting", "reading", "editing", "testing", "waiting", "measuring", "verdict", "refining", "finishing", "done"] as const;
export type WorkerPhase = (typeof WORKER_PHASES)[number];

/** What the agent is doing, from its thread's tool items. */
export type Activity = "reading" | "editing" | "testing";

/** Words and glyphs for each phase: state is always in words and shapes, never color alone. */
export const PHASE_INFO: Record<WorkerPhase, { label: string; icon: string; step: number }> = {
  starting: { label: "starting", icon: "Loader", step: 0 },
  reading: { label: "reading the code", icon: "BookOpen", step: 1 },
  editing: { label: "editing", icon: "Pencil", step: 2 },
  testing: { label: "testing locally", icon: "FlaskConical", step: 3 },
  waiting: { label: "waiting for the bench", icon: "Hourglass", step: 4 },
  measuring: { label: "being measured", icon: "Gauge", step: 5 },
  verdict: { label: "verdict received", icon: "Mail", step: 6 },
  refining: { label: "refining", icon: "RefreshCw", step: 2 },
  finishing: { label: "finishing", icon: "Flag", step: 7 },
  done: { label: "done", icon: "Check", step: 8 },
};

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
      return READ_ONLY_COMMAND.test(c) ? "reading" : "testing";
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
  submitted: { label: "Submitted", icon: "Upload" },
  gates: { label: "Tests", icon: "ListChecks" },
  queue: { label: "Queue", icon: "Hourglass" },
  bench: { label: "Bench", icon: "Gauge" },
  verdict: { label: "Verdict", icon: "Scale" },
  promoted: { label: "Promoted", icon: "Trophy" },
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
  deferredUntil: number | null;
  current: { kind: "measure"; n: number; stage: Stage; pairs: Pairs | null; startedAt: number } | { kind: "drift"; startedAt: number | null } | null;
  /** Share of the recent window the bench lock was held (all studies on this lock), or null before any running time. */
  utilization: number | null;
  windowSeconds: number;
}

export interface LiveIdea {
  id: number;
  title: string;
  theme: string;
  pinned: boolean;
  source: string;
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
  /** Server time when built (elapsed timers use the offset to the client clock). */
  now: number;
  /** Deltas at or below this event id are already in the view. */
  lastEventId: number;
  studyThreadId: string | null;
  best: { text: string | null; n: number | null; at: number | null };
  counts: { candidates: number; maxCandidates: number; workers: number; targetWorkers: number; queue: number };
  workers: LiveWorker[];
  /** In-flight candidates and the most recent decided ones. */
  cards: LiveCard[];
  /** The shared bench queue, next first (candidate numbers). */
  queue: number[];
  bench: LiveBenchHost[];
  ideas: { next: LiveIdea[]; total: number };
  feed: LiveFeedItem[];
}

// ------------------------------------------------------------ realtime deltas

/** Realtime channel for live deltas (the "study-changed" signal still asks other pages to refetch). */
export const LIVE_CHANNEL = "study-live";

/** A delta: ids and small numbers only; the data itself comes from RPC. `id` is the event id, `t` its time. */
export type LiveDelta =
  | { k: "stage"; id: number; t: number; c: number; to: Stage; v?: string }
  | { k: "phase"; id: number; t: number; w: number; to: WorkerPhase; c?: number | null }
  | { k: "pair"; id: number; t: number; c: number; run: "measure" | "confirm"; i: number; of: number }
  | { k: "verdict"; id: number; t: number; c: number; v: string; e: number | null }
  | { k: "best"; id: number; t: number; c: number }
  | { k: "idea"; id: number; t: number; i: number; to: string };

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
      return { k: "verdict", id: e.id, t: e.at, c, v, e: num(d.effect) };
    }
    case "best.promoted": {
      const c = num(d.n);
      return c === null ? null : { k: "best", id: e.id, t: e.at, c };
    }
    case "idea.added":
      return num(d.idea) === null ? null : { k: "idea", id: e.id, t: e.at, i: num(d.idea)!, to: "queued" };
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
  for (const d of [...msg.d].sort((a, b) => a.id - b.id)) {
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
        const ok = card(d.c, (c) => ({ ...c, verdict: d.v, effect: d.e, effectText: effectText ? effectText(d.e) : c.effectText, column: c.stage === "decided" ? columnOf("decided", d.v) : c.column }));
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
      case "idea": {
        const known = ideas.next.some((x) => x.id === d.i);
        if (d.to !== "queued" && known) ideas = { next: ideas.next.filter((x) => x.id !== d.i), total: Math.max(0, ideas.total - 1) };
        else if (d.to === "queued" && !known) refetch = true;
        break;
      }
    }
  }
  return { view: { ...view, cards, workers, ideas, lastEventId }, refetch };
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
] as const;

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
