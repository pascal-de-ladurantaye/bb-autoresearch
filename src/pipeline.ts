// Candidate pipeline: snapshot → scope → (rebase+squash) → gate → queue →
// measure → decide → confirm → promote → report. Each stage is a separate
// method keyed on the candidate's persisted `stage`, so a restart resumes
// from SQLite and every stage is safe to re-run.
import type { Ctx } from "./context.ts";
import type { CandidateRow, StudyRow, ThreadRow } from "./db/store.ts";
import type { HostRunner } from "./host/runner.ts";
import { parseMeasureOutput } from "./metrics.ts";
import { BenchError, strategyFor, type Bench, type MeasureOutcome, type RunResult, type Side } from "./noise.ts";
import { clip, verdictMessage } from "./prompts.ts";
import { checkScope } from "./scope.ts";
import { bestBranch, candidateRef, formatPct, type StudySpec } from "./spec.ts";
import { applyConfirmation, decideVerdict, type VerdictResult } from "./verdict.ts";

export type SubmitResult = { ok: true; candidate: CandidateRow; text: string } | { ok: false; text: string };

const MAX_ATTEMPTS = 3;

export interface PipelineHooks {
  /** A verdict was recorded (counts toward strategist triggers, idea state). */
  onDecided(candidate: CandidateRow): void;
  /** The system must pause the study and tell the human why. */
  systemPause(study: StudyRow, reason: string): Promise<void>;
}

