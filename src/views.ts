// Read models for the study page, the thread header badge, and the CLI.
// Pure functions of the store (plus the engine's scheduler view), bounded.
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { Engine } from "./engine.ts";
import type { CandidateRow, ChangesetRow, HarvestRow, StudyRow, ThreadRow } from "./db/store.ts";
import type { StackRecord } from "./harvest.ts";
import { changeFrom, changeWords, checkLimit, headroomWords, rangeWords, type GuardrailCalibration, type Position, type StoredGuardrails } from "./guardrails.ts";
import { BENCH_BOUND_STAGES, bestGuardrailPositions, evalTimes, studySingleMachine } from "./pipeline.ts";
import { singleMachineText } from "./single-machine.ts";
import { benchQueueOrder, queuePosition } from "./live-model.ts";
import { clip, safeJson } from "./prompts.ts";
import { accountingFor, standaloneText } from "./report.ts";
import { oracleHash, type StudySpec } from "./spec.ts";
import { metricSnapshotOf, type MetricSnapshot } from "./snapshot.ts";
import {
  bestHeadlineText,
  reasonText,
  segmentRawText,
  ciText,
  compound,
  compoundOne,
  factorText,
  formatValue,
  improvementOf,
  improvementText,
  magnitudePct,
  rawChange,
  shareOfGain,
  sharePct,
  signedPct,
  amountText,
  isPointCi,
  noiseFloorText,
  runningStatusText,
  effectStatisticText,
  valueWithUnit,
  verdictCause,
  vsBaseFromVsBest,
  type Direction,
  type MetricInfo,
} from "./present.ts";

export interface StudySummary {
  slug: string;
  /** The BB project the study runs in (the new-study composer preselects the latest one). */
  projectId: string;
  state: string;
  pauseReason: string | null;
  metric: { name: string; unit: string; direction: "lower" | "higher" };
  bestVsBase: number | null;
  candidates: number;
  maxCandidates: number;
  benchSeconds: number;
  maxBenchHours: number;
  workers: number;
  targetWorkers: number;
  maxWorkers: number;
  maxWorkersOverride: number | null;
  benchDepth: number;
  /** Notices the human hasn't seen yet (audit-only control notices excluded). */
  unreadNotices: number;
  /** Items that need the human (approvals, system pauses, failed calibration, harvest ready). */
  needsYou: number;
  /** Best vs base in words ("74.7% fewer ops (3.9×)"), or a state line when there is no win. */
  headline: string;
  updatedAt: number;
}

function specOf(engine: Engine, s: StudyRow): StudySpec | null {
  try {
    return engine.ctx.store.spec(s);
  } catch {
    return null;
  }
}

export function studySummary(engine: Engine, s: StudyRow): StudySummary {
  const { store } = engine.ctx;
  const spec = specOf(engine, s);
  return {
    slug: s.slug,
    projectId: s.project_id,
    state: s.state,
    pauseReason: s.pause_reason,
    metric: { name: spec?.metric.name ?? "?", unit: spec?.metric.unit ?? "", direction: spec?.metric.direction ?? "lower" },
    bestVsBase: engine.cumulative(s),
    candidates: store.candidateCount(s.id),
    maxCandidates: spec?.budget.max_candidates ?? 0,
    benchSeconds: store.budget(s).bench_seconds,
    maxBenchHours: spec?.budget.max_bench_hours ?? 0,
    workers: store.threads(s.id, { role: "worker", states: ["spawning", "active", "finishing"] }).length,
    targetWorkers: s.target_workers ?? (spec ? engine.maxWorkers(s) : 0),
    maxWorkers: spec ? engine.maxWorkers(s) : 0,
    maxWorkersOverride: s.max_workers_override,
    benchDepth: engine.benchDepth(s.id),
    unreadNotices: unseenNotices(engine, s),
    needsYou: s.state === "archived" ? 0 : needsYou(engine, s).length,
    headline: headlineText(engine, s, spec),
    updatedAt: s.updated_at,
  };
}

function metricOf(spec: StudySpec | null): MetricInfo {
  return { name: spec?.metric.name ?? "metric", unit: spec?.metric.unit ?? "", direction: spec?.metric.direction ?? "lower" };
}

function headlineText(engine: Engine, s: StudyRow, spec: StudySpec | null): string {
  const cum = engine.cumulative(s);
  if (cum === null) return s.state === "draft" ? "not started" : s.state === "calibrating" ? "calibrating" : "no win yet";
  return bestHeadlineText(cum, metricOf(spec), segmentsSpanned(s));
}

/** How many segments best vs base spans (the headline compounds every promotion, whatever its segment). */
export function segmentsSpanned(s: Pick<StudyRow, "segment">): number {
  return Math.max(1, s.segment ?? 1);
}

/** Notices since the human last looked, without the audit trail of their own controls. */
function unseenNotices(engine: Engine, s: StudyRow): number {
  if (s.state === "archived") return 0;
  const row = engine.ctx.store.db
    .prepare(`SELECT COUNT(*) AS c FROM notices WHERE study_id = ? AND at > ? AND kind NOT LIKE 'control.%'`)
    .get(s.id, s.notices_seen_at ?? 0) as { c: number };
  return row.c;
}

/**
 * Single-machine mode for the page and the CLI: whether gates hold the bench
 * lock, why, and one paragraph saying what that does.
 */
export function singleMachineView(engine: Engine, s: StudyRow) {
  const spec = specOf(engine, s);
  if (!spec) return null;
  const mode = studySingleMachine(engine.ctx.store, s, spec);
  const host = s.host_id ? engine.ctx.store.benchHost(s.id, s.host_id) : undefined;
  return {
    on: mode.on,
    /** Gates hold the bench lock (on, and there are gates). */
    serialized: mode.on && spec.oracle.gate.length > 0 && s.host_id !== null,
    setting: mode.setting,
    reason: mode.reason,
    quietBench: spec.oracle.quiet_bench,
    hostName: host?.name ?? null,
    text: singleMachineText(mode, spec, host?.name ?? null),
  };
}

/** Candidates whose gates hold a bench lock now (single-machine mode), by host: open `gate` intervals. */
export function gatesOnBench(engine: Engine, s: StudyRow): Array<{ hostId: string; n: number; candidateId: number; startedAt: number }> {
  const { store } = engine.ctx;
  const out: Array<{ hostId: string; n: number; candidateId: number; startedAt: number }> = [];
  for (const i of store.benchIntervals(s.id, { since: engine.ctx.now() })) {
    if (i.kind !== "gate" || i.ended_at !== null || i.candidate_id === null) continue;
    const c = store.candidate(i.candidate_id);
    if (c) out.push({ hostId: i.host_id, n: c.n, candidateId: c.id, startedAt: i.started_at });
  }
  return out;
}

/**
 * A candidate's place in the shared bench queue (1 = next), the same order
 * the Live view's queue, lanes and cards show (live-model.ts benchQueueOrder):
 * queued candidates and, in single-machine mode, the ones waiting to test.
 */
export function benchQueuePosition(engine: Engine, s: StudyRow, n: number): number | null {
  const { store } = engine.ctx;
  const testing = gatesOnBench(engine, s);
  const serialized = Boolean(singleMachineView(engine, s)?.serialized);
  const rows = store.candidates(s.id, { stages: serialized ? ["gating", "queued"] : ["queued"] }).filter((c) => c.stage === "queued" || !testing.some((g) => g.candidateId === c.id));
  return queuePosition(benchQueueOrder(rows.map((c) => ({ id: c.id, n: c.n, queuedAt: c.queued_at, submittedAt: c.submitted_at }))).map((c) => c.n), n);
}

/** Running periods [start, end) from the append-only state log. */
export function runningPeriods(engine: Engine, s: StudyRow): Array<[number, number]> {
  const { store } = engine.ctx;
  const rows = store.db
    .prepare(`SELECT at, data_json FROM events WHERE study_id = ? AND kind = 'study.state' ORDER BY id`)
    .all(s.id) as Array<{ at: number; data_json: string }>;
  const out: Array<[number, number]> = [];
  let since: number | null = null;
  for (const r of rows) {
    const to = (safeJson<{ to?: string }>(r.data_json) ?? {}).to;
    if (to === "running" && since === null) since = r.at;
    else if (to !== "running" && since !== null) {
      out.push([since, r.at]);
      since = null;
    }
  }
  if (since !== null) out.push([since, engine.ctx.now()]);
  return out;
}

