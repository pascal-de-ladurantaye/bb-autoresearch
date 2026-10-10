// Replay: the Live view of any study at any time t, rebuilt from its events
// and samples alone (the bundle `study.replay` returns). Pure and
// frontend-safe: the app runs it while the human scrubs or plays.
//
// Performance: the events are reduced once, with a keyframe (a copy of the
// reduced state) every KEYFRAME_EVERY events. A view at t restores the
// nearest keyframe at or before t and applies at most KEYFRAME_EVERY events;
// playing forward applies only the events since the last frame. See
// docs/design.md, "Implementation notes: live view (part 2)".
import { bandAt, type MeasureBand } from "./band.ts";
import { feedItems } from "./live-feed.ts";
import {
  bandShown,
  bestHistory,
  columnOf,
  mergeProgress,
  rebaseLanes,
  reducePairs,
  utilization,
  type EventLike,
  type LiveBenchHost,
  type LiveCard,
  type LiveFeedItem,
  type LiveView,
  type LiveWorker,
  type Pairs,
  type Stage,
  type WorkerPhase,
} from "./live-model.ts";
import { improvementText, runningStatusText, verdictCause, type MetricInfo, type NoiseClass } from "./present.ts";
import { titleKey, upNext } from "./scheduler.ts";

/** Everything replay needs: immutable metadata plus the timestamped event rows and the measurements' bands. */
export interface ReplayBundle {
  studyId: string;
  slug: string;
  metric: MetricInfo;
  /** The study's state now (the replay's end state). */
  state: string;
  studyThreadId: string | null;
  /** First and last event time; `now` is the server time the bundle was built (a running study's replay ends there). */
  start: number;
  end: number;
  now: number;
  spec: { maxCandidates: number; maxSubmissions: number; maxWorkers: number; noise?: NoiseClass };
  hosts: Array<{ hostId: string; name: string }>;
  ideas: Array<{ id: number; title: string; theme: string; source: string; variationOf: number | null }>;
  /** Worker rows (threads.id is the lane key). */
  workers: Array<{ key: number; threadId: string | null; ideaId: number | null; spawnedAt: number }>;
  /** `workerKey`: the worker row that submitted it (candidates.worker_id); lanes link through it, the BB thread id is the fallback. */
  candidates: Array<{ id: number; n: number; ideaId: number | null; threadId: string | null; workerKey?: number | null; title: string }>;
  /** Bench lock intervals (utilization). */
  intervals: Array<{ hostId: string; start: number; end: number | null }>;
  /** Event rows in id order, payloads trimmed to what replay reads. */
  events: EventLike[];
  bands: MeasureBand[];
}

/** Event kinds the bundle carries. */
export const REPLAY_VIEW_KINDS = [
  "candidate.stage",
  "candidate.submitted",
  "candidate.queued",
  "candidate.rebased",
  "candidate.requeued",
  "candidate.verdict",
  "gate.flaky",
  "measure.started",
  "measure.progress",
  "measure.finished",
  "measure.restarted",
  "measure.deferred",
  "best.promoted",
  "worker.spawned",
  "worker.finished",
  "worker.abandoned",
  "worker.phase",
  "worker.action",
  "drift.started",
  "drift.checked",
  "study.state",
  "scheduler.target",
  "idea.added",
  "idea.status",
  "idea.priority",
  "idea.pinned",
  "segment.started",
  "submission.refunded",
  "bench.online",
  "bench.offline",
  "bench.healthy",
  "bench.unhealthy",
] as const;

/** The kinds the live feed reads (the same list as the server's live view, so both tell the same story). */
const FEED_KINDS = new Set([
  "candidate.stage",
  "candidate.submitted",
  "candidate.queued",
  "candidate.rebased",
  "candidate.requeued",
  "candidate.verdict",
  "gate.flaky",
  "measure.started",
  "measure.progress",
  "measure.finished",
  "measure.restarted",
  "measure.deferred",
  "best.promoted",
  "worker.spawned",
  "worker.finished",
  "worker.abandoned",
  "drift.started",
  "drift.checked",
  "study.state",
]);

