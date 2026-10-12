// Candidate pipeline: snapshot → scope → (rebase+squash) → gate → queue →
// measure → decide → confirm → promote → report. Each stage is a separate
// method keyed on the candidate's persisted `stage`, so a restart resumes
// from SQLite and every stage is safe to re-run.
//
// Concurrency (M1): `launch()` starts one job per candidate that has work.
// Gates run in parallel (bounded by the study's worker limit, each in its own
// checkout slot) and never take the bench lock. Measurement runs one job per
// bench lock key, oldest queued first, so a bench host measures one candidate
// at a time while gates and agents keep working. Promotion is serialized per
// study and compare-and-swaps the best branch.
//
// M2: a study measures on every bench host its spec lists. Queued candidates
// go, oldest first, to whichever of their study's hosts is free, online and
// healthy (v1: the quietest first, and each host judges with its own win
// threshold). Each measurement runs health check → transfer (bundles, clone
// mode) → build (best cached per host) → paired runs as host jobs → verdict
// → confirmation → holdout → promotion. Measurements can be cancelled; a
// host worker restart or an offline host restarts the measurement from
// scratch with its partial samples discarded. Drift checks take a host's
// next free slot every `oracle.drift.every` evaluations.
import { ciRngFor } from "./band.ts";
import { BenchSite, BenchTransferError, makeBench as makeBenchOn, tail } from "./bench.ts";
import { HostMutex, type Ctx } from "./context.ts";
import { quietestFirst } from "./host-choice.ts";
import { StoreClosedError, type BenchHostRow, type BenchIntervalKind, type CandidateRow, type Store, type StudyRow, type ThreadRow } from "./db/store.ts";
import { driftExpensive, driftNoisy, type DriftResult } from "./drift.ts";
import { poolPaired, positionsFromChain, promotionChain, type GuardrailCalibration, type GuardrailEstimate, type Position } from "./guardrails.ts";
import { checkHealth } from "./health.ts";
import { HOLDOUT_FAIL, runHoldout } from "./holdout.ts";
import { HostJobLostError, RunAbortedError, type HostRunner } from "./host/runner.ts";
import { RemoteHostLostError } from "./bench-provider/runner.ts";
import type { RemoteFleet } from "./remote/fleet.ts";
import { BenchError, strategyFor, type Bench, type MeasureOutcome, type RunResult, type Side } from "./noise.ts";
import { clip, formatDuration, messageText, safeJson, verdictMessage, type AgentMessage } from "./prompts.ts";
import { checkScope } from "./scope.ts";
import { identityText, resolveCommitIdentity, type CommitIdentity } from "./identity.ts";
import { remoteGates, singleMachineMode, type SingleMachineMode } from "./single-machine.ts";
import { bestBranch, candidateRef, formatPct, type StudySpec } from "./spec.ts";
import { magnitudePct, signedPct } from "./present.ts";
import { applyConfirmation, decideVerdict, outcomeEstimates, type VerdictResult } from "./verdict.ts";

export type SubmitResult = { ok: true; candidate: CandidateRow; text: string } | { ok: false; text: string };

const MAX_ATTEMPTS = 3;
/** Conflicts that don't count against a worker's submission limit. */
export const CONFLICT_REFUNDS = 2;
const REPORT_RETRY_MS = 30_000;
/** Stages a candidate passes through on its way to and on the bench. */
export const BENCH_BOUND_STAGES = ["gating", "queued", "measuring", "confirming"] as const;
export const IN_FLIGHT_STAGES = ["submitted", "gating", "queued", "measuring", "confirming", "promoting"] as const;

export interface PipelineHooks {
  /** A verdict was recorded (counts toward strategist triggers, idea state). */
  onDecided(candidate: CandidateRow): void;
  /** The system must pause the study and tell the human why. */
  systemPause(study: StudyRow, reason: string): Promise<void>;
  /** Effective worker limit (gate parallelism follows it). */
  maxWorkers(study: StudyRow): number;
  /** Best moved: tell the study's other live workers. */
  bestMoved(study: StudyRow, winner: CandidateRow, promoted: string): void;
  /** A notice for the human (no agent turn). */
  notify(study: StudyRow, kind: string, text: string): Promise<void>;
  /** Live view: a sample of a measurement was recorded (the CI band moves pair by pair). */
  onSample?(studyId: string, candidateId: number): void;
  /** Live view: a measurement ended and its metrics are stored (the band is kept with the candidate). */
  onMeasured?(candidateId: number): void;
  /**
   * An automatic recalibration is due and the study's bench is free: A/A on best on every
   * bench host, a new segment with the same oracle (engine.ts → calibration.ts).
   */
  recalibrate?(study: StudyRow): Promise<void>;
}

/**
 * Whether best's runs got short enough, against the host's calibration, that
 * relative noise has grown for that reason alone: below `recalibrate_below`
 * of the calibrated per-run time. Returns the ratio when it triggers.
 */
export function recalibrationTrigger(spec: StudySpec, host: Pick<BenchHostRow, "run_seconds">, runSeconds: number | null | undefined): number | null {
  const below = spec.oracle.drift.recalibrate_below ?? 0;
  if (spec.oracle.noise !== "noisy" || !(below > 0) || !host.run_seconds || !(host.run_seconds > 0) || runSeconds === null || runSeconds === undefined || !(runSeconds > 0)) return null;
  const ratio = runSeconds / host.run_seconds;
  return ratio < below ? ratio : null;
}

/**
 * The win threshold a measurement of `study` on `host` uses: the host's own
 * calibrated MDE (the segment's for a host without a calibration), never
 * below `min_effect`. Each host's threshold controls false wins on that host
 * at the same rate, so a quiet host detects smaller wins than a noisy one
 * (v1; before, every host used the segment's, the noisiest host's).
 */
export function measurementMde(store: Store, study: StudyRow, spec: StudySpec, host: Pick<BenchHostRow, "mde">): number {
  const minEffect = spec.oracle.protocol.min_effect;
  const own = host.mde ?? store.segment(study.id, study.segment)?.mde ?? minEffect;
  return Math.max(minEffect, own);
}

/**
 * The calibrated guardrail noise a measurement on `hostId` uses (expensive and
 * deterministic classes): that host's own calibration (the segment's hosts,
 * or a remote machine's arrival calibration), else the segment's worst host.
 */
export function hostGuardrailCalibration(store: Store, study: StudyRow, hostId: string): GuardrailCalibration[] {
  const segment = store.segment(study.id, study.segment);
  const details = safeJson<{ hosts?: Array<{ hostId?: string; guardrails?: GuardrailCalibration[] }> }>(segment?.details_json ?? null);
  const own = details?.hosts?.find((h) => h.hostId === hostId)?.guardrails;
  if (own?.length) return own;
  const remote = safeJson<{ guardrails?: GuardrailCalibration[]; sha?: string }>(store.remoteHostByBench(study.id, hostId)?.calibration_json ?? null);
  if (remote?.guardrails?.length) return remote.guardrails;
  return segmentGuardrailCalibration(store, study);
}

/** The calibrated per-run noise a measurement on `host` uses (expensive: σ of one run). */
export function measurementNoise(store: Store, study: StudyRow, host: Pick<BenchHostRow, "noise_floor">): number | null {
  return host.noise_floor ?? store.segment(study.id, study.segment)?.noise_floor ?? null;
}

/**
 * Whether a noisy win skips its confirmation: its CI's lower bound is at
 * least `skip_confirm_factor` times the win threshold (0 turns this off). A
 * false win that far beyond the threshold would need the whole CI to be
 * wrong by several half-widths. Returns the reason recorded in the verdict.
 */
export function confirmationSkip(spec: StudySpec, mde: number, ciLo: number | null): string | null {
  const f = spec.oracle.protocol.skip_confirm_factor ?? 0;
  if (!(f > 0) || ciLo === null || !Number.isFinite(ciLo) || !(mde > 0) || ciLo < f * mde) return null;
  return `confirmation skipped: the CI's lower bound ${signedPct(ciLo)} is ${(ciLo / mde).toFixed(1)}× the ${magnitudePct(mde, 1)} win threshold (skip_confirm_factor ${f})`;
}

/** Live view: at most one measure.progress event per candidate this often (plus the first and the last). */
const PROGRESS_EVERY_MS = 2000;

/** What "pair i of n" counts per noise class: paired runs (noisy), candidate runs (expensive: the screening run, then the confirmation runs), or the single run (deterministic). */
export function progressUnits(spec: StudySpec): { measure: number; confirm: number } {
  const p = spec.oracle.protocol;
  if (spec.oracle.noise === "noisy") return { measure: p.n_max, confirm: p.n_max };
  if (spec.oracle.noise === "expensive") return { measure: 1 + p.confirm_runs, confirm: p.confirm_runs };
  return { measure: 1, confirm: 1 };
}

/** Restarts (offline host, worker restart) before a measurement counts as a pipeline error. */
const MAX_RESTARTS = 6;

/** The bench lock key a study's measurements on `hostId` serialize on. */
export function benchLockKey(study: StudyRow, spec: StudySpec, hostId: string): string {
  return strategyFor(spec.oracle.noise).benchLock ? hostId : `${hostId}:${study.slug}`;
}

/**
 * Best's position per guardrail against the active segment's base: the
 * promotion chain base → best, compounded (see guardrails.ts).
 */
export function bestGuardrailPositions(store: Store, study: StudyRow, spec: StudySpec): Record<string, Position> {
  const chain = promotionChain(store.candidates(study.id, { stages: ["decided"] }), guardrailChainBase(store, study), study.best_sha);
  return positionsFromChain(spec, chain, (m) => safeJson(m));
}

/**
 * Where guardrails' total limit is counted from: the baseline of the first
 * segment in the current run of segments with the same oracle. An automatic
 * recalibration starts a segment without changing the oracle, so it must
 * not reset the cumulative limit; an oracle change does.
 */
export function guardrailChainBase(store: Store, study: StudyRow): string | null {
  const segs = store.segments(study.id);
  const current = segs.find((g) => g.k === study.segment);
  if (!current) return study.base_sha;
  let base = current;
  for (let k = current.k - 1; k >= 1; k--) {
    const g = segs.find((x) => x.k === k);
    if (!g || g.oracle_hash !== current.oracle_hash) break;
    base = g;
  }
  return base.baseline_sha;
}

/** The active segment's calibrated guardrail noise (worst bench host), by guardrail name. */
export function segmentGuardrailCalibration(store: Store, study: StudyRow): GuardrailCalibration[] {
  return safeJson<{ guardrails?: GuardrailCalibration[] }>(store.segment(study.id, study.segment)?.details_json ?? null)?.guardrails ?? [];
}

