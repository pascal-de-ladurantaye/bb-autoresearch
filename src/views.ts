// Read models for the study page, the thread header badge, and the CLI.
// Pure functions of the store (plus the engine's scheduler view), bounded.
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { Engine } from "./engine.ts";
import type { CandidateRow, ChangesetRow, HarvestRow, StudyRow } from "./db/store.ts";
import type { StackRecord } from "./harvest.ts";
import { BENCH_BOUND_STAGES } from "./pipeline.ts";
import { clip, safeJson } from "./prompts.ts";
import { accountingFor, standaloneText } from "./report.ts";
import { oracleHash, type StudySpec } from "./spec.ts";

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
    benchHosts: benchHostsView(engine, s),
    segment: segmentView(engine, s),
    tEval: engine.pipeline.recentEvalSeconds(s),
    tThink: engine.thinkSeconds(s),
    trajectory: trajectory(engine, s),
    workerList: workers,
    queue,
    usage: usageView(engine, s),
    harvest: harvestSummary(engine, s),
    notices: store.notices(s.id, { limit: 10 }).map((n) => ({ id: n.id, at: n.at, kind: n.kind, text: clip(n.text, 1000), delivered: n.delivered_round !== null })),
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
      progress: progress.find((p) => p.hostId === h.host_id)?.text ?? null,
      driftStatus: h.drift_status,
      driftAt: h.drift_at,
      evalsSinceDrift: h.evals_since_drift,
      driftEvery: spec?.oracle.drift.every ?? 0,
      bestBuildSha: h.best_build_sha,
      noiseFloor: h.noise_floor,
      mde: h.mde,
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

