// Live view, server side: records every change the Live view shows as an
// event (worker phases here; candidate stages in the store; pair progress in
// the pipeline), projects those events into throttled realtime deltas, and
// builds the view model the Live tab and the study thread's Live panel read.
//
// See live-model.ts for the shared model, and docs/design.md "Implementation
// notes: live view (part 1)".
import type { Ctx } from "./context.ts";
import type { AppendedEvent, CandidateRow, EventRow, Store, StudyRow, ThreadRow } from "./db/store.ts";
import type { Engine } from "./engine.ts";
import {
  activityOnly,
  columnOf,
  deltaFromEvent,
  deltaKey,
  deriveWorkerPhase,
  LIVE_CHANNEL,
  reducePairs,
  type Activity,
  type EventLike,
  type FeedTone,
  type LiveBenchHost,
  type LiveCard,
  type LiveDelta,
  type LiveDeltaMessage,
  type LiveFeedItem,
  type LiveSkeleton,
  type LiveView,
  type LiveWorker,
  type Pairs,
  type Stage,
  type WorkerPhase,
} from "./live-model.ts";
import { improvementText, type MetricInfo } from "./present.ts";
import { clip, safeJson } from "./prompts.ts";
import { statusLine } from "./views.ts";

const LIVE_WORKER_STATES = ["spawning", "active", "finishing"] as const;

// -------------------------------------------------------------- delta bus

/**
 * Throttled realtime deltas: at most one publish per `intervalMs` per study
 * (≈4/s at 250 ms). Within a window only the latest delta per key is kept
 * (a card that went gating → queued → measuring sends "measuring"). A burst
 * larger than `maxBatch` becomes one "refetch" message.
 */
export class DeltaBus {
  private queues = new Map<string, Map<string, LiveDelta>>();
  private last = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly send: (msg: LiveDeltaMessage) => void,
    private readonly intervalMs = 250,
    private readonly now: () => number = Date.now,
    private readonly maxBatch = 40,
  ) {}

  push(studyId: string, d: LiveDelta): void {
    let q = this.queues.get(studyId);
    if (!q) {
      q = new Map();
      this.queues.set(studyId, q);
    }
    const key = deltaKey(d);
    q.delete(key);
    q.set(key, d);
    if (this.timers.has(studyId)) return;
    const wait = Math.max(0, (this.last.get(studyId) ?? Number.NEGATIVE_INFINITY) + this.intervalMs - this.now());
    const t = setTimeout(() => this.flush(studyId), wait);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(studyId, t);
  }

  flush(studyId: string): void {
    const t = this.timers.get(studyId);
    if (t) clearTimeout(t);
    this.timers.delete(studyId);
    const q = this.queues.get(studyId);
    if (!q?.size) return;
    const batch = [...q.values()].sort((a, b) => a.id - b.id);
    q.clear();
    this.last.set(studyId, this.now());
    try {
      this.send(batch.length > this.maxBatch ? { s: studyId, d: [], refetch: true } : { s: studyId, d: batch });
    } catch {
      // Realtime is best effort; the view refetches periodically.
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.queues.clear();
  }
}

// ---------------------------------------------------------- the recorder

/**
 * Keeps each worker's recorded phase (threads.phase) in step with plugin
 * state, appending a `worker.phase` event for every change, and forwards
 * every event the Live view shows to the delta bus. Any event of a study
 * schedules a phase sync for it (on a microtask, after the transaction that
 * appended it), so phases follow stage changes, verdict delivery, finishing,
 * and the activity seen in worker threads.
 */
export class LiveRecorder {
  readonly bus: DeltaBus;
  private pending = new Set<string>();
  private scheduled = false;
  private dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dwellMs: number;
  private unsubscribe: () => void;

