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
  bandShown,
  bestHistory,
  LIVE_CHANNEL,
  benchQueueOrder,
  mergeProgress,
  queuePosition,
  rebaseLanes,
  utilization,
  UTILIZATION_WINDOW_S,
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
import { buildBand, type BandInput, type MeasureBand, type SampleLike } from "./band.ts";
import type { GuardrailJudgement } from "./guardrails.ts";
import { feedItems } from "./live-feed.ts";
import { bestGuardrailPositions, measurementMde, measurementNoise } from "./pipeline.ts";
import { improvementText, verdictCause, type MetricInfo } from "./present.ts";
import { clip, safeJson } from "./prompts.ts";
import { REPLAY_VIEW_KINDS, type ReplayBundle } from "./replay.ts";
import { titleKey, upNext } from "./scheduler.ts";
import type { StudySpec } from "./spec.ts";
import { gatesOnBench, singleMachineView, statusLine } from "./views.ts";

export { feedItems } from "./live-feed.ts";

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
  private readonly actionMs: number;
  private unsubscribe: () => void;

  constructor(
    private readonly ctx: Ctx,
    opts: { intervalMs?: number; dwellMs?: number; actionMs?: number } = {},
  ) {
    this.dwellMs = opts.dwellMs ?? ctx.config.liveDwellMs ?? 3000;
    this.actionMs = opts.actionMs ?? ctx.config.liveActionMs ?? 3000;
    this.bus = new DeltaBus((msg) => ctx.bb.publish(LIVE_CHANNEL, msg), opts.intervalMs ?? 250);
    this.unsubscribe = ctx.store.onEvent((e) => this.onEvent(e));
  }

  private onEvent(e: AppendedEvent): void {
    if (!e.studyId) return;
    const d = deltaFromEvent(e);
    if (d) this.bus.push(e.studyId, d);
    if (e.kind !== "worker.phase" && e.kind !== "worker.action") this.schedule(e.studyId);
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
      const latest = store.workerCandidates(studyId, w, { order: "desc", limit: 1 })[0];
      const phase = deriveWorkerPhase({
        state: w.state,
        activity: (w.activity as Activity | null) ?? null,
        activityAt: w.activity_at,
        latest: latest ? { stage: latest.stage, reportedAt: latest.reported_at } : null,
      });
      const from = (w.phase as WorkerPhase | null) ?? null;
      // The "last action" line: a worker.action event when the label changes, at most one per actionMs per worker.
      if (live && w.last_action && w.last_action !== w.action_recorded) {
        if (w.action_recorded_at !== null && now - w.action_recorded_at < this.actionMs) {
          const wait = this.actionMs - (now - w.action_recorded_at);
          retryIn = retryIn === null ? wait : Math.min(retryIn, wait);
        } else {
          store.tx(() => {
            store.updateThread(w.id, { action_recorded: w.last_action, action_recorded_at: now });
            store.event(studyId, "worker.action", "plugin", { worker: w.id, thread: w.thread_id, label: w.last_action, item_at: w.last_action_at });
          });
          changes += 1;
        }
      }
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

  // ---------------------------------------------------- CI bands

  /** Bands recomputed for measurements decided before bands were stored (not written back: views are read only). */
  readonly legacy = new Map<number, { at: number | null; band: MeasureBand }>();
  private bands = new Map<number, { firstId: number; lastId: number; samples: SampleLike[]; key: string; band: MeasureBand | null }>();
  private bandPending = new Set<number>();
  private bandScheduled = false;
  private bandPushed = new Map<number, string>();

  /**
   * The CI band of a candidate's current measurement, from its samples,
   * extended incrementally: only samples after the last one read are
   * loaded, and points already computed are reused (band.ts). A restarted
   * measurement (its samples deleted) starts over.
   */
  band(c: CandidateRow, study: StudyRow): MeasureBand | null {
    const { store } = this.ctx;
    const bounds = store.sampleBounds(c.id);
    if (!bounds.count) {
      this.bands.delete(c.id);
      return null;
    }
    const input = bandInput(this.ctx, study, c);
    if (!input) return null;
    const key = JSON.stringify([input.mde, input.noiseFloor, input.guardrails.map((g) => [g.name, g.prior?.regression ?? null, g.prior?.lo ?? null, g.prior?.hi ?? null])]);
    let entry = this.bands.get(c.id);
    if (!entry || entry.firstId !== bounds.min || entry.lastId > bounds.max) {
      entry = { firstId: bounds.min, lastId: 0, samples: [], key, band: null };
      this.bands.set(c.id, entry);
    }
    if (entry.lastId === bounds.max && entry.key === key && entry.band) return entry.band;
    const rows = store.samplesAfter(c.id, entry.lastId);
    for (const r of rows) entry.samples.push(r);
    entry.lastId = rows.at(-1)?.id ?? entry.lastId;
    entry.band = buildBand(entry.samples, input, entry.key === key ? entry.band : null);
    entry.key = key;
    return entry.band;
  }

  /** A sample was recorded: push the band's new points as realtime deltas (after the current synchronous work). */
  onSample(studyId: string, candidateId: number): void {
    this.bandPending.add(candidateId);
    if (this.bandScheduled) return;
    this.bandScheduled = true;
    queueMicrotask(() => {
      this.bandScheduled = false;
      const ids = [...this.bandPending];
      this.bandPending.clear();
      for (const id of ids) {
        try {
          this.pushBand(studyId, id);
        } catch (e) {
          if (!this.ctx.disposed) this.ctx.bb.log("warn", `live band c#${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
  }

  private pushBand(studyId: string, candidateId: number): void {
    const { store } = this.ctx;
    const c = store.candidate(candidateId);
    const study = c ? store.study(c.study_id) : undefined;
    if (!c || !study) return;
    const b = this.band(c, study);
    if (!b || b.kind !== "noisy") return;
    const run = b.runs.at(-1);
    const p = run?.points.at(-1);
    if (!run || !p) return;
    const mark = `${b.startedAt}:${run.run}:${p.n}`;
    if (this.bandPushed.get(candidateId) === mark) return;
    this.bandPushed.set(candidateId, mark);
    this.bus.push(studyId, { k: "band", id: store.lastStudyEventId(studyId), t: p.at, c: c.n, run: run.run, p });
  }

  /** A measurement ended: keep its band with the candidate, with the verdict's guardrail checks (views and replay read it). */
  storeBand(candidateId: number): void {
    const { store } = this.ctx;
    const c = store.candidate(candidateId);
    const study = c ? store.study(c.study_id) : undefined;
    if (!c || !study) return;
    const b = this.band(c, study);
    if (!b) return;
    const final = finalOf(c, this.ctx.now());
    store.updateCandidate(c.id, { band_json: JSON.stringify({ ...b, final }) });
    this.bands.delete(c.id);
    this.bandPushed.delete(c.id);
  }

  /**
   * A candidate's band for its detail page: the stored band once measured
   * (or recomputed for measurements from before bands were stored), the live
   * one while it is on the bench, null before its first sample.
   */
  bandFor(c: CandidateRow, study: StudyRow): MeasureBand | null {
    if (c.stage === "decided" || (c.stage === "promoting" && c.band_json)) return storedBand(this, this.ctx, study, c);
    if (c.stage === "measuring" || c.stage === "confirming" || c.stage === "promoting") return this.band(c, study);
    return null;
  }

  dispose(): void {
    this.unsubscribe();
    this.bus.dispose();
    for (const t of this.dwellTimers.values()) clearTimeout(t);
    this.dwellTimers.clear();
    this.bands.clear();
    this.bandPending.clear();
  }
}

/** The band's inputs for a candidate: the spec's protocol, the host's MDE and noise, the guardrails and best's position. */
export function bandInput(ctx: Ctx, study: StudyRow, c: CandidateRow): BandInput | null {
  const { store } = ctx;
  let spec: StudySpec;
  try {
    spec = store.spec(study);
  } catch {
    return null;
  }
  const host = c.bench_host_id ? store.benchHost(study.id, c.bench_host_id) : undefined;
  const metrics = safeJson<{ mde?: number; guardrailJudgement?: Record<string, GuardrailJudgement> }>(c.metrics_json);
  const decided = c.stage === "decided" || c.stage === "promoting";
  const prior = decided ? null : bestGuardrailPositions(store, study, spec);
  return {
    kind: spec.oracle.noise,
    candidate: c.id,
    n: c.n,
    metric: { name: spec.metric.name, direction: spec.metric.direction },
    protocol: spec.oracle.protocol,
    guardrails: spec.guardrail.map((g) => ({
      name: g.name,
      direction: g.direction,
      limit: g.max_regression,
      totalLimit: g.max_total_regression ?? g.max_regression,
      prior: decided ? (metrics?.guardrailJudgement?.[g.name]?.prior ?? null) : (prior?.[g.name] ?? null),
    })),
    mde: decided && typeof metrics?.mde === "number" ? metrics.mde : host ? measurementMde(store, study, spec, host) : spec.oracle.protocol.min_effect,
    noiseFloor: host ? measurementNoise(store, study, host) : null,
  };
}

/** The verdict's guardrail checks, from a measured candidate's metrics. */
function finalOf(c: CandidateRow, at: number): MeasureBand["final"] {
  const j = safeJson<{ guardrailJudgement?: Record<string, GuardrailJudgement> }>(c.metrics_json)?.guardrailJudgement ?? {};
  return { at, guardrails: Object.values(j).map((g) => ({ name: g.name, state: g.state, step: g.step, total: g.total, final: true })) };
}

/** A decided candidate's stored band, or one recomputed from its samples (measurements from before bands were stored: not exact). */
function storedBand(recorder: LiveRecorder, ctx: Ctx, study: StudyRow, c: CandidateRow): MeasureBand | null {
  const stored = safeJson<MeasureBand>(c.band_json);
  if (stored) return stored;
  const hit = recorder.legacy.get(c.id);
  if (hit && hit.at === c.decided_at) return hit.band;
  const input = bandInput(ctx, study, c);
  if (!input || !ctx.store.sampleCount(c.id)) return null;
  const b = buildBand(ctx.store.samples(c.id), { ...input, exact: false });
  const band = { ...b, final: finalOf(c, c.decided_at ?? c.submitted_at) };
  recorder.legacy.set(c.id, { at: c.decided_at, band });
  return band;
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
  "gate.started",
  "gate.finished",
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

export const FEED_LIMIT = 40;
export const RECENT_DECIDED = 8;
export const NEXT_IDEAS = 6;
export const LIVE_WORKER_STATE_LIST = LIVE_WORKER_STATES;

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
  // Lanes link to candidates through the plugin's own worker row; the BB thread id is the fallback.
  const workerKeyOf = (c: CandidateRow): number | null => c.worker_id ?? (c.thread_id ? (workerKeyByThread.get(c.thread_id) ?? null) : null);

  const queuedRows = store.candidates(s.id, { stages: ["queued"] }).sort((a, b) => (a.queued_at ?? 0) - (b.queued_at ?? 0) || a.id - b.id);
  const inFlight = store.candidates(s.id, { stages: ["submitted", "gating", "queued", "measuring", "confirming", "promoting"] });
  const testing = gatesOnBench(engine, s);
  // Single-machine mode: candidates waiting to test share the bench queue, in its order (oldest first).
  const sm = spec ? singleMachineView(engine, s) : null;
  const waitingTests = sm?.serialized ? inFlight.filter((c) => c.stage === "gating" && !testing.some((g) => g.candidateId === c.id)) : [];
  const benchQueue = benchQueueOrder([...waitingTests, ...queuedRows].map((c) => ({ id: c.id, n: c.n, stage: c.stage, queuedAt: c.queued_at, submittedAt: c.submitted_at })));
  const queueNs = benchQueue.map((c) => c.n);
  const decided = store.decided(s.id, RECENT_DECIDED);

  // CI bands: measurements on the bench (from samples, incrementally) and ones that just ended (stored with the candidate).
  const bands: MeasureBand[] = [];
  const bandOf = new Map<number, MeasureBand>();
  for (const c of [...inFlight, ...decided]) {
    if (!bandShown(c.stage, c.decided_at, now) || bandOf.has(c.id)) continue;
    const b = c.stage === "decided" || (c.stage === "promoting" && c.band_json) ? storedBand(engine.live, engine.ctx, s, c) : engine.live.band(c, s);
    if (b) {
      bands.push(b);
      bandOf.set(c.id, b);
    }
  }

  const card = (c: CandidateRow): LiveCard => ({
    n: c.n,
    ideaId: c.idea_id,
    ideaTitle: c.idea_id !== null ? clip(ideas.get(c.idea_id)?.title ?? "", 120) : clip(c.summary.split("\n")[0] ?? "", 120),
    workerKey: workerKeyOf(c),
    stage: c.stage,
    column: columnOf(c.stage, c.verdict),
    stageAt: stageAt.get(c.id) ?? (c.stage === "decided" ? (c.decided_at ?? c.submitted_at) : c.stage === "queued" ? (c.queued_at ?? c.submitted_at) : c.submitted_at),
    verdict: c.verdict,
    effect: c.effect,
    effectText: c.effect === null ? null : improvementText(c.effect, metric, { digits: 1, factor: false }),
    cause: c.stage === "decided" ? verdictCause(c.verdict, safeJson<string[]>(c.reasons_json)) : null,
    hostId: c.bench_host_id,
    pairs: mergeProgress(pairs.get(c.id) ?? null, c.stage === "decided" ? null : bandOf.get(c.id)),
    rebases: c.rebases,
    submittedAt: c.submitted_at,
    decidedAt: c.decided_at,
  });
  const cards = [...inFlight.map(card), ...decided.map(card)].sort((a, b) => a.n - b.n);
  const cardByN = new Map(cards.map((c) => [c.n, c] as const));

  const workers: LiveWorker[] = threadsAll
    .filter((w) => (LIVE_WORKER_STATES as readonly string[]).includes(w.state))
    .map((w) => {
      const latest = store.workerCandidates(s.id, w, { order: "desc", limit: 1 })[0];
      const idea = w.idea_id !== null ? ideas.get(w.idea_id) : undefined;
      // The same position the Queue card and the bench strip show (1 = next for the bench).
      const qpos = latest?.stage === "queued" ? queuePosition(queueNs, latest.n) : null;
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
        action: w.action_recorded ? { label: w.action_recorded, at: w.action_recorded_at ?? w.spawned_at } : null,
      };
    });

  const measuringRows = store.candidates(s.id, { stages: ["measuring", "confirming", "promoting"] });
  const windowStart = now - UTILIZATION_WINDOW_S * 1000;
  const intervals = store.benchIntervals(s.id, { since: windowStart });
  const runningFrom = runningStart(store, s);
  const bench: LiveBenchHost[] = store.benchHosts(s.id).map((h) => {
    const m = measuringRows.find((c) => c.bench_host_id === h.host_id);
    const started = m ? lastAt(events, "measure.started", m.id) : null;
    const g = testing.find((x) => x.hostId === h.host_id);
    return {
      hostId: h.host_id,
      name: h.name,
      status: h.status,
      healthOk: h.health_ok === null ? null : h.health_ok === 1,
      healthRecord: spec && !spec.oracle.health.enabled ? ("off" as const) : null,
      deferredUntil: h.deferred_until !== null && h.deferred_until > now ? h.deferred_until : null,
      current: m
        ? { kind: "measure" as const, n: m.n, stage: m.stage, pairs: cardByN.get(m.n)?.pairs ?? null, startedAt: started ?? m.queued_at ?? m.submitted_at }
        : g
          ? { kind: "gate" as const, n: g.n, startedAt: g.startedAt }
          : h.drift_status === "running"
            ? { kind: "drift" as const, startedAt: lastHostAt(events, "drift.started", h.host_id) }
            : null,
      ...utilization(intervals.filter((i) => i.host_id === h.host_id).map((i) => ({ start: i.started_at, end: i.ended_at })), now, runningFrom),
    };
  });

  // Up next: the queue in the scheduler's own pick order (theme cap and no-repeat rule included).
  const w = s.target_workers ?? engine.maxWorkers(s);
  const order = upNext(store.ideas(s.id, ["queued"]), store.ideas(s.id, ["running"]), w, { lostTitles: new Set(store.ideas(s.id, ["lost"]).map((i) => titleKey(i.title))) });

  const wins = store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.effect !== null).sort((a, b) => (a.decided_at ?? 0) - (b.decided_at ?? 0) || a.id - b.id);
  const history = bestHistory(wins.map((c) => ({ n: c.n, at: c.decided_at ?? c.submitted_at, effect: c.effect! })), metric.direction);
  const bestRow = s.best_sha ? store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.promoted_sha === s.best_sha).at(-1) : undefined;
  const cum = engine.cumulative(s);
  const movedAt = [...events].reverse().find((e) => e.kind === "best.promoted")?.at ?? bestRow?.decided_at ?? null;
  const winnerKey = bestRow ? workerKeyOf(bestRow) : null;
  return {
    studyId: s.id,
    slug: s.slug,
    state: s.state,
    statusLine: statusLine(engine, s),
    metric,
    noise: spec?.oracle.noise ?? "noisy",
    now,
    lastEventId: store.lastStudyEventId(s.id),
    studyThreadId: s.study_thread_id,
    best: {
      text: cum === null ? null : improvementText(cum, metric),
      n: bestRow?.n ?? null,
      at: bestRow?.decided_at ?? null,
      value: cum,
      movedAt: bestRow ? movedAt : null,
      history,
      rebases: bestRow ? rebaseLanes(workers, winnerKey) : [],
    },
    counts: {
      candidates: store.candidateCount(s.id),
      maxCandidates: spec?.budget.max_candidates ?? 0,
      workers: workers.length,
      finishing: workers.filter((x) => x.phase === "finishing").length,
      targetWorkers: s.target_workers ?? engine.maxWorkers(s),
      queue: queuedRows.length,
    },
    workers,
    cards,
    queue: queueNs,
    queueTests: benchQueue.filter((c) => c.stage === "gating").map((c) => c.n),
    singleMachine: sm?.serialized ? { text: sm.text, quietBench: sm.quietBench } : null,
    bench,
    ideas: {
      next: order.slice(0, NEXT_IDEAS).map(({ idea: i, blocked }) => ({ id: i.id, title: clip(i.title, 160), theme: i.theme, pinned: i.pinned === 1, source: i.source, blocked })),
      total: order.length,
    },
    feed: feedItems(events, { metric, ideas, hostName: (id) => store.benchHost(s.id, id)?.name ?? id, candidateN: candidateNumbers(store, s.id), noise: spec?.oracle.noise ?? "noisy", gatesOnBench: Boolean(sm?.serialized) }).slice(-FEED_LIMIT),
    bands,
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

// ---------------------------------------------------------------- replay

/** Payload fields replay reads, per kind (everything else is dropped to keep the bundle small). */
function trimForReplay(kind: string, d: Record<string, unknown>): Record<string, unknown> {
  if (kind === "candidate.verdict") {
    const reasons = Array.isArray(d.reasons) && typeof d.reasons[0] === "string" ? [clip(d.reasons[0], 120)] : [];
    // Why it isn't the primary metric's verdict (a guardrail, the scope, a gate): the first reason alone doesn't say.
    const cause = verdictCause(typeof d.verdict === "string" ? d.verdict : null, d.reasons);
    return { candidate: d.candidate, n: d.n, verdict: d.verdict, effect: d.effect, reasons, ...(cause ? { cause } : {}) };
  }
  const keep = ["candidate", "n", "from", "to", "verdict", "worker", "thread", "idea", "candidate", "host", "of", "run", "pairs", "measure_pairs", "confirm_pairs", "seconds", "effect", "files", "label", "w", "worker_row", "priority", "pinned", "theme", "source", "segment", "ok", "decision"];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (d[k] !== undefined) out[k] = d[k];
  for (const k of ["reason", "title"]) if (typeof d[k] === "string") out[k] = clip(d[k] as string, 120);
  return out;
}

/**
 * Everything the app needs to replay a study: immutable metadata (ideas,
 * workers, candidates, bench hosts and their busy intervals), the event rows
 * replay reads (payloads trimmed) and every measurement's CI band. Read only.
 */
export function replayBundle(engine: Engine, s: StudyRow): ReplayBundle {
  const { store } = engine.ctx;
  const now = engine.ctx.now();
  let spec: StudySpec | null = null;
  try {
    spec = store.spec(s);
  } catch {
    spec = null;
  }
  const events = store.eventsAsc(s.id, { kinds: REPLAY_VIEW_KINDS, limit: 1_000_000 }).map((r) => {
    const e = rowToEvent(r);
    return { ...e, data: trimForReplay(e.kind, e.data) };
  });
  const ideas = store.ideas(s.id);
  const titles = new Map(ideas.map((i) => [i.id, i.title] as const));
  const candidates = store.candidates(s.id);
  const bands: MeasureBand[] = [];
  for (const c of candidates) {
    const b =
      c.stage === "decided" || (c.stage === "promoting" && c.band_json)
        ? storedBand(engine.live, engine.ctx, s, c)
        : c.stage === "measuring" || c.stage === "confirming" || c.stage === "promoting"
          ? engine.live.band(c, s)
          : null;
    if (b) bands.push(b);
  }
  return {
    studyId: s.id,
    slug: s.slug,
    metric: engine.metricInfo(s),
    state: s.state,
    studyThreadId: s.study_thread_id,
    start: events[0]?.at ?? s.created_at,
    // A running study's replay reaches now; any other ends with its last event (no idle tail).
    end: s.state === "running" ? now : (events.at(-1)?.at ?? now),
    now,
    spec: { maxCandidates: spec?.budget.max_candidates ?? 0, maxSubmissions: spec?.agents.max_submissions_per_worker ?? 0, maxWorkers: spec ? engine.maxWorkers(s) : 1, noise: spec?.oracle.noise ?? "noisy", healthChecks: spec ? spec.oracle.health.enabled : true },
    hosts: store.benchHosts(s.id).map((h) => ({ hostId: h.host_id, name: h.name })),
    ideas: ideas.map((i) => ({ id: i.id, title: i.title, theme: i.theme, source: i.source, variationOf: i.variation_of })),
    workers: store.threads(s.id, { role: "worker" }).map((w) => ({ key: w.id, threadId: w.thread_id, ideaId: w.idea_id, spawnedAt: w.spawned_at })),
    candidates: candidates.map((c) => ({ id: c.id, n: c.n, ideaId: c.idea_id, threadId: c.thread_id, workerKey: c.worker_id, title: c.idea_id !== null ? clip(titles.get(c.idea_id) ?? "", 120) : clip(c.summary.split("\n")[0] ?? "", 120) })),
    intervals: store.benchIntervals(s.id).map((i) => ({ hostId: i.host_id, start: i.started_at, end: i.ended_at })),
    singleMachine: (() => {
      const sm = spec ? singleMachineView(engine, s) : null;
      return sm?.serialized ? { text: sm.text, quietBench: sm.quietBench } : null;
    })(),
    events,
    bands,
  };
}