function overlap(a: [number, number], b: [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

export interface Utilization {
  /** Seconds the study was Running. */
  runningSeconds: number;
  /** Seconds the bench lock was held for this study while Running. */
  busySeconds: number;
  ratio: number | null;
  /** Busy share from the first submission to the last verdict (or now): excludes the first think time. */
  steadyRatio: number | null;
  /** Bench lock intervals (measurements, and gates in single-machine mode) that overlapped another on the same lock key (should be 0). */
  overlaps: number;
  /** Busy seconds spent gating (single-machine mode: gates hold the bench lock). */
  gateSeconds: number;
}

export function utilization(engine: Engine, s: StudyRow): Utilization {
  const { store } = engine.ctx;
  const periods = runningPeriods(engine, s);
  const now = engine.ctx.now();
  const intervals = store.benchIntervals(s.id).map((i) => ({ ...i, end: i.ended_at ?? now }));
  let busy = 0;
  let gateBusy = 0;
  for (const i of intervals) for (const p of periods) {
    const o = overlap([i.started_at, i.end], p);
    busy += o;
    if (i.kind === "gate") gateBusy += o;
  }
  const running = periods.reduce((a, p) => a + (p[1] - p[0]), 0);
  let overlaps = 0;
  const byKey = new Map<string, typeof intervals>();
  for (const i of intervals) byKey.set(i.lock_key, [...(byKey.get(i.lock_key) ?? []), i]);
  for (const list of byKey.values()) {
    list.sort((a, b) => a.started_at - b.started_at);
    for (let k = 1; k < list.length; k++) if (list[k]!.started_at < list[k - 1]!.end) overlaps += 1;
  }
  const cands = store.candidates(s.id);
  const first = cands[0]?.submitted_at ?? null;
  const lastDecided = Math.max(0, ...cands.map((c) => c.decided_at ?? 0));
  let steady: number | null = null;
  if (first !== null) {
    const pending = cands.some((c) => c.stage !== "decided");
    const window: [number, number] = [first, pending || !lastDecided ? now : lastDecided];
    let wRun = 0;
    let wBusy = 0;
    for (const p of periods) wRun += overlap(window, p);
    for (const i of intervals) for (const p of periods) {
      const clipped: [number, number] = [Math.max(p[0], window[0]), Math.min(p[1], window[1])];
      if (clipped[1] > clipped[0]) wBusy += overlap([i.started_at, i.end], clipped);
    }
    steady = wRun > 0 ? wBusy / wRun : null;
  }
  return { runningSeconds: running / 1000, busySeconds: busy / 1000, ratio: running > 0 ? busy / running : null, steadyRatio: steady, overlaps, gateSeconds: gateBusy / 1000 };
}

export interface TrajectoryPoint {
  n: number;
  verdict: string;
  /** Null for a verdict without a measurement (conflict, failed tests, rejected): the mark sits on the best line then. */
  effect: number | null;
  /** Where the candidate sat relative to base: best-at-measure-time compounded with its effect. */
  position: number;
  at: number;
}

export function trajectory(engine: Engine, s: StudyRow): { points: TrajectoryPoint[]; steps: Array<{ n: number; value: number }> } {
  const decided = engine.ctx.store.decided(s.id, 2000);
  const direction = metricOf(specOf(engine, s)).direction;
  let cum = 0;
  const points: TrajectoryPoint[] = [];
  const steps: Array<{ n: number; value: number }> = [{ n: 0, value: 0 }];
  for (const c of decided) {
    if (c.effect === null) {
      // Never measured (a conflict, failed tests, outside the scope): an "other verdict" mark on the best line at the time.
      points.push({ n: c.n, verdict: c.verdict ?? "?", effect: null, position: cum, at: c.decided_at ?? c.submitted_at });
      continue;
    }
    const position = compoundOne(cum, c.effect, direction);
    points.push({ n: c.n, verdict: c.verdict ?? "?", effect: c.effect, position, at: c.decided_at ?? c.submitted_at });
    if (c.verdict === "win") {
      cum = position;
      steps.push({ n: c.n, value: cum });
    }
  }
  return { points: points.slice(-1000), steps };
}

/** Best vs base with an approximate CI: the promoted effects' CI bounds compounded. */
export function bestCi(engine: Engine, s: StudyRow): { lo: number; hi: number } | null {
  const wins = engine.ctx.store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.effect !== null);
  if (!wins.length) return null;
  const direction = metricOf(specOf(engine, s)).direction;
  // Compounding is monotonic in each term, so the bounds compound to bounds.
  return { lo: compound(wins.map((w) => w.ci_lo ?? w.effect!), direction), hi: compound(wins.map((w) => w.ci_hi ?? w.effect!), direction) };
}

function workerPhase(engine: Engine, s: StudyRow, worker: ThreadRow): { phase: string; candidate: number | null; position: number | null } {
  const { store } = engine.ctx;
  // Linked through the worker row (a row may have no BB thread id); the thread id is the fallback.
  const mine = store.workerCandidates(s.id, worker).find((c) => c.stage !== "decided" || c.reported_at === null);
  if (!mine && !worker.thread_id) return { phase: "spawning", candidate: null, position: null };
  if (!mine) return { phase: "thinking", candidate: null, position: null };
  if (mine.stage === "queued") return { phase: "queued", candidate: mine.n, position: benchQueuePosition(engine, s, mine.n) };
  if (mine.stage === "gating" && gatesOnBench(engine, s).some((g) => g.candidateId === mine.id)) return { phase: "testing on the bench", candidate: mine.n, position: null };
  return { phase: mine.stage === "decided" ? "verdict pending delivery" : mine.stage, candidate: mine.n, position: null };
}

export function overview(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const spec = specOf(engine, s);
  const seg = store.segment(s.id, s.segment);
  const ideas = new Map(store.ideas(s.id).map((i) => [i.id, i] as const));
  const workers = store.threads(s.id, { role: "worker", states: ["spawning", "active", "finishing"] }).map((w) => {
    const phase = workerPhase(engine, s, w);
    return {
      threadId: w.thread_id,
      ideaId: w.idea_id,
      ideaTitle: w.idea_id !== null ? clip(ideas.get(w.idea_id)?.title ?? "", 160) : "",
      state: w.state,
      submissions: w.submissions,
      maxSubmissions: spec?.agents.max_submissions_per_worker ?? 0,
      phase: phase.phase,
      candidate: phase.candidate,
      queuePosition: phase.position,
      spawnedAt: w.spawned_at,
    };
  });
  const queue = store
    .candidates(s.id, { stages: [...BENCH_BOUND_STAGES, "promoting"] })
    .sort((a, b) => (a.queued_at ?? Number.MAX_SAFE_INTEGER) - (b.queued_at ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
    .map((c) => ({ n: c.n, stage: c.stage, ideaId: c.idea_id, queuedAt: c.queued_at, rebases: c.rebases }));
  const report = safeJson<{ report?: string; problems?: string[] }>(s.calibration_json);
  return {
    ...studySummary(engine, s),
    objective: spec?.study.objective ?? "",
    noise: spec?.oracle.noise ?? "noisy",
    projectId: s.project_id,
    studyThreadId: s.study_thread_id,
    specVersion: s.spec_version,
    calibration: {
      status: s.calibration_status,
      approved: s.calibration_approved_at !== null,
      mde: seg?.mde ?? null,
      noiseFloor: seg?.noise_floor ?? null,
      evalSeconds: seg?.eval_seconds ?? null,
      report: report?.report ?? null,
      problems: report?.problems ?? [],
    },
    baseSha: s.base_sha,
    /** The spec version an approval applies to (draft: the current one; mid-run: the pending one). */
    approvableSpecVersion: s.pending_spec_version ?? (s.state === "draft" ? s.spec_version : null),
    bestSha: s.best_sha,
    bestCi: bestCi(engine, s),
    utilization: utilization(engine, s),
    benchHosts: benchHostsView(engine, s),
    segment: segmentView(engine, s),
    tEval: engine.pipeline.recentEvalSeconds(s),
    /** T_eval's parts: gate and measurement seconds per candidate, and whether gates count (single-machine mode). */
    evalTimes: specOf(engine, s) ? evalTimes(store, s) : null,
    singleMachine: singleMachineView(engine, s),
    tThink: engine.thinkSeconds(s),
    trajectory: trajectory(engine, s),
    workerList: workers,
    queue,
    usage: usageView(engine, s),
    harvest: harvestSummary(engine, s),
    best: bestView(engine, s),
    needs: s.state === "archived" ? [] : needsYou(engine, s),
    status: statusLine(engine, s),
    secondary: secondaryMetricsView(engine, s),
    noticesSeenAt: s.notices_seen_at,
    notices: noticesView(engine, s, 30),
    events: store.events(s.id, { limit: 25 }).map((e) => ({ id: e.id, at: e.at, kind: e.kind, actor: clip(e.actor, 40), data: clip(e.data_json, 300) })),
  };
}

/**
 * Bench hosts for the study page and CLI: status, health, what it's
 * measuring, drift, cache, last bundle. No holdout data (agents can call RPC).
 */
export function benchHostsView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const spec = specOf(engine, s);
  const rows = store.benchHosts(s.id);
  const transfers = store.transfers(s.id, 200);
  const measuring = store.candidates(s.id, { stages: ["measuring", "confirming"] });
  const progress = engine.pipeline.progress(s.id);
  const gating = gatesOnBench(engine, s);
  return rows.map((h) => {
    const health = safeJson<{ summary?: string; problems?: string[] }>(h.health_json);
    const t = transfers.find((x) => x.host_id === h.host_id && x.ok);
    const sent = transfers.filter((x) => x.host_id === h.host_id && x.ok);
    return {
      hostId: h.host_id,
      name: h.name,
      mode: h.mode,
      status: h.status,
      healthOk: h.health_ok === null ? null : h.health_ok === 1,
      healthAt: h.health_at,
      healthSummary: health?.summary ?? null,
      problems: health?.problems ?? [],
      deferredUntil: h.deferred_until !== null && h.deferred_until > engine.ctx.now() ? h.deferred_until : null,
      offlineSince: h.offline_since,
      measuring: measuring.find((c) => c.bench_host_id === h.host_id)?.n ?? null,
      /** Single-machine mode: the candidate whose gates hold this host's bench lock now. */
      gating: gating.find((g) => g.hostId === h.host_id)?.n ?? null,
      progress: progress.find((p) => p.hostId === h.host_id)?.text ?? null,
      driftStatus: h.drift_status,
      driftAt: h.drift_at,
      evalsSinceDrift: h.evals_since_drift,
      driftEvery: spec?.oracle.drift.every ?? 0,
      bestBuildSha: h.best_build_sha,
      noiseFloor: h.noise_floor,
      mde: h.mde,
      /** noisy: runs of the measure command per side, and one run's seconds at calibration. */
      sideRuns: h.side_runs,
      runSeconds: h.run_seconds,
      repoPath: h.mode === "clone" ? h.repo_path : null,
      lastTransfer: t ? `${t.bytes} B (${t.purpose}, ${t.chunks} chunk${t.chunks === 1 ? "" : "s"})` : null,
      bundles: sent.length,
      bundleBytes: sent.reduce((a, x) => a + x.bytes, 0),
    };
  });
}

/** The active oracle segment and whether a pending spec changes it. */
export function segmentView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const seg = store.segment(s.id, s.segment);
  let pendingChangesOracle: boolean | null = null;
  if (s.pending_spec_version !== null) {
    try {
      pendingChangesOracle = oracleHash(store.specOfVersion(s.id, s.pending_spec_version)) !== oracleHash(store.spec(s));
    } catch {
      pendingChangesOracle = null;
    }
  }
  return {
    k: s.segment,
    count: store.segments(s.id).length,
    oracleHash: seg?.oracle_hash ?? null,
    specVersion: seg?.spec_version ?? null,
    baselineSha: seg?.baseline_sha ?? null,
    ref: s.segment > 0 ? `refs/studies/${s.slug}/segment/${s.segment}` : null,
    pendingSpecVersion: s.pending_spec_version,
    pendingChangesOracle,
  };
}

export type OverviewResult = ReturnType<typeof overview>;
export type IdeaView = ReturnType<typeof ideasView>[number];
export type CandidateView = ReturnType<typeof candidatesView>[number];
export type CandidateDetailView = NonNullable<Awaited<ReturnType<typeof candidateDetail>>>;

export function ideasView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const cands = store.candidates(s.id);
  const workers = store.threads(s.id, { role: "worker" });
  return store.ideas(s.id).slice(0, 500).map((i) => {
    const mine = cands.filter((c) => c.idea_id === i.id);
    const effects = mine.filter((c) => c.effect !== null).map((c) => c.effect!);
    const live = workers.filter((w) => w.idea_id === i.id && ["spawning", "active", "finishing"].includes(w.state));
    return {
      id: i.id,
      title: i.title,
      rationale: clip(i.rationale, 2000),
      theme: i.theme,
      source: i.source,
      priority: i.priority,
      pinned: i.pinned === 1,
      status: i.status,
      statusReason: i.status_reason,
      startRef: i.start_ref,
      variationOf: i.variation_of,
      candidates: mine.map((c) => c.n),
      bestEffect: effects.length ? Math.max(...effects) : null,
      workerThreadIds: [...new Set([...live, ...workers.filter((w) => w.idea_id === i.id)].map((w) => w.thread_id).filter((x): x is string => x !== null))].slice(0, 5),
      createdAt: i.created_at,
    };
  });
}

export function candidateRow(engine: Engine, c: CandidateRow, ideaTitle: string | null, spec: StudySpec | null = null) {
  const guardrails = c.effect !== null || c.metrics_json ? candidateGuardrails(spec, c.metrics_json) : [];
  const worst = worstGuardrail(guardrails);
  return {
    /** Guardrail summary for the row: worst state, and a text that carries it without color. */
    guardrails: {
      state: worst,
      text: worst === null ? (spec?.guardrail.length ? "not measured" : "none") : worst === "pass" ? `ok (${guardrails.length})` : guardrails.filter((g) => g.state === worst).map((g) => `${g.name} ${g.label}`).join(", "),
      list: guardrails,
    },
    effectText: c.effect === null ? null : improvementText(c.effect, metricOf(spec), { digits: 1, factor: false }),
    /** Why the verdict isn't the primary metric's own ("lost on guardrail mem_kb (27.6% worse)"); null when the primary metric decided it. */
    cause: c.stage === "decided" ? verdictCause(c.verdict, safeJson<string[]>(c.reasons_json)) : null,
    n: c.n,
    ideaId: c.idea_id,
    ideaTitle: ideaTitle ? clip(ideaTitle, 160) : null,
    stage: c.stage,
    verdict: c.verdict,
    effect: c.effect,
    ciLo: c.ci_lo,
    ciHi: c.ci_hi,
    threadId: c.thread_id,
    files: (safeJson<string[]>(c.changed_paths_json) ?? []).length,
    linesAdded: c.lines_added,
    linesDeleted: c.lines_deleted,
    rebases: c.rebases,
    benchSeconds: c.bench_seconds,
    benchHostId: c.bench_host_id,
    /** pass/fail only: holdout numbers never leave the plugin database. */
    holdout: c.holdout,
    summary: clip(c.summary.split("\n")[0] ?? "", 200),
    submittedAt: c.submitted_at,
    decidedAt: c.decided_at,
  };
}

