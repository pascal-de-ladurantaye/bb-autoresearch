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
import { HostMutex, type Ctx } from "./context.ts";
import type { CandidateRow, StudyRow, ThreadRow } from "./db/store.ts";
import type { HostRunner } from "./host/runner.ts";
import { parseMeasureOutput } from "./metrics.ts";
import { BenchError, strategyFor, type Bench, type MeasureOutcome, type RunResult, type Side } from "./noise.ts";
import { clip, formatDuration, verdictMessage } from "./prompts.ts";
import { checkScope } from "./scope.ts";
import { bestBranch, candidateRef, formatPct, type StudySpec } from "./spec.ts";
import { applyConfirmation, decideVerdict, type VerdictResult } from "./verdict.ts";

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
}

/** The bench lock key a study's measurements serialize on. */
export function benchLockKey(study: StudyRow, spec: StudySpec): string {
  return strategyFor(spec.oracle.noise).benchLock ? study.host_id! : `${study.host_id!}:${study.slug}`;
}

/** Hold the bench lock for `fn` and record the busy interval (bench utilization, overlap audits). */
export async function withBench<T>(ctx: Ctx, study: StudyRow, kind: "measure" | "profile" | "calibration", candidateId: number | null, fn: () => Promise<T>): Promise<T> {
  const key = benchLockKey(study, ctx.store.spec(study));
  return await ctx.benchLock.run(key, async () => {
    const id = ctx.store.openBenchInterval({ study_id: study.id, host_id: study.host_id!, lock_key: key, kind, candidate_id: candidateId });
    try {
      return await fn();
    } finally {
      ctx.store.closeBenchInterval(id);
    }
  });
}

