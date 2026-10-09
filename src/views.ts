// Read models for the study page, the thread header badge, and the CLI.
// Pure functions of the store (plus the engine's scheduler view), bounded.
import type { Engine } from "./engine.ts";
import type { CandidateRow, StudyRow } from "./db/store.ts";
import { BENCH_BOUND_STAGES } from "./pipeline.ts";
import { clip, safeJson } from "./prompts.ts";
import type { StudySpec } from "./spec.ts";

export interface StudySummary {
  slug: string;
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
  unreadNotices: number;
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
    unreadNotices: store.notices(s.id, { undelivered: true, limit: 100 }).length,
    updatedAt: s.updated_at,
  };
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
  /** Measurement intervals that overlapped another on the same lock key (should be 0). */
  overlaps: number;
}

export function utilization(engine: Engine, s: StudyRow): Utilization {
  const { store } = engine.ctx;
  const periods = runningPeriods(engine, s);
  const now = engine.ctx.now();
  const intervals = store.benchIntervals(s.id).map((i) => ({ ...i, end: i.ended_at ?? now }));
  let busy = 0;
  for (const i of intervals) for (const p of periods) busy += overlap([i.started_at, i.end], p);
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
  return { runningSeconds: running / 1000, busySeconds: busy / 1000, ratio: running > 0 ? busy / running : null, steadyRatio: steady, overlaps };
}

export interface TrajectoryPoint {
  n: number;
  verdict: string;
  effect: number;
  /** Where the candidate sat relative to base: best-at-measure-time compounded with its effect. */
  position: number;
  at: number;
}