export function candidatesView(engine: Engine, s: StudyRow, f: { verdict?: string; stage?: string; ideaId?: number; limit?: number }) {
  const { store } = engine.ctx;
  const titles = new Map(store.ideas(s.id).map((i) => [i.id, i.title] as const));
  const spec = specOf(engine, s);
  return store
    .candidates(s.id, { order: "desc" })
    .filter((c) => (!f.verdict || c.verdict === f.verdict) && (!f.stage || c.stage === f.stage) && (f.ideaId === undefined || c.idea_id === f.ideaId))
    .slice(0, Math.min(f.limit ?? 200, 500))
    .map((c) => candidateRow(engine, c, c.idea_id !== null ? (titles.get(c.idea_id) ?? null) : null, spec));
}

export async function candidateDetail(engine: Engine, s: StudyRow, n: number) {
  const { store } = engine.ctx;
  const c = store.candidateByN(s.id, n);
  if (!c) return null;
  const idea = c.idea_id !== null ? store.idea(c.idea_id) : undefined;
  let diff: { files: Array<{ path: string; added: number; deleted: number }>; patch: string; truncated: boolean; from: string; to: string } | null = null;
  let diffError: string | null = null;
  const from = c.prepared_sha && c.against_sha ? c.against_sha : c.parent_sha;
  const to = c.prepared_sha ?? c.sha;
  if (s.host_id && s.repo_path) {
    try {
      diff = { ...(await engine.ctx.bb.hostRunner(s.host_id).diffSummary(s.repo_path, from, to, 256 * 1024)), from, to };
    } catch (e) {
      diffError = clip(e instanceof Error ? e.message : String(e), 300);
    }
  }
  const samples = store.samples(c.id).slice(0, 4000);
  const spec = specOf(engine, s);
  return {
    ...candidateRow(engine, c, idea?.title ?? null, spec),
    /** Every recorded metric: primary, guardrails (limit and status), informational. */
    metricRows: metricsTable(spec, c.metrics_json),
    summaryFull: c.summary,
    sha: c.sha,
    preparedSha: c.prepared_sha,
    promotedSha: c.promoted_sha,
    againstSha: c.against_sha,
    ref: `refs/studies/${s.slug}/c/${c.n}`,
    /** The verdict's reasons in the page's format (older ones' raw "(CI 13.58%..21.99%, n=6)" rewritten). */
    reasons: (safeJson<string[]>(c.reasons_json) ?? []).map((r) => reasonText(r, spec?.oracle.noise ?? "noisy")),
    metrics: safeJson<Record<string, unknown>>(c.metrics_json),
    diag: (safeJson<string[]>(c.diag_json) ?? []).slice(0, 40),
    gateOutput: c.gate_output,
    changedPaths: (safeJson<string[]>(c.changed_paths_json) ?? []).slice(0, 200),
    samples,
    /** The oracle's noise class: how to read the samples (pairs, a single run, baseline and screening runs). */
    noise: spec?.oracle.noise ?? "noisy",
    /** Which statistic the headline improvement is (it can differ from the change between the medians in the metrics table). */
    effectStatistic: effectStatisticText(spec?.oracle.noise ?? "noisy"),
    /** How the verdict formed: the measurement's CI band (the Live view's), null before the first sample. */
    band: bandOrNull(engine, s, c),
    hostName: c.bench_host_id ? (store.benchHost(s.id, c.bench_host_id)?.name ?? null) : null,
    diff,
    diffError,
  };
}

function bandOrNull(engine: Engine, s: StudyRow, c: CandidateRow) {
  try {
    return engine.live.bandFor(c, s);
  } catch {
    return null;
  }
}

/** Header badge text for a study or worker thread; null for other threads. */
export function threadBadge(
  engine: Engine,
  threadId: string,
): { kind: "study" | "worker"; slug: string; state: string; text: string; tone: "running" | "paused" | "idle" | "attention"; needsYou: number; label: string } | null {
  const { store } = engine.ctx;
  const row = store.threadById(threadId);
  if (!row) return null;
  const s = store.study(row.study_id);
  if (!s) return null;
  const needs = s.state === "archived" ? [] : needsYou(engine, s);
  const tone = needs.length ? "attention" : s.state === "running" ? "running" : s.state === "paused" ? "paused" : "idle";
  if (row.role === "strategist") {
    const sum = studySummary(engine, s);
    const parts = [
      s.state === "running" ? null : s.state,
      sum.bestVsBase === null ? (s.state === "running" ? "no win yet" : null) : sum.headline,
      ["running", "paused", "harvesting"].includes(s.state) ? `${sum.workers} worker${sum.workers === 1 ? "" : "s"} · queue ${sum.benchDepth}` : null,
      needs.length ? `needs you: ${needs[0]!.short}${needs.length > 1 ? ` +${needs.length - 1}` : ""}` : null,
    ].filter(Boolean);
    const text = parts.join(" · ");
    return { kind: "study", slug: s.slug, state: s.state, tone, text, needsYou: needs.length, label: `Study ${s.slug}: ${text}` };
  }
  const spec = specOf(engine, s);
  const phase = workerPhase(engine, s, row);
  const where =
    phase.phase === "queued" && phase.position !== null ? `queued, ${ordinal(phase.position)} in line` : phase.phase === "thinking" ? (row.state === "active" ? "working" : row.state) : phase.phase;
  const text = `${s.slug} · idea #${row.idea_id ?? "?"} · submission ${row.submissions}/${spec?.agents.max_submissions_per_worker ?? "?"} · ${where}`;
  return { kind: "worker", slug: s.slug, state: s.state, tone: s.state === "running" ? "running" : s.state === "paused" ? "paused" : "idle", text, needsYou: 0, label: `Worker for study ${text}` };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// ------------------------------------------------------------------ M3

/** Provider limits, tokens, and spend projection for the Overview. */
export function usageView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const spec = specOf(engine, s);
  const u = engine.usageState(s);
  const tokens = store.studyTokens(s.id);
  const wins = store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win").length;
  const seg = store.segment(s.id, s.segment);
  const remaining = spec ? Math.max(0, spec.budget.max_candidates - store.candidateCount(s.id)) : 0;
  return {
    rateLimited: u.blocked,
    rateLimitedUntil: u.blockedUntil,
    tight: u.tight,
    maxPercent: u.maxPercent,
    tightPercent: spec?.agents.usage_tight_percent ?? 90,
    providers: u.providers,
    checkedAt: u.checkedAt,
    tokens,
    maxTokens: spec?.budget.max_tokens ?? null,
    tokensPerWin: tokens !== null && wins > 0 ? Math.round(tokens / wins) : null,
    /** Bench seconds the remaining candidate budget would take at the calibrated cost per evaluation. */
    projectedBenchSeconds: seg?.eval_seconds ? seg.eval_seconds * remaining : null,
    budgetNotices: safeJson<string[]>(s.budget_notices_json) ?? [],
  };
}

/** "No theme" filter value for findings whose idea has none (or that aren't tied to an idea). */
export const NO_THEME = "__none__";

/** Findings tab: searchable list with idea, theme, and candidate verdict; facets with counts; paged. */
export function findingsView(engine: Engine, s: StudyRow, q: { query?: string; outcome?: string; theme?: string; verdict?: string; limit?: number; offset?: number }) {
  const { store } = engine.ctx;
  const params: unknown[] = [s.id];
  const where = [`f.study_id = ?`];
  // A finding's idea is its own, else its candidate's idea.
  const from = `FROM findings f LEFT JOIN candidates c ON c.id = f.candidate_id LEFT JOIN ideas i ON i.id = COALESCE(f.idea_id, c.idea_id)`;
  if (q.query) {
    const like = `%${q.query.replace(/[%_]/gu, "")}%`;
    where.push(`(f.learned LIKE ? OR f.revisit_if LIKE ? OR f.evidence LIKE ? OR i.title LIKE ? OR c.summary LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  if (q.outcome) {
    where.push(`f.outcome = ?`);
    params.push(q.outcome);
  }
  if (q.theme === NO_THEME) where.push(`COALESCE(i.theme, '') = ''`);
  else if (q.theme) {
    where.push(`i.theme = ?`);
    params.push(q.theme);
  }
  if (q.verdict === "none") where.push(`c.verdict IS NULL`);
  else if (q.verdict) {
    where.push(`c.verdict = ?`);
    params.push(q.verdict);
  }
  const limit = Math.min(q.limit ?? 50, 500);
  const offset = Math.max(0, Math.min(q.offset ?? 0, 100_000));
  const matching = (store.db.prepare(`SELECT COUNT(*) AS c ${from} WHERE ${where.join(" AND ")}`).get(...params) as { c: number }).c;
  const rows = store.db
    .prepare(`SELECT f.*, COALESCE(f.idea_id, c.idea_id) AS any_idea, i.title AS idea_title, i.theme AS theme, c.n AS n, c.verdict AS verdict, c.effect AS effect, c.reasons_json AS reasons_json ${from} WHERE ${where.join(" AND ")} ORDER BY f.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<{ id: number; idea_id: number | null; any_idea: number | null; thread_id: string | null; outcome: string; learned: string; revisit_if: string; evidence: string; created_at: number; idea_title: string | null; theme: string | null; n: number | null; verdict: string | null; effect: number | null; reasons_json: string | null }>;
  const facet = (sql: string) => (store.db.prepare(sql).all(s.id) as Array<{ k: string | null; c: number }>).map((r) => ({ value: r.k ?? "", count: r.c }));
  const themes = facet(`SELECT COALESCE(NULLIF(i.theme, ''), '${NO_THEME}') AS k, COUNT(*) AS c ${from} WHERE f.study_id = ? GROUP BY k ORDER BY c DESC`);
  const metric = metricOf(specOf(engine, s));
  return {
    total: (store.db.prepare(`SELECT COUNT(*) AS c FROM findings WHERE study_id = ?`).get(s.id) as { c: number }).c,
    matching,
    offset,
    limit,
    outcomes: facet(`SELECT outcome AS k, COUNT(*) AS c FROM findings WHERE study_id = ? GROUP BY outcome ORDER BY c DESC`).filter((o) => o.value),
    themes: themes.map((t) => ({ ...t, label: t.value === NO_THEME ? "no theme" : t.value })),
    verdicts: facet(`SELECT COALESCE(c.verdict, 'none') AS k, COUNT(*) AS c ${from} WHERE f.study_id = ? GROUP BY k ORDER BY c DESC`).map((v) => ({ ...v, label: v.value === "none" ? "no candidate" : v.value })),
    findings: rows.map((f) => ({
      id: f.id,
      ideaId: f.any_idea,
      ideaTitle: f.idea_title ? clip(f.idea_title, 200) : null,
      theme: f.theme || null,
      candidate: f.n,
      verdict: f.verdict,
      effect: f.effect,
      effectText: f.effect === null ? null : improvementText(f.effect, metric, { factor: false }),
      /** Why the candidate's verdict isn't the primary metric's own ("lost on guardrail rss (30.0% worse)"). */
      cause: verdictCause(f.verdict, safeJson<string[]>(f.reasons_json)),
      threadId: f.thread_id,
      outcome: f.outcome,
      learned: clip(f.learned, 4000),
      revisitIf: clip(f.revisit_if, 1000),
      evidence: clip(f.evidence, 2000),
      createdAt: f.created_at,
    })),
  };
}

/**
 * The spec as TOML with the holdout section removed: RPC is reachable by
 * agents, and the holdout command must never enter agent context.
 */
export function redactedSpecToml(toml: string): { toml: string; holdout: boolean } {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(toml) as Record<string, unknown>;
  } catch {
    return { toml: "(unparseable spec)", holdout: false };
  }
  const oracle = raw.oracle as Record<string, unknown> | undefined;
  const holdout = Boolean(oracle && "holdout" in oracle);
  if (oracle && holdout) delete oracle.holdout;
  const text = stringifyToml(raw);
  return { toml: holdout ? `# [oracle.holdout] is configured and hidden here: agents can read this view.\n${text}` : text, holdout };
}

function lineDiff(a: string, b: string): Array<{ op: "same" | "add" | "del"; text: string }> {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  if (n * m > 400_000) return [...x.map((t) => ({ op: "del" as const, text: t })), ...y.map((t) => ({ op: "add" as const, text: t }))];
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<{ op: "same" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: "same", text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "del", text: x[i++]! });
    else out.push({ op: "add", text: y[j++]! });
  }
  while (i < n) out.push({ op: "del", text: x[i++]! });
  while (j < m) out.push({ op: "add", text: y[j++]! });
  return out;
}