export class Pipeline {
  private jobs = new Map<string, Promise<void>>();
  /** Lock keys with a measurement job launched. */
  private measuring = new Set<string>();
  /** Gate checkout slots in use, per study. */
  private gateSlots = new Map<string, Set<number>>();
  /** Job key → not before (ctx.now). */
  private backoff = new Map<string, number>();
  private promotions = new HostMutex();
  /** Submissions are serialized per study so candidate numbers stay dense and unique. */
  private submissions = new HostMutex();
  private built = new Map<string, string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: PipelineHooks,
  ) {}

  private runner(study: StudyRow): HostRunner {
    if (!study.host_id) throw new Error(`study ${study.slug} has no host`);
    return this.ctx.bb.hostRunner(study.host_id);
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
    if (!["running", "paused"].includes(study.state)) return { ok: false, text: `Study ${study.slug} is ${study.state}; submissions are closed.` };
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
    const n = store.nextCandidateNumber(study.id);
    const firstLine = clip(summary.split("\n")[0] ?? "", 120);
    const snap = await this.runner(study).snapshot({
      worktreePath: worker.worktree_path,
      message: `autoresearch c/${n}: ${firstLine}`,
      candidateRef: candidateRef(study.slug, n),
      baseSha: worker.fork_sha,
      bestSha: study.best_sha,
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
        sha: snap.sha,
        parent_sha: forkSha,
        summary: clip(summary, 4000),
        stage: "submitted",
        changed_paths_json: JSON.stringify(snap.changedPaths.slice(0, 500)),
        lines_added: snap.linesAdded,
        lines_deleted: snap.linesDeleted,
      });
      store.updateThread(worker.id, { submissions: worker.submissions + 1, nudged_at: null, fork_sha: forkSha, pending_notice: null });
      store.event(study.id, "candidate.submitted", worker.thread_id!, { candidate: c.id, n, sha: snap.sha, fork: forkSha, files: snap.changedPaths.length });
      return c;
    });
    const scope = checkScope(spec.scope, snap);
    if (!scope.ok) {
      const decided = this.decide(candidate, { verdict: "rejected", reasons: scope.reasons }, { reported: true });
      const left = spec.agents.max_submissions_per_worker - worker.submissions - 1;
      return { ok: true, candidate: decided, text: withNotice(notice, verdictMessage(decided, { submissionsLeft: left, spec })) };
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
          `Scope check passed. Rebase onto best and gates run now, then the bench queue: ${ahead} candidate(s) ahead of you.${eta} ` +
          "END YOUR TURN NOW. The verdict arrives as a message.",
      ),
    };
  }

  /** Mean bench seconds of recent measured candidates, else the calibrated estimate. */
  recentEvalSeconds(study: StudyRow): number | null {
    const measured = this.ctx.store.candidates(study.id, { stages: ["decided"], order: "desc", limit: 20 }).filter((c) => c.bench_seconds > 0);
    if (measured.length) return measured.reduce((a, c) => a + c.bench_seconds, 0) / measured.length;
    return this.ctx.store.segment(study.id, study.segment)?.eval_seconds ?? null;
  }

  /** Start jobs for whatever has work. Cheap and synchronous; safe to call often. */
  kick(): void {
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
        this.ctx.bb.log("warn", `pipeline job ${key}: ${errText(e)}`);
      } finally {
        this.jobs.delete(key);
        this.kick();
      }
    })();
    this.jobs.set(key, job);
  }

  private launch(): void {
    const { store } = this.ctx;
    const studies = store.studies(["running", "paused"]);
    const benchQueues = new Map<string, Array<{ study: StudyRow; c: CandidateRow }>>();
    for (const study of studies) {
      for (const c of store.candidates(study.id, { stages: ["promoting"] })) {
        const key = `c:${c.id}`;
        if (this.eligible(key, c)) this.start(key, () => this.guard(study, c, () => this.promote(c.id)));
      }
      // Gates: parallel, outside the bench lock, at most the study's worker limit at once.
      const limit = Math.max(1, this.hooks.maxWorkers(study));
      for (const c of store.candidates(study.id, { stages: ["gating"] })) {
        const key = `c:${c.id}`;
        if (!this.eligible(key, c)) continue;
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
      const spec = store.spec(study);
      const lockKey = benchLockKey(study, spec);
      for (const c of store.candidates(study.id, { stages: ["queued"] })) {
        if (!this.eligible(`c:${c.id}`, c)) continue;
        const list = benchQueues.get(lockKey) ?? [];
        list.push({ study, c });
        benchQueues.set(lockKey, list);
      }
    }
    // Bench: one measurement per lock key, oldest queued first across studies.
    for (const [lockKey, list] of benchQueues) {
      if (this.measuring.has(lockKey)) continue;
      list.sort((a, b) => (a.c.queued_at ?? a.c.submitted_at) - (b.c.queued_at ?? b.c.submitted_at) || a.c.id - b.c.id);
      const next = list[0]!;
      this.measuring.add(lockKey);
      this.start(`c:${next.c.id}`, async () => {
        try {
          await this.guard(next.study, next.c, () => this.measure(next.c.id));
        } finally {
          this.measuring.delete(lockKey);
        }
      });
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
  async gate(candidateId: number, slot = 0): Promise<void> {
    const { store } = this.ctx;
    const c = store.candidate(candidateId)!;
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
    });
    if (prepared.status === "conflict") {
      const reasons = [`does not apply onto current best ${best.slice(0, 10)}: ${prepared.paths.slice(0, 10).join(", ") || clip(prepared.detail, 300)}`];
      const worker = c.thread_id ? store.threadById(c.thread_id) : undefined;
      if (worker && worker.conflict_refunds < CONFLICT_REFUNDS) {
        // Best moved under the worker: not its fault, so the submission is refunded (bounded).
        store.updateThread(worker.id, { submissions: Math.max(0, worker.submissions - 1), conflict_refunds: worker.conflict_refunds + 1 });
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
      const dir = await runner.checkout(study.repo_path!, `${study.slug}-gate-${slot}`, prepared.sha);
      for (const command of spec.oracle.gate) {
        const r = await runner.exec({ cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000 });
        if (r.exitCode !== 0) {
          // One automatic retry for flaky gates.
          const retry = await runner.exec({ cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000 });
          store.event(study.id, retry.exitCode === 0 ? "gate.flaky" : "gate.failed", "plugin", { candidate: c.id, command: clip(command, 200) });
          if (retry.exitCode !== 0) {
            store.updateCandidate(c.id, { gate_output: clip(tail(r.stdout, r.stderr), 3000) });
            this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: [`gate failed${r.timedOut ? " (timeout)" : ""}: ${clip(command, 200)} exited ${retry.exitCode}`] });
            return;
          }
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

  private async buildIfNeeded(runner: HostRunner, spec: StudySpec, dir: string, key: string, sha: string): Promise<{ ok: true } | { ok: false; output: string }> {
    if (!spec.oracle.build) return { ok: true };
    const cacheKey = `${runner.hostId}:${key}`;
    if (this.built.get(cacheKey) === sha) return { ok: true };
    const r = await runner.exec({ cwd: dir, command: spec.oracle.build, timeoutMs: spec.oracle.timeout_minutes * 60_000 });
    if (r.exitCode !== 0) {
      this.built.delete(cacheKey);
      return { ok: false, output: tail(r.stdout, r.stderr) };
    }
    this.built.set(cacheKey, sha);
    return { ok: true };
  }

  makeBench(runner: HostRunner, spec: StudySpec, dirs: Record<Side, string>): Bench {
    return {
      run: async (side: Side): Promise<RunResult> => {
        const r = await runner.exec({ cwd: dirs[side], command: spec.oracle.measure, timeoutMs: spec.oracle.timeout_minutes * 60_000 });
        if (r.exitCode !== 0) throw new BenchError(side, `measure exited ${r.exitCode}${r.timedOut ? " (timeout)" : ""}`, tail(r.stdout, r.stderr));
        const parsed = parseMeasureOutput(r.stdout);
        if (parsed.metrics[spec.metric.name] === undefined) {
          throw new BenchError(side, `measure printed no "METRIC ${spec.metric.name}=<value>" line`, tail(r.stdout, r.stderr));
        }
        return { metrics: parsed.metrics, diag: parsed.diag, durationMs: r.durationMs };
      },
    };
  }

  /** Send a candidate back to rebase + gate + measure against the current best. */
  private requeue(c: CandidateRow, reason: string): void {
    const { store } = this.ctx;
    store.deleteSamples(c.id);
    store.updateCandidate(c.id, { stage: "gating" });
    store.event(c.study_id, "candidate.requeued", "plugin", { candidate: c.id, n: c.n, reason });
  }

  // ---- stage 6-8: measure, decide, confirm (holding the bench lock) ----
  async measure(candidateId: number): Promise<void> {
    const { store } = this.ctx;
    const initial = store.candidate(candidateId)!;
    const study0 = store.study(initial.study_id)!;
    await withBench(this.ctx, study0, "measure", candidateId, async () => {
      const c = store.candidate(candidateId)!;
      if (c.stage !== "queued") return;
      const study = store.study(c.study_id)!;
      const spec = store.spec(study);
      const strategy = strategyFor(spec.oracle.noise);
      const segment = store.segment(study.id, study.segment);
      if (c.against_sha !== study.best_sha) {
        // Best moved while it waited: rebase and gate again before measuring.
        this.requeue(c, "best moved while queued");
        return;
      }
      const against = study.best_sha!;
      const runner = this.runner(study);
      const started = this.ctx.now();
      store.deleteSamples(c.id);
      store.updateCandidate(c.id, { stage: "measuring" });
      store.event(study.id, "measure.started", "plugin", { candidate: c.id, n: c.n, against, host: runner.hostId });
      this.changed(study.id);
      const bestDir = await runner.checkout(study.repo_path!, `${study.slug}-best`, against);
      const candDir = await runner.checkout(study.repo_path!, `${study.slug}-cand`, c.prepared_sha!);
      const bestBuild = await this.buildIfNeeded(runner, spec, bestDir, `${study.slug}-best`, against);
      if (!bestBuild.ok) {
        // Parked until the human resumes (resume resets attempts).
        store.updateCandidate(c.id, { stage: "queued", attempts: MAX_ATTEMPTS });
        await this.hooks.systemPause(study, `oracle broken: best ${against.slice(0, 10)} does not build: ${clip(bestBuild.output, 300)}`);
        return;
      }
      const candBuild = await this.buildIfNeeded(runner, spec, candDir, `${study.slug}-cand`, c.prepared_sha!);
      if (!candBuild.ok) {
        store.updateCandidate(c.id, { gate_output: clip(candBuild.output, 3000) });
        this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: ["build failed on the bench host"] });
        return;
      }
      const bench = this.makeBench(runner, spec, { best: bestDir, candidate: candDir });
      const record = (run: string) => (s: { pair: number; side: Side; metrics: Record<string, number> }) => {
        for (const [metric, value] of Object.entries(s.metrics)) {
          store.addSample({ study_id: study.id, candidate_id: c.id, run, pair: s.pair, side: s.side, metric, value, host_id: runner.hostId });
        }
      };
      const bestCache = study.best_run_sha === against ? (JSON.parse(study.best_run_json ?? "null") as RunResult | null) : null;
      const mde = segment?.mde ?? spec.oracle.protocol.min_effect;
      let outcome: MeasureOutcome;
      let result: VerdictResult;
      try {
        outcome = await strategy.measure({ bench, spec, mde, rng: this.ctx.rng, record: record("measure"), bestCache });
        result = decideVerdict(outcome, spec);
        if (result.verdict === "win" && spec.oracle.protocol.confirm && strategy.kind === "noisy") {
          store.updateCandidate(c.id, { stage: "confirming" });
          const confirmation = await strategy.measure({ bench, spec, mde, rng: this.ctx.rng, record: record("confirm"), bestCache: null });
          result = applyConfirmation(result, decideVerdict(confirmation, spec));
        }
      } catch (e) {
        const seconds = (this.ctx.now() - started) / 1000;
        store.addBenchSeconds(study.id, seconds);
        if (e instanceof BenchError && e.side === "candidate") {
          store.updateCandidate(c.id, { gate_output: clip(e.output, 3000), bench_seconds: seconds });
          this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: [`measure failed on the candidate: ${e.message}`] });
          return;
        }
        store.updateCandidate(c.id, { stage: "queued", ...(e instanceof BenchError ? { attempts: MAX_ATTEMPTS } : {}) });
        store.deleteSamples(c.id);
        if (e instanceof BenchError) {
          await this.hooks.systemPause(study, `oracle broken: measuring best failed: ${e.message} ${clip(e.output, 300)}`);
          return;
        }
        throw e;
      }
      const seconds = (this.ctx.now() - started) / 1000;
      store.addBenchSeconds(study.id, seconds);
      store.event(study.id, "measure.finished", "plugin", { candidate: c.id, n: c.n, against, seconds, decision: result.verdict });
      // Cache a run of best: reused as the baseline by single-run classes, and its DIAG lines go into briefs.
      if (outcome.bestRun && study.best_run_sha !== against) {
        store.updateStudy(study.id, { best_run_json: JSON.stringify(outcome.bestRun), best_run_sha: against });
      }
      store.updateCandidate(c.id, {
        effect: Number.isFinite(outcome.effect) ? outcome.effect : null,
        ci_lo: outcome.ciLo,
        ci_hi: outcome.ciHi,
        metrics_json: JSON.stringify({ best: outcome.bestMetrics, candidate: outcome.candidateMetrics, guardrails: outcome.guardrails, n: outcome.n, mde }),
        diag_json: JSON.stringify(outcome.candidateDiag.slice(0, 40)),
        bench_seconds: c.bench_seconds + seconds,
      });
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
    });
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
    const promoted = await runner.rewordCommit(study.repo_path!, c.prepared_sha!, message);
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
    this.decide(store.candidate(c.id)!, { verdict: "win", reasons: JSON.parse(c.reasons_json ?? "[]") as string[] });
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
      await this.ctx.bb.send(c.thread_id!, withNotice(worker.pending_notice, verdictMessage(c, { submissionsLeft: left, spec })));
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
    for (const study of store.studies()) {
      for (const c of store.candidates(study.id, { stages: ["measuring", "confirming"] })) {
        store.deleteSamples(c.id);
        store.updateCandidate(c.id, { stage: "queued" });
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

function withNotice(notice: string | null, text: string): string {
  return notice ? `${notice}\n\n${text}` : text;
}

function tail(stdout: string, stderr: string): string {
  const both = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  return both.length > 3000 ? `…${both.slice(-3000)}` : both;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
