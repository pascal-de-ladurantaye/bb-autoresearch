// `bb study evidence`: everything an agent needs to harvest a study, as one
// stable JSON document (format "bb-autoresearch/evidence", version 1). It is
// what the plugin measured and decided, never an agent's claim: candidates
// with their refs, commit messages, diff stats, verdicts, measurements,
// guardrails and samples; findings; segments and calibration; base and best
// (and the frozen best of the latest harvest); the promotions on best; and
// the measurements and gates agents asked for. Holdout data never appears
// (verdicts carry pass/fail only).
//
// Stability: fields are only ever added within a version. A field that
// changes meaning or goes away bumps `version`. docs/stability.md
// documents every field.
import { commitParts } from "./commit.ts";
import type { Ctx } from "./context.ts";
import type { CandidateRow, StudyRow } from "./db/store.ts";
import { candidateFromMessage } from "./commit.ts";
import { frozenRef, type Promotion } from "./harvest.ts";
import { measurementMde } from "./pipeline.ts";
import { adhocResult } from "./primitives.ts";
import { safeJson } from "./prompts.ts";
import { bestBranch, candidateRef, type StudySpec } from "./spec.ts";
import type { GuardrailJudgement, StoredGuardrails } from "./guardrails.ts";

export const EVIDENCE_FORMAT = "bb-autoresearch/evidence";
export const EVIDENCE_VERSION = 1;

export interface EvidenceOptions {
  /** Include every candidate's raw samples (pairs and runs). Off by default: they are most of the size. */
  samples?: boolean;
  /** Only these candidates (by number); default: all. */
  candidates?: number[] | null;
}

interface SampleOut {
  run: string;
  pair: number;
  side: "best" | "candidate";
  metrics: Record<string, number>;
  host: string | null;
}

function groupSamples(rows: Array<{ run: string; pair: number; side: string; metric: string; value: number; host_id: string | null }>): SampleOut[] {
  const by = new Map<string, SampleOut>();
  for (const r of rows) {
    const key = `${r.run}|${r.pair}|${r.side}|${r.host_id ?? ""}`;
    let s = by.get(key);
    if (!s) {
      s = { run: r.run, pair: r.pair, side: r.side === "best" ? "best" : "candidate", metrics: {}, host: r.host_id };
      by.set(key, s);
    }
    s.metrics[r.metric] = r.value;
  }
  return [...by.values()];
}