export const KEYFRAME_EVERY = 256;
const FEED_LIMIT = 40;
const RECENT_DECIDED = 8;
const NEXT_IDEAS = 6;

interface RW {
  key: number;
  threadId: string | null;
  ideaId: number | null;
  phase: WorkerPhase;
  phaseAt: number;
  action: { label: string; at: number } | null;
}

interface RC {
  n: number;
  id: number;
  stage: Stage;
  stageAt: number;
  verdict: string | null;
  effect: number | null;
  cause: string | null;
  host: string | null;
  pairs: Pairs | null;
  rebases: number;
  submittedAt: number;
  decidedAt: number | null;
  queuedAt: number | null;
  startedAt: number | null;
}

/** The reduced state at an event index: plain records, copied entry by entry for keyframes. */
export interface ReplayState {
  /** Events applied. */
  i: number;
  lastEventId: number;
  workers: Record<number, RW>;
  cands: Record<number, RC>;
  candCount: number;
  /** Worker row (lane key) → its latest candidate number, and its submissions used. */
  latestByWorker: Record<number, number>;
  submissions: Record<number, number>;
  ideas: Record<number, { status: string; priority: number; pinned: boolean; at: number }>;
  best: number | null;
  movedAt: number | null;
  wins: Array<{ n: number; at: number; effect: number }>;
  state: string;
  runningSince: number | null;
  pauseReason: string | null;
  w: number | null;
  drift: Record<string, number>;
  hostStatus: Record<string, { status: "online" | "offline" | "unknown"; healthOk: boolean | null }>;
}

function empty(): ReplayState {
  return { i: 0, lastEventId: 0, workers: {}, cands: {}, candCount: 0, latestByWorker: {}, submissions: {}, ideas: {}, best: null, movedAt: null, wins: [], state: "draft", runningSince: null, pauseReason: null, w: null, drift: {}, hostStatus: {} };
}