/** A number, or null when it is missing or not finite (imported studies have no A/A noise floor). */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Calibrated guardrail noise as table rows (Oracle tab, CLI, report). */
export function guardrailCalibrationRows(list: readonly GuardrailCalibration[]) {
  return list.map((g) => ({ name: g.name, noise: g.noise, halfWidth: g.halfWidth, limit: g.limit, totalLimit: g.totalLimit, judgeable: g.judgeable, text: g.text }));
}

/** Oracle tab: the active spec (holdout hidden), version history, segments, calibration reports, and a pending spec with its diff. Approval stays CLI-only. */
export function oracleView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const versions = store.specVersions(s.id);
  const activeRow = versions.find((v) => v.version === s.spec_version) ?? null;
  const active = activeRow ? redactedSpecToml(activeRow.spec_toml) : null;
  const pendingRow = s.pending_spec_version !== null ? (versions.find((v) => v.version === s.pending_spec_version) ?? null) : null;
  let pending = null as null | { version: number; oracleHash: string; changesOracle: boolean; action: { kind: "approve_spec"; version: number; changesOracle: boolean }; command: string; toml: string; diff: Array<{ op: "same" | "add" | "del"; text: string }> };
  if (pendingRow && activeRow) {
    const changes = pendingRow.oracle_hash !== activeRow.oracle_hash;
    const p = redactedSpecToml(pendingRow.spec_toml);
    pending = {
      version: pendingRow.version,
      oracleHash: pendingRow.oracle_hash,
      changesOracle: changes,
      action: { kind: "approve_spec", version: pendingRow.version, changesOracle: changes } as const,
      command: changes ? `bb study calibrate ${s.slug}` : `bb study approve ${s.slug}`,
      toml: p.toml,
      diff: lineDiff(active!.toml, p.toml).slice(0, 2000),
    };
  }
  const report = safeJson<{ ok?: boolean; report?: string; problems?: string[]; warnings?: string[]; guardrails?: GuardrailCalibration[]; baselineSha?: string; oracleHash?: string; hosts?: Array<{ name: string; noiseFloor: number | null; mde: number; evalSeconds: number; report: string }>; finishedAt?: number }>(s.calibration_json);
  const spec = specOf(engine, s);
  return {
    slug: s.slug,
    state: s.state,
    specVersion: s.spec_version,
    activeToml: active?.toml ?? null,
    holdoutConfigured: active?.holdout ?? false,
    versions: versions.map((v) => ({
      version: v.version,
      oracleHash: v.oracle_hash,
      createdAt: v.created_at,
      approvedAt: v.approved_at,
      active: v.version === s.spec_version,
      pending: v.version === s.pending_spec_version,
      benchHosts: (safeJson<Array<{ name: string; mode: string }>>(v.bench_json) ?? []).map((b) => `${b.name} (${b.mode})`),
    })),
    pending,
    singleMachine: singleMachineView(engine, s),
    calibration: {
      status: s.calibration_status,
      approved: s.calibration_approved_at !== null,
      ok: report?.ok ?? null,
      report: report?.report ?? null,
      problems: report?.problems ?? [],
      /** Don't fail calibration, but the human should know (a guardrail too noisy to be judged within its limit). */
      warnings: report?.warnings ?? [],
      /** Per guardrail: A/A noise, the CI half-width an evaluation gets, and whether it can be judged within its limit. */
      guardrails: guardrailCalibrationRows(report?.guardrails ?? []),
      baselineSha: report?.baselineSha ?? null,
      oracleHash: report?.oracleHash ?? null,
      hosts: (report?.hosts ?? []).map((h) => ({ name: h.name, noiseFloor: finiteOrNull(h.noiseFloor), mde: h.mde, evalSeconds: h.evalSeconds, report: clip(h.report, 600) })),
      finishedAt: report?.finishedAt ?? null,
      /** The oracle's noise class: the noise is per pair (noisy), the σ of one run (expensive), or none (deterministic: single runs against the tolerance). */
      noise: spec?.oracle.noise ?? "noisy",
      /** The calibrated noise in one sentence for the class; "not measured" without an A/A floor. */
      noiseText: noiseFloorText(spec?.oracle.noise ?? "noisy", (report?.hosts ?? []).map((h) => finiteOrNull(h.noiseFloor)), spec?.oracle.protocol.tolerance ?? 0),
      /** The command that approves what's waiting, if anything (the page has the same action as a button). */
      nextCommand: s.state === "draft" && s.calibration_status !== "running" ? `bb study calibrate ${s.slug}` : s.state === "calibrating" && s.calibration_status === "ready" && s.calibration_approved_at === null ? `bb study start ${s.slug}` : null,
      /** The in-app action for what's waiting: approve the draft spec (and calibrate), or approve the calibration (and start). */
      action:
        s.state === "draft" && s.calibration_status !== "running"
          ? ({ kind: "approve_spec", version: s.spec_version, changesOracle: false } as const)
          : s.state === "calibrating" && s.calibration_status === "ready" && s.calibration_approved_at === null
            ? ({ kind: "start" } as const)
            : null,
      /** The smallest change a win can show with confidence at n_max pairs (MDE plus the CI half-width), when the report has it. */
      detectable: (() => {
        const m = /Detects changes of ([\d.]+)%/u.exec(report?.report ?? "");
        return m ? Number(m[1]) / 100 : null;
      })(),
    },
    segments: store.segments(s.id).map((g) => ({
      k: g.k,
      active: g.k === s.segment && (s.calibration_approved_at !== null || store.hasRun(s.id)),
      awaitingApproval: g.k === s.segment && s.calibration_approved_at === null && s.state === "calibrating",
      oracleHash: g.oracle_hash,
      specVersion: g.spec_version,
      baselineSha: g.baseline_sha,
      noiseFloor: finiteOrNull(g.noise_floor),
      mde: g.mde,
      evalSeconds: g.eval_seconds,
      gateSeconds: g.gate_seconds,
      report: g.report ? clip(g.report, 1500) : null,
      hosts: (safeJson<{ hosts?: Array<{ name: string; noiseFloor: number | null; mde: number; evalSeconds: number; sideRuns?: number | null; runSeconds?: number | null }> }>(g.details_json)?.hosts ?? []).map((h) => ({ name: h.name, noiseFloor: finiteOrNull(h.noiseFloor), mde: h.mde, evalSeconds: h.evalSeconds, sideRuns: h.sideRuns ?? null, runSeconds: finiteOrNull(h.runSeconds) })),
      /** Started by an automatic recalibration (same oracle), and why. */
      auto: safeJson<{ auto?: boolean }>(g.details_json)?.auto === true,
      autoReason: safeJson<{ reason?: string }>(g.details_json)?.reason ?? null,
      guardrails: guardrailCalibrationRows(safeJson<{ guardrails?: GuardrailCalibration[] }>(g.details_json)?.guardrails ?? []),
      ref: `refs/studies/${s.slug}/segment/${g.k}`,
      createdAt: g.created_at,
    })),
    /** Approval is a human control, in the app or the CLI; both are audited the same way (see the threat model). */
    approvalVia: "app-or-cli" as const,
  };
}