function candidateOut(ctx: Ctx, study: StudyRow, c: CandidateRow, ideas: Map<number, { id: number; title: string; theme: string }>, findingIds: number[], withSamples: boolean) {
  const idea = c.idea_id !== null ? ideas.get(c.idea_id) : undefined;
  const m = safeJson<StoredGuardrails & { best?: Record<string, number>; candidate?: Record<string, number>; n?: number; mde?: number; stop?: string; confirmSkipped?: boolean }>(c.metrics_json);
  const parts = commitParts(c, idea?.title);
  const judgement = (m?.guardrailJudgement ?? {}) as Record<string, GuardrailJudgement>;
  const guardrails: Record<string, { regression: number | null; lo: number | null; hi: number | null; state: string | null; text: string | null }> = {};
  for (const name of new Set([...Object.keys(m?.guardrails ?? {}), ...Object.keys(judgement)])) {
    const ci = m?.guardrailCi?.[name];
    guardrails[name] = { regression: m?.guardrails?.[name] ?? null, lo: ci?.lo ?? null, hi: ci?.hi ?? null, state: judgement[name]?.state ?? null, text: judgement[name]?.text ?? null };
  }
  const hostName = c.bench_host_id ? (ctx.store.benchHost(study.id, c.bench_host_id)?.name ?? c.bench_host_id) : null;
  return {
    n: c.n,
    ref: candidateRef(study.slug, c.n),
    /** The worker's snapshot commit, its fork point, the commit measured (rebased onto best), what it was measured against, and its commit on best if promoted. */
    sha: c.sha,
    parentSha: c.parent_sha,
    preparedSha: c.prepared_sha,
    againstSha: c.against_sha,
    promotedSha: c.promoted_sha,
    idea: idea ? { id: idea.id, title: idea.title, theme: idea.theme } : null,
    /** The commit message: the worker's own title and body (`fromWorker`), or for candidates from before 1.0 the idea title and summary. */
    commit: { title: parts.title, body: parts.body, fromWorker: c.commit_title !== null },
    summary: c.summary,
    stats: { files: (safeJson<string[]>(c.changed_paths_json) ?? []).length, linesAdded: c.lines_added, linesDeleted: c.lines_deleted, paths: safeJson<string[]>(c.changed_paths_json) ?? [] },
    stage: c.stage,
    verdict: c.verdict,
    reasons: safeJson<string[]>(c.reasons_json) ?? [],
    /** Primary metric, relative to what it was measured against, better is positive. */
    effect: c.effect,
    ciLo: c.ci_lo,
    ciHi: c.ci_hi,
    pairs: m?.n ?? null,
    threshold: m?.mde ?? null,
    stop: m?.stop ?? null,
    confirmSkipped: m?.confirmSkipped ?? false,
    metrics: { best: m?.best ?? null, candidate: m?.candidate ?? null },
    guardrails,
    holdout: c.holdout,
    benchHost: hostName,
    benchSeconds: c.bench_seconds,
    gateSeconds: c.gate_seconds,
    rebases: c.rebases,
    findings: findingIds,
    submittedAt: c.submitted_at,
    decidedAt: c.decided_at,
    ...(withSamples ? { samples: groupSamples(ctx.store.samples(c.id)) } : {}),
  };
}