/** Hold the bench lock of `hostId` for `fn` and record the busy interval (bench utilization, overlap audits). */
export async function withBench<T>(ctx: Ctx, study: StudyRow, hostId: string, kind: BenchIntervalKind, candidateId: number | null, fn: () => Promise<T>): Promise<T> {
  const spec = ctx.store.spec(study);
  const key = benchLockKey(study, spec, hostId);
  return await ctx.benchLock.run(key, async () => {
    const id = ctx.store.openBenchInterval({ study_id: study.id, host_id: hostId, lock_key: key, kind, candidate_id: candidateId });
    try {
      return await fn();
    } finally {
      ctx.store.closeBenchInterval(id);
      // Quiet bench: worker turns held while this measurement ran may start now.
      if (kind !== "gate" && spec.oracle.quiet_bench && !ctx.disposed) ctx.bb.recheckDispatch().catch(() => undefined);
    }
  });
}

/**
 * Whether a study's gates are serialized with measurements (single-machine
 * mode), and the bench lock key they take: the edit host's.
 */
export function studySingleMachine(store: Store, study: StudyRow, spec: StudySpec = store.spec(study)): SingleMachineMode & { lockKey: string | null } {
  const ids = store.benchHosts(study.id).map((h) => h.host_id);
  const mode = singleMachineMode(spec, study.host_id, ids.length ? ids : null);
  return { ...mode, lockKey: mode.on && study.host_id ? benchLockKey(study, spec, study.host_id) : null };
}

/** Gates serialize with measurements when single-machine mode is on and there are gates to run. */
export function gatesSerialized(store: Store, study: StudyRow, spec: StudySpec = store.spec(study)): boolean {
  return spec.oracle.gate.length > 0 && Boolean(study.host_id) && studySingleMachine(store, study, spec).on;
}

/** Run gates (calibration, harvest) under the edit host's bench lock in single-machine mode, else directly. */
export async function withGateLock<T>(ctx: Ctx, study: StudyRow, candidateId: number | null, fn: () => Promise<T>): Promise<T> {
  if (!gatesSerialized(ctx.store, study)) return await fn();
  return await withBench(ctx, study, study.host_id!, "gate", candidateId, fn);
}

/** Bench time per candidate: measurement, plus the gates when they hold the bench lock (single-machine mode). */
export interface EvalTimes {
  /** Seconds per candidate the scheduler uses as T_eval; null until learned. */
  tEval: number | null;
  /** Mean gate seconds per candidate (always tracked). */
  gate: number | null;
  /** Mean measurement seconds per measured candidate. */
  measure: number | null;
  /** Gates hold the bench lock, so T_eval = gate + measure. */
  serialized: boolean;
}

/** T_eval from the last 20 decided candidates (calibration's estimate until one exists). */
export function evalTimes(store: Store, study: StudyRow): EvalTimes {
  const spec = store.spec(study);
  // Gates hold a bench lock: the edit host's (single-machine mode) or a remote machine's (remote gates).
  const serialized = gatesSerialized(store, study, spec) || (remoteGates(spec) && spec.oracle.gate.length > 0);
  const recent = store.candidates(study.id, { stages: ["decided"], order: "desc", limit: 20 });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const measured = recent.filter((c) => c.bench_seconds > 0);
  const gated = recent.filter((c) => (c.gate_seconds ?? 0) > 0);
  const seg = store.segment(study.id, study.segment);
  const measure = mean(measured.map((c) => c.bench_seconds));
  const gate = mean(gated.map((c) => c.gate_seconds ?? 0));
  if (!serialized) return { tEval: measure ?? seg?.eval_seconds ?? null, gate, measure, serialized };
  // Serialized gates occupy the bench too, also for candidates whose gate failed.
  const used = recent.filter((c) => c.bench_seconds > 0 || (c.gate_seconds ?? 0) > 0);
  const t = mean(used.map((c) => c.bench_seconds + (c.gate_seconds ?? 0)));
  const fallback = seg?.eval_seconds !== null && seg?.eval_seconds !== undefined ? seg.eval_seconds + (seg.gate_seconds ?? 0) : null;
  return { tEval: t ?? fallback, gate: gate ?? seg?.gate_seconds ?? null, measure: measure ?? seg?.eval_seconds ?? null, serialized };
}

export class Pipeline {
  private jobs = new Map<string, Promise<void>>();
  /** Lock keys with a measurement job launched. */
  private measuring = new Set<string>();
  /** The study of each launched measurement, by lock key (an automatic recalibration waits until its study has none). */
  private measuringStudy = new Map<string, string>();
  /** Lock keys with a serialized gate job launched (single-machine mode). */
  private gating = new Set<string>();
  /** Gate checkout slots in use, per study. */
  private gateSlots = new Map<string, Set<number>>();
  /** Job key → not before (ctx.now). */
  private backoff = new Map<string, number>();
  private promotions = new HostMutex();
  /** Submissions are serialized per study so candidate numbers stay dense and unique. */
  private submissions = new HostMutex();
  /** Cached best checkouts per study and bench host (see BenchSite.bestCheckout). */
  private bestDirs = new Map<string, { sha: string; dir: string }>();
  /** Measurements on the bench now, with their cancel handles. */
  private inflight = new Map<number, { controller: AbortController; hostId: string; studyId: string; reason: string | null; regate: boolean }>();
  /** Drift checks running now, by lock key. */
  private drifting = new Set<string>();
  /** Counts host worker exits per host; a measurement that saw the count change restarts. */
  private exitEpoch = new Map<string, number>();
  /** The expensive class's confirmation runs of a win, kept until promotion (the next baseline). */
  private pendingBaselines = new Map<number, { hostId: string; runs: RunResult[] }>();
  /** Commit identity per study, resolved on the edit host (see identity.ts), and when. */
  private identities = new Map<string, { at: number; id: CommitIdentity }>();
  /** Latest progress per bench lock key, for the study page. */
  private progressByKey = new Map<string, { studyId: string; hostId: string; text: string; at: number }>();