/** Bench tab: machines, queue, health history, drift checks, bundle transfers, recent bench intervals. */
export function benchView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const titles = new Map(store.ideas(s.id).map((i) => [i.id, i.title] as const));
  const queue = store
    .candidates(s.id, { stages: [...BENCH_BOUND_STAGES, "promoting"] })
    .sort((a, b) => (a.queued_at ?? Number.MAX_SAFE_INTEGER) - (b.queued_at ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
    .map((c) => ({ n: c.n, stage: c.stage, ideaTitle: c.idea_id !== null ? clip(titles.get(c.idea_id) ?? "", 120) : null, queuedAt: c.queued_at, benchHostId: c.bench_host_id, benchHostName: c.bench_host_id ? (store.benchHosts(s.id, { all: true }).find((h) => h.host_id === c.bench_host_id)?.name ?? c.bench_host_id) : null, rebases: c.rebases }));
  const now = engine.ctx.now();
  const gateRuns = store.events(s.id, { kinds: ["gate.flaky", "gate.failed"], limit: 200 });
  const names = new Map(store.benchHosts(s.id, { all: true }).map((h) => [h.host_id, h.name] as const));
  const hostName = (id: string | null) => (id === null ? null : (names.get(id) ?? id));
  const seenHealth = new Set<string>();
  return {
    hosts: benchHostsView(engine, s),
    queue,
    utilization: utilization(engine, s),
    singleMachine: singleMachineView(engine, s),
    health: store.healthChecks(s.id, { limit: 100 }).map((h) => ({
      id: h.id,
      hostId: h.host_id,
      hostName: hostName(h.host_id),
      /** The newest check of its host (the list is newest first). */
      latest: !seenHealth.has(h.host_id) && Boolean(seenHealth.add(h.host_id)),
      at: h.at,
      context: h.context,
      ok: h.ok === 1,
      problems: safeJson<string[]>(h.problems_json) ?? [],
      summary: (() => {
        const r = safeJson<{ loadavg?: number[]; cpus?: number; topProcesses?: Array<{ command: string; cpu: number }> }>(h.report_json);
        return r ? `load ${(r.loadavg ?? []).map((v) => v.toFixed(2)).join("/")} on ${r.cpus ?? "?"} CPUs${r.topProcesses?.[0] ? ` · top ${r.topProcesses[0].command} ${r.topProcesses[0].cpu.toFixed(0)}%` : ""}` : "";
      })(),
    })),
    drift: store.driftChecks(s.id, 50).map((d) => ({ id: d.id, hostId: d.host_id, hostName: hostName(d.host_id), segment: d.segment, bestSha: d.best_sha, startedAt: d.started_at, finishedAt: d.finished_at, status: d.status, pairs: d.pairs, noise: d.noise, calibrated: d.calibrated, ratio: d.ratio })),
    transfers: store.transfers(s.id, 100).map((t) => ({ id: t.id, hostId: t.host_id, hostName: hostName(t.host_id), sha: t.sha, purpose: t.purpose, bytes: t.bytes, chunks: t.chunks, ms: t.ms, ok: t.ok === 1, error: t.error, at: t.at })),
    intervals: store
      .benchIntervals(s.id)
      .slice(-60)
      .reverse()
      .map((i) => ({ id: i.id, hostId: i.host_id, hostName: hostName(i.host_id), kind: i.kind, candidate: i.candidate_id !== null ? (store.candidate(i.candidate_id)?.n ?? null) : null, startedAt: i.started_at, seconds: ((i.ended_at ?? now) - i.started_at) / 1000, open: i.ended_at === null })),
    gates: { flaky: gateRuns.filter((e) => e.kind === "gate.flaky").length, failed: gateRuns.filter((e) => e.kind === "gate.failed").length },
  };
}

/** A relative-to-best estimate as a share of the base→best gain, in points of the headline, and in metric units. */
export function contributionView(e: { value: number | null; lo: number | null; hi: number | null }, total: number | null, vsBase: number | null, bestRaw: number | null, metric: MetricInfo) {
  if (e.value === null) return null;
  const share = shareOfGain(e.value, total);
  const lo = e.lo === null ? null : shareOfGain(e.lo, total);
  const hi = e.hi === null ? null : shareOfGain(e.hi, total);
  const points = share !== null && vsBase !== null ? share * vsBase : null;
  const units = bestRaw !== null ? e.value * Math.abs(bestRaw) : null;
  const shareCi = lo !== null && hi !== null ? `CI ${sharePct(Math.min(lo, hi), 1)} to ${sharePct(Math.max(lo, hi), 1)}` : "";
  return {
    share,
    shareLo: lo === null || hi === null ? null : Math.min(lo, hi),
    shareHi: lo === null || hi === null ? null : Math.max(lo, hi),
    /** Percentage points of the headline best-vs-base improvement. */
    points,
    /** The same amount in the metric's units (better is positive). */
    units,
    /** "81% of the gain (CI 80% to 82%)" */
    text: share === null ? "share unknown (total gain not measured)" : `${sharePct(share, 1)} of the gain${shareCi ? ` (${shareCi})` : ""}`,
    /** "81.3 of the 99.9 points · ≈ 171,000 fewer opcodes" */
    detail: [points !== null && vsBase !== null ? `${(points * 100).toFixed(1)} of the ${(vsBase * 100).toFixed(1)} points` : "", units !== null ? amountText(units, metric) : ""].filter(Boolean).join(" · "),
    /** The raw ablation number (relative to best), for the record. */
    vsBest: `${signedPct(e.value, 2)} vs best${e.lo !== null && e.hi !== null ? ` (${ciText(e.lo, e.hi, 2)})` : ""}`,
  };
}

function prBaseText(c: ChangesetRow, baseBranch: string): string {
  if (!c.pr_base || c.pr_base === "base") return `${baseBranch}, the study base`;
  return `stacked on ${c.pr_base}`;
}

/** Why a changeset is (or isn't) in a stack, in words. */
export function dependencyText(c: ChangesetRow, all: ChangesetRow[], baseBranch: string): string[] {
  const byId = (id: number) => all.find((x) => x.id === id);
  const neededBy = all.filter((o) => (safeJson<number[]>(o.depends_on_json) ?? []).includes(c.id));
  const deps = (safeJson<number[]>(c.depends_on_json) ?? []).map(byId).filter((x): x is ChangesetRow => Boolean(x));
  const list = (xs: ChangesetRow[]) => xs.map((x) => `#${x.k}`).join(", ").replace(/, ([^,]*)$/u, " and $1");
  const paths = /in (.+)$/u.exec(c.ablation_detail ?? "")?.[1];
  const out: string[] = [];
  if (neededBy.length) {
    if (c.ablation_status === "conflict") out.push(`Reverting this from best conflicts with ${list(neededBy)}${paths ? ` (in ${clip(paths, 120)})` : ""}, so it can't be measured alone: ${neededBy.length === 1 ? "that changeset builds" : "those changesets build"} on it.`);
    else if (c.ablation_status === "gate_failed") out.push(`Reverting this from best breaks the gates unless ${list(neededBy)} ${neededBy.length === 1 ? "is" : "are"} reverted too, so it can't be measured alone.`);
    else out.push(`${list(neededBy)} build${neededBy.length === 1 ? "s" : ""} on this one.`);
  }
  // Name what can't be reverted: "it" read as this changeset.
  if (deps.length) out.push(`Builds on ${list(deps)}: reverting ${list(deps)} from best fails while this changeset stays.`);
  if (c.stack !== null) {
    const members = all.filter((x) => x.stack === c.stack).sort((a, b) => a.k - b.k);
    out.push(`Ships in stack ${c.stack} (${members.map((m) => `#${m.k}`).join(" → ")})${c.pr_base && c.pr_base !== "base" ? `, as a PR stacked on ${c.pr_base}` : `, as the first PR, based on ${baseBranch}`}${c.contribution === null ? "; the stack's contribution is measured together" : ""}.`);
  } else if (!neededBy.length && !deps.length) out.push(`Independent: its PR is based on ${baseBranch} and can be reviewed and reverted alone.`);
  return out;
}

function changesetView(c: ChangesetRow, all: ChangesetRow[], ctx: { total: number | null; vsBase: number | null; bestRaw: number | null; metric: MetricInfo; baseBranch: string; publish: PublishedPrLite[] }) {
  const k = (id: number) => all.find((x) => x.id === id)?.k ?? null;
  const neededBy = all.filter((o) => (safeJson<number[]>(o.depends_on_json) ?? []).includes(c.id)).map((o) => o.k);
  const published = ctx.publish.find((p) => p.changesetId === c.id) ?? null;
  return {
    id: c.id,
    k: c.k,
    title: c.title,
    rationale: clip(c.rationale, 2000),
    candidates: safeJson<number[]>(c.candidates_json) ?? [],
    commits: safeJson<string[]>(c.commits_json) ?? [],
    paths: (safeJson<string[]>(c.paths_json) ?? []).slice(0, 100),
    ablation: { status: c.ablation_status, detail: c.ablation_detail, sha: c.ablation_sha, contribution: c.contribution, ciLo: c.ci_lo, ciHi: c.ci_hi, n: c.n },
    /** The contribution as a share of the base→best gain, in points and units (null when not measured alone). */
    contribution: contributionView({ value: c.contribution, lo: c.ci_lo, hi: c.ci_hi }, ctx.total, ctx.vsBase, ctx.bestRaw, ctx.metric),
    droppable: c.droppable === 1,
    /** The human's choice for this changeset; dropping is only possible when nothing builds on it. */
    choice: c.human_choice,
    canDrop: neededBy.length === 0,
    dependsOn: (safeJson<number[]>(c.depends_on_json) ?? []).map(k).filter((x): x is number => x !== null),
    neededBy,
    dependencyReason: c.dependency_reason,
    /** Dependencies and stack placement in words. */
    explanation: dependencyText(c, all, ctx.baseBranch),
    stack: c.stack,
    prBase: c.pr_base,
    prBaseText: prBaseText(c, ctx.baseBranch),
    standalone: {
      status: c.standalone_status,
      detail: c.standalone_detail,
      sha: c.standalone_sha,
      effect: c.standalone_effect,
      ciLo: c.standalone_ci_lo,
      ciHi: c.standalone_ci_hi,
      text: standaloneText(c),
      /** "gates pass · 30.7% fewer ops on main (CI …)" */
      summary:
        c.standalone_status === "pass"
          ? `gates pass${c.standalone_effect !== null ? ` · ${improvementText(c.standalone_effect, ctx.metric, { factor: false })} on its PR base${c.standalone_ci_lo !== null && c.standalone_ci_hi !== null ? ` (${ciText(c.standalone_ci_lo, c.standalone_ci_hi)})` : ""}` : " (effect not measured)"}`
          : c.standalone_status === "pending"
            ? "not checked yet"
            : `${c.standalone_status.replace(/_/gu, " ")}${c.standalone_detail ? `: ${clip(c.standalone_detail, 200)}` : ""}`,
    },
    pr: { branch: c.branch, title: c.pr_title, body: c.pr_body, url: c.pr_url ?? published?.url ?? null, status: c.pr_status, published },
  };
}

interface PublishedPrLite {
  changesetId: number;
  k: number;
  branch: string;
  baseBranch: string;
  status: string;
  url: string | null;
  detail: string | null;
}

function harvestSummary(engine: Engine, s: StudyRow) {
  const h = engine.ctx.store.latestHarvest(s.id);
  if (!h) return null;
  return { id: h.id, state: h.state, detail: h.phase_detail, changesets: engine.ctx.store.changesets(h.id).length, startedAt: h.started_at, finishedAt: h.finished_at, publishState: h.publish_state };
}

/** Harvest tab: the latest harvest's changesets, ablations, dependency stacks, PR drafts, accounting and publish state. */
export function harvestView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const spec = specOf(engine, s);
  const metric = metricOf(spec);
  const all = store.harvests(s.id);
  const h: HarvestRow | undefined = all[0];
  const canStartState = ["running", "paused"].includes(s.state) || (s.state === "harvesting" && (!h || ["ready", "failed", "cancelled"].includes(h.state)));
  const promotions = store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win").length;
  const canStart = canStartState && promotions > 0;
  const cannotStartReason = canStart
    ? null
    : promotions === 0
      ? "Nothing to harvest yet: no candidate has been promoted to best."
      : s.state === "harvesting"
        ? "A harvest is still running; wait for it to finish (or resume the study to cancel it)."
        : `Harvest starts from Running or Paused (the study is ${s.state}).`;
  const base = {
    slug: s.slug,
    state: s.state,
    promotions,
    canStart,
    cannotStartReason,
    startCommand: `bb study harvest ${s.slug}`,
    history: all.map((x) => ({ id: x.id, state: x.state, startedAt: x.started_at, finishedAt: x.finished_at, publishState: x.publish_state })),
  };
  if (!h) return { ...base, harvest: null };
  const cs = store.changesets(h.id);
  const stacks = safeJson<StackRecord[]>(h.stacks_json) ?? [];
  const acc = accountingFor(engine.ctx, h);
  const t = h.total_effect;
  const vsBase = vsBaseFromVsBest(t, metric.direction);
  const vsLo = vsBaseFromVsBest(h.total_ci_lo, metric.direction);
  const vsHi = vsBaseFromVsBest(h.total_ci_hi, metric.direction);
  const snap = metricSnapshot(engine, s);
  const bestRaw = snap.bestSha === h.best_sha ? (snap.best?.[metric.name] ?? null) : null;
  const baseRaw = snap.baseline?.[metric.name] ?? null;
  const publish = safeJson<{ mode?: string; exportDir?: string; prs?: PublishedPrLite[] }>(h.publish_json);
  const githubPrs = publish?.mode === "github" ? (publish.prs ?? []) : [];
  const ctx = { total: t, vsBase, bestRaw, metric, baseBranch: spec?.study.base ?? "main", publish: githubPrs };
  const share = (v: number | null) => (v === null || t === null || t === 0 ? null : v / t);
  return {
    ...base,
    harvest: {
      id: h.id,
      state: h.state,
      detail: h.phase_detail,
      error: h.error,
      fromState: h.from_state,
      baseSha: h.base_sha,
      bestSha: h.best_sha,
      groupingSource: h.grouping_source,
      groupingNotes: h.grouping_notes,
      measureStandalone: h.measure_standalone === 1,
      total: t === null ? null : { value: t, lo: h.total_ci_lo, hi: h.total_ci_hi, n: h.total_n, vsBase, vsBaseLo: vsLo, vsBaseHi: vsHi },
      /** The measured base→best improvement in words, as everywhere else on the page. */
      headline:
        vsBase === null
          ? null
          : {
              text: improvementText(vsBase, metric),
              ci: vsLo !== null && vsHi !== null ? ciText(vsLo, vsHi) : "",
              raw: rawChange(baseRaw, bestRaw, metric.unit),
              vsBest: `${signedPct(t, 2)} vs best`,
            },
      accounting: {
        sum: acc.sum,
        sumHalfWidth: acc.sumHalfWidth,
        gap: acc.gap,
        gapHalfWidth: acc.gapHalfWidth,
        interaction: acc.interaction,
        /** How far beyond the noise the gap is: "slight" (within 2× its CI half-width; common with small-sample bootstrap CIs) or "large". */
        severity: !acc.interaction ? ("none" as const) : acc.gap !== null && acc.gapHalfWidth !== null && Math.abs(acc.gap) <= 2 * acc.gapHalfWidth && !acc.missing.length ? ("slight" as const) : ("large" as const),
        missing: acc.missing,
        /** Shares of the gain: explained by the measured terms, and what is left. */
        explained: share(acc.sum),
        explainedHalfWidth: share(acc.sumHalfWidth),
        unexplained: share(acc.gap),
        unexplainedHalfWidth: share(acc.gapHalfWidth),
        items: acc.items.map((i) => ({ label: i.label, source: i.source, value: i.estimate?.value ?? null, lo: i.estimate?.lo ?? null, hi: i.estimate?.hi ?? null, share: share(i.estimate?.value ?? null) })),
      },
      changesets: cs.map((c) => changesetView(c, cs, ctx)),
      stacks: stacks.map((st) => ({
        stack: st.stack,
        members: st.members.map((id) => cs.find((c) => c.id === id)?.k ?? null).filter((x): x is number => x !== null),
        status: st.status,
        estimate: st.estimate,
        contribution: st.estimate ? contributionView(st.estimate, t, vsBase, bestRaw, metric) : null,
        detail: st.detail,
      })),
      publisher: h.publisher,
      publishState: h.publish_state,
      exportDir: h.export_dir,
      /** GitHub publish results per PR (URLs or errors), once a publish ran. */
      published: githubPrs.length ? githubPrs : null,
      canPublish: h.state === "ready" && h.publish_state !== "published" && h.publish_state !== "publishing",
      publishCommand: h.state === "ready" && h.publish_state !== "published" ? `bb study harvest ${s.slug} --publish` : null,
      benchSeconds: h.bench_seconds,
      startedAt: h.started_at,
      finishedAt: h.finished_at,
    },
  };
}

export type FindingsView = ReturnType<typeof findingsView>;
export type OracleView = ReturnType<typeof oracleView>;
export type BenchView = ReturnType<typeof benchView>;
export type HarvestView = ReturnType<typeof harvestView>;
export type UsageView = ReturnType<typeof usageView>;

// ------------------------------------------------------- human interface
//
// View models for the "what you see first" layer: best vs base in words,
// the Needs-you list, notices with the action they ask for, secondary
// metrics and guardrail status. Every number follows src/present.ts:
// better is positive, in the metric's own terms.

type Metrics = Record<string, number>;
interface CandidateMetrics extends StoredGuardrails {
  best?: Metrics;
  candidate?: Metrics;
}

/** Raw metric values of the active segment's baseline and of the current best (medians as measured). */
export function metricSnapshot(engine: Engine, s: StudyRow): MetricSnapshot {
  return metricSnapshotOf(engine.ctx.store, s);
}

export type GuardrailState = "pass" | "warn" | "inconclusive" | "broken" | "missing";

/** A regression with an optional CI against one limit. */
export interface GuardrailCheckInput {
  regression: number | null;
  lo?: number | null;
  hi?: number | null;
  limit: number | null;
}

export interface GuardrailInput {
  name: string;
  direction: Direction;
  /** Per step: the spec's max_regression (fraction, positive = worse allowed). */
  limit: number;
  /** In total against the segment base: the spec's max_total_regression (defaults to `limit`). */
  totalLimit?: number | null;
  /** Value of the reference side (best for a verdict, the segment base for the Overview). */
  reference: number | null;
  value: number | null;
  /** The regression the verdict computed (per-pair medians for noisy); preferred over the two values when present. */
  regression?: number | null;
  /**
   * What the numbers are against: "best" (a candidate's verdict: the step
   * limit applies to `regression`, the total limit to `cumulative`), or
   * "base" (the Overview: best's position against the segment base, judged
   * against the total limit).
   */
  against: "best" | "base";
  /** CI of `regression` (positive = worse). */
  ci?: { lo: number | null; hi: number | null } | null;
  /** "best": where best would stand against the segment base with this candidate, and the total limit. */
  cumulative?: GuardrailCheckInput | null;
}

export interface GuardrailCheck {
  regression: number;
  lo: number | null;
  hi: number | null;
  limit: number;
  /** regression / limit (null when no regression is allowed). */
  used: number | null;
  /** ok: the CI is within the limit; inconclusive: it straddles the limit; broken: it is entirely beyond. Without a CI, the point decides. */
  state: "ok" | "inconclusive" | "broken";
  /** Room left under the limit (limit − regression). */
  headroom: number;
}

export interface GuardrailStatus {
  name: string;
  direction: Direction;
  limit: number;
  totalLimit: number;
  /** Relative regression, positive = worse (null when not measured). */
  regression: number | null;
  /** The same change, better is positive. */
  improvement: number | null;
  /** How much of the binding limit is used (the larger of the step and total shares); null when not measured or no regression allowed. */
  used: number | null;
  state: GuardrailState;
  /** "ok", "near limit", "inconclusive", "BROKEN", "not measured": text that carries the state without color. */
  label: string;
  /** One sentence: "0.4% worse than best (limit 5.0% worse) · 3.1% worse than the segment base (total limit 10.0% worse)". */
  text: string;
  against: "best" | "base";
  ci: { lo: number; hi: number } | null;
  /** The check against the limit `regression` is judged on (the step for "best", the total for "base"). */
  check: GuardrailCheck | null;
  /** Against the segment base: for "best" where best would stand with this candidate; for "base" the same as `check`. */
  cumulative: GuardrailCheck | null;
}

/** Warn when a guardrail has used more than this share of its limit. */
export const GUARDRAIL_WARN_SHARE = 0.8;

const finiteNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

function guardrailCheck(regression: number, lo: number | null | undefined, hi: number | null | undefined, limit: number): GuardrailCheck {
  const c = checkLimit({ regression, lo: finiteNum(lo) ? lo : null, hi: finiteNum(hi) ? hi : null }, limit);
  const used = limit > 0 ? Math.max(0, regression) / limit : regression > 0 ? Infinity : 0;
  return { regression, lo: c.lo, hi: c.hi, limit, used: Number.isFinite(used) ? used : null, state: c.state, headroom: limit - regression };
}

/** "no change from best (limit 5.0% worse)", "3.1% worse than the segment base (CI …; total limit 10.0% worse)". */
function checkText(c: GuardrailCheck, against: string, limitWord: string): string {
  // The Live rows' rule (guardrails.ts changeWords): under 0.05% reads "no change", never "0.0% better".
  const change = changeFrom(c.regression, against);
  const ci = rangeWords(c.lo, c.hi);
  return `${change} (${ci ? `${ci}; ` : ""}${limitWord} ${magnitudePct(c.limit, 1)} worse)`;
}

/**
 * The one place the UI decides a guardrail's status: pass, warn (more than
 * 80% of a limit used), inconclusive (a CI straddles a limit: flagged, not a
 * rejection), broken (a CI entirely beyond a limit), or missing. It checks the
 * per-step limit and the cumulative limit against the segment base with the
 * same rule as the verdict (guardrails.ts), so components only display it.
 */
export function guardrailStatus(g: GuardrailInput): GuardrailStatus {
  const totalLimit = finiteNum(g.totalLimit) ? g.totalLimit : g.limit;
  const regression =
    finiteNum(g.regression)
      ? g.regression
      : g.reference !== null && g.value !== null
        ? (() => {
            const imp = improvementOf(g.reference, g.value, g.direction);
            return imp === null ? null : -imp;
          })()
        : null;
  const ci = g.ci && finiteNum(g.ci.lo) && finiteNum(g.ci.hi) && g.ci.lo !== g.ci.hi ? { lo: g.ci.lo, hi: g.ci.hi } : null;
  const common = { name: g.name, direction: g.direction, limit: g.limit, totalLimit, against: g.against, ci };
  if (regression === null) {
    const limitText = g.against === "base" ? `total limit ${magnitudePct(totalLimit, 1)} worse` : `limit ${magnitudePct(g.limit, 1)} worse`;
    return { ...common, regression: null, improvement: null, used: null, state: "missing", label: "not measured", text: `not measured (${limitText})`, check: null, cumulative: null };
  }
  let check: GuardrailCheck;
  let cumulative: GuardrailCheck | null = null;
  let text: string;
  if (g.against === "base") {
    check = guardrailCheck(regression, ci?.lo, ci?.hi, totalLimit);
    cumulative = check;
    text = `${checkText(check, "the segment base", "total limit")}${totalLimit !== g.limit ? ` · ${magnitudePct(g.limit, 1)} per step` : ""}`;
  } else {
    check = guardrailCheck(regression, ci?.lo, ci?.hi, g.limit);
    const cum = g.cumulative;
    if (cum && finiteNum(cum.regression)) cumulative = guardrailCheck(cum.regression, cum.lo, cum.hi, finiteNum(cum.limit) ? cum.limit : totalLimit);
    text = checkText(check, "best", "limit") + (cumulative ? ` · ${checkText(cumulative, "the segment base", "total limit")}` : "");
  }
  const checks = [check, ...(cumulative && cumulative !== check ? [cumulative] : [])];
  const usedList = checks.map((c) => c.used).filter((u): u is number => u !== null);
  const used = usedList.length ? Math.max(...usedList) : null;
  const state: GuardrailState = checks.some((c) => c.state === "broken")
    ? "broken"
    : checks.some((c) => c.state === "inconclusive")
      ? "inconclusive"
      : checks.some((c) => c.limit > 0 && (c.used ?? 0) > GUARDRAIL_WARN_SHARE) || checks.some((c) => c.limit === 0 && c.regression > 0)
        ? "warn"
        : "pass";
  // For a candidate, say when only the total against the segment base is what's broken or inconclusive.
  const onlyTotal = g.against === "best" && cumulative !== null && (state === "broken" || state === "inconclusive") && check.state !== state && cumulative.state === state;
  const label = (state === "broken" ? "BROKEN" : state === "inconclusive" ? "inconclusive" : state === "warn" ? "near limit" : "ok") + (onlyTotal ? " (total)" : "");
  return { ...common, regression, improvement: -regression, used, state, label, text, check, cumulative };
}

/** Worst state first. */
export function worstGuardrail(list: readonly GuardrailStatus[]): GuardrailState | null {
  if (!list.length) return null;
  for (const st of ["broken", "inconclusive", "warn", "missing", "pass"] as const) if (list.some((g) => g.state === st)) return st;
  return null;
}

export interface MetricRow {
  name: string;
  kind: "primary" | "guardrail" | "info";
  unit: string;
  direction: Direction | null;
  best: number | null;
  candidate: number | null;
  /** Better is positive (null for informational metrics, whose direction is unknown). */
  improvement: number | null;
  /** Raw relative change (candidate − best) / |best|, signed by value, for informational metrics. */
  change: number | null;
  text: string;
  guardrail: GuardrailStatus | null;
}

/** Every metric a candidate's measurement recorded: primary, guardrails, then informational ones. */
export function metricsTable(spec: StudySpec | null, metricsJson: string | null): MetricRow[] {
  const m = safeJson<CandidateMetrics>(metricsJson);
  if (!m?.best && !m?.candidate) return [];
  const best = m.best ?? {};
  const cand = m.candidate ?? {};
  const primary = metricOf(spec);
  const rows: MetricRow[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const p = { b: num(best[primary.name]), c: num(cand[primary.name]) };
  const imp = improvementOf(p.b, p.c, primary.direction);
  rows.push({ name: primary.name, kind: "primary", unit: primary.unit, direction: primary.direction, best: p.b, candidate: p.c, improvement: imp, change: null, text: imp === null ? "not measured" : improvementText(imp, primary, { digits: 2 }), guardrail: null });
  for (const g of spec?.guardrail ?? []) {
    const b = num(best[g.name]);
    const c = num(cand[g.name]);
    // The verdict's judgement (step CI, and where best would stand against the segment base) when it recorded one.
    const j = m.guardrailJudgement?.[g.name];
    const stored = m.guardrailCi?.[g.name];
    const st = guardrailStatus({
      name: g.name,
      direction: g.direction,
      limit: j?.step?.limit ?? g.max_regression,
      totalLimit: j?.total?.limit ?? g.max_total_regression,
      reference: b,
      value: c,
      regression: m.guardrails?.[g.name] ?? null,
      against: "best",
      ci: j?.step ? { lo: j.step.lo, hi: j.step.hi } : stored ? { lo: stored.lo, hi: stored.hi } : null,
      cumulative: j?.total ? { regression: j.total.regression, lo: j.total.lo, hi: j.total.hi, limit: j.total.limit } : null,
    });
    rows.push({ name: g.name, kind: "guardrail", unit: "", direction: g.direction, best: b, candidate: c, improvement: st.improvement, change: null, text: st.text, guardrail: st });
  }
  const known = new Set([primary.name, ...(spec?.guardrail ?? []).map((g) => g.name)]);
  for (const name of [...new Set([...Object.keys(best), ...Object.keys(cand)])].filter((k) => !known.has(k)).sort().slice(0, 40)) {
    const b = num(best[name]);
    const c = num(cand[name]);
    const change = b !== null && c !== null && b !== 0 ? (c - b) / Math.abs(b) : null;
    rows.push({ name, kind: "info", unit: "", direction: null, best: b, candidate: c, improvement: null, change, text: change === null ? "—" : `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)}% (informational, no direction)`, guardrail: null });
  }
  return rows;
}

/** Guardrail statuses of one candidate, from its verdict's recorded regressions. */
export function candidateGuardrails(spec: StudySpec | null, metricsJson: string | null): GuardrailStatus[] {
  return metricsTable(spec, metricsJson)
    .map((r) => r.guardrail)
    .filter((g): g is GuardrailStatus => g !== null);
}

/**
 * Overview: secondary metrics of best against the segment base. Guardrails
 * get best's cumulative position against the total limit: the promotion
 * chain's per-step estimates compounded, with a CI (the same position the
 * next verdict compounds onto), plus the worst single step and the value of
 * best after each promotion for a small trend line. Raw values are shown
 * next to it; they are medians measured at different times, so the position
 * comes from the paired per-step estimates instead.
 */
export function secondaryMetricsView(engine: Engine, s: StudyRow) {
  const spec = specOf(engine, s);
  const snap = metricSnapshot(engine, s);
  const decided = engine.ctx.store.decided(s.id, 2000);
  const wins = decided.filter((c) => c.verdict === "win");
  const trend = (name: string): Array<{ n: number; value: number }> => {
    const out: Array<{ n: number; value: number }> = [];
    const first = snap.baseline?.[name];
    if (typeof first === "number") out.push({ n: 0, value: first });
    for (const w of wins) {
      const v = safeJson<CandidateMetrics>(w.metrics_json)?.candidate?.[name];
      if (typeof v === "number" && Number.isFinite(v)) out.push({ n: w.n, value: v });
    }
    return out.slice(-200);
  };
  const positions: Record<string, Position> = spec ? bestGuardrailPositions(engine.ctx.store, s, spec) : {};
  const guardrails = (spec?.guardrail ?? []).map((g) => {
    const base = snap.baseline?.[g.name] ?? null;
    const best = snap.best?.[g.name] ?? null;
    // Per-promotion regressions as the verdicts recorded them (the limit each promotion was held to).
    const steps = wins.map((w) => ({ n: w.n, regression: safeJson<CandidateMetrics>(w.metrics_json)?.guardrails?.[g.name] ?? null }));
    const worstStep = steps.reduce<number | null>((a, x) => (x.regression === null ? a : a === null ? x.regression : Math.max(a, x.regression)), null);
    const pos = positions[g.name];
    // No recorded estimate on any promotion (older data): fall back to the raw values.
    const usable = pos && Number.isFinite(pos.regression) && (pos.steps > 0 || !pos.missing);
    const totalLimit = g.max_total_regression ?? g.max_regression;
    return {
      ...guardrailStatus({
        name: g.name,
        direction: g.direction,
        limit: g.max_regression,
        totalLimit,
        reference: base,
        value: best,
        regression: usable ? pos.regression : null,
        ci: usable && pos.lo !== null && pos.hi !== null ? { lo: pos.lo, hi: pos.hi } : null,
        against: "base",
      }),
      base,
      best,
      raw: rawChange(base, best, ""),
      /** Promotions compounded into the position (and how many lacked an estimate). */
      promotions: pos?.steps ?? 0,
      missingSteps: pos?.missing ?? 0,
      /** Remaining room under the total limit, in words. */
      headroomText: headroomWords(g.name, usable ? pos : null, totalLimit),
      /** Worst regression any single promotion had against the best before it. */
      worstStep,
      /** "worst single promotion 1.2% worse", "worst single promotion: no change" (null without promotions). */
      worstStepText: worstStep === null ? null : changeWords(worstStep) === "no change" ? "worst single promotion: no change" : `worst single promotion ${changeWords(worstStep)}`,
      trend: trend(g.name),
    };
  });
  const known = new Set([spec?.metric.name ?? "", ...(spec?.guardrail ?? []).map((g) => g.name)]);
  const names = [...new Set([...Object.keys(snap.baseline ?? {}), ...Object.keys(snap.best ?? {})])].filter((k) => !known.has(k)).sort().slice(0, 40);
  const info = names.map((name) => {
    const base = snap.baseline?.[name] ?? null;
    const best = snap.best?.[name] ?? null;
    const change = base !== null && best !== null && base !== 0 ? (best - base) / Math.abs(base) : null;
    return { name, base, best, change, raw: rawChange(base, best, ""), trend: trend(name) };
  });
  return { baselineSha: snap.baselineSha, bestSha: snap.bestSha, guardrails, info, measured: Boolean(snap.baseline || snap.best) };
}

/** Best vs base: the headline number in words, its CI, the factor, and the raw values. */
export function bestView(engine: Engine, s: StudyRow) {
  const spec = specOf(engine, s);
  const metric = metricOf(spec);
  const value = engine.cumulative(s);
  const ci = bestCi(engine, s);
  const snap = metricSnapshot(engine, s);
  const base = snap.baseline?.[metric.name] ?? null;
  const best = snap.best?.[metric.name] ?? null;
  const segments = segmentsSpanned(s);
  return {
    value,
    lo: ci?.lo ?? null,
    hi: ci?.hi ?? null,
    /** "74.7% fewer ops (3.9×)"; across segments "81.8% lower time (5.5×) across 3 segments" */
    text: value === null ? null : bestHeadlineText(value, metric, segments),
    signed: signedPct(value),
    factor: value === null ? "" : factorText(value, metric.direction),
    ciText: ci ? (isPointCi(ci.lo, ci.hi) ? "single runs, no CI" : `${ciText(ci.lo, ci.hi)} (compounded from the promoted candidates)`) : "",
    /** Raw values of the current segment's baseline and of best. */
    base,
    best,
    /** Segments the headline spans (it compounds every promotion; raw values are this segment's). */
    segments,
    /** "210,802 → 53,300 opcodes"; across segments "this segment 3.62 → 2.04 s" */
    raw: segmentRawText(base, best, metric.unit, segments),
    metric,
  };
}

export interface NeedsYouItem {
  id: string;
  kind:
    | "approve_spec"
    | "calibration_failed"
    | "start"
    | "pending_spec"
    | "budget_exhausted"
    | "drift"
    | "oracle_broken"
    | "paused"
    | "bench_unhealthy"
    | "bench_offline"
    | "harvest_ready"
    | "harvest_failed"
    | "publish_failed";
  /** "alert": something is broken; "action": a decision waits for you. */
  tone: "alert" | "action";
  title: string;
  /** Badge-sized: "approve spec", "harvest ready". */
  short: string;
  detail: string;
  /** Where the page shows it, and the in-app action that resolves it (null when the fix is elsewhere). */
  tab: "overview" | "oracle" | "bench" | "harvest" | "ideas";
  action: null | { kind: "approve_spec"; version: number; changesOracle: boolean } | { kind: "start" } | { kind: "resume" } | { kind: "harvest" } | { kind: "open_harvest" } | { kind: "open_thread" } | { kind: "open_bench" };
  command: string | null;
  at: number | null;
}

/** Whether the last pause was the system's, and why (from the append-only state log). */
export function pauseInfo(engine: Engine, s: StudyRow): { system: boolean; kind: "budget" | "drift" | "oracle" | "other" | null; at: number | null } {
  if (s.state !== "paused") return { system: false, kind: null, at: null };
  const row = engine.ctx.store.db.prepare(`SELECT at, data_json FROM events WHERE study_id = ? AND kind = 'study.state' ORDER BY id DESC LIMIT 1`).get(s.id) as { at: number; data_json: string } | undefined;
  const data = safeJson<{ system?: boolean; to?: string }>(row?.data_json ?? null) ?? {};
  const reason = s.pause_reason ?? "";
  const kind = /^budget exhausted/u.test(reason) ? "budget" : /^noise drift|^automatic recalibration failed/u.test(reason) ? "drift" : /^oracle broken|could not send best|holdout check failed on best/u.test(reason) ? "oracle" : "other";
  return { system: Boolean(data.system), kind, at: row?.at ?? null };
}

/** What needs the human now, most urgent first. Derived from state on every read, so it never goes stale. */
export function needsYou(engine: Engine, s: StudyRow): NeedsYouItem[] {
  const { store } = engine.ctx;
  const items: NeedsYouItem[] = [];
  const slug = s.slug;
  const report = safeJson<{ ok?: boolean; problems?: string[]; finishedAt?: number }>(s.calibration_json);
  if (s.state === "draft") {
    if (s.calibration_status === "failed") {
      items.push({
        id: "calibration_failed",
        kind: "calibration_failed",
        tone: "alert",
        title: "Calibration failed",
        short: "calibration failed",
        detail: `${(report?.problems ?? []).slice(0, 3).map((p) => clip(p, 240)).join(" · ") || "see the Oracle tab"}. Ask the study thread to revise the spec, then approve the new version.`,
        tab: "oracle",
        action: s.study_thread_id ? { kind: "open_thread" } : null,
        command: null,
        at: report?.finishedAt ?? null,
      });
    }
    if (s.calibration_status !== "running") {
      items.push({
        id: `approve_spec:${s.spec_version}`,
        kind: "approve_spec",
        tone: "action",
        title: `Approve spec v${s.spec_version} and calibrate`,
        short: "approve spec",
        detail: "Review the spec on the Oracle tab. Approving runs the gates on the base commit, then A/A measurements to learn the noise floor.",
        tab: "oracle",
        action: { kind: "approve_spec", version: s.spec_version, changesOracle: false },
        command: `bb study calibrate ${slug}`,
        at: store.specVersion(s.id, s.spec_version)?.created_at ?? null,
      });
    }
  }
  if (s.state === "calibrating" && s.calibration_status === "ready" && s.calibration_approved_at === null) {
    items.push({
      id: `start:${s.segment}`,
      kind: "start",
      tone: "action",
      title: "Calibration is ready: review it and start",
      short: "start the study",
      detail: clip(report && "report" in report ? String((report as { report?: string }).report ?? "") : "", 400) || "See the calibration report on the Oracle tab.",
      tab: "oracle",
      action: { kind: "start" },
      command: `bb study start ${slug}`,
      at: report?.finishedAt ?? null,
    });
  }
  if (s.pending_spec_version !== null && s.state !== "archived") {
    const seg = segmentView(engine, s);
    items.push({
      id: `pending_spec:${s.pending_spec_version}`,
      kind: "pending_spec",
      tone: "action",
      title: `Spec v${s.pending_spec_version} waits for approval`,
      short: "approve spec",
      detail: seg.pendingChangesOracle
        ? `The oracle changed: approving recalibrates on the current best and starts segment ${s.segment + 1}. The study keeps running on v${s.spec_version} until then.`
        : `The oracle is unchanged: approving applies it without recalibration. The study keeps running on v${s.spec_version} until then.`,
      tab: "oracle",
      action: { kind: "approve_spec", version: s.pending_spec_version, changesOracle: Boolean(seg.pendingChangesOracle) },
      command: seg.pendingChangesOracle ? `bb study calibrate ${slug}` : `bb study approve ${slug}`,
      at: store.specVersion(s.id, s.pending_spec_version)?.created_at ?? null,
    });
  }
  const pause = pauseInfo(engine, s);
  if (s.state === "paused" && pause.system) {
    const reason = clip(s.pause_reason ?? "", 300);
    if (pause.kind === "budget") {
      items.push({ id: "budget_exhausted", kind: "budget_exhausted", tone: "action", title: "Budget used up: harvest the wins", short: "harvest ready to start", detail: `${reason}. Harvest turns the promotions into reviewable PRs (a dry run: nothing is pushed).`, tab: "harvest", action: { kind: "harvest" }, command: `bb study harvest ${slug}`, at: pause.at });
    } else if (pause.kind === "drift" && /^automatic recalibration failed/u.test(reason)) {
      items.push({ id: "drift", kind: "drift", tone: "alert", title: "Paused: recalibrating on best's shorter runs failed", short: "recalibration failed", detail: `${reason}.`, tab: "oracle", action: { kind: "resume" }, command: `bb study resume ${slug}`, at: pause.at });
    } else if (pause.kind === "drift") {
      items.push({ id: "drift", kind: "drift", tone: "alert", title: "Paused: the bench got noisier (drift check)", short: "drift alarm", detail: `${reason}. Check what else runs on the bench host, then resume; or ask the study thread for an oracle with more pairs.`, tab: "bench", action: { kind: "resume" }, command: `bb study resume ${slug}`, at: pause.at });
    } else if (pause.kind === "oracle") {
      items.push({ id: "oracle_broken", kind: "oracle_broken", tone: "alert", title: "Paused: the oracle is broken on best", short: "oracle broken", detail: `${reason}. Fix the environment or the spec, then resume.`, tab: "bench", action: { kind: "resume" }, command: `bb study resume ${slug}`, at: pause.at });
    } else {
      items.push({ id: "paused", kind: "paused", tone: "alert", title: "Paused by the system", short: "paused", detail: `${reason}.`, tab: "overview", action: { kind: "resume" }, command: `bb study resume ${slug}`, at: pause.at });
    }
  }
  if (["running", "paused", "calibrating", "harvesting"].includes(s.state)) {
    const now = engine.ctx.now();
    const spec = specOf(engine, s);
    const graceMs = (spec?.oracle.health.notify_after_minutes ?? 15) * 60_000;
    for (const h of benchHostsView(engine, s)) {
      if (h.status === "offline" && h.offlineSince !== null && now - h.offlineSince > (spec?.oracle.offline_grace_minutes ?? 10) * 60_000) {
        items.push({ id: `bench_offline:${h.hostId}`, kind: "bench_offline", tone: "alert", title: `Bench host ${h.name} is offline`, short: "bench offline", detail: `Offline since ${new Date(h.offlineSince).toISOString().slice(11, 16)} UTC. Measurements wait for it; workers keep editing until the queue fills.`, tab: "bench", action: { kind: "open_bench" }, command: `bb study bench ${slug}`, at: h.offlineSince });
      } else if (h.healthOk === false && h.healthAt !== null) {
        const streak = unhealthySince(engine, s, h.hostId);
        if (streak !== null && now - streak > graceMs) {
          items.push({ id: `bench_unhealthy:${h.hostId}`, kind: "bench_unhealthy", tone: "alert", title: `Bench host ${h.name} fails its health check`, short: "bench unhealthy", detail: `${h.problems.slice(0, 2).join("; ") || "see the Bench tab"}. Measurements are deferred until it passes.`, tab: "bench", action: { kind: "open_bench" }, command: `bb study bench ${slug}`, at: streak });
        }
      }
    }
  }
  const h = store.latestHarvest(s.id);
  if (h && s.state === "harvesting") {
    if (h.state === "ready" && h.publish_state !== "published") {
      items.push({
        id: `harvest_ready:${h.id}`,
        kind: h.publish_state === "failed" ? "publish_failed" : "harvest_ready",
        tone: h.publish_state === "failed" ? "alert" : "action",
        title: h.publish_state === "failed" ? `Publishing harvest h${h.id} failed` : `Harvest h${h.id} is ready for review`,
        short: h.publish_state === "failed" ? "publish failed" : "harvest ready",
        detail: h.publish_state === "failed" ? clip(h.error ?? "see the Harvest tab for each PR's result", 300) : `${store.changesets(h.id).length} changeset(s) with measured contributions. Review them, then publish draft PRs, keep exploring, or archive.`,
        tab: "harvest",
        action: { kind: "open_harvest" },
        command: `bb study harvest ${slug}`,
        at: h.finished_at,
      });
    } else if (h.state === "failed") {
      items.push({ id: `harvest_failed:${h.id}`, kind: "harvest_failed", tone: "alert", title: `Harvest h${h.id} failed`, short: "harvest failed", detail: clip(h.error ?? "", 300), tab: "harvest", action: { kind: "open_harvest" }, command: `bb study harvest ${slug} --restart`, at: h.finished_at });
    }
  }
  const order = { alert: 0, action: 1 } as const;
  return items.sort((a, b) => order[a.tone] - order[b.tone]);
}

/** Start of the current unhealthy streak of a bench host (latest run of failing checks). */
function unhealthySince(engine: Engine, s: StudyRow, hostId: string): number | null {
  const checks = engine.ctx.store.healthChecks(s.id, { limit: 200 }).filter((c) => c.host_id === hostId);
  let since: number | null = null;
  for (const c of checks) {
    if (c.ok === 1) break;
    since = c.at;
  }
  return since;
}

/** One plain sentence: what the study is doing right now. */
export function statusLine(engine: Engine, s: StudyRow): string {
  const { store } = engine.ctx;
  const liveRows = store.threads(s.id, { role: "worker", states: ["spawning", "active", "finishing"] });
  const live = liveRows.length;
  // What each live worker is doing: its recorded phase (the live view's), else what its state says.
  const phases = liveRows.map((w) => w.phase ?? (w.state === "spawning" ? "starting" : w.state === "finishing" ? "finishing" : "working"));
  const measuring = store.candidates(s.id, { stages: ["measuring", "confirming"] }).map((c) => `c/${c.n}`);
  const testing = gatesOnBench(engine, s).map((g) => `c/${g.n}`);
  switch (s.state) {
    case "draft":
      return s.calibration_status === "failed" ? "Draft: the last calibration failed. A revised spec needs your approval." : `Draft: spec v${s.spec_version} waits for your approval.`;
    case "calibrating":
      return s.calibration_status === "running" ? "Calibrating: gates on the base commit, then A/A measurements to learn the noise." : s.calibration_status === "ready" ? "Calibration finished: review it and start the study." : "Calibrating.";
    case "running": {
      const line = runningStatusText(phases, measuring, store.candidates(s.id, { stages: ["queued"] }).length, store.candidates(s.id, { stages: ["gating"] }).length, testing);
      // An automatic recalibration holds the bench (or waits for it): best's runs got much shorter.
      return s.recalibrate_due !== null ? `${line.replace(/\.$/u, "")}; recalibrating on best at the next free bench slot (its runs got much shorter).` : line;
    }
    case "paused": {
      const p = pauseInfo(engine, s);
      return `Paused${p.system ? " by the system" : " by you"}: ${clip(s.pause_reason ?? "no reason recorded", 200)}.${live ? ` ${live} worker${live === 1 ? "" : "s"} finishing.` : ""}`;
    }
    case "harvesting": {
      const h = store.latestHarvest(s.id);
      return h ? `Harvesting (h${h.id}): ${h.state}${h.phase_detail ? `, ${clip(h.phase_detail, 120)}` : ""}.` : "Harvesting.";
    }
    case "archived":
      return "Archived: workers stopped; candidate refs and the best branch are kept.";
    default:
      return s.state;
  }
}

/** The action a notice asks for: a tab of the study page and the CLI equivalent. Control notices are an audit trail and ask for nothing. */
/**
 * The action a notice asks for, given the study's state now: a notice is
 * stored once, but the step it named may be done or under way (a harvest
 * running after "budget used up", a started study after "calibration
 * ready"), so the button follows the state instead of offering a stale action.
 */
export function noticeAction(
  kind: string,
  s: Pick<StudyRow, "slug"> & Partial<Pick<StudyRow, "state" | "calibration_status" | "calibration_approved_at" | "pending_spec_version">>,
  harvest: { state: string } | null = null,
): { label: string; tab: "overview" | "oracle" | "bench" | "harvest" | "ideas" | "candidates"; command: string | null } | null {
  const slug = s.slug;
  if (kind.startsWith("control.")) return null;
  const known = s.state !== undefined;
  switch (kind) {
    case "calibration.ready":
      if (known && !(s.state === "calibrating" && s.calibration_status === "ready" && !s.calibration_approved_at)) return { label: "See calibration", tab: "oracle", command: `bb study show ${slug}` };
      return { label: "Review calibration and start", tab: "oracle", command: `bb study start ${slug}` };
    case "calibration.failed":
      return { label: "See what failed", tab: "oracle", command: `bb study show ${slug}` };
    case "segment.recalibrated":
      return { label: "See calibration", tab: "oracle", command: `bb study bench ${slug}` };
    case "spec.proposed":
      if (known && s.pending_spec_version === null) return { label: "See the spec", tab: "oracle", command: `bb study show ${slug}` };
      return { label: "Review the pending spec", tab: "oracle", command: `bb study show ${slug}` };
    case "best.new":
      return { label: "See candidates", tab: "candidates", command: null };
    case "budget.threshold":
      return { label: "See budget", tab: "overview", command: `bb study show ${slug}` };
    case "budget.exhausted":
      // Offer to start a harvest only while one can start (paused on the budget); once it runs or is ready, open it.
      if (s.state === "harvesting") return { label: harvest?.state === "ready" ? "Review harvest" : "Open Harvest", tab: "harvest", command: `bb study harvest ${slug}` };
      if (s.state === "archived") return harvest ? { label: "Open Harvest", tab: "harvest", command: `bb study harvest ${slug}` } : null;
      if (known && s.state !== "paused") return { label: "See budget", tab: "overview", command: `bb study show ${slug}` };
      return { label: "Start harvest", tab: "harvest", command: `bb study harvest ${slug}` };
    case "oracle.broken":
    case "drift":
    case "bench.unhealthy":
    case "bench.offline":
      return { label: "Open Bench", tab: "bench", command: `bb study bench ${slug}` };
    case "stall":
      return { label: "Steer the ideas", tab: "ideas", command: `bb study ideas add ${slug} "<idea>"` };
    case "harvest.ready":
    case "harvest.failed":
      return { label: "Open Harvest", tab: "harvest", command: `bb study harvest ${slug}` };
    case "rate_limit":
    case "usage.tight":
    case "study.paused":
      return { label: "See status", tab: "overview", command: `bb study show ${slug}` };
    default:
      return null;
  }
}

/** Notices for the page, newest first: the first line is the summary, the rest is detail. */
export function noticesView(engine: Engine, s: StudyRow, limit = 30) {
  const harvest = engine.ctx.store.latestHarvest(s.id) ?? null;
  return engine.ctx.store.notices(s.id, { limit }).map((n) => {
    const [first, ...rest] = n.text.split("\n");
    return {
      id: n.id,
      at: n.at,
      kind: n.kind,
      audit: n.kind.startsWith("control."),
      summary: clip(first ?? "", 400),
      detail: clip(rest.join("\n").trim(), 1200),
      text: clip(n.text, 1600),
      action: noticeAction(n.kind, s, harvest),
      unseen: n.at > (s.notices_seen_at ?? 0),
      delivered: n.delivered_round !== null,
    };
  });
}

/** Across studies: how many need the human (the nav panel badge). */
export function attentionView(engine: Engine) {
  const studies = engine.ctx.store.studies().filter((s) => s.state !== "archived");
  const items = studies.map((s) => ({ slug: s.slug, needs: needsYou(engine, s).map((n) => n.short) })).filter((x) => x.needs.length);
  return { total: items.reduce((a, x) => a + x.needs.length, 0), studies: items };
}