/** The evidence document. Async: the promotions on best come from git on the edit host. */
export async function studyEvidence(ctx: Ctx, study: StudyRow, spec: StudySpec, opts: EvidenceOptions = {}) {
  const { store } = ctx;
  const ideaRows = store.ideas(study.id);
  const ideas = new Map(ideaRows.map((i) => [i.id, i] as const));
  const findings = store.findings(study.id, { limit: 100_000 });
  const findingsBy = new Map<number, number[]>();
  for (const f of findings) if (f.candidate_id !== null) findingsBy.set(f.candidate_id, [...(findingsBy.get(f.candidate_id) ?? []), f.id]);
  const only = opts.candidates?.length ? new Set(opts.candidates) : null;
  const candidates = store.candidates(study.id).filter((c) => !only || only.has(c.n));
  const harvests = store.harvests(study.id);
  const latest = harvests[0];
  let promotions: Promotion[] = [];
  let promotionsError: string | null = null;
  if (study.base_sha && study.best_sha && study.host_id && study.repo_path) {
    if (study.base_sha !== study.best_sha) {
      try {
        const log = await ctx.bb.hostRunner(study.host_id).commitLog(study.repo_path, study.base_sha, study.best_sha);
        promotions = log.map((c) => {
          const n = candidateFromMessage(c.message, study.slug);
          const cand = n !== null ? store.candidateByN(study.id, n) : store.candidates(study.id).find((x) => x.promoted_sha === c.sha);
          return { sha: c.sha, n: cand?.n ?? null, title: c.subject, body: c.message.split("\n").slice(1).filter((l) => !/^Autoresearch-[A-Za-z-]+:/u.test(l)).join("\n").trim() || null, paths: c.paths };
        });
      } catch (e) {
        promotionsError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  const benchHosts = store.benchHosts(study.id, { all: true });
  return {
    format: EVIDENCE_FORMAT,
    version: EVIDENCE_VERSION,
    generatedAt: new Date(ctx.now()).toISOString(),
    study: {
      slug: study.slug,
      state: study.state,
      objective: spec.study.objective,
      repoPath: study.repo_path,
      baseBranch: spec.study.base,
      metric: { name: spec.metric.name, unit: spec.metric.unit ?? "", direction: spec.metric.direction },
      noise: spec.oracle.noise,
      guardrails: spec.guardrail.map((g) => ({ name: g.name, direction: g.direction, maxRegression: g.max_regression, maxTotalRegression: g.max_total_regression ?? g.max_regression })),
      scope: { editable: [...spec.scope.editable], protected: [...spec.scope.protected] },
      gates: [...spec.oracle.gate],
      protocol: { nMin: spec.oracle.protocol.n_min, nMax: spec.oracle.protocol.n_max, minEffect: spec.oracle.protocol.min_effect, confidence: spec.oracle.protocol.confidence },
      holdout: Boolean(spec.oracle.holdout),
      specVersion: study.spec_version,
    },
    git: {
      base: study.base_sha,
      best: study.best_sha,
      bestBranch: bestBranch(study.slug),
      candidateRefs: `refs/studies/${study.slug}/c/<n>`,
      segmentRefs: `refs/studies/${study.slug}/segment/<k>`,
      /** The latest harvest's frozen best (null when none is frozen). */
      frozen: latest && latest.best_sha && ["frozen", "ready"].includes(latest.state) ? { harvest: latest.seq, state: latest.state, ref: frozenRef(study.slug, latest.seq), base: latest.base_sha, best: latest.best_sha, at: latest.finished_at } : null,
    },
    /** First-parent commits base..best, oldest first: each one promoted candidate, its message the worker's. */
    promotions,
    promotionsError,
    segments: store.segments(study.id).map((g) => ({
      k: g.k,
      baseline: g.baseline_sha,
      oracleHash: g.oracle_hash,
      specVersion: g.spec_version,
      noiseFloor: g.noise_floor,
      threshold: g.mde,
      evalSeconds: g.eval_seconds,
      startedAt: g.created_at,
      auto: Boolean(safeJson<{ auto?: boolean }>(g.details_json)?.auto),
    })),
    /** Each host decides with its own win threshold (never below min_effect); `excluded` is why a host much noisier than its peers measures nothing until the next calibration. */
    benchHosts: benchHosts.map((h) => ({ id: h.host_id, name: h.name, mode: h.mode, active: h.active === 1, noiseFloor: h.noise_floor, threshold: h.mde === null ? null : measurementMde(store, study, spec, h), sideRuns: h.side_runs, excluded: safeJson<{ reason?: string }>(h.excluded_json)?.reason ?? null })),
    candidates: candidates.map((c) => candidateOut(ctx, study, c, ideas, findingsBy.get(c.id) ?? [], Boolean(opts.samples))),
    findings: findings.map((f) => ({ id: f.id, candidate: f.candidate_id !== null ? (store.candidate(f.candidate_id)?.n ?? null) : null, idea: f.idea_id, outcome: f.outcome, learned: f.learned, revisitIf: f.revisit_if || null, evidence: f.evidence || null, at: f.created_at })),
    ideas: ideaRows.map((i) => ({ id: i.id, title: i.title, theme: i.theme, status: i.status, source: i.source })),
    harvests: harvests.map((h) => ({ seq: h.seq, state: h.state, base: h.base_sha, best: h.best_sha, startedAt: h.started_at, finishedAt: h.finished_at, legacy: store.changesets(h.id).length > 0 || !["waiting", "frozen", "cancelled", "failed"].includes(h.state) })),
    /** `bb study measure` / `bb study gate` runs, newest first. */
    runs: store.adhocRuns(study.id, { limit: 200 }).map((r) => ({ id: `r${r.seq}`, kind: r.kind, a: r.ref_a ? { ref: r.ref_a, sha: r.sha_a } : null, b: { ref: r.ref_b, sha: r.sha_b }, state: r.state, error: r.error, result: adhocResult(r), requestedBy: r.actor, requestedAt: r.requested_at, finishedAt: r.finished_at })),
    budget: { candidates: store.candidateCount(study.id), maxCandidates: spec.budget.max_candidates, benchSeconds: store.budget(study).bench_seconds, maxBenchHours: spec.budget.max_bench_hours },
  };
}

export type Evidence = Awaited<ReturnType<typeof studyEvidence>>;
