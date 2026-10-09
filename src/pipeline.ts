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
// healthy. Each measurement runs health check → transfer (bundles, clone
// mode) → build (best cached per host) → paired runs as host jobs → verdict
// → confirmation → holdout → promotion. Measurements can be cancelled; a
// host worker restart or an offline host restarts the measurement from
// scratch with its partial samples discarded. Drift checks take a host's
// next free slot every `oracle.drift.every` evaluations.
import { BenchSite, BenchTransferError, makeBench as makeBenchOn, tail } from "./bench.ts";
import { HostMutex, type Ctx } from "./context.ts";
import type { BenchHostRow, CandidateRow, StudyRow, ThreadRow } from "./db/store.ts";
import { driftExpensive, driftNoisy, type DriftResult } from "./drift.ts";
import { checkHealth } from "./health.ts";
import { HOLDOUT_FAIL, runHoldout } from "./holdout.ts";
import { HostJobLostError, RunAbortedError, type HostRunner } from "./host/runner.ts";
import { BenchError, strategyFor, type Bench, type MeasureOutcome, type RunResult, type Side } from "./noise.ts";
import { clip, formatDuration, safeJson, verdictMessage } from "./prompts.ts";
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
  /** A notice for the human (no agent turn). */
  notify(study: StudyRow, kind: string, text: string): Promise<void>;
}

/** Restarts (offline host, worker restart) before a measurement counts as a pipeline error. */
const MAX_RESTARTS = 6;

/** The bench lock key a study's measurements on `hostId` serialize on. */
export function benchLockKey(study: StudyRow, spec: StudySpec, hostId: string): string {
  return strategyFor(spec.oracle.noise).benchLock ? hostId : `${hostId}:${study.slug}`;
}