/** Findings tab: searchable list with idea, theme, and candidate verdict. */
export function findingsView(engine: Engine, s: StudyRow, q: { query?: string; outcome?: string; theme?: string; verdict?: string; limit?: number }) {
  const { store } = engine.ctx;
  const params: unknown[] = [s.id];
  const where = [`f.study_id = ?`];
  if (q.query) {
    const like = `%${q.query.replace(/[%_]/gu, "")}%`;
    where.push(`(f.learned LIKE ? OR f.revisit_if LIKE ? OR f.evidence LIKE ? OR i.title LIKE ? OR c.summary LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  if (q.outcome) {
    where.push(`f.outcome = ?`);
    params.push(q.outcome);
  }
  if (q.theme) {
    where.push(`i.theme = ?`);
    params.push(q.theme);
  }
  if (q.verdict) {
    where.push(`c.verdict = ?`);
    params.push(q.verdict);
  }
  const rows = store.db
    .prepare(
      `SELECT f.*, i.title AS idea_title, i.theme AS theme, c.n AS n, c.verdict AS verdict, c.effect AS effect FROM findings f
       LEFT JOIN ideas i ON i.id = f.idea_id LEFT JOIN candidates c ON c.id = f.candidate_id
       WHERE ${where.join(" AND ")} ORDER BY f.id DESC LIMIT ?`,
    )
    .all(...params, Math.min(q.limit ?? 200, 500)) as Array<{ id: number; idea_id: number | null; thread_id: string | null; outcome: string; learned: string; revisit_if: string; evidence: string; created_at: number; idea_title: string | null; theme: string | null; n: number | null; verdict: string | null; effect: number | null }>;
  const facet = (sql: string) => (store.db.prepare(sql).all(s.id) as Array<{ k: string | null; c: number }>).filter((r) => r.k).map((r) => ({ value: r.k!, count: r.c }));
  return {
    total: (store.db.prepare(`SELECT COUNT(*) AS c FROM findings WHERE study_id = ?`).get(s.id) as { c: number }).c,
    outcomes: facet(`SELECT outcome AS k, COUNT(*) AS c FROM findings WHERE study_id = ? GROUP BY outcome ORDER BY c DESC`),
    themes: facet(`SELECT i.theme AS k, COUNT(*) AS c FROM findings f JOIN ideas i ON i.id = f.idea_id WHERE f.study_id = ? AND i.theme != '' GROUP BY i.theme ORDER BY c DESC`),
    findings: rows.map((f) => ({
      id: f.id,
      ideaId: f.idea_id,
      ideaTitle: f.idea_title ? clip(f.idea_title, 200) : null,
      theme: f.theme || null,
      candidate: f.n,
      verdict: f.verdict,
      effect: f.effect,
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

/** Oracle tab: the active spec (holdout hidden), version history, segments, calibration reports, and a pending spec with its diff. Approval stays CLI-only. */
export function oracleView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const versions = store.specVersions(s.id);
  const activeRow = versions.find((v) => v.version === s.spec_version) ?? null;
  const active = activeRow ? redactedSpecToml(activeRow.spec_toml) : null;
  const pendingRow = s.pending_spec_version !== null ? (versions.find((v) => v.version === s.pending_spec_version) ?? null) : null;
  let pending = null as null | { version: number; oracleHash: string; changesOracle: boolean; command: string; toml: string; diff: Array<{ op: "same" | "add" | "del"; text: string }> };
  if (pendingRow && activeRow) {
    const changes = pendingRow.oracle_hash !== activeRow.oracle_hash;
    const p = redactedSpecToml(pendingRow.spec_toml);
    pending = {
      version: pendingRow.version,
      oracleHash: pendingRow.oracle_hash,
      changesOracle: changes,
      command: changes ? `bb study calibrate ${s.slug}` : `bb study approve ${s.slug}`,
      toml: p.toml,
      diff: lineDiff(active!.toml, p.toml).slice(0, 2000),
    };
  }
  const report = safeJson<{ ok?: boolean; report?: string; problems?: string[]; baselineSha?: string; oracleHash?: string; hosts?: Array<{ name: string; noiseFloor: number; mde: number; evalSeconds: number; report: string }>; finishedAt?: number }>(s.calibration_json);
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
    calibration: {
      status: s.calibration_status,
      approved: s.calibration_approved_at !== null,
      ok: report?.ok ?? null,
      report: report?.report ?? null,
      problems: report?.problems ?? [],
      baselineSha: report?.baselineSha ?? null,
      oracleHash: report?.oracleHash ?? null,
      hosts: (report?.hosts ?? []).map((h) => ({ name: h.name, noiseFloor: h.noiseFloor, mde: h.mde, evalSeconds: h.evalSeconds, report: clip(h.report, 600) })),
      finishedAt: report?.finishedAt ?? null,
      /** The command that approves what's waiting, if anything. */
      nextCommand: s.state === "draft" ? `bb study calibrate ${s.slug}` : s.state === "calibrating" && s.calibration_status === "ready" && s.calibration_approved_at === null ? `bb study start ${s.slug}` : null,
    },
    segments: store.segments(s.id).map((g) => ({
      k: g.k,
      active: g.k === s.segment,
      oracleHash: g.oracle_hash,
      specVersion: g.spec_version,
      baselineSha: g.baseline_sha,
      noiseFloor: g.noise_floor,
      mde: g.mde,
      evalSeconds: g.eval_seconds,
      gateSeconds: g.gate_seconds,
      report: g.report ? clip(g.report, 1500) : null,
      hosts: (safeJson<{ hosts?: Array<{ name: string; noiseFloor: number; mde: number; evalSeconds: number }> }>(g.details_json)?.hosts ?? []).map((h) => ({ name: h.name, noiseFloor: h.noiseFloor, mde: h.mde, evalSeconds: h.evalSeconds })),
      ref: `refs/studies/${s.slug}/segment/${g.k}`,
      createdAt: g.created_at,
    })),
    /** Approval is a human control in the CLI only (see the threat model); the page shows what to run. */
    approvalVia: "cli" as const,
  };
}

/** Bench tab: machines, queue, health history, drift checks, bundle transfers, recent bench intervals. */
export function benchView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const titles = new Map(store.ideas(s.id).map((i) => [i.id, i.title] as const));
  const queue = store
    .candidates(s.id, { stages: [...BENCH_BOUND_STAGES, "promoting"] })
    .sort((a, b) => (a.queued_at ?? Number.MAX_SAFE_INTEGER) - (b.queued_at ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
    .map((c) => ({ n: c.n, stage: c.stage, ideaTitle: c.idea_id !== null ? clip(titles.get(c.idea_id) ?? "", 120) : null, queuedAt: c.queued_at, benchHostId: c.bench_host_id, rebases: c.rebases }));
  const now = engine.ctx.now();
  const gateRuns = store.events(s.id, { kinds: ["gate.flaky", "gate.failed"], limit: 200 });
  return {
    hosts: benchHostsView(engine, s),
    queue,
    utilization: utilization(engine, s),
    health: store.healthChecks(s.id, { limit: 100 }).map((h) => ({
      id: h.id,
      hostId: h.host_id,
      at: h.at,
      context: h.context,
      ok: h.ok === 1,
      problems: safeJson<string[]>(h.problems_json) ?? [],
      summary: (() => {
        const r = safeJson<{ loadavg?: number[]; cpus?: number; topProcesses?: Array<{ command: string; cpu: number }> }>(h.report_json);
        return r ? `load ${(r.loadavg ?? []).map((v) => v.toFixed(2)).join("/")} on ${r.cpus ?? "?"} CPUs${r.topProcesses?.[0] ? ` · top ${r.topProcesses[0].command} ${r.topProcesses[0].cpu.toFixed(0)}%` : ""}` : "";
      })(),
    })),
    drift: store.driftChecks(s.id, 50).map((d) => ({ id: d.id, hostId: d.host_id, segment: d.segment, bestSha: d.best_sha, startedAt: d.started_at, finishedAt: d.finished_at, status: d.status, pairs: d.pairs, noise: d.noise, calibrated: d.calibrated, ratio: d.ratio })),
    transfers: store.transfers(s.id, 100).map((t) => ({ id: t.id, hostId: t.host_id, sha: t.sha, purpose: t.purpose, bytes: t.bytes, chunks: t.chunks, ms: t.ms, ok: t.ok === 1, error: t.error, at: t.at })),
    intervals: store
      .benchIntervals(s.id)
      .slice(-60)
      .reverse()
      .map((i) => ({ id: i.id, hostId: i.host_id, kind: i.kind, candidate: i.candidate_id !== null ? (store.candidate(i.candidate_id)?.n ?? null) : null, startedAt: i.started_at, seconds: ((i.ended_at ?? now) - i.started_at) / 1000, open: i.ended_at === null })),
    gates: { flaky: gateRuns.filter((e) => e.kind === "gate.flaky").length, failed: gateRuns.filter((e) => e.kind === "gate.failed").length },
  };
}

function changesetView(c: ChangesetRow, all: ChangesetRow[]) {
  const k = (id: number) => all.find((x) => x.id === id)?.k ?? null;
  return {
    id: c.id,
    k: c.k,
    title: c.title,
    rationale: clip(c.rationale, 2000),
    candidates: safeJson<number[]>(c.candidates_json) ?? [],
    commits: safeJson<string[]>(c.commits_json) ?? [],
    paths: (safeJson<string[]>(c.paths_json) ?? []).slice(0, 100),
    ablation: { status: c.ablation_status, detail: c.ablation_detail, sha: c.ablation_sha, contribution: c.contribution, ciLo: c.ci_lo, ciHi: c.ci_hi, n: c.n },
    droppable: c.droppable === 1,
    dependsOn: (safeJson<number[]>(c.depends_on_json) ?? []).map(k).filter((x): x is number => x !== null),
    neededBy: all.filter((o) => (safeJson<number[]>(o.depends_on_json) ?? []).includes(c.id)).map((o) => o.k),
    dependencyReason: c.dependency_reason,
    stack: c.stack,
    prBase: c.pr_base,
    standalone: { status: c.standalone_status, detail: c.standalone_detail, sha: c.standalone_sha, effect: c.standalone_effect, ciLo: c.standalone_ci_lo, ciHi: c.standalone_ci_hi, text: standaloneText(c) },
    pr: { branch: c.branch, title: c.pr_title, body: c.pr_body, url: c.pr_url, status: c.pr_status },
  };
}

function harvestSummary(engine: Engine, s: StudyRow) {
  const h = engine.ctx.store.latestHarvest(s.id);
  if (!h) return null;
  return { id: h.id, state: h.state, detail: h.phase_detail, changesets: engine.ctx.store.changesets(h.id).length, startedAt: h.started_at, finishedAt: h.finished_at };
}

/** Harvest tab: the latest harvest's changesets, ablations, dependency stacks, PR drafts, accounting and publish state. */
export function harvestView(engine: Engine, s: StudyRow) {
  const { store } = engine.ctx;
  const all = store.harvests(s.id);
  const h: HarvestRow | undefined = all[0];
  const canStart = ["running", "paused"].includes(s.state) || (s.state === "harvesting" && (!h || ["ready", "failed", "cancelled"].includes(h.state)));
  const promotions = store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.verdict === "win").length;
  const base = { slug: s.slug, state: s.state, promotions, canStart, startCommand: `bb study harvest ${s.slug}`, history: all.map((x) => ({ id: x.id, state: x.state, startedAt: x.started_at, finishedAt: x.finished_at })) };
  if (!h) return { ...base, harvest: null };
  const cs = store.changesets(h.id);
  const stacks = safeJson<StackRecord[]>(h.stacks_json) ?? [];
  const acc = accountingFor(engine.ctx, h);
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
      total: h.total_effect === null ? null : { value: h.total_effect, lo: h.total_ci_lo, hi: h.total_ci_hi, n: h.total_n, vsBase: h.total_vs_base },
      accounting: { sum: acc.sum, sumHalfWidth: acc.sumHalfWidth, gap: acc.gap, gapHalfWidth: acc.gapHalfWidth, interaction: acc.interaction, missing: acc.missing, items: acc.items.map((i) => ({ label: i.label, source: i.source, value: i.estimate?.value ?? null, lo: i.estimate?.lo ?? null, hi: i.estimate?.hi ?? null })) },
      changesets: cs.map((c) => changesetView(c, cs)),
      stacks: stacks.map((st) => ({ stack: st.stack, members: st.members.map((id) => cs.find((c) => c.id === id)?.k ?? null).filter((x): x is number => x !== null), status: st.status, estimate: st.estimate, detail: st.detail })),
      publisher: h.publisher,
      publishState: h.publish_state,
      exportDir: h.export_dir,
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