  /** Remote bench hosts (set by the engine): machines lent by bench provider plugins. */
  remote: RemoteFleet | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: PipelineHooks,
  ) {}

  /**
   * Who the plugin's commits in the study's repository are by: resolved on
   * the edit host (cached for a minute), passed explicitly to every commit.
   * A repo without an identity falls back to the plugin's, with one notice.
   */
  async commitIdentity(study: StudyRow): Promise<CommitIdentity> {
    const cached = this.identities.get(study.id);
    const now = this.ctx.now();
    if (cached && now - cached.at < 60_000) return cached.id;
    const id = await resolveCommitIdentity(this.runner(study), study.repo_path!, this.ctx.store.spec(study));
    this.identities.set(study.id, { at: now, id });
    const key = `${id.source}:${id.name} <${id.email}>`;
    const last = this.ctx.store.events(study.id, { kinds: ["git.identity"], limit: 1 })[0];
    if (!last || !last.data_json.includes(JSON.stringify(key).slice(1, -1))) {
      this.ctx.store.event(study.id, "git.identity", "plugin", { key, source: id.source });
      if (id.source === "fallback") void this.hooks.notify(study, "git.identity", `\`${study.slug}\`: ${identityText(id)}`);
    }
    return id;
  }

  /** Forget cached commit identities (spec change, tests). */
  forgetIdentity(studyId?: string): void {
    if (studyId) this.identities.delete(studyId);
    else this.identities.clear();
  }

  /** The edit host: snapshots, prepare, gates, promotion refs. */
  private runner(study: StudyRow): HostRunner {
    if (!study.host_id) throw new Error(`study ${study.slug} has no host`);
    return this.ctx.bb.hostRunner(study.host_id);
  }

  /** A study's bench host as a measuring site. */
  site(study: StudyRow, host: BenchHostRow): BenchSite {
    return new BenchSite(this.ctx, study, host, this.bestDirs);
  }

  /** The study's active bench hosts (falls back to its edit host in shared mode for studies from before M2). */
  benchHosts(study: StudyRow): BenchHostRow[] {
    const rows = this.ctx.store.benchHosts(study.id);
    if (rows.length || !study.host_id) return rows;
    // Remote-only studies measure on their lent machines alone; joining ones have inactive rows.
    if (this.ctx.store.benchHosts(study.id, { all: true }).some((h) => h.mode === "remote")) return rows;
    if (this.ctx.store.hasResolvedBench(study.id, study.spec_version) && !this.ctx.store.resolvedBench(study.id, study.spec_version).length) return rows;
    this.ctx.store.syncBenchHosts(study.id, [{ entry: "local", hostId: study.host_id, name: "local", mode: "shared" }]);
    return this.ctx.store.benchHosts(study.id);
  }

  /**
   * The hosts that take measurements and drift checks, quietest first (lowest
   * effective win threshold, then noise floor, then spec order). A host taken
   * out for being much noisier than its peers (`excluded_json`) is left out.
   */
  dispatchHosts(study: StudyRow, spec: StudySpec = this.ctx.store.spec(study)): BenchHostRow[] {
    const rows = this.benchHosts(study).filter((h) => !h.excluded_json);
    return quietestFirst(rows, (h) => measurementMde(this.ctx.store, study, spec, h));
  }

  /** Latest bench progress lines for a study (study page). */
  progress(studyId: string): Array<{ hostId: string; text: string; at: number }> {
    return [...this.progressByKey.values()].filter((p) => p.studyId === studyId).map(({ hostId, text, at }) => ({ hostId, text, at }));
  }

  private setProgress(key: string, studyId: string, hostId: string, text: string): void {
    this.progressByKey.set(key, { studyId, hostId, text: clip(text, 300), at: this.ctx.now() });
  }

  // ---- stage 1-2: snapshot + scope (synchronous inside study_submit_candidate) ----
  async submit(study: StudyRow, worker: ThreadRow, summary: string): Promise<SubmitResult> {
    return await this.submissions.run(study.id, async () => {
      const fresh = this.ctx.store.study(study.id) ?? study;
      const row = this.ctx.store.threadRow(worker.id) ?? worker;
      return await this.submitLocked(fresh, row, summary);
    });
  }

  private async submitLocked(study: StudyRow, worker: ThreadRow, summary: string): Promise<SubmitResult> {
    const { store } = this.ctx;
    const spec = store.spec(study);
    // A study recalibrating after an oracle change keeps taking submissions; they wait at the gate until it runs again.
    const recalibrating = study.state === "calibrating" && store.hasRun(study.id);
    if (study.state === "harvesting") return { ok: false, text: `Study ${study.slug} is harvesting (turning its wins into PRs), so submissions are closed. Call study_record_finding with what you learned (and what you would try), then study_finish.` };
    if (!["running", "paused"].includes(study.state) && !recalibrating) return { ok: false, text: `Study ${study.slug} is ${study.state}; submissions are closed.` };
    if (!worker.thread_id || !worker.worktree_path || !worker.fork_sha) return { ok: false, text: "This worker has no worktree recorded yet; try again in a moment." };
    const pending = store.candidates(study.id, { threadId: worker.thread_id }).find((c) => c.stage !== "decided" || c.reported_at === null);
    if (pending) return { ok: false, text: `c/${pending.n} is still being evaluated (${pending.stage}). End your turn; its verdict arrives as a message.` };
    if (worker.submissions >= spec.agents.max_submissions_per_worker) {
      return { ok: false, text: `Submission cap reached (${spec.agents.max_submissions_per_worker}). Call study_record_finding, then study_finish.` };
    }
    if (store.candidateCount(study.id) >= spec.budget.max_candidates) {
      return { ok: false, text: `The study's candidate budget is spent (${spec.budget.max_candidates}). Call study_record_finding with what you learned, then study_finish.` };
    }
    if (!study.best_sha) return { ok: false, text: "Study has no best commit yet." };
    const identity = await this.commitIdentity(study);
    const n = store.nextCandidateNumber(study.id);
    const firstLine = clip(summary.split("\n")[0] ?? "", 120);
    const snap = await this.runner(study).snapshot({
      worktreePath: worker.worktree_path,
      message: `autoresearch c/${n}: ${firstLine}`,
      candidateRef: candidateRef(study.slug, n),
      baseSha: worker.fork_sha,
      bestSha: study.best_sha,
      ignore: [...(spec.scope.ignore ?? [])],
      identity: { name: identity.name, email: identity.email },
    });
    // A worker that rebased onto a newer best forks from there now.
    const forkSha = snap.forkSha ?? worker.fork_sha;
    const notice = worker.pending_notice;
    const candidate = store.tx(() => {
      const c = store.insertCandidate({
        study_id: study.id,
        n,
        idea_id: worker.idea_id,
        thread_id: worker.thread_id,
        worker_id: worker.id,
        sha: snap.sha,
        parent_sha: forkSha,
        summary: clip(summary, 4000),
        stage: "submitted",
        changed_paths_json: JSON.stringify(snap.changedPaths.slice(0, 500)),
        lines_added: snap.linesAdded,
        lines_deleted: snap.linesDeleted,
      });
      store.updateThread(worker.id, { submissions: worker.submissions + 1, nudged_at: null, fork_sha: forkSha, pending_notice: null });
      store.event(study.id, "candidate.submitted", worker.thread_id!, { candidate: c.id, n, sha: snap.sha, fork: forkSha, files: snap.changedPaths.length, ignored: snap.ignoredPaths?.length ?? 0 });
      return c;
    });
    const scope = checkScope(spec.scope, snap);
    const ignoredNote = snap.ignoredPaths?.length
      ? ` Left out ${snap.ignoredPaths.length}${snap.ignoredPaths.length >= 200 ? "+" : ""} untracked build output(s) or cache file(s) matching [scope] ignore (e.g. ${snap.ignoredPaths.slice(0, 3).join(", ")}); they are never committed.`
      : "";
    if (!scope.ok) {
      const decided = this.decide(candidate, { verdict: "rejected", reasons: scope.reasons }, { reported: true });
      const left = spec.agents.max_submissions_per_worker - worker.submissions - 1;
      return { ok: true, candidate: decided, text: messageText(withNotice(notice, verdictMessage(decided, { submissionsLeft: left, spec, guardrailPositions: bestGuardrailPositions(store, study, spec) }))) };
    }
    store.updateCandidate(candidate.id, { stage: "gating" });
    this.changed(study.id);
    const ahead = store.candidates(study.id, { stages: [...BENCH_BOUND_STAGES] }).filter((c) => c.id !== candidate.id).length;
    const tEval = this.recentEvalSeconds(study);
    const eta = tEval === null ? "" : ` Estimated wait for a verdict: about ${formatDuration((ahead + 1) * tEval)}.`;
    this.kick();
    return {
      ok: true,
      candidate: store.candidate(candidate.id)!,
      text: withNotice(
        notice,
        `Submitted as c/${n} (${snap.sha.slice(0, 10)}, ${snap.changedPaths.length} files, +${snap.linesAdded}/-${snap.linesDeleted}). ` +
          `Scope check passed.${ignoredNote} Rebase onto best and gates run now, then the bench queue: ${ahead} candidate(s) ahead of you.${eta} ` +
          "END YOUR TURN NOW. The verdict arrives as a message.",
      ),
    };
  }

  /**
   * Bench seconds per candidate (T_eval): the mean of recent measured
   * candidates, else the calibrated estimate. In single-machine mode gates
   * hold the bench lock, so their time is part of it.
   */
  recentEvalSeconds(study: StudyRow): number | null {
    return evalTimes(this.ctx.store, study).tEval;
  }

  /** Single-machine mode of a study (and the lock key its gates take). */
  singleMachine(study: StudyRow, spec?: StudySpec): SingleMachineMode & { lockKey: string | null } {
    this.benchHosts(study);
    return studySingleMachine(this.ctx.store, study, spec);
  }

  /** A bench lock key is taken by a launched measurement, drift check, or serialized gate. */
  private keyBusy(lockKey: string): boolean {
    return this.measuring.has(lockKey) || this.drifting.has(lockKey) || this.gating.has(lockKey);
  }

  /** Something runs or waits on this bench lock key (a remote machine retires only when nothing does). */
  lockKeyBusy(lockKey: string): boolean {
    return this.keyBusy(lockKey) || this.ctx.benchLock.busy(lockKey);
  }

  /** Start jobs for whatever has work. Cheap and synchronous; safe to call often. */
  kick(): void {
    if (this.ctx.disposed) return;
    try {
      this.launch();
    } catch (e) {
      this.ctx.bb.log("error", `pipeline launch: ${errText(e)}`);
    }
  }

  /** Run the pipeline until nothing is left to do (tests, settle). */
  async pump(): Promise<void> {
    for (;;) {
      this.kick();
      if (!this.jobs.size) return;
      await Promise.allSettled([...this.jobs.values()]);
    }
  }

  /** Jobs currently running (introspection for tests and the bench view). */
  activeJobs(): string[] {
    return [...this.jobs.keys()];
  }

  private eligible(key: string, c: CandidateRow): boolean {
    return c.attempts < MAX_ATTEMPTS && !this.jobs.has(key) && (this.backoff.get(key) ?? 0) <= this.ctx.now();
  }

  private start(key: string, fn: () => Promise<void>): void {
    const job = (async () => {
      await Promise.resolve(); // let the map entry land before any synchronous finally
      try {
        await fn();
      } catch (e) {
        // A disposed instance (plugin reload) stops quietly: the new one reconciles.
        if (!this.ctx.disposed && !(e instanceof StoreClosedError)) this.ctx.bb.log("warn", `pipeline job ${key}: ${errText(e)}`);
      } finally {
        this.jobs.delete(key);
        if (!this.ctx.disposed) this.kick();
      }
    })();
    this.jobs.set(key, job);
  }

  private launch(): void {
    const { store } = this.ctx;
    // Harvesting studies finish their in-flight candidates (no new submissions arrive).
    const studies = store.studies(["running", "paused", "harvesting"]);
    // Work that holds a bench lock: measurements, and gates in single-machine mode.
    const bench: Array<{ kind: "measure" | "gate" | "remote-gate"; study: StudyRow; spec: StudySpec; c: CandidateRow; lockKey: string | null; limit: number }> = [];
    for (const study of studies) {
      for (const c of store.candidates(study.id, { stages: ["promoting"] })) {
        const key = `c:${c.id}`;
        if (this.eligible(key, c)) this.start(key, () => this.guard(study, c, () => this.promote(c.id)));
      }
      const spec = store.spec(study);
      const sm = this.singleMachine(study, spec);
      const onRemote = remoteGates(spec) && spec.oracle.gate.length > 0;
      const serialized = !onRemote && sm.lockKey !== null && spec.oracle.gate.length > 0;
      // Gates: parallel, outside the bench lock, at most the study's worker limit at once
      // (single-machine mode: in the bench queue, below).
      const limit = Math.max(1, this.hooks.maxWorkers(study));
      for (const c of store.candidates(study.id, { stages: ["gating"] })) {
        const key = `c:${c.id}`;
        if (!this.eligible(key, c)) continue;
        if (onRemote) {
          // Remote gates: in the bench queue, on a remote machine of an entry with `gates = true`, under its lock.
          bench.push({ kind: "remote-gate", study, spec, c, lockKey: null, limit });
          continue;
        }
        if (serialized) {
          bench.push({ kind: "gate", study, spec, c, lockKey: sm.lockKey, limit });
          continue;
        }
        const slot = this.takeGateSlot(study.id, limit);
        if (slot === null) break;
        this.start(key, async () => {
          try {
            await this.guard(study, c, () => this.gate(c.id, slot));
          } finally {
            this.gateSlots.get(study.id)?.delete(slot);
          }
        });
      }
      // An automatic recalibration is due: no new measurement or drift check starts; once the study's
      // measurements on the bench have finished, it runs (each host under its own bench lock).
      const recal = study.state === "running" && study.recalibrate_due !== null;
      if (!recal) {
        for (const c of store.candidates(study.id, { stages: ["queued"] })) {
          if (this.eligible(`c:${c.id}`, c)) bench.push({ kind: "measure", study, spec, c, lockKey: null, limit });
        }
      }
      // Drift checks are due on idle hosts even with nothing queued.
      if (study.state === "running" && !recal) for (const h of this.dispatchHosts(study, spec)) this.maybeStartDrift(study, spec, h);
      if (recal) this.maybeStartRecalibration(study);
    }
    // Bench: one holder per lock key, oldest first across studies (a candidate
    // waits since it was queued, or, for a first gate, since it was submitted).
    // A measurement goes to the quietest free, online, healthy host of its study
    // (dispatchHosts: lowest win threshold first); a serialized gate to its edit host's key.
    bench.sort((a, b) => (a.c.queued_at ?? a.c.submitted_at) - (b.c.queued_at ?? b.c.submitted_at) || a.c.id - b.c.id);
    const now = this.ctx.now();
    for (const { kind, study, spec, c, lockKey: gateKey, limit } of bench) {
      if (kind === "gate") {
        if (!gateKey || this.keyBusy(gateKey)) continue;
        const slot = this.takeGateSlot(study.id, limit);
        if (slot === null) continue;
        this.gating.add(gateKey);
        this.start(`c:${c.id}`, async () => {
          try {
            await this.guard(study, c, () => this.gate(c.id, slot));
          } finally {
            this.gateSlots.get(study.id)?.delete(slot);
            this.gating.delete(gateKey);
            if (this.progressByKey.get(gateKey)?.studyId === study.id) this.progressByKey.delete(gateKey);
          }
        });
        continue;
      }
      if (kind === "remote-gate") {
        const h = this.remoteGateHost(study, spec);
        if (!h) continue;
        const lockKey = benchLockKey(study, spec, h.host_id);
        const slot = this.takeGateSlot(study.id, limit);
        if (slot === null) continue;
        this.gating.add(lockKey);
        this.start(`c:${c.id}`, async () => {
          try {
            await this.guard(study, c, () => this.gate(c.id, slot, h));
          } finally {
            this.gateSlots.get(study.id)?.delete(slot);
            this.gating.delete(lockKey);
            if (this.progressByKey.get(lockKey)?.studyId === study.id) this.progressByKey.delete(lockKey);
          }
        });
        continue;
      }
      for (const h of this.dispatchHosts(study, spec)) {
        const lockKey = benchLockKey(study, spec, h.host_id);
        if (this.keyBusy(lockKey)) continue;
        if (h.status === "offline" || (h.deferred_until ?? 0) > now) continue;
        // A host whose drift check paused the study measures nothing until resume or recalibration.
        if (h.drift_status === "drift") continue;
        if (study.state === "running" && this.maybeStartDrift(study, spec, h)) continue;
        this.measuring.add(lockKey);
        this.measuringStudy.set(lockKey, study.id);
        this.start(`c:${c.id}`, async () => {
          try {
            await this.guard(study, c, () => this.measure(c.id, h.host_id));
          } finally {
            this.measuring.delete(lockKey);
            this.measuringStudy.delete(lockKey);
            if (this.progressByKey.get(lockKey)?.studyId === study.id) this.progressByKey.delete(lockKey);
          }
        });
        break;
      }
    }
    for (const study of store.studies()) {
      for (const c of store.candidates(study.id, { stages: ["decided"] })) {
        if (c.reported_at !== null) continue;
        const key = `r:${c.id}`;
        if (this.jobs.has(key) || (this.backoff.get(key) ?? 0) > this.ctx.now()) continue;
        this.start(key, () => this.report(c.id));
      }
    }
  }

  /** Start the study's automatic recalibration once none of its measurements or drift checks is on the bench. */
  private maybeStartRecalibration(study: StudyRow): void {
    const key = `recal:${study.id}`;
    if (!this.hooks.recalibrate || this.jobs.has(key) || (this.backoff.get(key) ?? 0) > this.ctx.now()) return;
    // A health-deferred retry keeps its time across a reload.
    const retryAt = safeJson<{ retry_at?: number | null }>(study.recalibrate_due)?.retry_at;
    if (typeof retryAt === "number" && retryAt > this.ctx.now()) return;
    if ([...this.measuringStudy.values()].includes(study.id)) return;
    if ([...this.jobs.keys()].some((k) => k.startsWith(`d:${study.id}:`))) return;
    this.start(key, async () => {
      try {
        await this.hooks.recalibrate!(study);
      } catch (e) {
        if (this.ctx.disposed || e instanceof StoreClosedError) return;
        // Host errors: try again later rather than on every pass.
        this.backoff.set(key, this.ctx.now() + Math.max(this.ctx.config.retryDelayMs, 1000) * 5);
        this.ctx.bb.log("warn", `automatic recalibration of ${study.slug}: ${errText(e)}`);
      }
    });
  }

  /** An automatic recalibration found a bench host unhealthy: its next try waits `ms` (v1: instead of pausing). */
  deferRecalibration(studyId: string, ms: number): void {
    this.backoff.set(`recal:${studyId}`, this.ctx.now() + ms);
  }

  /** When the study's deferred automatic recalibration tries again (null: not deferred). */
  recalibrationRetryAt(studyId: string): number | null {
    const at = this.backoff.get(`recal:${studyId}`);
    return at !== undefined && at > this.ctx.now() ? at : null;
  }

  /**
   * Schedule an automatic recalibration (best's runs got much shorter than at
   * calibration): it runs at the next free bench slot, before any other
   * measurement of the study.
   */
  markRecalibrationDue(study: StudyRow, reason: string, data: Record<string, unknown> = {}): void {
    const fresh = this.ctx.store.study(study.id);
    if (!fresh || fresh.recalibrate_due !== null || fresh.state === "archived") return;
    this.ctx.store.tx(() => {
      this.ctx.store.updateStudy(study.id, { recalibrate_due: JSON.stringify({ reason, at: this.ctx.now(), ...data }) });
      this.ctx.store.event(study.id, "recalibration.due", "plugin", { reason, ...data });
    });
    this.changed(study.id);
  }

  /** A free remote machine that runs gates (its entry has `gates = true`), or null. */
  private remoteGateHost(study: StudyRow, spec: StudySpec): BenchHostRow | null {
    const entries = spec.oracle.remote_bench ?? [];
    const now = this.ctx.now();
    for (const h of this.benchHosts(study)) {
      if (h.mode !== "remote") continue;
      const row = this.ctx.store.remoteHostByBench(study.id, h.host_id);
      if (!row || row.state !== "ready" || !entries[row.entry]?.gates) continue;
      if ((h.deferred_until ?? 0) > now || h.drift_status === "drift") continue;
      if (this.keyBusy(benchLockKey(study, spec, h.host_id))) continue;
      return h;
    }
    return null;
  }

  private takeGateSlot(studyId: string, limit: number): number | null {
    let used = this.gateSlots.get(studyId);
    if (!used) {
      used = new Set();
      this.gateSlots.set(studyId, used);
    }
    for (let i = 0; i < limit; i++) {
      if (!used.has(i)) {
        used.add(i);
        return i;
      }
    }
    return null;
  }

  /** Host failures: retry a few times (with backoff), then pause the study and notify. */
  private async guard(study: StudyRow, c: CandidateRow, fn: () => Promise<void>): Promise<void> {
    if (c.attempts >= MAX_ATTEMPTS) return;
    try {
      await fn();
    } catch (e) {
      if (this.ctx.disposed || e instanceof StoreClosedError) return;
      const fresh = this.ctx.store.candidate(c.id) ?? c;
      const attempts = fresh.attempts + 1;
      this.ctx.store.updateCandidate(c.id, { attempts });
      this.backoff.set(`c:${c.id}`, this.ctx.now() + this.ctx.config.retryDelayMs * attempts);
      this.ctx.store.event(study.id, "pipeline.error", "plugin", { candidate: c.id, stage: fresh.stage, attempts, error: clip(errText(e), 500) });
      this.ctx.bb.log("warn", `study ${study.slug} c/${c.n} ${fresh.stage} failed (attempt ${attempts}): ${errText(e)}`);
      if (attempts >= MAX_ATTEMPTS) {
        await this.hooks.systemPause(study, `pipeline error on c/${c.n} (${fresh.stage}) after ${attempts} attempts: ${clip(errText(e), 300)}`);
      }
    }
  }

  // ---- stage 3-4: rebase onto the current best (squash) + gate ----
  /**
   * Rebase and gate a candidate. In single-machine mode (gates configured)
   * the whole stage holds the edit host's bench lock, recorded as a `gate`
   * bench interval, so it never overlaps a measurement on that machine.
   */
  async gate(candidateId: number, slot = 0, remoteHost?: BenchHostRow): Promise<void> {
    const { store } = this.ctx;
    const c = store.candidate(candidateId)!;
    if (c.stage !== "gating") return;
    const study = store.study(c.study_id)!;
    if (remoteHost) {
      try {
        await withBench(this.ctx, study, remoteHost.host_id, "gate", c.id, () => this.gateNow(candidateId, slot, true, remoteHost));
      } catch (e) {
        // The machine left mid-gate: not the candidate's fault; it gates again on another machine.
        if (e instanceof RemoteHostLostError || store.remoteHostByBench(study.id, remoteHost.host_id)?.state === "gone") {
          if (!this.ctx.disposed) store.event(study.id, "gate.restarted", "plugin", { candidate: c.id, n: c.n, host: remoteHost.host_id, reason: "remote bench host left" });
          return;
        }
        throw e;
      }
      return;
    }
    if (!gatesSerialized(store, study)) return await this.gateNow(candidateId, slot, false);
    await withBench(this.ctx, study, study.host_id!, "gate", c.id, () => this.gateNow(candidateId, slot, true));
  }

  private async gateNow(candidateId: number, slot: number, serialized: boolean, remoteHost?: BenchHostRow): Promise<void> {
    const { store } = this.ctx;
    const c = store.candidate(candidateId)!;
    // It may have been decided (archive) while it waited for the lock.
    if (c.stage !== "gating") return;
    const study = store.study(c.study_id)!;
    const spec = store.spec(study);
    const runner = this.runner(study);
    const best = study.best_sha!;
    const prepared = await runner.prepareCandidate({
      repoPath: study.repo_path!,
      bestSha: best,
      forkSha: c.parent_sha,
      candidateSha: c.sha,
      message: `autoresearch c/${c.n}: ${clip(c.summary.split("\n")[0] ?? "", 120)}`,
      identity: gitId(await this.commitIdentity(study)),
    });
    if (prepared.status === "conflict") {
      const reasons = [`does not apply onto current best ${best.slice(0, 10)}: ${prepared.paths.slice(0, 10).join(", ") || clip(prepared.detail, 300)}`];
      const worker = c.thread_id ? store.threadById(c.thread_id) : undefined;
      if (worker && worker.conflict_refunds < CONFLICT_REFUNDS) {
        // Best moved under the worker: not its fault, so the submission is refunded (bounded).
        store.updateThread(worker.id, { submissions: Math.max(0, worker.submissions - 1), conflict_refunds: worker.conflict_refunds + 1 });
        store.event(study.id, "submission.refunded", "plugin", { candidate: c.id, n: c.n, worker: worker.id });
        reasons.push("this conflict does not count against your submission limit");
      }
      this.decide(c, { verdict: "conflict", reasons });
      return;
    }
    if (c.against_sha && c.against_sha !== best) {
      store.updateCandidate(c.id, { rebases: c.rebases + 1 });
      store.event(study.id, "candidate.rebased", "plugin", { candidate: c.id, n: c.n, from: c.against_sha, to: best });
    }
    store.updateCandidate(c.id, { prepared_sha: prepared.sha, against_sha: best });
    if (spec.oracle.gate.length) {
      const started = this.ctx.now();
      const gateHost = remoteHost?.host_id ?? study.host_id!;
      const lockKey = benchLockKey(study, spec, gateHost);
      if (serialized) {
        store.event(study.id, "gate.started", "plugin", { candidate: c.id, n: c.n, host: gateHost });
        this.setProgress(lockKey, study.id, gateHost, remoteHost ? `c/${c.n}: gates (on ${remoteHost.name})` : `c/${c.n}: gates (single-machine mode: tests hold the bench)`);
        this.changed(study.id);
      }
      let ok = true;
      const site = remoteHost ? this.site(study, remoteHost) : null;
      const gateRunner = site ? site.runner : runner;
      try {
        // Remote gates: the prepared commit travels as a delta bundle into the machine's reused gate checkout.
        const dir = site ? await site.checkout("gate", prepared.sha, "candidate", `c/${c.n} gates`) : await runner.checkout(study.repo_path!, `${study.slug}-gate-${slot}`, prepared.sha);
        for (const command of spec.oracle.gate) {
          const job = { cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: `gate c/${c.n}` };
          const r = await gateRunner.run(job);
          if (r.exitCode !== 0) {
            // One automatic retry for flaky gates.
            const retry = await gateRunner.run(job);
            store.event(study.id, retry.exitCode === 0 ? "gate.flaky" : "gate.failed", "plugin", { candidate: c.id, command: clip(command, 200) });
            if (retry.exitCode !== 0) {
              ok = false;
              store.updateCandidate(c.id, { gate_output: clip(tail(r), 3000), gate_seconds: (store.candidate(c.id)?.gate_seconds ?? 0) + (this.ctx.now() - started) / 1000 });
              if (serialized) store.event(study.id, "gate.finished", "plugin", { candidate: c.id, n: c.n, host: gateHost, ok, seconds: (this.ctx.now() - started) / 1000 });
              this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: [`gate failed${r.timedOut ? " (timeout)" : ""}: ${clip(command, 200)} exited ${retry.exitCode}`] });
              return;
            }
          }
        }
      } catch (e) {
        ok = false;
        if (serialized && !this.ctx.disposed) store.event(study.id, "gate.finished", "plugin", { candidate: c.id, n: c.n, host: gateHost, ok, seconds: (this.ctx.now() - started) / 1000, error: true });
        throw e;
      } finally {
        if (serialized) this.progressByKey.delete(lockKey);
        if (ok && !this.ctx.disposed) {
          const seconds = (this.ctx.now() - started) / 1000;
          store.updateCandidate(c.id, { gate_seconds: (store.candidate(c.id)?.gate_seconds ?? 0) + seconds });
          if (serialized) store.event(study.id, "gate.finished", "plugin", { candidate: c.id, n: c.n, host: gateHost, ok, seconds });
        }
      }
    }
    // A candidate sent back by a rebase keeps its place in the bench queue.
    store.updateCandidate(c.id, { stage: "queued", queued_at: c.queued_at ?? this.ctx.now() });
    store.event(study.id, "candidate.queued", "plugin", { candidate: c.id, against: best });
    this.changed(study.id);
  }

  /** Live UI: the study page refetches on this signal. */
  private changed(studyId: string): void {
    this.ctx.bb.publish("study-changed", { study: studyId });
  }

  makeBench(runner: HostRunner, spec: StudySpec, dirs: Record<Side, string>, opts: { signal?: AbortSignal; label?: string } = {}): Bench {
    return makeBenchOn(runner, spec, dirs, opts);
  }

  /** Send a candidate back to rebase + gate + measure against the current best. */
  private requeue(c: CandidateRow, reason: string): void {
    const { store } = this.ctx;
    store.deleteSamples(c.id);
    store.updateCandidate(c.id, { stage: "gating" });
    store.event(c.study_id, "candidate.requeued", "plugin", { candidate: c.id, n: c.n, reason });
  }

  // ---- stage 6-8: measure, decide, confirm, holdout (holding the bench lock) ----
  async measure(candidateId: number, hostId?: string): Promise<void> {
    const { store } = this.ctx;
    const initial = store.candidate(candidateId)!;
    const study0 = store.study(initial.study_id)!;
    const host0 = hostId ? store.benchHost(study0.id, hostId) : this.benchHosts(study0)[0];
    if (!host0) throw new Error(`study ${study0.slug} has no bench host ${hostId ?? ""}`);
    await withBench(this.ctx, study0, host0.host_id, "measure", candidateId, async () => {
      const c = store.candidate(candidateId)!;
      if (c.stage !== "queued") return;
      const study = store.study(c.study_id)!;
      const spec = store.spec(study);
      if (c.against_sha !== study.best_sha) {
        // Best moved while it waited: rebase and gate again before measuring.
        this.requeue(c, "best moved while queued");
        return;
      }
      const host = store.benchHost(study.id, host0.host_id)!;
      let health;
      try {
        health = await checkHealth(this.ctx, study, host, spec, "measure", (kind, text) => this.hooks.notify(study, kind, text));
      } catch (e) {
        // The machine left before the measurement started: not the candidate's error; it stays queued for another host.
        if (host.mode === "remote" && (e instanceof RemoteHostLostError || store.remoteHostByBench(study.id, host.host_id)?.state === "gone")) {
          store.event(study.id, "measure.deferred", "plugin", { candidate: c.id, n: c.n, host: host.host_id, problems: [`remote bench host ${host.name} left`] });
          this.changed(study.id);
          return;
        }
        throw e;
      }
      if (!health.ok) {
        // A failing health check defers the measurement: the candidate keeps its place, the host waits.
        store.event(study.id, "measure.deferred", "plugin", { candidate: c.id, n: c.n, host: host.host_id, problems: health.problems.slice(0, 5) });
        this.changed(study.id);
        return;
      }
      const entry = { controller: new AbortController(), hostId: host.host_id, studyId: study.id, reason: null as string | null, regate: false };
      this.inflight.set(c.id, entry);
      const epoch = this.exitEpoch.get(host.host_id) ?? 0;
      const started = this.ctx.now();
      try {
        await this.measureOn(study, spec, host, c, entry.controller.signal, started);
      } catch (e) {
        // Plugin reload: the store is closed and the new instance restarts this measurement.
        if (this.ctx.disposed) return;
        // Another instance (after a restart) took this measurement over: write nothing.
        if (e instanceof StaleMeasurementError) return;
        const seconds = (this.ctx.now() - started) / 1000;
        store.addBenchSeconds(study.id, seconds);
        const fresh = store.candidate(c.id)!;
        if (fresh.stage === "decided") return; // archived while measuring
        if (entry.reason !== null) {
          this.restartMeasurement(fresh, entry.reason, entry.regate);
          return;
        }
        if (e instanceof RemoteHostLostError || (host.mode === "remote" && this.ctx.store.remoteHostByBench(study.id, host.host_id)?.state === "gone")) {
          this.restartMeasurement(fresh, `remote bench host ${host.name} left`);
          return;
        }
        if (e instanceof HostJobLostError || (this.exitEpoch.get(host.host_id) ?? 0) !== epoch) {
          this.restartMeasurement(fresh, `host worker restarted on ${host.name}`);
          return;
        }
        if (await this.hostOffline(study, host)) {
          this.restartMeasurement(fresh, `bench host ${host.name} went offline`);
          return;
        }
        if (e instanceof BenchTransferError) {
          if (e.purpose === "candidate") {
            this.decide(fresh, { verdict: "rejected", reasons: [`could not send the candidate to bench host ${host.name}: ${clip(e.message, 400)}`] });
          } else {
            store.updateCandidate(c.id, { stage: "queued", attempts: MAX_ATTEMPTS });
            store.deleteSamples(c.id);
            await this.hooks.systemPause(study, `could not send best to bench host ${host.name}: ${clip(e.message, 300)}`);
          }
          return;
        }
        if (e instanceof BenchError && e.side === "candidate") {
          store.updateCandidate(c.id, { gate_output: clip(e.output, 3000), bench_seconds: fresh.bench_seconds + seconds });
          this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: [`measure failed on the candidate: ${e.message}`] });
          return;
        }
        store.updateCandidate(c.id, { stage: "queued", ...(e instanceof BenchError ? { attempts: MAX_ATTEMPTS } : {}) });
        store.deleteSamples(c.id);
        if (e instanceof BenchError) {
          await this.hooks.systemPause(study, `oracle broken: measuring best failed on ${host.name}: ${e.message} ${clip(e.output, 300)}`);
          return;
        }
        throw e;
      } finally {
        this.inflight.delete(c.id);
      }
    });
  }

  private async measureOn(study: StudyRow, spec: StudySpec, host: BenchHostRow, c: CandidateRow, signal: AbortSignal, started: number): Promise<void> {
    const { store } = this.ctx;
    const strategy = strategyFor(spec.oracle.noise);
    const segment = store.segment(study.id, study.segment);
    const against = study.best_sha!;
    const site = this.site(study, host);
    const lockKey = benchLockKey(study, spec, host.host_id);
    const progress = (text: string) => this.setProgress(lockKey, study.id, host.host_id, `c/${c.n}: ${text}`);
    store.deleteSamples(c.id);
    store.updateCandidate(c.id, { stage: "measuring", bench_host_id: host.host_id, holdout: null });
    const units = progressUnits(spec);
    store.event(study.id, "measure.started", "plugin", { candidate: c.id, n: c.n, against, host: host.host_id, mode: host.mode, of: units.measure });
    this.changed(study.id);
    progress("preparing best");
    const best = await site.bestCheckout(against, spec, signal);
    if (!best.ok) {
      // Parked until the human resumes (resume resets attempts).
      store.updateCandidate(c.id, { stage: "queued", attempts: MAX_ATTEMPTS });
      store.addBenchSeconds(study.id, (this.ctx.now() - started) / 1000);
      await this.hooks.systemPause(study, `oracle broken: best ${against.slice(0, 10)} does not build on ${host.name}: ${clip(best.output, 300)}`);
      return;
    }
    progress("preparing candidate");
    const candDir = await site.checkout("cand", c.prepared_sha!, "candidate", `c/${c.n}`, signal);
    const candBuild = await site.build(candDir, spec, `c/${c.n}`, signal);
    if (!candBuild.ok) {
      store.updateCandidate(c.id, { gate_output: clip(candBuild.output, 3000), bench_seconds: c.bench_seconds + (this.ctx.now() - started) / 1000 });
      store.addBenchSeconds(study.id, (this.ctx.now() - started) / 1000);
      this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: [`build failed on bench host ${host.name}`] });
      return;
    }
    const dirs = { best: best.dir, candidate: candDir };
    const sideRunsUsed = strategy.kind === "noisy" ? site.sideRuns() : 1;
    const bench = site.bench(spec, dirs, { signal, label: `c/${c.n}`, onProgress: (line) => progress(line) });
    let runNo = 0;
    // Pair progress for the live view: completed pairs (noisy) or candidate runs, recorded as
    // measure.progress events at a coarse granularity (the first, then at most one per
    // PROGRESS_EVERY_MS, and the last before a decision) so replay can rebuild the bench strip.
    const pairs = { run: "measure", done: 0, sides: new Map<string, Set<Side>>(), counted: new Set<string>(), lastAt: 0, recorded: 0, byRun: {} as Record<string, number> };
    const recordProgress = (force: boolean) => {
      if (pairs.done === pairs.recorded) return;
      const now = this.ctx.now();
      if (!force && pairs.recorded > 0 && now - pairs.lastAt < PROGRESS_EVERY_MS) return;
      pairs.lastAt = now;
      pairs.recorded = pairs.done;
      store.event(study.id, "measure.progress", "plugin", { candidate: c.id, n: c.n, run: pairs.run, pairs: pairs.done, of: pairs.run === "confirm" ? units.confirm : units.measure, host: host.host_id });
    };
    // A measurement that reconciliation restarted elsewhere (measure_restarts moved on) must not write.
    const stillMine = () => {
      const now = store.candidate(c.id);
      if (!now || now.measure_restarts !== c.measure_restarts || !["measuring", "confirming"].includes(now.stage)) throw new StaleMeasurementError();
    };
    const record = (run: string) => (s: { pair: number; side: Side; metrics: Record<string, number> }) => {
      stillMine();
      runNo += 1;
      progress(`${run} pair ${s.pair + 1} ${s.side} (run ${runNo})`);
      for (const [metric, value] of Object.entries(s.metrics)) {
        store.addSample({ study_id: study.id, candidate_id: c.id, run, pair: s.pair, side: s.side, metric, value, host_id: host.host_id });
      }
      if (run !== pairs.run) {
        pairs.byRun[pairs.run] = pairs.done;
        pairs.run = run;
        pairs.done = 0;
        pairs.recorded = 0;
        pairs.sides.clear();
        pairs.counted.clear();
      }
      const key = String(s.pair);
      const sides = pairs.sides.get(key) ?? new Set<Side>();
      sides.add(s.side);
      pairs.sides.set(key, sides);
      const complete = strategy.kind === "noisy" ? sides.size === 2 && !pairs.counted.has(key) : s.side === "candidate";
      if (complete) {
        pairs.counted.add(key);
        pairs.done += 1;
        recordProgress(false);
      }
      this.hooks.onSample?.(study.id, c.id);
    };
    const bestCache = study.best_run_sha === against ? (JSON.parse(study.best_run_json ?? "null") as RunResult | null) : null;
    const baseline = safeJson<{ sha: string; runs: RunResult[] }>(store.benchHost(study.id, host.host_id)?.baseline_json ?? null);
    const mde = measurementMde(store, study, spec, host);
    const noiseFloor = measurementNoise(store, study, host);
    const guardrailNoise = Object.fromEntries(hostGuardrailCalibration(store, study, host.host_id).map((g) => [g.name, g.noise]));
    // Guardrails: the step is judged against best, the total against the segment base (best's position so far).
    const prior = bestGuardrailPositions(store, study, spec);
    const outcome = await strategy.measure({
      bench,
      spec,
      mde,
      rng: this.ctx.rng,
      ciRng: ciRngFor(c.id, "measure"),
      record: record("measure"),
      bestCache,
      baseline: baseline?.sha === against ? baseline.runs : null,
      noiseFloor,
      guardrailNoise,
      signal,
    });
    recordProgress(true);
    stillMine();
    let result = decideVerdict(outcome, spec, { prior, mde });
    let estimates: Record<string, GuardrailEstimate> = outcomeEstimates(outcome);
    let confirmSkipped = false;
    const p0 = spec.oracle.protocol;
    const skip = confirmationSkip(spec, mde, outcome.ciLo);
    if (result.verdict === "win" && p0.confirm && strategy.kind === "noisy" && skip) {
      // The measurement alone is far beyond the threshold: a fresh confirmation would only cost pairs.
      confirmSkipped = true;
      result = { ...result, reasons: [result.reasons[0] ?? "win", skip, ...result.reasons.slice(1)] };
      store.event(study.id, "confirm.skipped", "plugin", { candidate: c.id, n: c.n, lo: outcome.ciLo, mde, factor: p0.skip_confirm_factor });
    } else if (result.verdict === "win" && p0.confirm && strategy.kind === "noisy") {
      store.updateCandidate(c.id, { stage: "confirming" });
      // The confirmation starts: its first pair is running (the live view shows a placeholder for its band).
      pairs.byRun[pairs.run] = pairs.done;
      pairs.run = "confirm";
      pairs.done = 0;
      pairs.recorded = 0;
      pairs.sides.clear();
      pairs.counted.clear();
      store.event(study.id, "measure.progress", "plugin", { candidate: c.id, n: c.n, run: "confirm", pairs: 0, of: units.confirm, host: host.host_id });
      this.changed(study.id);
      const confirmation = await strategy.measure({ bench, spec, mde, rng: this.ctx.rng, ciRng: ciRngFor(c.id, "confirm"), record: record("confirm"), bestCache: null, guardrailNoise, signal });
      recordProgress(true);
      // Guardrails didn't select the candidate, so the confirmation judges them on both measurements' pairs.
      const p = spec.oracle.protocol;
      const second = outcomeEstimates(confirmation);
      const pooled: Record<string, GuardrailEstimate> = {};
      for (const g of spec.guardrail) {
        const e = poolPaired(estimates[g.name], second[g.name], p.confidence, p.bootstrap, this.ctx.rng);
        if (e) pooled[g.name] = e;
      }
      estimates = pooled;
      result = applyConfirmation(result, decideVerdict({ ...confirmation, guardrails: Object.fromEntries(Object.entries(pooled).map(([k, e]) => [k, e.regression])), guardrailEstimates: pooled }, spec, { prior, mde }));
    }
    if (result.verdict === "win" && spec.oracle.holdout) {
      store.updateCandidate(c.id, { stage: "confirming" });
      progress("holdout check");
      const h = await runHoldout(this.ctx, study, c, spec, site.runner, dirs, signal);
      store.updateCandidate(c.id, { holdout: h.pass ? "pass" : "fail" });
      store.event(study.id, "holdout.checked", "plugin", { candidate: c.id, n: c.n, pass: h.pass, host: host.host_id });
      if (h.broken) {
        store.updateCandidate(c.id, { stage: "queued", attempts: MAX_ATTEMPTS });
        store.deleteSamples(c.id);
        store.addBenchSeconds(study.id, (this.ctx.now() - started) / 1000);
        await this.hooks.systemPause(study, `oracle broken: ${h.reason} on ${host.name} (details stay on the bench host)`);
        return;
      }
      result = h.pass ? { verdict: "win", reasons: [...result.reasons, h.reason] } : { verdict: "lose", reasons: [...result.reasons, HOLDOUT_FAIL] };
    }
    stillMine();
    const seconds = (this.ctx.now() - started) / 1000;
    store.addBenchSeconds(study.id, seconds);
    store.event(study.id, "measure.finished", "plugin", { candidate: c.id, n: c.n, against, seconds, decision: result.verdict, host: host.host_id, pairs: pairs.done, run: pairs.run, measure_pairs: pairs.run === "measure" ? pairs.done : (pairs.byRun.measure ?? 0), confirm_pairs: pairs.run === "confirm" ? pairs.done : 0, effect: Number.isFinite(outcome.effect) ? outcome.effect : null, ...(outcome.stop ? { stop: outcome.stop } : {}), ...(confirmSkipped ? { confirm_skipped: true } : {}) });
    const hostRow = store.benchHost(study.id, host.host_id)!;
    store.updateBenchHost(study.id, host.host_id, { evals_since_drift: hostRow.evals_since_drift + 1 });
    // Cache a run of best: reused as the baseline by single-run classes, and its DIAG lines go into briefs.
    if (outcome.bestRun && study.best_run_sha !== against) {
      store.updateStudy(study.id, { best_run_json: JSON.stringify(outcome.bestRun), best_run_sha: against });
    }
    if (outcome.baselineRuns && baseline?.sha !== against) {
      store.updateBenchHost(study.id, host.host_id, { baseline_json: JSON.stringify({ sha: against, runs: outcome.baselineRuns.slice(0, 20) }) });
    }
    if (outcome.confirmRuns) this.pendingBaselines.set(c.id, { hostId: host.host_id, runs: outcome.confirmRuns });
    store.updateCandidate(c.id, {
      effect: Number.isFinite(outcome.effect) ? outcome.effect : null,
      ci_lo: outcome.ciLo,
      ci_hi: outcome.ciHi,
      metrics_json: JSON.stringify({
        best: outcome.bestMetrics,
        candidate: outcome.candidateMetrics,
        guardrails: Object.fromEntries(Object.entries(estimates).map(([k, e]) => [k, Number.isFinite(e.regression) ? e.regression : null])),
        guardrailCi: Object.fromEntries(Object.entries(estimates).map(([k, e]) => [k, { lo: e.lo, hi: e.hi, n: e.n }])),
        ...(result.guardrails ? { guardrailJudgement: result.guardrails } : {}),
        n: outcome.n,
        mde,
        ...(outcome.stop ? { stop: outcome.stop } : {}),
        ...(confirmSkipped ? { confirmSkipped: true } : {}),
        ...(outcome.runSeconds ? { runSeconds: outcome.runSeconds } : {}),
        ...(sideRunsUsed > 1 ? { sideRuns: sideRunsUsed } : {}),
      }),
      diag_json: JSON.stringify(outcome.candidateDiag.slice(0, 40)),
      bench_seconds: c.bench_seconds + seconds,
    });
    this.hooks.onMeasured?.(c.id);
    // Best's runs much shorter than at calibration: relative noise grew for that reason alone, so recalibrate.
    const bestRatio = recalibrationTrigger(spec, store.benchHost(study.id, host.host_id) ?? host, outcome.runSeconds?.best);
    if (bestRatio !== null) this.markRecalibrationDue(study, `best's runs take ${Math.round(bestRatio * 100)}% of the time they took at calibration on ${host.name}`, { ratio: bestRatio, host: host.host_id, source: "measurement" });
    if (result.verdict === "win") {
      // A win only counts against the best it was measured on. If best moved
      // during the measurement (another bench host promoted), measure again.
      if (store.study(study.id)!.best_sha !== against) {
        this.requeue(store.candidate(c.id)!, "best moved during measurement");
        return;
      }
      store.updateCandidate(c.id, { stage: "promoting", reasons_json: JSON.stringify(result.reasons) });
      await this.promote(c.id);
    } else {
      // Non-wins stand: they were measured against the best of their time (against_sha).
      this.decide(store.candidate(c.id)!, result);
    }
  }

  /** A measurement that could not finish restarts from scratch: partial samples are discarded. */
  private restartMeasurement(c: CandidateRow, reason: string, regate = false): void {
    const { store } = this.ctx;
    store.deleteSamples(c.id);
    const restarts = c.measure_restarts + 1;
    store.updateCandidate(c.id, { stage: regate ? "gating" : "queued", measure_restarts: restarts, ...(restarts >= MAX_RESTARTS ? { attempts: MAX_ATTEMPTS } : {}) });
    store.event(c.study_id, "measure.restarted", "plugin", { candidate: c.id, n: c.n, reason, restarts, regate });
    this.changed(c.study_id);
    if (restarts >= MAX_RESTARTS) {
      const study = store.study(c.study_id);
      if (study) void this.hooks.systemPause(study, `c/${c.n} could not be measured after ${restarts} restarts (last: ${reason})`);
    }
  }

  /** Ask BB whether a bench host is connected (cached); record transitions. */
  async hostOffline(study: StudyRow, host: BenchHostRow): Promise<boolean> {
    // Remote machines aren't BB machines: the fleet knows whether they are still there.
    if (host.mode === "remote") return this.remote?.status(host) !== "connected";
    const status = await this.ctx.bb.hostStatus(host.host_id).catch(() => "unknown" as const);
    this.noteHostStatus(study, host, status);
    return status === "disconnected";
  }

  /** Record a bench host's connection status; notify the human after the offline grace period. */
  noteHostStatus(study: StudyRow, host: BenchHostRow, status: "connected" | "disconnected" | "unknown"): void {
    const { store } = this.ctx;
    const now = this.ctx.now();
    const row = store.benchHost(study.id, host.host_id) ?? host;
    if (status === "unknown") return;
    if (status === "connected") {
      if (row.status !== "online") {
        store.updateBenchHost(study.id, host.host_id, { status: "online", status_at: now, offline_since: null, offline_notified_at: null });
        if (row.status === "offline") store.event(study.id, "bench.online", "plugin", { host: host.host_id });
        this.changed(study.id);
      } else store.updateBenchHost(study.id, host.host_id, { status_at: now });
      return;
    }
    const since = row.offline_since ?? now;
    if (row.status !== "offline") {
      store.updateBenchHost(study.id, host.host_id, { status: "offline", status_at: now, offline_since: since });
      store.event(study.id, "bench.offline", "plugin", { host: host.host_id });
      this.changed(study.id);
    }
    const spec = store.spec(study);
    if (row.offline_notified_at === null && now - since >= spec.oracle.offline_grace_minutes * 60_000) {
      store.updateBenchHost(study.id, host.host_id, { offline_notified_at: now });
      void this.hooks.notify(
        study,
        "bench.offline",
        `Bench host ${host.name} has been offline for ${Math.round((now - since) / 60_000)} min, so measurements on it wait. Next: bring the machine back online (Bench tab); workers keep editing meanwhile.`,
      );
    }
  }

  /** Host worker exit (server.ts): in-flight measurements on that host restart from scratch. */
  hostWorkerExited(hostId: string): number {
    this.exitEpoch.set(hostId, (this.exitEpoch.get(hostId) ?? 0) + 1);
    return this.cancelMeasurements((e) => e.hostId === hostId, `host worker restarted on ${hostId}`);
  }

  /** Cancel in-flight measurements matching `match`; they restart later (or are re-gated). */
  cancelMeasurements(match: (e: { hostId: string; studyId: string; candidateId: number }) => boolean, reason: string, opts: { regate?: boolean } = {}): number {
    let n = 0;
    for (const [candidateId, e] of this.inflight) {
      if (!match({ hostId: e.hostId, studyId: e.studyId, candidateId })) continue;
      e.reason = reason;
      e.regate = Boolean(opts.regate);
      e.controller.abort();
      n += 1;
    }
    return n;
  }

  /** Candidates measuring right now (study page, tests). */
  inflightCandidates(studyId?: string): number[] {
    return [...this.inflight].filter(([, e]) => !studyId || e.studyId === studyId).map(([id]) => id);
  }

  // ---- drift checks ----
  private driftDue(study: StudyRow, spec: StudySpec, h: BenchHostRow): boolean {
    const every = spec.oracle.drift.every;
    if (every <= 0 || spec.oracle.noise === "deterministic") return false;
    if (h.status === "offline" || (h.deferred_until ?? 0) > this.ctx.now()) return false;
    return h.evals_since_drift >= every;
  }

  /** Start a drift check on `h` when one is due and its lock key is free. */
  private maybeStartDrift(study: StudyRow, spec: StudySpec, h: BenchHostRow): boolean {
    if (!this.driftDue(study, spec, h)) return false;
    const lockKey = benchLockKey(study, spec, h.host_id);
    const key = `d:${study.id}:${h.host_id}`;
    if (this.keyBusy(lockKey) || this.jobs.has(key)) return false;
    this.drifting.add(lockKey);
    this.start(key, async () => {
      try {
        await this.runDrift(study.id, h.host_id);
      } catch (e) {
        this.ctx.bb.log("warn", `drift check ${study.slug} on ${h.host_id}: ${errText(e)}`);
        // Try again after the host's retry delay rather than on every pass.
        this.ctx.store.updateBenchHost(study.id, h.host_id, { deferred_until: this.ctx.now() + spec.oracle.health.retry_seconds * 1000 });
      } finally {
        this.drifting.delete(lockKey);
        this.progressByKey.delete(lockKey);
      }
    });
    return true;
  }

  /** A/A on best on one bench host; pause the study when noise drifted past max_ratio × calibrated. */
  async runDrift(studyId: string, hostId: string): Promise<DriftResult | null> {
    const { store } = this.ctx;
    const study0 = store.study(studyId)!;
    return await withBench(this.ctx, study0, hostId, "drift", null, async () => {
      const study = store.study(studyId)!;
      if (study.state !== "running" || !study.best_sha) return null;
      const spec = store.spec(study);
      const host = store.benchHost(studyId, hostId)!;
      const health = await checkHealth(this.ctx, study, host, spec, "drift", (kind, text) => this.hooks.notify(study, kind, text));
      if (!health.ok) return null;
      const segment = store.segment(study.id, study.segment);
      const calibrated = host.noise_floor ?? segment?.noise_floor ?? null;
      const id = store.openDriftCheck({ study_id: study.id, host_id: hostId, segment: study.segment, best_sha: study.best_sha });
      store.updateBenchHost(study.id, hostId, { drift_status: "running" });
      store.event(study.id, "drift.started", "plugin", { host: hostId });
      const lockKey = benchLockKey(study, spec, hostId);
      this.setProgress(lockKey, study.id, hostId, "drift check (A/A on best)");
      this.changed(study.id);
      const started = this.ctx.now();
      try {
        const site = this.site(study, host);
        const best = await site.bestCheckout(study.best_sha, spec);
        if (!best.ok) throw new Error(`best does not build on ${host.name}`);
        let result: DriftResult;
        if (spec.oracle.noise === "expensive") {
          const baseline = safeJson<{ sha: string; runs: RunResult[] }>(host.baseline_json);
          const bench = site.bench(spec, { best: best.dir, candidate: best.dir }, { label: "drift" });
          result = await driftExpensive(bench, spec, baseline?.sha === study.best_sha ? baseline.runs : [], calibrated);
        } else {
          const second = await site.checkout("drift", study.best_sha, "best", "drift");
          const built = await site.build(second, spec, "drift");
          if (!built.ok) throw new Error(`best does not build in the drift checkout on ${host.name}`);
          const bench = site.bench(spec, { best: best.dir, candidate: second }, { label: "drift" });
          result = await driftNoisy(bench, spec, this.ctx.rng, calibrated);
        }
        store.addBenchSeconds(study.id, (this.ctx.now() - started) / 1000);
        store.closeDriftCheck(id, { status: result.ok ? "ok" : "drift", pairs: result.pairs, noise: result.noise, calibrated: result.calibrated, ratio: result.ratio, median: result.median });
        store.updateBenchHost(study.id, hostId, { evals_since_drift: 0, drift_status: result.ok ? "ok" : "drift", drift_at: this.ctx.now() });
        store.event(study.id, "drift.checked", "plugin", { host: hostId, ok: result.ok, noise: result.noise, calibrated: result.calibrated, ratio: Math.round(result.ratio * 100) / 100, pairs: result.pairs });
        this.changed(study.id);
        const shorter = recalibrationTrigger(spec, host, result.runSeconds);
        if (!result.ok && shorter !== null) {
          // Not drift: best's runs got much shorter, and shorter runs are noisier relative to themselves.
          store.updateBenchHost(study.id, hostId, { drift_status: null });
          store.event(study.id, "drift.explained", "plugin", { host: hostId, ratio: shorter, noise: result.noise, calibrated: result.calibrated });
          this.markRecalibrationDue(study, `a drift check on ${host.name} measured noise ${formatPct(result.noise)} per pair (${result.ratio.toFixed(1)}× the calibrated level) while best's runs take ${Math.round(shorter * 100)}% of the time they took at calibration`, { ratio: shorter, host: hostId, source: "drift" });
          return result;
        }
        if (!result.ok) {
          // Measurements of this study on this host wait (an in-flight one restarts later) until resume or recalibration.
          this.cancelMeasurements((e) => e.studyId === study.id && e.hostId === hostId, `noise drift on ${host.name}: the study paused`);
          await this.hooks.systemPause(
            study,
            `noise drift on bench host ${host.name}: an A/A check on best measured noise ${formatPct(result.noise)} per pair, ${result.ratio.toFixed(1)}× the calibrated ${formatPct(result.calibrated)} (limit ${spec.oracle.drift.max_ratio}×). Check the machine, then resume or recalibrate`,
          );
        }
        return result;
      } catch (e) {
        store.addBenchSeconds(study.id, (this.ctx.now() - started) / 1000);
        store.closeDriftCheck(id, { status: "error" });
        store.updateBenchHost(study.id, hostId, { drift_status: null });
        throw e;
      }
    });
  }

  /** Request a drift check on every bench host of a study at the next free slot. */
  requestDrift(studyId: string): void {
    const study = this.ctx.store.study(studyId);
    if (!study) return;
    const spec = this.ctx.store.spec(study);
    for (const h of this.dispatchHosts(study, spec)) this.ctx.store.updateBenchHost(studyId, h.host_id, { evals_since_drift: Math.max(spec.oracle.drift.every, 1), deferred_until: null });
    this.kick();
  }

  // ---- stage 8: promotion (squash + compare-and-swap best), serialized per study ----
  async promote(candidateId: number): Promise<void> {
    const studyId = this.ctx.store.candidate(candidateId)?.study_id;
    if (!studyId) return;
    await this.promotions.run(studyId, () => this.promoteLocked(candidateId));
  }

  private async promoteLocked(candidateId: number): Promise<void> {
    const { store } = this.ctx;
    const c = store.candidate(candidateId)!;
    if (c.stage !== "promoting") return;
    const study = store.study(c.study_id)!;
    const spec = store.spec(study);
    const runner = this.runner(study);
    const branch = `refs/heads/${bestBranch(study.slug)}`;
    const current = await runner.resolveRef(study.repo_path!, branch);
    if (c.promoted_sha && current === c.promoted_sha) {
      this.finishPromotion(study, c, c.promoted_sha);
      return;
    }
    if (current !== c.against_sha || study.best_sha !== c.against_sha) {
      // Best moved after the measurement: rebase and re-measure, never promote a stale win.
      this.requeue(c, "best moved before promotion");
      return;
    }
    const idea = c.idea_id ? store.idea(c.idea_id) : undefined;
    const reasons = (JSON.parse(c.reasons_json ?? "[]") as string[]).slice(0, 3);
    const message = [
      clip(idea?.title ?? c.summary.split("\n")[0] ?? `candidate c/${c.n}`, 72),
      "",
      `Autoresearch study ${study.slug}, candidate c/${c.n}${idea ? `, idea #${idea.id}` : ""}.`,
      `${spec.metric.name}: ${formatPct(c.effect)}${c.ci_lo !== null && c.ci_hi !== null ? ` (CI ${formatPct(c.ci_lo)}..${formatPct(c.ci_hi)})` : ""}`,
      ...reasons.map((r) => `- ${r}`),
      "",
      clip(c.summary, 2000),
      "",
      `Autoresearch-Candidate: c/${c.n}`,
      `Autoresearch-Source: ${c.sha}`,
    ].join("\n");
    const promoted = await runner.rewordCommit(study.repo_path!, c.prepared_sha!, message, gitId(await this.commitIdentity(study)));
    store.updateCandidate(c.id, { promoted_sha: promoted });
    const r = await runner.updateRef(study.repo_path!, branch, promoted, c.against_sha);
    if (!r.ok && r.current !== promoted) {
      this.requeue(store.candidate(c.id)!, `best branch moved to ${r.current?.slice(0, 10) ?? "nothing"} during promotion`);
      return;
    }
    this.finishPromotion(study, store.candidate(c.id)!, promoted);
  }

  private finishPromotion(study: StudyRow, c: CandidateRow, promoted: string): void {
    const { store } = this.ctx;
    store.tx(() => {
      store.updateStudy(study.id, { best_sha: promoted });
      store.event(study.id, "best.promoted", "plugin", { candidate: c.id, n: c.n, from: c.against_sha, to: promoted, effect: c.effect });
    });
    // Best moved: every bench host's cached best build is stale.
    for (const h of this.benchHosts(study)) this.site(study, h).invalidateBest();
    store.event(study.id, "bench.cache_invalidated", "plugin", { best: promoted, hosts: this.benchHosts(study).map((h) => h.host_id) });
    // expensive: the winner's confirmation runs are the new best's baseline on the host that measured it.
    const pending = this.pendingBaselines.get(c.id);
    this.pendingBaselines.delete(c.id);
    if (pending) store.updateBenchHost(study.id, pending.hostId, { baseline_json: JSON.stringify({ sha: promoted, runs: pending.runs }) });
    this.decide(store.candidate(c.id)!, { verdict: "win", reasons: JSON.parse(c.reasons_json ?? "[]") as string[] });
    // The new best's runs (the winner's candidate side) much shorter than at calibration: recalibrate before the next measurement.
    const measured = safeJson<{ runSeconds?: { candidate?: number | null } }>(c.metrics_json)?.runSeconds?.candidate;
    const hostRow = c.bench_host_id ? store.benchHost(study.id, c.bench_host_id) : undefined;
    const ratio = hostRow ? recalibrationTrigger(store.spec(study), hostRow, measured) : null;
    if (ratio !== null) this.markRecalibrationDue(study, `c/${c.n} made best's runs ${Math.round(ratio * 100)}% as long as at calibration on ${hostRow!.name}`, { ratio, host: hostRow!.host_id, source: "promotion", candidate: c.n });
    this.hooks.bestMoved(store.study(study.id)!, store.candidate(c.id)!, promoted);
  }

  // ---- stage 7: decide ----
  decide(c: CandidateRow, result: VerdictResult, opts: { reported?: boolean } = {}): CandidateRow {
    const { store } = this.ctx;
    const now = this.ctx.now();
    store.tx(() => {
      store.updateCandidate(c.id, {
        stage: "decided",
        verdict: result.verdict,
        reasons_json: JSON.stringify(result.reasons.slice(0, 20)),
        decided_at: now,
        ...(opts.reported ? { reported_at: now } : {}),
      });
      const study = store.study(c.study_id)!;
      store.updateStudy(study.id, { verdicts_since_round: study.verdicts_since_round + 1 });
      store.event(c.study_id, "candidate.verdict", "plugin", { candidate: c.id, n: c.n, verdict: result.verdict, effect: c.effect, reasons: result.reasons.slice(0, 5) });
    });
    const decided = store.candidate(c.id)!;
    this.hooks.onDecided(decided);
    this.ctx.bb.publish("study-changed", { study: c.study_id });
    return decided;
  }

  // ---- stage 9: report ----
  async report(candidateId: number): Promise<void> {
    const { store } = this.ctx;
    const c = store.candidate(candidateId)!;
    if (c.reported_at !== null || c.stage !== "decided") return;
    const worker = c.thread_id ? store.threadById(c.thread_id) : undefined;
    if (!worker || !["active", "finishing"].includes(worker.state)) {
      store.updateCandidate(c.id, { reported_at: this.ctx.now() });
      return;
    }
    const study = store.study(c.study_id)!;
    const spec = store.spec(study);
    const left = spec.agents.max_submissions_per_worker - worker.submissions;
    try {
      await this.ctx.bb.send(c.thread_id!, withNotice(worker.pending_notice, verdictMessage(c, { submissionsLeft: left, spec, guardrailPositions: bestGuardrailPositions(store, study, spec) })));
      store.tx(() => {
        store.updateCandidate(c.id, { reported_at: this.ctx.now() });
        store.updateThread(worker.id, { pending_notice: null });
        store.event(study.id, "verdict.delivered", "plugin", { candidate: c.id, thread: c.thread_id });
      });
    } catch (e) {
      this.backoff.set(`r:${c.id}`, this.ctx.now() + REPORT_RETRY_MS);
      this.ctx.bb.log("warn", `could not deliver verdict for c/${c.n}: ${errText(e)}`);
    }
  }

  /** Un-park candidates that hit the retry limit (on resume). */
  resetAttempts(studyId: string): void {
    for (const c of this.ctx.store.candidates(studyId, { stages: ["submitted", "gating", "queued", "promoting"] })) {
      if (c.attempts) this.ctx.store.updateCandidate(c.id, { attempts: 0 });
      this.backoff.delete(`c:${c.id}`);
    }
  }

  /** Reconciliation: in-flight measurements restart from scratch. */
  reconcile(): { requeued: number } {
    const { store } = this.ctx;
    let requeued = 0;
    store.closeOpenBenchIntervals();
    store.abortRunningDriftChecks();
    for (const study of store.studies()) {
      for (const h of store.benchHosts(study.id)) {
        // In-memory build caches are gone with the old process; deferrals restart fresh.
        if (h.drift_status === "running") store.updateBenchHost(study.id, h.host_id, { drift_status: null });
        if (h.best_build_sha !== null) store.updateBenchHost(study.id, h.host_id, { best_build_sha: null });
      }
      for (const c of store.candidates(study.id, { stages: ["measuring", "confirming"] })) {
        // The in-flight measurement restarts from scratch; its partial samples are discarded.
        store.deleteSamples(c.id);
        store.updateCandidate(c.id, { stage: "queued", measure_restarts: c.measure_restarts + 1 });
        store.event(study.id, "candidate.requeued", "plugin", { candidate: c.id, reason: "reconcile: in-flight measurement restarted" });
        requeued += 1;
      }
      for (const c of store.candidates(study.id, { stages: ["submitted"] })) {
        // Crashed between snapshot and scope check: re-check scope on the recorded paths.
        const paths = JSON.parse(c.changed_paths_json ?? "[]") as string[];
        const scope = checkScope(store.spec(study).scope, { changedPaths: paths, linesAdded: c.lines_added, linesDeleted: c.lines_deleted });
        if (scope.ok) store.updateCandidate(c.id, { stage: "gating" });
        else this.decide(c, { verdict: "rejected", reasons: scope.reasons });
      }
    }
    return { requeued };
  }
}

function withNotice(notice: string | null, text: string): string;
function withNotice(notice: string | null, text: AgentMessage): AgentMessage;
function withNotice(notice: string | null, text: string | AgentMessage): string | AgentMessage {
  if (!notice) return text;
  return typeof text === "string" ? `${notice}\n\n${text}` : { summary: text.summary, detail: `${notice}\n\n${text.detail}` };
}


/** The name and email of a resolved commit identity (what the host ops take). */
export function gitId(id: CommitIdentity): { name: string; email: string } {
  return { name: id.name, email: id.email };
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A measurement whose candidate was restarted by another instance (reconciliation after a restart). */
export class StaleMeasurementError extends Error {
  constructor() {
    super("measurement restarted elsewhere");
    this.name = "StaleMeasurementError";
  }
}