export function trajectory(engine: Engine, s: StudyRow): { points: TrajectoryPoint[]; steps: Array<{ n: number; value: number }> } {
  const decided = engine.ctx.store.decided(s.id, 2000);
  let cum = 0;
  const points: TrajectoryPoint[] = [];
  const steps: Array<{ n: number; value: number }> = [{ n: 0, value: 0 }];
  for (const c of decided) {
    if (c.effect === null) continue;
    const position = 1 - (1 - cum) * (1 - c.effect);
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
  let lo = 0;
  let hi = 0;
  for (const w of wins) {
    lo = 1 - (1 - lo) * (1 - (w.ci_lo ?? w.effect!));
    hi = 1 - (1 - hi) * (1 - (w.ci_hi ?? w.effect!));
  }
  return { lo, hi };
}

function workerPhase(engine: Engine, s: StudyRow, threadId: string | null): { phase: string; candidate: number | null; position: number | null } {
  if (!threadId) return { phase: "spawning", candidate: null, position: null };
  const { store } = engine.ctx;
  const mine = store.candidates(s.id, { threadId }).find((c) => c.stage !== "decided" || c.reported_at === null);
  if (!mine) return { phase: "thinking", candidate: null, position: null };
  if (mine.stage === "queued") {
    const queued = store.candidates(s.id, { stages: ["queued"] }).sort((a, b) => (a.queued_at ?? 0) - (b.queued_at ?? 0) || a.id - b.id);
    const onBench = store.candidates(s.id, { stages: ["measuring", "confirming"] }).length;
    return { phase: "queued", candidate: mine.n, position: queued.findIndex((c) => c.id === mine.id) + 1 + onBench };
  }
  return { phase: mine.stage === "decided" ? "verdict pending delivery" : mine.stage, candidate: mine.n, position: null };
}

export function overview(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const spec = specOf(engine, s);
  const seg = store.segment(s.id, s.segment);
  const ideas = new Map(store.ideas(s.id).map((i) => [i.id, i] as const));
  const workers = store.threads(s.id, { role: "worker", states: ["spawning", "active", "finishing"] }).map((w) => {
    const phase = workerPhase(engine, s, w.thread_id);
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
    bestSha: s.best_sha,
    bestCi: bestCi(engine, s),
    utilization: utilization(engine, s),
    tEval: engine.pipeline.recentEvalSeconds(s),
    tThink: engine.thinkSeconds(s),
    trajectory: trajectory(engine, s),
    workerList: workers,
    queue,
    notices: store.notices(s.id, { limit: 10 }).map((n) => ({ id: n.id, at: n.at, kind: n.kind, text: clip(n.text, 1000), delivered: n.delivered_round !== null })),
    events: store.events(s.id, { limit: 25 }).map((e) => ({ id: e.id, at: e.at, kind: e.kind, actor: clip(e.actor, 40), data: clip(e.data_json, 300) })),
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

export function candidateRow(engine: Engine, c: CandidateRow, ideaTitle: string | null) {
  return {
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
    summary: clip(c.summary.split("\n")[0] ?? "", 200),
    submittedAt: c.submitted_at,
    decidedAt: c.decided_at,
  };
}

export function candidatesView(engine: Engine, s: StudyRow, f: { verdict?: string; stage?: string; ideaId?: number; limit?: number }) {
  const { store } = engine.ctx;
  const titles = new Map(store.ideas(s.id).map((i) => [i.id, i.title] as const));
  return store
    .candidates(s.id, { order: "desc" })
    .filter((c) => (!f.verdict || c.verdict === f.verdict) && (!f.stage || c.stage === f.stage) && (f.ideaId === undefined || c.idea_id === f.ideaId))
    .slice(0, Math.min(f.limit ?? 200, 500))
    .map((c) => candidateRow(engine, c, c.idea_id !== null ? (titles.get(c.idea_id) ?? null) : null));
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
  return {
    ...candidateRow(engine, c, idea?.title ?? null),
    summaryFull: c.summary,
    sha: c.sha,
    preparedSha: c.prepared_sha,
    promotedSha: c.promoted_sha,
    againstSha: c.against_sha,
    ref: `refs/studies/${s.slug}/c/${c.n}`,
    reasons: safeJson<string[]>(c.reasons_json) ?? [],
    metrics: safeJson<Record<string, unknown>>(c.metrics_json),
    diag: (safeJson<string[]>(c.diag_json) ?? []).slice(0, 40),
    gateOutput: c.gate_output,
    changedPaths: (safeJson<string[]>(c.changed_paths_json) ?? []).slice(0, 200),
    samples,
    diff,
    diffError,
  };
}

/** Header badge text for a study or worker thread; null for other threads. */
export function threadBadge(engine: Engine, threadId: string): { kind: "study" | "worker"; slug: string; text: string; tone: "running" | "paused" | "idle" } | null {
  const { store } = engine.ctx;
  const row = store.threadById(threadId);
  if (!row) return null;
  const s = store.study(row.study_id);
  if (!s) return null;
  const tone = s.state === "running" ? "running" : s.state === "paused" ? "paused" : "idle";
  if (row.role === "strategist") {
    const sum = studySummary(engine, s);
    const ci = bestCi(engine, s);
    const best =
      sum.bestVsBase === null
        ? "no win yet"
        : `best ${fmtSigned(sum.metric.direction === "lower" ? -sum.bestVsBase : sum.bestVsBase)}${ci ? ` ±${((ci.hi - ci.lo) * 50).toFixed(1)}` : ""}`;
    const head = s.state === "running" ? `run ${sum.candidates}` : `${s.state}${s.state === "paused" ? "" : ""} · run ${sum.candidates}`;
    return { kind: "study", slug: s.slug, tone, text: `${head} · ${best} · ${sum.workers} worker${sum.workers === 1 ? "" : "s"} · queue ${sum.benchDepth}` };
  }
  const spec = specOf(engine, s);
  const phase = workerPhase(engine, s, threadId);
  const where =
    phase.phase === "queued" && phase.position !== null ? `queued ${ordinal(phase.position)}` : phase.phase === "thinking" ? (row.state === "active" ? "working" : row.state) : phase.phase;
  return {
    kind: "worker",
    slug: s.slug,
    tone,
    text: `${s.slug} · idea #${row.idea_id ?? "?"} · submission ${row.submissions}/${spec?.agents.max_submissions_per_worker ?? "?"} · ${where}`,
  };
}

/** Relative change in the metric's own direction, e.g. "-23.4%" for a lower-is-better latency. */
function fmtSigned(f: number): string {
  return `${f >= 0 ? "+" : "−"}${Math.abs(f * 100).toFixed(1)}%`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