  constructor(
    private readonly ctx: Ctx,
    opts: { intervalMs?: number; dwellMs?: number } = {},
  ) {
    this.dwellMs = opts.dwellMs ?? ctx.config.liveDwellMs ?? 3000;
    this.bus = new DeltaBus((msg) => ctx.bb.publish(LIVE_CHANNEL, msg), opts.intervalMs ?? 250);
    this.unsubscribe = ctx.store.onEvent((e) => this.onEvent(e));
  }

  private onEvent(e: AppendedEvent): void {
    if (!e.studyId) return;
    const d = deltaFromEvent(e);
    if (d) this.bus.push(e.studyId, d);
    if (e.kind !== "worker.phase") this.schedule(e.studyId);
  }

  /** Sync a study's worker phases soon (after the current synchronous work). */
  schedule(studyId: string): void {
    this.pending.add(studyId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flushPending());
  }

  /** Run pending syncs now (tests). */
  flushPending(): void {
    this.scheduled = false;
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) {
      try {
        this.sync(id);
      } catch (e) {
        this.ctx.bb.log("warn", `live sync ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Record phase changes of a study's workers; returns how many were recorded. */
  sync(studyId: string): number {
    const { store } = this.ctx;
    const now = this.ctx.now();
    let changes = 0;
    let retryIn: number | null = null;
    for (const w of store.threads(studyId, { role: "worker" })) {
      const live = (LIVE_WORKER_STATES as readonly string[]).includes(w.state);
      // Workers that ended before this view existed (no recorded phase) stay out of the event log.
      if (!live && (w.phase === null || w.phase === "done")) continue;
      const latest = w.thread_id ? store.candidates(studyId, { threadId: w.thread_id, order: "desc", limit: 1 })[0] : undefined;
      const phase = deriveWorkerPhase({
        state: w.state,
        activity: (w.activity as Activity | null) ?? null,
        activityAt: w.activity_at,
        latest: latest ? { stage: latest.stage, reportedAt: latest.reported_at } : null,
      });
      const from = (w.phase as WorkerPhase | null) ?? null;
      if (phase === from) continue;
      if (activityOnly(from, phase) && w.phase_at !== null && now - w.phase_at < this.dwellMs) {
        // Rate-limit flips between reading, editing and testing; record the latest after the dwell.
        const wait = this.dwellMs - (now - w.phase_at);
        retryIn = retryIn === null ? wait : Math.min(retryIn, wait);
        continue;
      }
      store.tx(() => {
        store.updateThread(w.id, { phase, phase_at: now });
        store.event(studyId, "worker.phase", "plugin", {
          worker: w.id,
          thread: w.thread_id,
          idea: w.idea_id,
          from,
          to: phase,
          candidate: latest?.n ?? null,
          ...(phase === "done" ? { reason: w.end_reason ? clip(w.end_reason, 120) : w.state } : {}),
        });
      });
      changes += 1;
    }
    if (retryIn !== null && !this.dwellTimers.has(studyId)) {
      const t = setTimeout(() => {
        this.dwellTimers.delete(studyId);
        this.schedule(studyId);
      }, Math.max(50, retryIn));
      (t as { unref?: () => void }).unref?.();
      this.dwellTimers.set(studyId, t);
    }
    return changes;
  }

  dispose(): void {
    this.unsubscribe();
    this.bus.dispose();
    for (const t of this.dwellTimers.values()) clearTimeout(t);
    this.dwellTimers.clear();
  }
}

// ------------------------------------------------------------ view model

/** Event kinds the live view reads (stage times, pair progress, the feed). */
export const LIVE_VIEW_KINDS = [
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
] as const;

const FEED_LIMIT = 40;
const RECENT_DECIDED = 8;
const NEXT_IDEAS = 6;
const UTILIZATION_WINDOW_S = 600;

function rowToEvent(r: EventRow): EventLike {
  return { id: r.id, at: r.at, kind: r.kind, data: safeJson<Record<string, unknown>>(r.data_json) ?? {} };
}

function metricOf(engine: Engine, s: StudyRow): MetricInfo {
  return engine.metricInfo(s);
}

/** Pair progress per candidate id, from its events (same reducer as replay). */
function pairsByCandidate(events: readonly EventLike[]): Map<number, Pairs | null> {
  const out = new Map<number, Pairs | null>();
  for (const e of events) {
    const id = typeof e.data.candidate === "number" ? e.data.candidate : null;
    if (id === null) continue;
    out.set(id, reducePairs(out.get(id) ?? null, e));
  }
  return out;
}

/** The Live view model of a study (the Live tab and the study thread's Live panel). Read only. */
export function liveView(engine: Engine, s: StudyRow): LiveView {
  const { store } = engine.ctx;
  const now = engine.ctx.now();
  let spec: ReturnType<Store["spec"]> | null = null;
  try {
    spec = store.spec(s);
  } catch {
    spec = null;
  }
  const metric = metricOf(engine, s);
  const events = store.recentEvents(s.id, LIVE_VIEW_KINDS, 3000).map(rowToEvent);
  const pairs = pairsByCandidate(events);
  const stageAt = new Map<number, number>();
  for (const e of events) if (e.kind === "candidate.stage" && typeof e.data.candidate === "number") stageAt.set(e.data.candidate, e.at);
  const ideas = new Map(store.ideas(s.id).map((i) => [i.id, i] as const));
  const threadsAll = store.threads(s.id, { role: "worker" });
  const workerKeyByThread = new Map(threadsAll.filter((t) => t.thread_id).map((t) => [t.thread_id!, t.id] as const));

  const queuedRows = store.candidates(s.id, { stages: ["queued"] }).sort((a, b) => (a.queued_at ?? 0) - (b.queued_at ?? 0) || a.id - b.id);
  const onBench = store.candidates(s.id, { stages: ["measuring", "confirming"] }).length;
  const inFlight = store.candidates(s.id, { stages: ["submitted", "gating", "queued", "measuring", "confirming", "promoting"] });
  const decided = store.decided(s.id, RECENT_DECIDED);
  const card = (c: CandidateRow): LiveCard => ({
    n: c.n,
    ideaId: c.idea_id,
    ideaTitle: c.idea_id !== null ? clip(ideas.get(c.idea_id)?.title ?? "", 120) : clip(c.summary.split("\n")[0] ?? "", 120),
    workerKey: c.thread_id ? (workerKeyByThread.get(c.thread_id) ?? null) : null,
    stage: c.stage,
    column: columnOf(c.stage, c.verdict),
    stageAt: stageAt.get(c.id) ?? (c.stage === "decided" ? (c.decided_at ?? c.submitted_at) : c.stage === "queued" ? (c.queued_at ?? c.submitted_at) : c.submitted_at),
    verdict: c.verdict,
    effect: c.effect,
    effectText: c.effect === null ? null : improvementText(c.effect, metric, { digits: 1, factor: false }),
    hostId: c.bench_host_id,
    pairs: pairs.get(c.id) ?? null,
    rebases: c.rebases,
    submittedAt: c.submitted_at,
    decidedAt: c.decided_at,
  });
  const cards = [...inFlight.map(card), ...decided.map(card)].sort((a, b) => a.n - b.n);

  const workers: LiveWorker[] = threadsAll
    .filter((w) => (LIVE_WORKER_STATES as readonly string[]).includes(w.state))
    .map((w) => {
      const latest = w.thread_id ? store.candidates(s.id, { threadId: w.thread_id, order: "desc", limit: 1 })[0] : undefined;
      const idea = w.idea_id !== null ? ideas.get(w.idea_id) : undefined;
      const qpos = latest?.stage === "queued" ? queuedRows.findIndex((q) => q.id === latest.id) + 1 + onBench : null;
      return {
        key: w.id,
        threadId: w.thread_id,
        ideaId: w.idea_id,
        ideaTitle: clip(idea?.title ?? "", 160),
        theme: idea?.theme ?? "",
        phase: (w.phase as WorkerPhase | null) ?? recordedOrDerived(w, latest),
        phaseAt: w.phase_at ?? w.spawned_at,
        spawnedAt: w.spawned_at,
        submissions: w.submissions,
        maxSubmissions: spec?.agents.max_submissions_per_worker ?? 0,
        candidate: latest?.n ?? null,
        candidateStage: latest?.stage ?? null,
        queuePosition: qpos,
      };
    });

  const measuringRows = store.candidates(s.id, { stages: ["measuring", "confirming", "promoting"] });
  const windowStart = now - UTILIZATION_WINDOW_S * 1000;
  const intervals = store.benchIntervals(s.id, { since: windowStart });
  const runningFrom = runningStart(store, s);
  const bench: LiveBenchHost[] = store.benchHosts(s.id).map((h) => {
    const m = measuringRows.find((c) => c.bench_host_id === h.host_id);
    const started = m ? lastAt(events, "measure.started", m.id) : null;
    const from = Math.max(windowStart, runningFrom ?? windowStart);
    const span = Math.max(0, now - from);
    let busy = 0;
    for (const i of intervals) {
      if (i.host_id !== h.host_id) continue;
      busy += Math.max(0, Math.min(i.ended_at ?? now, now) - Math.max(i.started_at, from));
    }
    return {
      hostId: h.host_id,
      name: h.name,
      status: h.status,
      healthOk: h.health_ok === null ? null : h.health_ok === 1,
      deferredUntil: h.deferred_until !== null && h.deferred_until > now ? h.deferred_until : null,
      current: m
        ? { kind: "measure" as const, n: m.n, stage: m.stage, pairs: pairs.get(m.id) ?? null, startedAt: started ?? m.queued_at ?? m.submitted_at }
        : h.drift_status === "running"
          ? { kind: "drift" as const, startedAt: lastHostAt(events, "drift.started", h.host_id) }
          : null,
      utilization: span >= 5000 ? Math.min(1, busy / span) : null,
      windowSeconds: Math.round(span / 1000),
    };
  });

  const queuedIdeas = store.ideas(s.id, ["queued"]);
  const bestRow = s.best_sha ? store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.promoted_sha === s.best_sha).at(-1) : undefined;
  const cum = engine.cumulative(s);
  return {
    studyId: s.id,
    slug: s.slug,
    state: s.state,
    statusLine: statusLine(engine, s),
    metric,
    now,
    lastEventId: store.lastStudyEventId(s.id),
    studyThreadId: s.study_thread_id,
    best: { text: cum === null ? null : improvementText(cum, metric), n: bestRow?.n ?? null, at: bestRow?.decided_at ?? null },
    counts: {
      candidates: store.candidateCount(s.id),
      maxCandidates: spec?.budget.max_candidates ?? 0,
      workers: workers.length,
      targetWorkers: s.target_workers ?? engine.maxWorkers(s),
      queue: queuedRows.length,
    },
    workers,
    cards,
    queue: queuedRows.map((c) => c.n),
    bench,
    ideas: {
      next: queuedIdeas.slice(0, NEXT_IDEAS).map((i) => ({ id: i.id, title: clip(i.title, 160), theme: i.theme, pinned: i.pinned === 1, source: i.source })),
      total: queuedIdeas.length,
    },
    feed: feedItems(events, { metric, ideas, hostName: (id) => store.benchHost(s.id, id)?.name ?? id, candidateN: candidateNumbers(store, s.id) }).slice(-FEED_LIMIT),
  };
}

function recordedOrDerived(w: ThreadRow, latest: CandidateRow | undefined): WorkerPhase {
  return deriveWorkerPhase({ state: w.state, activity: (w.activity as Activity | null) ?? null, activityAt: w.activity_at, latest: latest ? { stage: latest.stage, reportedAt: latest.reported_at } : null });
}

function runningStart(_store: Store, s: StudyRow): number | null {
  return s.running_since ?? null;
}

function lastAt(events: readonly EventLike[], kind: string, candidateId: number): number | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === kind && events[i]!.data.candidate === candidateId) return events[i]!.at;
  return null;
}

function lastHostAt(events: readonly EventLike[], kind: string, hostId: string): number | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === kind && events[i]!.data.host === hostId) return events[i]!.at;
  return null;
}

function candidateNumbers(store: Store, studyId: string): Map<number, number> {
  return new Map(store.candidates(studyId).map((c) => [c.id, c.n] as const));
}

// ------------------------------------------------------------------ feed

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${(s / 60).toFixed(1)} min`;
}

/**
 * The event feed: one plain sentence per event the human cares about,
 * tagged with its candidate so the page can group them ("c/14 tests passed
 * in 41 s", "c/13 lost: 0.4% more ops").
 */
export function feedItems(
  events: readonly EventLike[],
  ctx: { metric: MetricInfo; ideas: Map<number, { title: string }>; hostName: (id: string) => string; candidateN: Map<number, number> },
): LiveFeedItem[] {
  const out: LiveFeedItem[] = [];
  const gatingAt = new Map<number, number>();
  const nOf = (d: Record<string, unknown>): number | null => (typeof d.n === "number" ? d.n : typeof d.candidate === "number" ? (ctx.candidateN.get(d.candidate) ?? null) : null);
  const idea = (id: unknown): string => (typeof id === "number" ? `idea #${id}${ctx.ideas.get(id) ? ` (${clip(ctx.ideas.get(id)!.title, 60)})` : ""}` : "an idea");
  for (const e of events) {
    const d = e.data;
    const n = nOf(d);
    const push = (text: string, tone: FeedTone = "info", candidate: number | null = n) => out.push({ id: e.id, at: e.at, candidate, text, tone });
    switch (e.kind) {
      case "candidate.submitted":
        push(`c/${n} submitted${typeof d.files === "number" ? ` (${plural(d.files, "file")})` : ""}`);
        break;
      case "candidate.stage":
        if (d.to === "gating" && typeof d.candidate === "number") {
          gatingAt.set(d.candidate, e.at);
          if (d.from === "queued" || d.from === "measuring" || d.from === "confirming") break; // rebased: the requeue line says why
          push(`c/${n} tests started`);
        } else if (d.to === "confirming") push(`c/${n} looks like a win: confirming with fresh pairs`);
        break;
      case "candidate.queued": {
        const started = typeof d.candidate === "number" ? gatingAt.get(d.candidate) : undefined;
        push(`c/${n} tests passed${started !== undefined ? ` in ${seconds(e.at - started)}` : ""}, queued for the bench`);
        break;
      }
      case "gate.flaky":
        push(`c/${n} a test was flaky (passed on the retry)`, "warn");
        break;
      case "candidate.rebased":
        push(`c/${n} rebased onto the new best`);
        break;
      case "candidate.requeued":
        push(`c/${n} back to tests: ${clip(String(d.reason ?? "best moved"), 80)}`, "warn");
        break;
      case "measure.started":
        push(`c/${n} on the bench${typeof d.host === "string" ? ` (${ctx.hostName(d.host)})` : ""}`);
        break;
      case "measure.restarted":
        push(`c/${n} measurement restarted: ${clip(String(d.reason ?? ""), 80)}`, "warn");
        break;
      case "measure.deferred":
        push(`c/${n} waits: the bench host failed its health check`, "warn");
        break;
      case "measure.finished":
        push(`c/${n} measured${typeof d.pairs === "number" ? `: ${plural(d.pairs, "pair")}` : ""}${typeof d.seconds === "number" ? ` in ${seconds(d.seconds * 1000)}` : ""}`);
        break;
      case "candidate.verdict": {
        const eff = typeof d.effect === "number" ? improvementText(d.effect, ctx.metric, { digits: 1, factor: false }) : null;
        const reason = Array.isArray(d.reasons) && typeof d.reasons[0] === "string" ? clip(d.reasons[0], 90) : "";
        switch (d.verdict) {
          case "win":
            push(`c/${n} won${eff ? `: ${eff}` : ""}`, "win");
            break;
          case "lose":
            push(`c/${n} lost${eff ? `: ${eff}` : reason ? `: ${reason}` : ""}`, "lose");
            break;
          case "inconclusive":
            push(`c/${n} inconclusive${eff ? `: ${eff}, within the noise` : ""}`, "info");
            break;
          case "gate_failed":
            push(`c/${n} failed the tests`, "lose");
            break;
          case "conflict":
            push(`c/${n} conflicts with the new best`, "warn");
            break;
          case "rejected":
            push(`c/${n} rejected${reason ? `: ${reason}` : ""}`, "lose");
            break;
          default:
            push(`c/${n}: ${String(d.verdict)}`);
        }
        break;
      }
      case "best.promoted":
        push(`Best moved: c/${n} promoted, workers notified`, "best");
        break;
      case "worker.spawned":
        push(`A worker picked ${idea(d.idea)}`, "info", null);
        break;
      case "worker.finished":
        push(`The worker on ${idea(d.idea)} finished`, "info", null);
        break;
      case "worker.abandoned":
        push(`The worker on ${idea(d.idea)} stopped${d.reason ? `: ${clip(String(d.reason), 60)}` : ""}`, "warn", null);
        break;
      case "drift.checked":
        push(`Drift check on ${typeof d.host === "string" ? ctx.hostName(d.host) : "the bench"}: ${d.ok ? "noise as calibrated" : "noise drifted"}`, d.ok ? "info" : "warn", null);
        break;
      case "study.state":
        push(`Study ${String(d.to)}${d.reason ? `: ${clip(String(d.reason), 80)}` : ""}`, d.to === "paused" ? "warn" : "info", null);
        break;
    }
  }
  return out;
}

// ------------------------------------------------------- skeleton (tests)

/** The skeleton of the current state from the database (replay must reproduce it from events alone). */
export function skeletonFromDb(store: Store, s: StudyRow): LiveSkeleton {
  const events = store.eventsAsc(s.id, { kinds: ["candidate.stage", "measure.started", "measure.progress", "measure.finished", "measure.restarted", "candidate.requeued"] }).map(rowToEvent);
  const pairs = pairsByCandidate(events);
  const out: LiveSkeleton = { workers: {}, candidates: {}, best: null, queuedIdeas: [], benchCurrent: {} };
  for (const w of store.threads(s.id, { role: "worker" })) {
    if (!(LIVE_WORKER_STATES as readonly string[]).includes(w.state) || w.phase === null) continue;
    out.workers[w.id] = { phase: w.phase as WorkerPhase, idea: w.idea_id };
  }
  for (const c of store.candidates(s.id)) {
    out.candidates[c.n] = { stage: c.stage as Stage, verdict: c.verdict, pairs: pairs.get(c.id) ?? null };
    if ((c.stage === "measuring" || c.stage === "confirming") && c.bench_host_id) out.benchCurrent[c.bench_host_id] = c.n;
  }
  const best = s.best_sha ? store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.promoted_sha === s.best_sha).at(-1) : undefined;
  out.best = best?.n ?? null;
  out.queuedIdeas = store.ideas(s.id, ["queued"]).map((i) => i.id).sort((a, b) => a - b);
  return out;
}

/** Which study a thread belongs to (the study thread's Live panel resolves its study from the thread). */
export function threadStudy(engine: Engine, threadId: string): { slug: string; role: "study" | "worker"; state: string; studyThreadId: string | null; workerKey: number | null } | null {
  const { store } = engine.ctx;
  const row = store.threadById(threadId);
  const s = row ? store.study(row.study_id) : store.studies().find((x) => x.study_thread_id === threadId);
  if (!s) return null;
  return { slug: s.slug, role: row?.role === "worker" ? "worker" : "study", state: s.state, studyThreadId: s.study_thread_id, workerKey: row?.role === "worker" ? row.id : null };
}