/** Hold the bench lock of `hostId` for `fn` and record the busy interval (bench utilization, overlap audits). */
export async function withBench<T>(ctx: Ctx, study: StudyRow, hostId: string, kind: "measure" | "profile" | "calibration" | "drift" | "harvest", candidateId: number | null, fn: () => Promise<T>): Promise<T> {
  const key = benchLockKey(study, ctx.store.spec(study), hostId);
  return await ctx.benchLock.run(key, async () => {
    const id = ctx.store.openBenchInterval({ study_id: study.id, host_id: hostId, lock_key: key, kind, candidate_id: candidateId });
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
  /** Latest progress per bench lock key, for the study page. */
  private progressByKey = new Map<string, { studyId: string; hostId: string; text: string; at: number }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: PipelineHooks,
  ) {}

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
    this.ctx.store.syncBenchHosts(study.id, [{ entry: "local", hostId: study.host_id, name: "local", mode: "shared" }]);
    return this.ctx.store.benchHosts(study.id);
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
    // Harvesting studies finish their in-flight candidates (no new submissions arrive).
    const studies = store.studies(["running", "paused", "harvesting"]);
    const queued: Array<{ study: StudyRow; spec: StudySpec; c: CandidateRow }> = [];
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
      for (const c of store.candidates(study.id, { stages: ["queued"] })) {
        if (this.eligible(`c:${c.id}`, c)) queued.push({ study, spec, c });
      }
      // Drift checks are due on idle hosts even with nothing queued.
      if (study.state === "running") for (const h of this.benchHosts(study)) this.maybeStartDrift(study, spec, h);
    }
    // Bench: one measurement per lock key, oldest queued first across studies,
    // each to the first free, online, healthy host of its study.
    queued.sort((a, b) => (a.c.queued_at ?? a.c.submitted_at) - (b.c.queued_at ?? b.c.submitted_at) || a.c.id - b.c.id);
    const now = this.ctx.now();
    for (const { study, spec, c } of queued) {
      for (const h of this.benchHosts(study)) {
        const lockKey = benchLockKey(study, spec, h.host_id);
        if (this.measuring.has(lockKey) || this.drifting.has(lockKey)) continue;
        if (h.status === "offline" || (h.deferred_until ?? 0) > now) continue;
        if (study.state === "running" && this.maybeStartDrift(study, spec, h)) continue;
        this.measuring.add(lockKey);
        this.start(`c:${c.id}`, async () => {
          try {
            await this.guard(study, c, () => this.measure(c.id, h.host_id));
          } finally {
            this.measuring.delete(lockKey);
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
        const job = { cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: `gate c/${c.n}` };
        const r = await runner.run(job);
        if (r.exitCode !== 0) {
          // One automatic retry for flaky gates.
          const retry = await runner.run(job);
          store.event(study.id, retry.exitCode === 0 ? "gate.flaky" : "gate.failed", "plugin", { candidate: c.id, command: clip(command, 200) });
          if (retry.exitCode !== 0) {
            store.updateCandidate(c.id, { gate_output: clip(tail(r), 3000) });
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
      const health = await checkHealth(this.ctx, study, host, spec, "measure", (kind, text) => this.hooks.notify(study, kind, text));
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
        const seconds = (this.ctx.now() - started) / 1000;
        store.addBenchSeconds(study.id, seconds);
        const fresh = store.candidate(c.id)!;
        if (fresh.stage === "decided") return; // archived while measuring
        if (entry.reason !== null) {
          this.restartMeasurement(fresh, entry.reason, entry.regate);
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
    store.event(study.id, "measure.started", "plugin", { candidate: c.id, n: c.n, against, host: host.host_id, mode: host.mode });
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
    const bench = site.bench(spec, dirs, { signal, label: `c/${c.n}`, onProgress: (line) => progress(line) });
    let runNo = 0;
    const record = (run: string) => (s: { pair: number; side: Side; metrics: Record<string, number> }) => {
      runNo += 1;
      progress(`${run} pair ${s.pair + 1} ${s.side} (run ${runNo})`);
      for (const [metric, value] of Object.entries(s.metrics)) {
        store.addSample({ study_id: study.id, candidate_id: c.id, run, pair: s.pair, side: s.side, metric, value, host_id: host.host_id });
      }
    };
    const bestCache = study.best_run_sha === against ? (JSON.parse(study.best_run_json ?? "null") as RunResult | null) : null;
    const baseline = safeJson<{ sha: string; runs: RunResult[] }>(store.benchHost(study.id, host.host_id)?.baseline_json ?? null);
    const mde = Math.max(segment?.mde ?? spec.oracle.protocol.min_effect, host.mde ?? 0);
    const noiseFloor = host.noise_floor ?? segment?.noise_floor ?? null;
    const outcome = await strategy.measure({
      bench,
      spec,
      mde,
      rng: this.ctx.rng,
      record: record("measure"),
      bestCache,
      baseline: baseline?.sha === against ? baseline.runs : null,
      noiseFloor,
      signal,
    });
    let result = decideVerdict(outcome, spec);
    if (result.verdict === "win" && spec.oracle.protocol.confirm && strategy.kind === "noisy") {
      store.updateCandidate(c.id, { stage: "confirming" });
      this.changed(study.id);
      const confirmation = await strategy.measure({ bench, spec, mde, rng: this.ctx.rng, record: record("confirm"), bestCache: null, signal });
      result = applyConfirmation(result, decideVerdict(confirmation, spec));
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
    const seconds = (this.ctx.now() - started) / 1000;
    store.addBenchSeconds(study.id, seconds);
    store.event(study.id, "measure.finished", "plugin", { candidate: c.id, n: c.n, against, seconds, decision: result.verdict, host: host.host_id });
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
        `Bench host ${host.name} has been offline for ${Math.round((now - since) / 60_000)} min. Measurements on it wait at the measure step; workers keep editing until backpressure stops new spawns.`,
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
    if (this.measuring.has(lockKey) || this.drifting.has(lockKey) || this.jobs.has(key)) return false;
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
        if (!result.ok) {
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
    for (const h of this.benchHosts(study)) this.ctx.store.updateBenchHost(studyId, h.host_id, { evals_since_drift: Math.max(spec.oracle.drift.every, 1), deferred_until: null });
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
    // Best moved: every bench host's cached best build is stale.
    for (const h of this.benchHosts(study)) this.site(study, h).invalidateBest();
    store.event(study.id, "bench.cache_invalidated", "plugin", { best: promoted, hosts: this.benchHosts(study).map((h) => h.host_id) });
    // expensive: the winner's confirmation runs are the new best's baseline on the host that measured it.
    const pending = this.pendingBaselines.get(c.id);
    this.pendingBaselines.delete(c.id);
    if (pending) store.updateBenchHost(study.id, pending.hostId, { baseline_json: JSON.stringify({ sha: promoted, runs: pending.runs }) });
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

function withNotice(notice: string | null, text: string): string {
  return notice ? `${notice}\n\n${text}` : text;
}


export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