export class Pipeline {
  private current: Promise<void> | null = null;
  private again = false;
  private built = new Map<string, string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: PipelineHooks,
  ) {}

  private runner(study: StudyRow): HostRunner {
    if (!study.host_id) throw new Error(`study ${study.slug} has no host`);
    return this.ctx.bb.hostRunner(study.host_id);
  }

  // ---- stage 1-2: snapshot + scope (synchronous inside submit_candidate) ----
  async submit(study: StudyRow, worker: ThreadRow, summary: string): Promise<SubmitResult> {
    const { store } = this.ctx;
    const spec = store.spec(study);
    if (!["running", "paused"].includes(study.state)) return { ok: false, text: `Study ${study.slug} is ${study.state}; submissions are closed.` };
    if (!worker.thread_id || !worker.worktree_path || !worker.fork_sha) return { ok: false, text: "This worker has no worktree recorded yet; try again in a moment." };
    const pending = store.candidates(study.id, { threadId: worker.thread_id }).find((c) => c.stage !== "decided" || c.reported_at === null);
    if (pending) return { ok: false, text: `c/${pending.n} is still being evaluated (${pending.stage}). End your turn; its verdict arrives as a message.` };
    if (worker.submissions >= spec.agents.max_submissions_per_worker) {
      return { ok: false, text: `Submission cap reached (${spec.agents.max_submissions_per_worker}). Call record_finding, then finish.` };
    }
    if (!study.best_sha) return { ok: false, text: "Study has no best commit yet." };
    const n = store.nextCandidateNumber(study.id);
    const firstLine = clip(summary.split("\n")[0] ?? "", 120);
    const snap = await this.runner(study).snapshot({
      worktreePath: worker.worktree_path,
      message: `autoresearch c/${n}: ${firstLine}`,
      candidateRef: candidateRef(study.slug, n),
      baseSha: worker.fork_sha,
    });
    const candidate = store.tx(() => {
      const c = store.insertCandidate({
        study_id: study.id,
        n,
        idea_id: worker.idea_id,
        thread_id: worker.thread_id,
        sha: snap.sha,
        parent_sha: worker.fork_sha!,
        summary: clip(summary, 4000),
        stage: "submitted",
        changed_paths_json: JSON.stringify(snap.changedPaths.slice(0, 500)),
      });
      store.updateThread(worker.id, { submissions: worker.submissions + 1, nudged_at: null });
      store.event(study.id, "candidate.submitted", worker.thread_id!, { candidate: c.id, n, sha: snap.sha, files: snap.changedPaths.length });
      return c;
    });
    const scope = checkScope(spec.scope, snap);
    if (!scope.ok) {
      const decided = this.decide(candidate, { verdict: "rejected", reasons: scope.reasons }, { reported: true });
      const left = spec.agents.max_submissions_per_worker - worker.submissions - 1;
      return { ok: true, candidate: decided, text: verdictMessage(decided, { submissionsLeft: left, spec }) };
    }
    store.updateCandidate(candidate.id, { stage: "gating" });
    const ahead = store.candidates(study.id, { stages: ["gating", "queued", "measuring", "confirming"] }).filter((c) => c.id !== candidate.id).length;
    this.kick();
    return {
      ok: true,
      candidate: store.candidate(candidate.id)!,
      text:
        `Submitted as c/${n} (${snap.sha.slice(0, 10)}, ${snap.changedPaths.length} files, +${snap.linesAdded}/-${snap.linesDeleted}). ` +
        `Scope check passed. Gates and measurement run now; ${ahead} candidate(s) ahead of you. ` +
        "END YOUR TURN NOW. The verdict arrives as a message.",
    };
  }

  /** Ask the pump to run; coalesces bursts. */
  kick(): void {
    void this.pump().catch((e) => this.ctx.bb.log("error", `pipeline pump: ${errText(e)}`));
  }

  /** Run the pipeline until nothing is left to do. Concurrent callers share one run. */
  pump(): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      await Promise.resolve(); // let the assignment land before any synchronous finally
      try {
        do {
          this.again = false;
          await this.pumpOnce();
        } while (this.again);
      } finally {
        this.current = null;
      }
    })();
    return this.current;
  }

  private async pumpOnce(): Promise<void> {
    const { store } = this.ctx;
    const studies = store.studies(["running", "paused"]);
    for (const study of studies) {
      for (const c of store.candidates(study.id, { stages: ["promoting"] })) await this.guard(study, c, () => this.promote(c.id));
      for (const c of store.candidates(study.id, { stages: ["gating"] })) await this.guard(study, c, () => this.gate(c.id));
    }
    // Bench: oldest queued candidate first, one measurement at a time per host.
    for (const study of studies) {
      const fresh = store.study(study.id)!;
      if (!["running", "paused"].includes(fresh.state)) continue;
      const next = store.candidates(study.id, { stages: ["queued"] }).find((c) => c.attempts < MAX_ATTEMPTS);
      if (next) {
        await this.guard(fresh, next, () => this.measure(next.id));
        this.again = this.again || store.candidates(study.id, { stages: ["queued", "gating"] }).some((c) => c.attempts < MAX_ATTEMPTS);
      }
    }
    for (const study of store.studies()) {
      for (const c of store.candidates(study.id, { stages: ["decided"] }).filter((x) => x.reported_at === null)) await this.report(c.id);
    }
  }

  /** Host failures: retry a few times, then pause the study and notify. */
  private async guard(study: StudyRow, c: CandidateRow, fn: () => Promise<void>): Promise<void> {
    // Parked after repeated failures until the human resumes the study.
    if (c.attempts >= MAX_ATTEMPTS) return;
    try {
      await fn();
    } catch (e) {
      const attempts = c.attempts + 1;
      this.ctx.store.updateCandidate(c.id, { attempts });
      this.ctx.store.event(study.id, "pipeline.error", "plugin", { candidate: c.id, stage: c.stage, attempts, error: clip(errText(e), 500) });
      this.ctx.bb.log("warn", `study ${study.slug} c/${c.n} ${c.stage} failed (attempt ${attempts}): ${errText(e)}`);
      if (attempts >= MAX_ATTEMPTS) {
        await this.hooks.systemPause(study, `pipeline error on c/${c.n} (${c.stage}) after ${attempts} attempts: ${clip(errText(e), 300)}`);
      }
    }
  }

  // ---- stage 3-4: rebase onto best (squash) + gate ----
  async gate(candidateId: number): Promise<void> {
    const { store } = this.ctx;
    const c = store.candidate(candidateId)!;
    const study = store.study(c.study_id)!;
    const spec = store.spec(study);
    const runner = this.runner(study);
    const prepared = await runner.prepareCandidate({
      repoPath: study.repo_path!,
      bestSha: study.best_sha!,
      forkSha: c.parent_sha,
      candidateSha: c.sha,
      message: `autoresearch c/${c.n}: ${clip(c.summary.split("\n")[0] ?? "", 120)}`,
    });
    if (prepared.status === "conflict") {
      this.decide(c, { verdict: "conflict", reasons: [`does not apply onto current best ${study.best_sha!.slice(0, 10)}: ${prepared.paths.slice(0, 10).join(", ") || prepared.detail}`] });
      return;
    }
    store.updateCandidate(c.id, { prepared_sha: prepared.sha, against_sha: study.best_sha });
    if (spec.oracle.gate.length) {
      const dir = await runner.checkout(study.repo_path!, `${study.slug}-gate`, prepared.sha);
      for (const command of spec.oracle.gate) {
        let r = await runner.exec({ cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000 });
        if (r.exitCode !== 0) {
          // One automatic retry for flaky gates.
          const retry = await runner.exec({ cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000 });
          store.event(study.id, retry.exitCode === 0 ? "gate.flaky" : "gate.failed", "plugin", { candidate: c.id, command: clip(command, 200) });
          if (retry.exitCode !== 0) {
            store.updateCandidate(c.id, { gate_output: clip(tail(r.stdout, r.stderr), 3000) });
            this.decide(store.candidate(c.id)!, { verdict: "gate_failed", reasons: [`gate failed${r.timedOut ? " (timeout)" : ""}: ${clip(command, 200)} exited ${retry.exitCode}`] });
            return;
          }
          r = retry;
        }
      }
    }
    store.updateCandidate(c.id, { stage: "queued" });
    store.event(study.id, "candidate.queued", "plugin", { candidate: c.id });
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

  // ---- stage 6-8: measure, decide, confirm ----
  async measure(candidateId: number): Promise<void> {
    const { store } = this.ctx;
    const initial = store.candidate(candidateId)!;
    const study0 = store.study(initial.study_id)!;
    const strategy = strategyFor(store.spec(study0).oracle.noise);
    const lockHost = strategy.benchLock ? study0.host_id! : `${study0.host_id!}:${study0.slug}`;
    await this.ctx.benchLock.run(lockHost, async () => {
      const c = store.candidate(candidateId)!;
      if (c.stage !== "queued") return;
      const study = store.study(c.study_id)!;
      const spec = store.spec(study);
      const segment = store.segment(study.id, study.segment);
      if (c.against_sha !== study.best_sha) {
        // Best moved while queued: rebase again before measuring.
        store.updateCandidate(c.id, { stage: "gating" });
        return;
      }
      const runner = this.runner(study);
      const started = this.ctx.now();
      store.deleteSamples(c.id);
      store.updateCandidate(c.id, { stage: "measuring" });
      const bestDir = await runner.checkout(study.repo_path!, `${study.slug}-best`, study.best_sha!);
      const candDir = await runner.checkout(study.repo_path!, `${study.slug}-cand`, c.prepared_sha!);
      const bestBuild = await this.buildIfNeeded(runner, spec, bestDir, `${study.slug}-best`, study.best_sha!);
      if (!bestBuild.ok) {
        store.updateCandidate(c.id, { stage: "queued" });
        await this.hooks.systemPause(study, `oracle broken: best ${study.best_sha!.slice(0, 10)} does not build: ${clip(bestBuild.output, 300)}`);
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
      const bestCache = study.best_run_sha === study.best_sha ? (JSON.parse(study.best_run_json ?? "null") as RunResult | null) : null;
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
        store.updateCandidate(c.id, { stage: "queued" });
        store.deleteSamples(c.id);
        if (e instanceof BenchError) {
          await this.hooks.systemPause(study, `oracle broken: measuring best failed: ${e.message} ${clip(e.output, 300)}`);
          return;
        }
        throw e;
      }
      const seconds = (this.ctx.now() - started) / 1000;
      store.addBenchSeconds(study.id, seconds);
      // Cache a run of best: reused as the baseline by single-run classes, and its DIAG lines go into briefs.
      if (outcome.bestRun && study.best_run_sha !== study.best_sha) {
        store.updateStudy(study.id, { best_run_json: JSON.stringify(outcome.bestRun), best_run_sha: study.best_sha });
      }
      store.updateCandidate(c.id, {
        effect: Number.isFinite(outcome.effect) ? outcome.effect : null,
        ci_lo: outcome.ciLo,
        ci_hi: outcome.ciHi,
        metrics_json: JSON.stringify({ best: outcome.bestMetrics, candidate: outcome.candidateMetrics, guardrails: outcome.guardrails, n: outcome.n, mde }),
        diag_json: JSON.stringify(outcome.candidateDiag.slice(0, 40)),
        bench_seconds: seconds,
      });
      if (result.verdict === "win") {
        store.updateCandidate(c.id, { stage: "promoting", reasons_json: JSON.stringify(result.reasons) });
        await this.promote(c.id);
      } else {
        this.decide(store.candidate(c.id)!, result);
      }
    });
  }

  // ---- stage 8: promotion (squash + fast-forward best) ----
  async promote(candidateId: number): Promise<void> {
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
      // Best moved under us (M1 concurrency): rebase and re-measure.
      store.updateCandidate(c.id, { stage: "gating" });
      store.event(study.id, "candidate.requeued", "plugin", { candidate: c.id, reason: "best moved before promotion" });
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
    if (!r.ok && r.current !== promoted) throw new Error(`could not fast-forward ${bestBranch(study.slug)}: now at ${r.current}`);
    this.finishPromotion(study, store.candidate(c.id)!, promoted);
  }

  private finishPromotion(study: StudyRow, c: CandidateRow, promoted: string): void {
    const { store } = this.ctx;
    store.tx(() => {
      store.updateStudy(study.id, { best_sha: promoted });
      store.event(study.id, "best.promoted", "plugin", { candidate: c.id, n: c.n, from: c.against_sha, to: promoted, effect: c.effect });
    });
    this.decide(store.candidate(c.id)!, { verdict: "win", reasons: JSON.parse(c.reasons_json ?? "[]") as string[] });
    // Tell other running workers best moved; they're rebased when they next submit.
    for (const w of store.threads(study.id, { role: "worker", states: ["active"] })) {
      if (!w.thread_id || w.thread_id === c.thread_id) continue;
      void this.ctx.bb
        .send(w.thread_id, `[autoresearch] FYI: best moved to ${promoted.slice(0, 10)} (c/${c.n}, ${formatPct(c.effect)}). Your next submission is rebased onto it automatically. No action needed.`)
        .catch(() => undefined);
    }
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
      await this.ctx.bb.send(c.thread_id!, verdictMessage(c, { submissionsLeft: left, spec }));
      store.updateCandidate(c.id, { reported_at: this.ctx.now() });
      store.event(study.id, "verdict.delivered", "plugin", { candidate: c.id, thread: c.thread_id });
    } catch (e) {
      this.ctx.bb.log("warn", `could not deliver verdict for c/${c.n}: ${errText(e)}`);
    }
  }

  /** Un-park candidates that hit the retry limit (on resume). */
  resetAttempts(studyId: string): void {
    for (const c of this.ctx.store.candidates(studyId, { stages: ["submitted", "gating", "queued", "promoting"] })) {
      if (c.attempts) this.ctx.store.updateCandidate(c.id, { attempts: 0 });
    }
  }

  /** Reconciliation: in-flight measurements restart from scratch. */
  reconcile(): { requeued: number } {
    const { store } = this.ctx;
    let requeued = 0;
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
        const scope = checkScope(store.spec(study).scope, { changedPaths: paths, linesAdded: 0, linesDeleted: 0 });
        if (scope.ok) store.updateCandidate(c.id, { stage: "gating" });
        else this.decide(c, { verdict: "rejected", reasons: scope.reasons });
      }
    }
    return { requeued };
  }
}

function tail(stdout: string, stderr: string): string {
  const both = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  return both.length > 3000 ? `…${both.slice(-3000)}` : both;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