function clone(s: ReplayState): ReplayState {
  const rec = <T extends object>(r: Record<string | number, T>) => {
    const o: Record<string | number, T> = {};
    for (const k in r) o[k] = { ...r[k]! };
    return o;
  };
  return {
    ...s,
    workers: rec(s.workers),
    cands: rec(s.cands),
    latestByWorker: { ...s.latestByWorker },
    submissions: { ...s.submissions },
    ideas: rec(s.ideas),
    wins: [...s.wins],
    drift: { ...s.drift },
    hostStatus: rec(s.hostStatus),
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class ReplayModel {
  readonly start: number;
  readonly end: number;
  readonly events: readonly EventLike[];
  private readonly ats: number[];
  private readonly keyframes: ReplayState[] = [];
  private work: ReplayState;
  private readonly feed: LiveFeedItem[];
  private readonly feedMaxId: number[];
  private readonly candById = new Map<number, ReplayBundle["candidates"][number]>();
  private readonly candByN = new Map<number, ReplayBundle["candidates"][number]>();
  private readonly ideaById = new Map<number, ReplayBundle["ideas"][number]>();
  private readonly workerMeta = new Map<number, ReplayBundle["workers"][number]>();
  private readonly keyByThread = new Map<string, number>();
  private readonly bandByN = new Map<number, MeasureBand>();
  private readonly hostName = new Map<string, string>();
  readonly keyframeEvery: number;

  constructor(
    readonly bundle: ReplayBundle,
    opts: { keyframeEvery?: number } = {},
  ) {
    this.keyframeEvery = Math.max(16, opts.keyframeEvery ?? KEYFRAME_EVERY);
    this.events = bundle.events;
    for (const c of bundle.candidates) {
      this.candById.set(c.id, c);
      this.candByN.set(c.n, c);
    }
    for (const i of bundle.ideas) this.ideaById.set(i.id, i);
    for (const w of bundle.workers) {
      this.workerMeta.set(w.key, w);
      if (w.threadId) this.keyByThread.set(w.threadId, w.key);
    }
    for (const b of bundle.bands) this.bandByN.set(b.n, b);
    for (const h of bundle.hosts) this.hostName.set(h.hostId, h.name);
    // Times, made non-decreasing so a binary search is valid even if the clock stepped back.
    this.ats = [];
    let max = Number.NEGATIVE_INFINITY;
    for (const e of this.events) {
      max = Math.max(max, e.at);
      this.ats.push(max);
    }
    this.start = bundle.events.length ? bundle.events[0]!.at : bundle.start;
    this.end = Math.max(this.start, bundle.end);
    // One reduction pass with keyframes.
    const s = empty();
    this.keyframes.push(clone(s));
    for (let i = 0; i < this.events.length; i++) {
      this.apply(s, this.events[i]!);
      if ((i + 1) % this.keyframeEvery === 0) this.keyframes.push(clone(s));
    }
    this.work = clone(this.keyframes[0]!);
    // The feed, told once over the whole study (only the kinds the live view's feed reads).
    this.feed = feedItems(
      this.events.filter((e) => FEED_KINDS.has(e.kind)),
      { metric: bundle.metric, ideas: new Map(bundle.ideas.map((i) => [i.id, { title: i.title }] as const)), hostName: (id) => this.hostName.get(id) ?? id, candidateN: new Map(bundle.candidates.map((c) => [c.id, c.n] as const)), noise: bundle.spec.noise ?? "noisy" },
    );
    this.feedMaxId = [];
    let m = 0;
    for (const f of this.feed) {
      m = Math.max(m, f.id);
      this.feedMaxId.push(m);
    }
  }

  /**
   * The lane (worker row) a candidate belongs to: its worker row, else the
   * worker row its BB thread id maps to, else the submit event's worker row or thread.
   */
  private workerKeyOf(meta: ReplayBundle["candidates"][number] | undefined, d: Record<string, unknown>): number | null {
    if (typeof meta?.workerKey === "number") return meta.workerKey;
    const thread = meta?.threadId ?? str(d.worker);
    if (thread && this.keyByThread.has(thread)) return this.keyByThread.get(thread)!;
    return num(d.worker_row);
  }

  /** How many events happened at or before t. */
  indexAt(t: number): number {
    let lo = 0;
    let hi = this.ats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ats[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The reduced state after the first `count` events (incremental when moving forward, else from the nearest keyframe). */
  stateAtIndex(count: number): ReplayState {
    const target = Math.max(0, Math.min(count, this.events.length));
    if (target < this.work.i || target - this.work.i > this.keyframeEvery) {
      const k = Math.floor(target / this.keyframeEvery);
      this.work = clone(this.keyframes[Math.min(k, this.keyframes.length - 1)]!);
    }
    while (this.work.i < target) this.apply(this.work, this.events[this.work.i]!);
    return this.work;
  }

  stateAt(t: number): ReplayState {
    return this.stateAtIndex(this.indexAt(t));
  }

  private apply(s: ReplayState, e: EventLike): void {
    s.i += 1;
    s.lastEventId = Math.max(s.lastEventId, e.id);
    const d = e.data;
    const candN = num(d.n) ?? (num(d.candidate) !== null ? (this.candById.get(num(d.candidate)!)?.n ?? null) : null);
    const c = candN !== null ? s.cands[candN] : undefined;
    switch (e.kind) {
      case "candidate.stage": {
        if (candN === null) break;
        const to = str(d.to) as Stage | null;
        if (!to) break;
        if (!c) {
          const meta = this.candByN.get(candN);
          const key = this.workerKeyOf(meta, d);
          s.cands[candN] = { n: candN, id: num(d.candidate) ?? meta?.id ?? 0, stage: to, stageAt: e.at, verdict: str(d.verdict), effect: null, cause: null, host: null, pairs: reducePairs(null, e), rebases: 0, submittedAt: e.at, decidedAt: null, queuedAt: to === "queued" ? e.at : null, startedAt: null };
          s.candCount += 1;
          if (key !== null) {
            s.latestByWorker[key] = Math.max(s.latestByWorker[key] ?? 0, candN);
            s.submissions[key] = (s.submissions[key] ?? 0) + 1;
          }
          break;
        }
        c.stage = to;
        c.stageAt = e.at;
        c.verdict = str(d.verdict) ?? (to === "decided" ? c.verdict : null);
        c.pairs = reducePairs(c.pairs, e);
        if (to === "queued" && c.queuedAt === null) c.queuedAt = e.at;
        break;
      }
      case "candidate.verdict":
        if (!c) break;
        c.verdict = str(d.verdict);
        c.effect = num(d.effect) ?? c.effect;
        c.cause = str(d.cause) ?? verdictCause(c.verdict, d.reasons);
        c.decidedAt = e.at;
        if (d.verdict === "win" && num(d.effect) !== null) s.wins.push({ n: c.n, at: e.at, effect: num(d.effect)! });
        break;
      case "measure.started":
        if (!c) break;
        c.host = str(d.host) ?? c.host;
        c.startedAt = e.at;
        c.pairs = reducePairs(c.pairs, e);
        break;
      case "measure.finished":
        if (!c) break;
        c.pairs = reducePairs(c.pairs, e);
        if (num(d.effect) !== null) c.effect = num(d.effect);
        break;
      case "measure.progress":
      case "measure.restarted":
      case "candidate.requeued":
        if (c) c.pairs = reducePairs(c.pairs, e);
        break;
      case "candidate.rebased":
        if (c) c.rebases += 1;
        break;
      case "submission.refunded": {
        const key = num(d.worker) ?? (candN !== null ? this.workerKeyOf(this.candByN.get(candN), {}) : null);
        if (key !== null) s.submissions[key] = Math.max(0, (s.submissions[key] ?? 0) - 1);
        break;
      }
      case "worker.phase": {
        const key = num(d.worker);
        const to = str(d.to) as WorkerPhase | null;
        if (key === null || !to) break;
        if (to === "done") {
          delete s.workers[key];
          break;
        }
        const prev = s.workers[key];
        s.workers[key] = { key, threadId: str(d.thread) ?? prev?.threadId ?? null, ideaId: num(d.idea) ?? prev?.ideaId ?? this.workerMeta.get(key)?.ideaId ?? null, phase: to, phaseAt: e.at, action: prev?.action ?? null };
        break;
      }
      case "worker.action": {
        const key = num(d.worker);
        const w = key !== null ? s.workers[key] : undefined;
        if (w && str(d.label)) w.action = { label: str(d.label)!, at: e.at };
        break;
      }
      case "best.promoted":
        if (num(d.n) !== null) {
          s.best = num(d.n);
          s.movedAt = e.at;
        }
        break;
      case "idea.added": {
        const id = num(d.idea);
        if (id !== null) s.ideas[id] = { status: "queued", priority: num(d.priority) ?? 0, pinned: d.pinned === true, at: e.at };
        break;
      }
      case "idea.status": {
        const id = num(d.idea);
        if (id !== null && str(d.to)) s.ideas[id] = { ...(s.ideas[id] ?? { priority: 0, pinned: false, at: e.at }), status: str(d.to)! };
        break;
      }
      case "idea.priority": {
        const id = num(d.idea);
        if (id !== null && s.ideas[id] && num(d.priority) !== null) s.ideas[id]!.priority = num(d.priority)!;
        break;
      }
      case "idea.pinned": {
        const id = num(d.idea);
        if (id !== null && s.ideas[id]) s.ideas[id]!.pinned = d.pinned === true;
        break;
      }
      case "study.state":
        if (str(d.to)) {
          if (d.to === "running" && s.state !== "running") s.runningSince = e.at;
          if (d.to !== "running") s.runningSince = null;
          s.state = str(d.to)!;
          s.pauseReason = d.to === "paused" ? (str(d.reason) ?? null) : null;
        }
        break;
      case "scheduler.target":
        if (num(d.w) !== null) s.w = num(d.w);
        break;
      case "drift.started":
        if (str(d.host)) s.drift[str(d.host)!] = e.at;
        break;
      case "drift.checked":
        if (str(d.host)) delete s.drift[str(d.host)!];
        break;
      case "bench.online":
      case "bench.offline":
        if (str(d.host)) s.hostStatus[str(d.host)!] = { healthOk: s.hostStatus[str(d.host)!]?.healthOk ?? null, status: e.kind === "bench.online" ? "online" : "offline" };
        break;
      case "bench.healthy":
      case "bench.unhealthy":
        if (str(d.host)) s.hostStatus[str(d.host)!] = { status: s.hostStatus[str(d.host)!]?.status ?? "online", healthOk: e.kind === "bench.healthy" };
        break;
    }
  }

  /** The Live view at time t. */
  viewAt(t: number): LiveView {
    const s = this.stateAt(t);
    const b = this.bundle;
    const metric = b.metric;
    const cands = Object.values(s.cands);
    const bandsShown: MeasureBand[] = [];
    const bandOf = new Map<number, MeasureBand>();
    const decidedAll = cands.filter((c) => c.stage === "decided").sort((x, y) => (x.decidedAt ?? 0) - (y.decidedAt ?? 0) || x.id - y.id);
    const decided = decidedAll.slice(-RECENT_DECIDED);
    const inFlight = cands.filter((c) => c.stage !== "decided").sort((x, y) => x.id - y.id);
    for (const c of [...inFlight, ...decided]) {
      const full = bandShown(c.stage, c.decidedAt, t) ? this.bandByN.get(c.n) : undefined;
      const band = full ? bandAt(full, t) : null;
      if (band) {
        bandsShown.push(band);
        bandOf.set(c.n, band);
      }
    }
    const queued = cands.filter((c) => c.stage === "queued").sort((x, y) => (x.queuedAt ?? 0) - (y.queuedAt ?? 0) || x.id - y.id);
    const onBench = cands.filter((c) => c.stage === "measuring" || c.stage === "confirming").length;
    const card = (c: RC): LiveCard => {
      const meta = this.candByN.get(c.n);
      return {
        n: c.n,
        ideaId: meta?.ideaId ?? null,
        ideaTitle: meta?.title ?? "",
        workerKey: this.workerKeyOf(meta, {}),
        stage: c.stage,
        column: columnOf(c.stage, c.verdict),
        stageAt: c.stageAt,
        verdict: c.verdict,
        effect: c.effect,
        effectText: c.effect === null ? null : improvementText(c.effect, metric, { digits: 1, factor: false }),
        cause: c.stage === "decided" ? c.cause : null,
        hostId: c.host,
        pairs: mergeProgress(c.pairs, c.stage === "decided" ? null : bandOf.get(c.n)),
        rebases: c.rebases,
        submittedAt: c.submittedAt,
        decidedAt: c.decidedAt,
      };
    };
    const cards = [...inFlight.map(card), ...decided.map(card)].sort((x, y) => x.n - y.n);
    const cardByN = new Map(cards.map((c) => [c.n, c] as const));
    const workers: LiveWorker[] = Object.values(s.workers)
      .sort((x, y) => x.key - y.key)
      .map((w) => {
        const meta = this.workerMeta.get(w.key);
        const idea = w.ideaId !== null ? this.ideaById.get(w.ideaId) : undefined;
        const thread = w.threadId ?? null;
        const latestN = s.latestByWorker[w.key] ?? null;
        const latest = latestN !== null ? s.cands[latestN] : undefined;
        const qpos = latest?.stage === "queued" ? queued.findIndex((q) => q.n === latest.n) + 1 + onBench : null;
        return {
          key: w.key,
          threadId: thread,
          ideaId: w.ideaId,
          ideaTitle: clip(idea?.title ?? "", 160),
          theme: idea?.theme ?? "",
          phase: w.phase,
          phaseAt: w.phaseAt,
          spawnedAt: meta?.spawnedAt ?? w.phaseAt,
          submissions: s.submissions[w.key] ?? 0,
          maxSubmissions: b.spec.maxSubmissions,
          candidate: latestN,
          candidateStage: latest?.stage ?? null,
          queuePosition: qpos,
          action: w.action,
        };
      });
    const bench: LiveBenchHost[] = b.hosts.map((h) => {
      const m = inFlight.find((c) => c.host === h.hostId && (c.stage === "measuring" || c.stage === "confirming" || c.stage === "promoting"));
      const st = s.hostStatus[h.hostId];
      const intervals = b.intervals.filter((i) => i.hostId === h.hostId && i.start <= t).map((i) => ({ start: i.start, end: i.end !== null && i.end <= t ? i.end : null }));
      return {
        hostId: h.hostId,
        name: h.name,
        status: st?.status ?? "online",
        healthOk: st?.healthOk ?? null,
        deferredUntil: null,
        current: m
          ? { kind: "measure" as const, n: m.n, stage: m.stage, pairs: cardByN.get(m.n)?.pairs ?? null, startedAt: m.startedAt ?? m.queuedAt ?? m.submittedAt }
          : s.drift[h.hostId] !== undefined
            ? { kind: "drift" as const, startedAt: s.drift[h.hostId]! }
            : null,
        ...utilization(intervals, t, s.runningSince),
      };
    });
    // Up next with the scheduler's policy at t.
    const ideaRow = (id: number) => {
      const meta = this.ideaById.get(id);
      const st = s.ideas[id]!;
      return { id, title: meta?.title ?? `idea #${id}`, theme: meta?.theme ?? "", pinned: st.pinned ? 1 : 0, priority: st.priority, status: st.status as "queued", source: (meta?.source ?? "strategist") as "strategist", variation_of: meta?.variationOf ?? null };
    };
    const ids = Object.keys(s.ideas).map(Number);
    const w = s.w ?? b.spec.maxWorkers;
    const order = upNext(
      ids.filter((id) => s.ideas[id]!.status === "queued").map(ideaRow),
      ids.filter((id) => s.ideas[id]!.status === "running").map(ideaRow),
      w,
      { lostTitles: new Set(ids.filter((id) => s.ideas[id]!.status === "lost").map((id) => titleKey(this.ideaById.get(id)?.title ?? ""))) },
    );
    const history = bestHistory(s.wins, metric.direction);
    const value = history.length ? history.at(-1)!.value : null;
    const bestCand = s.best !== null ? s.cands[s.best] : undefined;
    const winnerKey = s.best !== null ? this.workerKeyOf(this.candByN.get(s.best), {}) : null;
    const measuring = inFlight.filter((c) => c.stage === "measuring" || c.stage === "confirming").map((c) => `c/${c.n}`);
    const inTests = inFlight.filter((c) => c.stage === "gating").length;
    return {
      studyId: b.studyId,
      slug: b.slug,
      state: s.state,
      statusLine: replayStatusLine(s.state, workers.length, measuring, { queued: queued.length, inTests }, s.pauseReason),
      metric,
      noise: b.spec.noise ?? "noisy",
      now: t,
      lastEventId: s.lastEventId,
      studyThreadId: b.studyThreadId,
      best: {
        text: value === null ? null : improvementText(value, metric),
        n: s.best,
        at: bestCand?.decidedAt ?? null,
        value,
        movedAt: s.best !== null ? s.movedAt : null,
        history,
        rebases: s.best !== null ? rebaseLanes(workers, winnerKey) : [],
      },
      counts: { candidates: s.candCount, maxCandidates: b.spec.maxCandidates, workers: workers.length, targetWorkers: w, queue: queued.length },
      workers,
      cards,
      queue: queued.map((c) => c.n),
      bench,
      ideas: { next: order.slice(0, NEXT_IDEAS).map(({ idea, blocked }) => ({ id: idea.id, title: clip(idea.title, 160), theme: idea.theme, pinned: idea.pinned === 1, source: idea.source, blocked })), total: order.length },
      feed: this.feedUpTo(s.lastEventId),
      bands: bandsShown,
    };
  }

  /** The last FEED_LIMIT feed lines whose event is at or before `eventId`. */
  private feedUpTo(eventId: number): LiveFeedItem[] {
    // feedMaxId is non-decreasing: everything before `cut` has id ≤ eventId except lines told out of order (best after its win).
    let lo = 0;
    let hi = this.feedMaxId.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.feedMaxId[mid]! <= eventId) lo = mid + 1;
      else hi = mid;
    }
    const out: LiveFeedItem[] = [];
    for (let i = Math.min(this.feed.length, lo + 3) - 1; i >= 0 && out.length < FEED_LIMIT; i--) if (this.feed[i]!.id <= eventId) out.push(this.feed[i]!);
    return out.reverse();
  }

  /** Milestones for the scrubber: wins, best moved, pauses and resumes, segment changes, harvest. */
  milestones(): Milestone[] {
    const out: Milestone[] = [];
    for (const e of this.events) {
      const d = e.data;
      if (e.kind === "candidate.verdict" && d.verdict === "win") out.push({ at: e.at, kind: "win", label: `c/${String(d.n)} won` });
      else if (e.kind === "best.promoted") out.push({ at: e.at, kind: "best", label: `Best moved: c/${String(d.n)}` });
      else if (e.kind === "study.state" && d.to === "paused") out.push({ at: e.at, kind: "pause", label: `Paused${typeof d.reason === "string" ? `: ${clip(d.reason, 60)}` : ""}` });
      else if (e.kind === "study.state" && d.to === "running") out.push({ at: e.at, kind: "resume", label: d.from === "paused" ? "Resumed" : "Running" });
      else if (e.kind === "study.state" && d.to === "harvesting") out.push({ at: e.at, kind: "harvest", label: "Harvest started" });
      else if (e.kind === "segment.started") out.push({ at: e.at, kind: "segment", label: `Segment ${String(d.segment)}: new oracle` });
    }
    return out;
  }

  /** Event counts in `bins` equal slices of [start, end] (the scrubber's density marks). */
  density(bins: number): number[] {
    const out = new Array<number>(bins).fill(0);
    const span = Math.max(1, this.end - this.start);
    for (const e of this.events) out[Math.min(bins - 1, Math.max(0, Math.floor(((e.at - this.start) / span) * bins)))]! += 1;
    return out;
  }
}

export interface Milestone {
  at: number;
  kind: "win" | "best" | "pause" | "resume" | "harvest" | "segment";
  label: string;
}

/** The time of the first milestone of `kind` strictly after t (null: none). */
export function nextMilestone(milestones: readonly Milestone[], t: number, kind: Milestone["kind"]): number | null {
  for (const m of milestones) if (m.kind === kind && m.at > t) return m.at;
  return null;
}

/** The status line at a replayed moment (the live one also reads the harvest and pause details from the database). */
export function replayStatusLine(state: string, workers: number, measuring: readonly string[], waiting: { queued: number; inTests: number }, pauseReason: string | null): string {
  switch (state) {
    case "running":
      return runningStatusText(workers, measuring, waiting.queued, waiting.inTests);
    case "paused":
      return `Paused: ${clip(pauseReason ?? "no reason recorded", 200)}.${workers ? ` ${workers} worker${workers === 1 ? "" : "s"} finishing.` : ""}`;
    case "harvesting":
      return "Harvesting.";
    case "archived":
      return "Archived.";
    case "calibrating":
      return "Calibrating.";
    case "draft":
      return "Draft.";
    default:
      return state;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
