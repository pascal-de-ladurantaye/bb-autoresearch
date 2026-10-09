// The study engine: lifecycle transitions, the control loop (spawn, idle
// handling, strategist rounds, budget), worker tools, and reconciliation.
// Only this module and the pipeline change study state.
import { randomUUID } from "node:crypto";
import { resolveBenchHosts } from "./bench.ts";
import { recordCalibration, runCalibration, type CalibrationReport } from "./calibration.ts";
import type { Ctx } from "./context.ts";
import type { BenchHostRow, CandidateRow, IdeaRow, ResolvedBenchHost, StudyRow, ThreadRow } from "./db/store.ts";
import { checkHealth } from "./health.ts";
import { BENCH_BOUND_STAGES, errText, IN_FLIGHT_STAGES, Pipeline, withBench } from "./pipeline.ts";
import { clip, formatDuration, nudgeMessage, safeJson, strategistDigest, workerBrief } from "./prompts.ts";
import { budgetExhausted, idleAction, meanThinkSeconds, pickIdea, repeatsLostIdea, roundTrigger, spawnSlots, targetWorkers, titleKey, type RoundTrigger, type ThinkSample } from "./scheduler.ts";
import { bestBranch, formatPct, oracleHash, parseSpec, type StudySpec } from "./spec.ts";

export type Role = "worker" | "strategist" | "creator";

/**
 * Who changed a human control. BB gives plugins no caller-thread identity
 * for RPC (app, CLI and agents are all "client"), and the CLI's thread id
 * comes from the invoking shell, so this is recorded, not trusted.
 */
export interface Caller {
  via: "cli" | "rpc" | "internal";
  threadId?: string | null;
  pluginId?: string | null;
}

export function callerActor(c: Caller): string {
  if (c.via === "cli") return c.threadId ? `cli:thread:${c.threadId}` : "cli:human";
  if (c.via === "rpc") return c.pluginId ? `rpc:plugin:${c.pluginId}` : "rpc:client";
  return "plugin";
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

const LIVE_WORKER_STATES = ["spawning", "active", "finishing"] as const;

export class Engine {
  readonly pipeline: Pipeline;
  private currentTick: Promise<void> | null = null;
  private tickAgain = false;
  private calibrations = new Map<string, Promise<void>>();

  constructor(readonly ctx: Ctx) {
    this.pipeline = new Pipeline(ctx, {
      onDecided: (c) => this.onDecided(c),
      systemPause: (study, reason) => this.systemPause(study.id, reason),
      maxWorkers: (study) => this.maxWorkers(study),
      bestMoved: (study, winner, promoted) => void this.notifyBestMoved(study, winner, promoted).catch((e) => this.ctx.bb.log("warn", `best-moved notice: ${errText(e)}`)),
      notify: (study, kind, text) => this.notify(study.id, kind, text),
    });
  }

  private get store() {
    return this.ctx.store;
  }

  study(slug: string): StudyRow {
    const s = this.store.study(slug);
    if (!s) throw new EngineError(`no study named ${JSON.stringify(slug)}; see \`bb study list\``);
    return s;
  }

  // ---------------------------------------------------------------- roles

  /**
   * Role for tool selection. Synchronous (bb.agents.configure is sync; the
   * database is too). Metadata alone never grants a role: worker metadata
   * must match a live worker row, and strategists are known only by row.
   */
  roleForConfigure(threadId: string, metadata: Readonly<Record<string, unknown>>): Role | null {
    const row = this.store.threadById(threadId);
    if (metadata.role === "worker") {
      const token = typeof metadata.spawnToken === "string" ? metadata.spawnToken : null;
      const w = row ?? (token ? this.store.threadByToken(token) : undefined);
      if (!w || w.role !== "worker" || !LIVE_WORKER_STATES.includes(w.state as never)) return null;
      if (w.thread_id !== null && w.thread_id !== threadId) return null;
      const study = this.store.study(w.study_id);
      if (!study || study.slug !== metadata.study) return null;
      return "worker";
    }
    if (row?.role === "strategist" && row.state === "active") return "strategist";
    if (row) return null;
    return "creator";
  }

  /** Role check for every tool call, against the plugin's own threads table. */
  async requireRole(threadId: string, role: Role): Promise<{ study: StudyRow | null; row: ThreadRow | null }> {
    let row = this.store.threadById(threadId) ?? null;
    if (!row && role === "worker") row = await this.bindBySpawnToken(threadId);
    if (role === "creator") {
      if (row && row.role !== "strategist") throw new EngineError("study_propose is not available to worker threads");
      return { study: row ? (this.store.study(row.study_id) ?? null) : null, row };
    }
    if (!row || row.role !== role) throw new EngineError(`this tool is only available to autoresearch ${role} threads`);
    if (role === "worker" && !LIVE_WORKER_STATES.includes(row.state as never)) throw new EngineError(`this worker is ${row.state}`);
    if (role === "strategist" && row.state !== "active") throw new EngineError("this study thread is no longer active");
    const study = this.store.study(row.study_id) ?? null;
    if (!study) throw new EngineError("study not found");
    return { study, row };
  }

  /** A tool call can race the spawn call's return; bind the thread id through the spawn token in its metadata. */
  private async bindBySpawnToken(threadId: string): Promise<ThreadRow | null> {
    const meta = await this.ctx.bb.getMetadata(threadId).catch(() => ({}) as Record<string, unknown>);
    const token = typeof meta.spawnToken === "string" ? meta.spawnToken : null;
    if (!token) return null;
    const row = this.store.threadByToken(token);
    if (!row || row.thread_id !== null) return null;
    this.store.updateThread(row.id, { thread_id: threadId, state: row.state === "spawning" ? "active" : row.state });
    return this.store.threadRow(row.id) ?? null;
  }

  // ------------------------------------------------------ human controls

  async proposeStudy(threadId: string, projectId: string, toml: string): Promise<string> {
    const parsed = parseSpec(toml);
    if (!parsed.ok) throw new EngineError(`Spec is invalid:\n${parsed.errors.map((e) => `- ${e}`).join("\n")}`);
    const { spec, warnings } = parsed;
    const existingRow = this.store.threadById(threadId);
    let study: StudyRow | undefined;
    let hostId: string;
    if (existingRow) {
      study = this.store.study(existingRow.study_id);
      if (!study || study.slug !== spec.study.slug) {
        throw new EngineError(`This thread already drives study ${study?.slug ?? "?"}; a revised spec must keep that slug.`);
      }
      if (study.state === "archived") throw new EngineError(`Study ${study.slug} is archived.`);
      if (this.calibrations.has(study.id)) throw new EngineError("Calibration is running; wait for it before revising the spec.");
      hostId = study.host_id!;
    } else {
      if (this.store.study(spec.study.slug)) throw new EngineError(`A study named ${spec.study.slug} already exists; pick another slug.`);
      const primary = await this.ctx.bb.primaryHostId();
      if (!primary) throw new EngineError("The BB server has no local machine identity; studies edit on the server's own machine.");
      hostId = primary;
    }
    const resolved = resolveBenchHosts(spec.oracle.bench_hosts, await this.ctx.bb.listHosts().catch(() => []), hostId);
    if (!resolved.ok) throw new EngineError(`Spec is invalid:\n${resolved.errors.map((e) => `- ${e}`).join("\n")}`);
    if (!study) {
      const repo = await this.ctx.bb.projectCheckout(projectId, hostId);
      if (!repo) throw new EngineError("This project has no checkout on the server's machine; the edit host must be the server's machine.");
      const id = `std_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
      this.store.tx(() => {
        this.store.insertStudy({ id, slug: spec.study.slug, project_id: projectId, host_id: hostId, repo_path: repo, study_thread_id: threadId });
        this.store.insertThread({ study_id: id, role: "strategist", thread_id: threadId, state: "active" });
        this.store.event(id, "study.created", threadId, { slug: spec.study.slug, project: projectId, repo });
      });
      study = this.store.study(id)!;
      await this.ctx.bb.setMetadata(threadId, { study: spec.study.slug, role: "strategist" }).catch((e) => this.ctx.bb.log("warn", `metadata: ${errText(e)}`));
    }
    const benchText = resolved.hosts.map((h) => `${h.name} (${h.mode === "clone" ? "own clone, git bundles" : "local checkouts"})`).join(", ");
    const hasRun = this.store.hasRun(study.id);
    if (hasRun) {
      // Mid-run: the study keeps its active spec until the human approves this one.
      const active = this.store.spec(study);
      const changed = oracleHash(active) !== oracleHash(spec);
      const version = this.store.addSpecVersion(study.id, toml, spec, oracleHash(spec), threadId, { bench: resolved.hosts, pending: true });
      this.publish(study.id);
      await this.notify(study.id, "spec.proposed", `Spec v${version} for \`${study.slug}\` was proposed and waits for approval (${changed ? "the oracle changed: approving starts a new segment with recalibration, `bb study calibrate`" : "oracle unchanged: `bb study approve` applies it"}).`);
      return [
        `Spec v${version} recorded for \`${spec.study.slug}\`; the study keeps running on spec v${study.spec_version} until the human approves it.`,
        changed
          ? `The oracle changed (${oracleHash(active)} → ${oracleHash(spec)}). Approval (\`bb study calibrate ${spec.study.slug}\`) moves the study to Calibrating: in-flight measurements are cancelled, best is calibrated under the new oracle, and a new segment starts once the human runs \`bb study start\`.`
          : `The oracle is unchanged, so no recalibration is needed: \`bb study approve ${spec.study.slug}\` applies it.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ].join("\n");
    }
    const version = this.store.addSpecVersion(study.id, toml, spec, oracleHash(spec), threadId, { bench: resolved.hosts });
    if (study.state === "calibrating") this.store.setStudyState(study.id, "draft", threadId, { reason: "spec revised" });
    this.publish(study.id);
    return [
      `Study \`${spec.study.slug}\` drafted with spec v${version} (oracle ${oracleHash(spec)}), repo ${study.repo_path} on this machine. Bench: ${benchText}.`,
      ...warnings.map((w) => `Warning: ${w}`),
      "",
      "Next steps are the human's: review with `bb study show " + spec.study.slug + "`, then approve and calibrate with `bb study calibrate " + spec.study.slug + "`.",
      "Calibration runs the gates on the base commit and repeated A/A measurements on every bench host to find the noise floor. Then `bb study start` begins the run.",
      "Seed ideas now with `bb study ideas add` (human) or wait for your first strategist round.",
    ].join("\n");
  }

  /** Bench hosts of a spec version (pre-M2 versions: the edit host, shared). */
  private benchOf(study: StudyRow, version: number): ResolvedBenchHost[] {
    const r = this.store.resolvedBench(study.id, version);
    return r.length ? r : [{ entry: "local", hostId: study.host_id!, name: "local", mode: "shared" }];
  }

  /** Apply a pending spec whose oracle is unchanged (budget, agents, scope limits): no recalibration. */
  approve(slug: string, actor: string): string {
    const study = this.study(slug);
    const pending = study.pending_spec_version;
    if (pending === null) throw new EngineError(`${slug} has no pending spec to approve`);
    const next = this.store.specOfVersion(study.id, pending);
    if (oracleHash(next) !== oracleHash(this.store.spec(study))) {
      throw new EngineError(`spec v${pending} changes the oracle; approve it with \`bb study calibrate ${slug}\` (new segment, recalibration)`);
    }
    this.store.approveSpec(study.id, pending, actor);
    this.store.tx(() => {
      this.store.updateStudy(study.id, { spec_version: pending, pending_spec_version: null });
      this.store.event(study.id, "spec.applied", actor, { version: pending, from: study.spec_version, recalibrated: false });
    });
    this.publish(study.id);
    this.kick();
    return `${slug}: spec v${pending} applied (oracle unchanged, segment ${study.segment} continues).`;
  }

  /**
   * Approve the current (or pending) spec and start calibration in the
   * background. Before Running this is the first calibration. Mid-run it is
   * an oracle change: in-flight measurements are cancelled, queued
   * candidates go back to the gate, best is calibrated under the new oracle,
   * and `bb study start` then opens a new segment.
   */
  async calibrate(slug: string, actor: string): Promise<string> {
    const study = this.study(slug);
    if (this.calibrations.has(study.id)) return `Calibration of ${slug} is already running.`;
    const midRun = this.store.hasRun(study.id);
    if (!midRun) {
      if (!["draft", "calibrating"].includes(study.state)) throw new EngineError(`study ${slug} is ${study.state}`);
      if (this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] }).length) throw new EngineError("workers are still running");
      this.store.approveSpec(study.id, study.spec_version, actor);
      this.store.syncBenchHosts(study.id, this.benchOf(study, study.spec_version));
      this.store.tx(() => {
        this.store.updateStudy(study.id, { calibration_status: "running", calibration_json: null, calibration_approved_at: null });
        this.store.setStudyState(study.id, "calibrating", actor, { spec_version: study.spec_version });
      });
      this.startCalibrationJob(study.id);
      return `Spec v${study.spec_version} approved. Calibrating ${slug}: gates on the base commit, then A/A measurement on ${this.store.benchHosts(study.id).length} bench host(s). Check progress with \`bb study show ${slug}\`.`;
    }
    if (study.state === "archived") throw new EngineError(`${slug} is archived`);
    const version = study.pending_spec_version ?? study.spec_version;
    // Measurements under the old oracle stop now; queued candidates are gated again under the new one.
    const cancelled = this.pipeline.cancelMeasurements((e) => e.studyId === study.id, "oracle change: recalibrating", { regate: true });
    const regated = this.store.candidates(study.id, { stages: ["queued"] });
    this.store.approveSpec(study.id, version, actor);
    this.store.tx(() => {
      for (const c of regated) {
        this.store.deleteSamples(c.id);
        this.store.updateCandidate(c.id, { stage: "gating" });
      }
      this.store.updateStudy(study.id, {
        prev_spec_version: study.spec_version,
        spec_version: version,
        pending_spec_version: null,
        calibration_status: "running",
        calibration_json: null,
        calibration_approved_at: null,
      });
      this.store.setStudyState(study.id, "calibrating", actor, { spec_version: version, from_spec: study.spec_version, mid_run: true });
      this.store.event(study.id, "segment.recalibrating", actor, { from_segment: study.segment, spec_version: version, cancelled, regated: regated.length });
    });
    this.store.syncBenchHosts(study.id, this.benchOf(study, version));
    this.startCalibrationJob(study.id);
    this.publish(study.id);
    return `Spec v${version} approved for ${slug}: recalibrating on the current best (${cancelled} measurement(s) cancelled, ${regated.length} queued candidate(s) sent back to the gate). Workers keep editing; \`bb study start ${slug}\` approves the calibration and opens segment ${study.segment + 1}.`;
  }

  private startCalibrationJob(studyId: string): void {
    const job = (async () => {
      try {
        const report = await runCalibration(this.ctx, this.pipeline, studyId);
        const study = this.store.study(studyId)!;
        if (!report.ok && study.prev_spec_version !== null && this.store.hasRun(study.id)) {
          // A new oracle that fails calibration mid-run: keep the old one and pause.
          this.restorePreviousSpec(study, report);
          return;
        }
        await recordCalibration(this.ctx, study, report);
        await this.notify(studyId, report.ok ? "calibration.ready" : "calibration.failed", calibrationNotice(this.store.study(studyId)!, report));
      } catch (e) {
        this.ctx.bb.log("error", `calibration failed: ${errText(e)}`);
        this.store.tx(() => {
          this.store.updateStudy(studyId, { calibration_status: "failed", calibration_json: JSON.stringify({ ok: false, problems: [errText(e)] }) });
          this.store.setStudyState(studyId, "draft", "plugin", { reason: "calibration error", error: clip(errText(e), 500) });
        });
      } finally {
        this.calibrations.delete(studyId);
        this.publish(studyId);
      }
    })();
    this.calibrations.set(studyId, job);
  }

  private restorePreviousSpec(study: StudyRow, report: CalibrationReport): void {
    const prev = study.prev_spec_version!;
    this.store.tx(() => {
      this.store.updateStudy(study.id, { spec_version: prev, prev_spec_version: null, calibration_status: "ready", calibration_json: JSON.stringify(report), calibration_approved_at: this.ctx.now() });
      this.store.setStudyState(study.id, "paused", "plugin", { reason: `the new oracle (spec v${study.spec_version}) failed calibration; kept spec v${prev}`, system: true });
    });
    this.store.syncBenchHosts(study.id, this.benchOf(study, prev));
    void this.notify(
      study.id,
      "calibration.failed",
      `Recalibration of \`${study.slug}\` under spec v${study.spec_version} failed, so the study is back on spec v${prev} (segment ${study.segment}) and paused.\n${report.problems.map((p) => `- ${clip(p, 500)}`).join("\n")}\nResume with \`bb study resume ${study.slug}\`, or propose a fixed spec.`,
    );
  }

  async waitForCalibration(slug: string, timeoutMs: number): Promise<void> {
    const study = this.study(slug);
    const job = this.calibrations.get(study.id);
    if (!job) return;
    await Promise.race([job, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Approve the calibration and start running (or resume a paused study). */
  async start(slug: string, actor: string): Promise<string> {
    const study = this.study(slug);
    if (study.state === "paused") return this.resume(slug, actor);
    if (study.state === "running") return `${slug} is already running.`;
    if (study.state !== "calibrating" || study.calibration_status !== "ready") {
      throw new EngineError(`${slug} needs a finished calibration first (state ${study.state}, calibration ${study.calibration_status ?? "none"}); run \`bb study calibrate ${slug}\``);
    }
    const midRun = this.store.hasRun(study.id);
    this.store.tx(() => {
      this.store.updateStudy(study.id, { calibration_approved_at: this.ctx.now(), prev_spec_version: null });
      this.store.event(study.id, "calibration.approved", actor, { segment: study.segment, mid_run: midRun });
      this.store.setStudyState(study.id, "running", actor);
    });
    if (midRun) {
      this.pipeline.resetAttempts(study.id);
      this.kick();
      const seg = this.store.segment(study.id, study.segment);
      return `${slug} is running again in segment ${study.segment} (oracle ${seg?.oracle_hash ?? "?"}, MDE ${formatPct(seg?.mde ?? null)}).`;
    }
    // Strategist tools apply when the provider session next starts: release
    // the study thread's runtime so the first round starts a fresh session.
    if (study.study_thread_id) {
      const t = await this.ctx.bb.getThread(study.study_thread_id).catch(() => null);
      if (t && t.status === "idle") await this.ctx.bb.stop(study.study_thread_id).catch(() => undefined);
    }
    this.kick();
    const spec = this.store.spec(study);
    return `${slug} is running with up to ${this.maxWorkers(this.store.study(study.id)!)} worker(s) (max_workers ${spec.budget.max_workers}; W adapts to think and eval times). The study thread gets strategist rounds.`;
  }

  /** Human control: override max_workers (null returns to the spec's value). */
  setConcurrency(slug: string, maxWorkers: number | null, actor: string): string {
    const study = this.study(slug);
    if (study.state === "archived") throw new EngineError(`${slug} is archived`);
    if (maxWorkers !== null && (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 64)) throw new EngineError("concurrency must be an integer from 1 to 64");
    const spec = this.store.spec(study);
    // A control can only lower concurrency below the approved spec, never raise it.
    const clamped = maxWorkers === null ? null : Math.min(maxWorkers, spec.budget.max_workers);
    this.store.tx(() => {
      this.store.updateStudy(study.id, { max_workers_override: clamped === spec.budget.max_workers ? null : clamped });
      this.store.event(study.id, "study.concurrency", actor, { requested: maxWorkers, max_workers: clamped, clamped: clamped !== maxWorkers });
    });
    this.publish(study.id);
    this.kick();
    if (clamped === null) return `${slug}: max workers back to the spec's ${spec.budget.max_workers}.`;
    const note = clamped !== maxWorkers ? ` (clamped from ${maxWorkers}: the approved spec allows at most ${spec.budget.max_workers}; raise it with a spec change)` : "";
    return `${slug}: max workers set to ${clamped}${note}. Running workers above the limit finish their current idea.`;
  }

  /**
   * Audit a human control: an event with the caller information BB gives
   * (via, thread id from the CLI's environment, plugin id for plugin RPC)
   * and which of the study's own agent turns were running at that moment,
   * plus a notice. The study thread is marked unread only when a study agent
   * turn was running (the case worth a look).
   */
  async auditControl(slug: string, kind: string, caller: Caller, detail: string, data: Record<string, unknown> = {}): Promise<void> {
    const study = this.store.study(slug);
    if (!study) return;
    const agents = [
      ...this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] }),
      ...this.store.threads(study.id, { role: "strategist", states: ["active"] }),
    ].filter((t) => t.thread_id);
    const active: string[] = [];
    for (const t of agents) {
      const info = await this.ctx.bb.getThread(t.thread_id!).catch(() => null);
      if (info?.status === "active" || info?.status === "starting") active.push(`${t.thread_id} (${t.role === "worker" ? "worker" : "study thread"})`);
    }
    const actor = callerActor(caller);
    this.store.event(study.id, `control.${kind}`, actor, { ...data, via: caller.via, thread: caller.threadId ?? null, plugin: caller.pluginId ?? null, active_agent_turns: active });
    const text = `Control: ${detail} (via ${actor}).${active.length ? ` Study agent turn(s) running at that moment: ${active.join(", ")}. BB does not identify RPC callers; if you did not do this, check those threads.` : ""}`;
    await this.notify(study.id, `control.${kind}`, text, { quiet: active.length === 0 });
  }

  /** Effective max_workers: the human override, else the spec. */
  maxWorkers(study: StudyRow): number {
    const spec = this.store.spec(study);
    return Math.min(this.ctx.config.workerCeiling, study.max_workers_override ?? spec.budget.max_workers);
  }

  pause(slug: string, actor: string, reason = "paused by human"): string {
    const study = this.study(slug);
    if (study.state !== "running") throw new EngineError(`${slug} is ${study.state}, not running`);
    this.store.setStudyState(study.id, "paused", actor, { reason });
    this.publish(study.id);
    return `${slug} paused. No new workers start; running workers finish their current submission.`;
  }

  resume(slug: string, actor: string): string {
    const study = this.study(slug);
    if (study.state !== "paused") throw new EngineError(`${slug} is ${study.state}, not paused`);
    this.pipeline.resetAttempts(study.id);
    this.store.setStudyState(study.id, "running", actor);
    this.kick();
    return `${slug} resumed.`;
  }

  async archiveStudy(slug: string, actor: string): Promise<string> {
    const study = this.study(slug);
    if (study.state === "archived") return `${slug} is already archived.`;
    let stopped = 0;
    for (const w of this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] })) {
      await this.endWorker(w, "abandoned", "study archived");
      stopped += 1;
    }
    for (const c of this.store.candidates(study.id, { stages: ["submitted", "gating", "queued", "measuring", "confirming"] })) {
      this.pipeline.decide(c, { verdict: "inconclusive", reasons: ["study archived before evaluation finished"] }, { reported: true });
    }
    // Stop host jobs still measuring for this study (their candidates are decided above).
    this.pipeline.cancelMeasurements((e) => e.studyId === study.id, "study archived");
    const s = this.store.study(study.id)!;
    let clones = 0;
    for (const h of this.store.benchHosts(s.id, { all: true })) {
      if (h.mode !== "clone") continue;
      const runner = this.ctx.bb.hostRunner(h.host_id);
      try {
        const repo = h.repo_path ?? (await runner.benchRepo(s.slug)).path;
        await runner.removeCheckouts(repo, `${s.slug}-bench-`);
        if (await runner.removeBenchRepo(s.slug)) clones += 1;
      } catch (e) {
        this.ctx.bb.log("warn", `bench clone cleanup on ${h.host_id}: ${errText(e)}`);
      }
    }
    if (s.host_id && s.repo_path) {
      await this.ctx.bb.hostRunner(s.host_id).removeCheckouts(s.repo_path, `${s.slug}-`).catch((e) => this.ctx.bb.log("warn", `checkout cleanup: ${errText(e)}`));
    }
    this.store.tx(() => {
      for (const t of this.store.threads(study.id, { role: "strategist", states: ["active"] })) this.store.updateThread(t.id, { state: "finished", ended_at: this.ctx.now(), end_reason: "study archived" });
      this.store.setStudyState(study.id, "archived", actor);
    });
    this.publish(study.id);
    return `${slug} archived: ${stopped} worker(s) stopped, bench checkouts removed${clones ? `, ${clones} bench clone(s) deleted` : ""}. Refs under refs/studies/${slug}/ and the branch ${bestBranch(slug)} are kept.`;
  }

  addIdea(slug: string, idea: { title: string; rationale?: string; theme?: string; priority?: number; pinned?: boolean; startRef?: string | null; variationOf?: number | null }, actor: string, source: IdeaRow["source"] = "human"): IdeaRow {
    const study = this.study(slug);
    if (study.state === "archived") throw new EngineError(`${slug} is archived`);
    const title = idea.title.trim();
    if (title.length < 3) throw new EngineError("idea title is too short");
    const startRef = this.normalizeStartRef(study, idea.startRef ?? null);
    const variationOf = this.resolveVariation(study, idea.variationOf ?? null, startRef);
    const row = this.store.addIdea(study.id, { title: clip(title, 200), rationale: clip(idea.rationale ?? "", 2000), theme: clip(idea.theme ?? "", 60), source, priority: idea.priority ?? 0, pinned: idea.pinned ?? source === "human", start_ref: startRef, variation_of: variationOf }, actor);
    this.publish(study.id);
    this.kick();
    return row;
  }

  /** `c/12` or `refs/studies/<slug>/c/12` → `c/12`, checked against the study's candidates. */
  private normalizeStartRef(study: StudyRow, ref: string | null): string | null {
    if (!ref) return null;
    const m = /^(?:refs\/studies\/[a-z0-9-]+\/)?c\/(\d+)$/u.exec(ref.trim());
    if (!m) throw new EngineError(`start_ref ${JSON.stringify(ref)}: use a candidate like "c/12"`);
    if (!this.store.candidateByN(study.id, Number(m[1]))) throw new EngineError(`start_ref c/${m[1]}: no such candidate`);
    return `c/${m[1]}`;
  }

  /** Explicit variation, or implicitly the idea of the candidate an idea starts from. */
  private resolveVariation(study: StudyRow, variationOf: number | null, startRef: string | null): number | null {
    if (variationOf !== null) {
      const parent = this.store.idea(variationOf);
      if (!parent || parent.study_id !== study.id) throw new EngineError(`variation_of #${variationOf}: no such idea`);
      return parent.id;
    }
    if (startRef) return this.store.candidateByN(study.id, Number(startRef.slice(2)))?.idea_id ?? null;
    return null;
  }

  private lostTitles(studyId: string): Set<string> {
    return new Set(this.store.ideas(studyId, ["lost"]).map((i) => titleKey(i.title)));
  }

  /** Human control on the Ideas board: priority and pin. */
  updateIdea(slug: string, id: number, patch: { priority?: number; pinned?: boolean }, actor: string): IdeaRow {
    const study = this.study(slug);
    const idea = this.store.idea(id);
    if (!idea || idea.study_id !== study.id) throw new EngineError(`idea #${id} not found`);
    if (patch.priority !== undefined) this.store.setIdeaPriority(id, Math.max(-100, Math.min(100, patch.priority)), actor);
    if (patch.pinned !== undefined) this.store.setIdeaPinned(id, patch.pinned, actor);
    this.publish(study.id);
    this.kick();
    return this.store.idea(id)!;
  }

  /** Human control: put queued ideas in this order (first runs first). */
  reorderIdeas(slug: string, ids: number[], actor: string): void {
    const study = this.study(slug);
    const valid = ids.filter((id) => this.store.idea(id)?.study_id === study.id).slice(0, 200);
    this.store.tx(() => valid.forEach((id, i) => this.store.setIdeaPriority(id, Math.max(-100, 100 - i), actor)));
    this.publish(study.id);
  }

  /** Human veto: a queued idea is retired and never assigned. */
  vetoIdea(slug: string, id: number, reason: string, actor: string): void {
    const study = this.study(slug);
    const idea = this.store.idea(id);
    if (!idea || idea.study_id !== study.id) throw new EngineError(`idea #${id} not found`);
    if (idea.status !== "queued") throw new EngineError(`idea #${id} is ${idea.status}; only queued ideas can be vetoed`);
    this.store.setIdeaStatus(id, "retired", actor, clip(`vetoed by the human${reason ? `: ${reason}` : ""}`, 500));
    this.publish(study.id);
  }

  // -------------------------------------------------------- worker tools

  async submit(threadId: string, summary: string): Promise<string> {
    const { study, row } = await this.requireRole(threadId, "worker");
    let worker = row!;
    if (!worker.worktree_path) {
      await this.resolveWorktree(worker);
      worker = this.store.threadRow(worker.id)!;
    }
    return (await this.pipeline.submit(study!, worker, summary)).text;
  }

  recordFinding(threadId: string, args: { outcome: string; learned: string; revisit_if?: string; evidence?: string; candidate?: number }): Promise<string> {
    return this.requireRole(threadId, "worker").then(({ study, row }) => {
      let candidateId: number | null = null;
      if (args.candidate !== undefined) {
        const c = this.store.candidateByN(study!.id, args.candidate);
        if (!c || c.thread_id !== threadId) throw new EngineError(`c/${args.candidate} is not one of your candidates`);
        candidateId = c.id;
      } else {
        candidateId = this.store.candidates(study!.id, { threadId, order: "desc", limit: 1 })[0]?.id ?? null;
      }
      const f = this.store.addFinding(
        {
          study_id: study!.id,
          idea_id: row!.idea_id,
          candidate_id: candidateId,
          thread_id: threadId,
          outcome: args.outcome,
          learned: clip(args.learned, 4000),
          revisit_if: clip(args.revisit_if ?? "", 1000),
          evidence: clip(args.evidence ?? "", 2000),
        },
        threadId,
      );
      return `Finding #${f.id} recorded. Call study_finish when you are done, or keep refining.`;
    });
  }

  async proposeIdea(threadId: string, args: { title: string; rationale: string; theme?: string }): Promise<string> {
    const { study } = await this.requireRole(threadId, "worker");
    const idea = this.store.addIdea(study!.id, { title: clip(args.title, 200), rationale: clip(args.rationale, 2000), theme: clip(args.theme ?? "", 60), source: "worker", priority: -1 }, threadId);
    return `Idea #${idea.id} queued for the strategist to triage.`;
  }

  async finish(threadId: string): Promise<string> {
    const { study, row } = await this.requireRole(threadId, "worker");
    if (!this.store.findings(study!.id, { threadId, limit: 1 }).length) {
      throw new EngineError("study_finish refuses until you call study_record_finding: what you learned, why it won or lost, when it is worth revisiting.");
    }
    const pending = this.store.candidates(study!.id, { threadId }).find((c) => c.stage !== "decided");
    if (pending) throw new EngineError(`c/${pending.n} is still being evaluated. End your turn and wait for its verdict before finishing.`);
    this.store.tx(() => {
      this.store.updateThread(row!.id, { state: "finishing", end_reason: "finished", finishing_at: this.ctx.now() });
      if (row!.idea_id !== null) {
        const won = this.store.candidates(study!.id, { threadId }).some((c) => c.verdict === "win");
        this.store.setIdeaStatus(row!.idea_id, won ? "won" : "lost", threadId);
      }
      this.store.event(study!.id, "worker.finish_requested", threadId, { idea: row!.idea_id });
    });
    return "Assignment finished. End your turn now; the plugin archives this thread and removes its worktree. Candidate refs are kept.";
  }

  /**
   * Run `oracle.profile` on a bench host for best or the worker's latest
   * candidate. It holds that host's bench lock, counts against the bench
   * budget (and is refused when the budget is spent), is capped per worker,
   * and returns a bounded summary: DIAG lines first, then the output tail.
   */
  async requestProfile(threadId: string, target: "best" | "candidate"): Promise<string> {
    const { study, row } = await this.requireRole(threadId, "worker");
    const spec = this.store.spec(study!);
    if (!spec.oracle.profile) return "This study has no profile command (oracle.profile). Ask the human to add one if profiling would help.";
    if (row!.profiles >= spec.agents.max_profiles_per_worker) return `Profile limit reached (${spec.agents.max_profiles_per_worker} per worker).`;
    const spent = this.store.budget(study!).bench_seconds;
    const est = this.pipeline.recentEvalSeconds(study!) ?? 0;
    if (spent + est > spec.budget.max_bench_hours * 3600) return `Not enough bench budget left for a profile (${formatDuration(spent)} of ${spec.budget.max_bench_hours} h used).`;
    let sha = study!.best_sha!;
    let purpose: "best" | "candidate" = "best";
    if (target === "candidate") {
      const c = this.store.candidates(study!.id, { threadId: row!.thread_id!, order: "desc", limit: 1 })[0];
      if (!c?.prepared_sha) return "You have no measured candidate yet; submit first or profile best.";
      sha = c.prepared_sha;
      purpose = "candidate";
    }
    const hosts = this.pipeline.benchHosts(study!).filter((h) => h.status !== "offline");
    const host = hosts.find((h) => (h.deferred_until ?? 0) <= this.ctx.now()) ?? hosts[0];
    if (!host) return "No bench host is online right now; try again later.";
    this.store.updateThread(row!.id, { profiles: row!.profiles + 1 });
    const started = this.ctx.now();
    const site = this.pipeline.site(study!, host);
    const out = await withBench(this.ctx, study!, host.host_id, "profile", null, async () => {
      const health = await checkHealth(this.ctx, study!, host, spec, "profile", (kind, text) => this.notify(study!.id, kind, text));
      if (!health.ok) return null;
      const dir = await site.checkout("profile", sha, purpose, "profile");
      const built = await site.build(dir, spec, "profile");
      if (!built.ok) return { exitCode: -1, stdout: "", stderr: "build failed on the bench host" };
      return await site.runner.run({ cwd: dir, command: spec.oracle.profile!, timeoutMs: spec.oracle.timeout_minutes * 60_000, tailBytes: 64 * 1024, label: "profile" });
    });
    const seconds = (this.ctx.now() - started) / 1000;
    this.store.addBenchSeconds(study!.id, seconds);
    this.store.event(study!.id, "profile.ran", threadId, { target, sha, seconds, host: host.host_id });
    if (out === null) return `The bench host failed its health check, so the profile was not run (${formatDuration(seconds)}). Try again later.`;
    return `Profile of ${target} ${sha.slice(0, 10)} on ${host.name} (exit ${out.exitCode}, ${formatDuration(seconds)} of bench time, ${row!.profiles + 1}/${spec.agents.max_profiles_per_worker} profiles used):\n${profileSummary(out.stdout, out.stderr)}`;
  }

  // ---------------------------------------------------- strategist tools

  async queueIdeas(threadId: string, args: { ideas: Array<{ title: string; rationale: string; theme: string; priority?: number; start_ref?: string; variation_of?: number }>; reorder?: Array<{ id: number; priority: number }> }): Promise<string> {
    const { study } = await this.requireRole(threadId, "strategist");
    const added: number[] = [];
    const skipped: string[] = [];
    const lost = this.lostTitles(study!.id);
    for (const i of args.ideas) {
      const startRef = this.normalizeStartRef(study!, i.start_ref ?? null);
      const variationOf = this.resolveVariation(study!, i.variation_of ?? null, startRef);
      if (repeatsLostIdea({ title: i.title, source: "strategist", variation_of: variationOf }, lost)) {
        const prior = this.store.ideas(study!.id, ["lost"]).find((x) => titleKey(x.title) === titleKey(i.title));
        skipped.push(`"${clip(i.title, 80)}" repeats lost idea #${prior?.id ?? "?"}; queue it with variation_of=${prior?.id ?? "<id>"} and say what is different`);
        continue;
      }
      added.push(this.store.addIdea(study!.id, { title: clip(i.title, 200), rationale: clip(i.rationale, 2000), theme: clip(i.theme, 60), source: "strategist", priority: i.priority ?? 0, start_ref: startRef, variation_of: variationOf }, threadId).id);
    }
    for (const r of args.reorder ?? []) {
      const idea = this.store.idea(r.id);
      if (idea && idea.study_id === study!.id) this.store.setIdeaPriority(r.id, r.priority, threadId);
    }
    this.publish(study!.id);
    this.kick();
    return [
      `Queued ${added.length} idea(s)${added.length ? ` (#${added.join(", #")})` : ""}${args.reorder?.length ? `, reprioritized ${args.reorder.length}` : ""}. Ready ideas: ${this.store.ideas(study!.id, ["queued"]).length}.`,
      ...skipped.map((x) => `Skipped: ${x}.`),
    ].join("\n");
  }

  async retireIdea(threadId: string, id: number, reason: string): Promise<string> {
    const { study } = await this.requireRole(threadId, "strategist");
    const idea = this.store.idea(id);
    if (!idea || idea.study_id !== study!.id) throw new EngineError(`idea #${id} not found`);
    if (idea.status !== "queued") throw new EngineError(`idea #${id} is ${idea.status}; only queued ideas can be retired`);
    this.store.setIdeaStatus(id, "retired", threadId, clip(reason, 500));
    this.publish(study!.id);
    return `Idea #${id} retired.`;
  }

  async updateDossier(threadId: string, text: string): Promise<string> {
    const { study } = await this.requireRole(threadId, "strategist");
    const v = this.store.setDossier(study!.id, clip(text, 20_000), threadId);
    return `Dossier v${v} saved (${text.length} chars). Workers get it in their brief.`;
  }

  async searchFindings(threadId: string, q: { query?: string; theme?: string; verdict?: string; limit?: number }): Promise<string> {
    const { study } = await this.requireRole(threadId, "strategist");
    const rows = this.store.searchFindings(study!.id, { text: q.query, theme: q.theme, verdict: q.verdict, limit: Math.min(q.limit ?? 20, 50) });
    const lines = [`${rows.length} finding(s)`];
    for (const f of rows) {
      lines.push(`- #${f.id} idea #${f.idea_id ?? "?"} ${clip(f.title ?? "", 80)}${f.theme ? ` [${f.theme}]` : ""}${f.n ? ` c/${f.n} ${f.verdict}` : ""} [${f.outcome}]: ${clip(f.learned, 300)}${f.revisit_if ? ` · revisit if: ${clip(f.revisit_if, 120)}` : ""}`);
    }
    if (q.verdict || q.query) {
      const cands = this.store.candidates(study!.id, { stages: ["decided"], order: "desc", limit: 200 }).filter((c) => (!q.verdict || c.verdict === q.verdict) && (!q.query || c.summary.toLowerCase().includes(q.query.toLowerCase())));
      lines.push(`${cands.length} matching candidate(s)`);
      for (const c of cands.slice(0, 15)) lines.push(`- c/${c.n} idea #${c.idea_id ?? "?"} ${c.verdict} ${formatPct(c.effect)}: ${clip(c.summary.split("\n")[0] ?? "", 160)}`);
    }
    return clip(lines.join("\n"), 8000);
  }

  async proposeHarvest(threadId: string, groups: Array<{ title: string; candidates: number[]; rationale: string }>): Promise<string> {
    const { study } = await this.requireRole(threadId, "strategist");
    const id = this.store.addHarvestProposal(study!.id, groups, threadId);
    return `Harvest proposal #${id} recorded (${groups.length} changesets). Ablation and PR drafting arrive in M3.`;
  }

  // -------------------------------------------------------- thread events

  onThreadIdle(threadId: string): void {
    const row = this.store.threadById(threadId);
    if (!row) return;
    const now = this.ctx.now();
    if (row.role === "strategist") {
      const study = this.store.study(row.study_id);
      if (study?.round_in_flight) this.store.updateStudy(study.id, { round_in_flight: 0 });
      this.kick();
      return;
    }
    this.store.updateThread(row.id, { last_idle_at: now });
    if (row.state === "finishing") void this.endWorker(row, "finished", "finished").catch((e) => this.ctx.bb.log("warn", `cleanup: ${errText(e)}`));
  }

  onThreadActive(threadId: string): void {
    const row = this.store.threadById(threadId);
    if (!row) return;
    if (row.role === "worker") {
      this.store.updateThread(row.id, { last_active_at: this.ctx.now() });
      return;
    }
    const study = this.store.study(row.study_id);
    if (study && !study.round_in_flight && ["draft", "calibrating"].includes(study.state)) {
      // Before Running there are no rounds: pending notices (calibration results) ride the human's own turn.
      void this.steerNotices(study, threadId).catch((e) => this.ctx.bb.log("warn", `notices: ${errText(e)}`));
      return;
    }
    if (!study || study.round_in_flight || !["running", "paused"].includes(study.state)) return;
    // A turn we didn't start: the human sent a message. Treat it as a round
    // and steer the current digest into it if anything changed.
    void this.sendRound(study, "human").catch((e) => this.ctx.bb.log("warn", `human round: ${errText(e)}`));
  }

  private async steerNotices(study: StudyRow, threadId: string): Promise<void> {
    const notices = this.store.notices(study.id, { undelivered: true, limit: 10 }).reverse();
    if (!notices.length) return;
    this.store.markNoticesDelivered(notices.map((n) => n.id), 0);
    const text = [`[autoresearch] Notices for study \`${study.slug}\` (for the human; relay briefly):`, ...notices.map((n) => `- [${n.kind}] ${clip(n.text, 1500)}`)].join("\n");
    await this.ctx.bb.steer(threadId, text).catch(() => this.ctx.bb.send(threadId, text));
  }

  onThreadFailed(threadId: string): void {
    // A failed worker turn counts as idle for the nudge/abandon clock.
    this.onThreadIdle(threadId);
  }

  onThreadGone(threadId: string, why: "archived" | "deleted"): void {
    const row = this.store.threadById(threadId);
    if (!row) return;
    if (row.role === "worker" && (row.state === "active" || row.state === "spawning")) {
      void this.endWorker(row, "abandoned", `thread ${why} outside the plugin`);
    } else if (row.role === "worker" && row.state === "finishing") {
      void this.endWorker(row, "finished", "finished");
    } else if (row.role === "strategist" && row.state === "active") {
      this.store.updateThread(row.id, { state: "finished", ended_at: this.ctx.now(), end_reason: `study thread ${why}` });
      const study = this.store.study(row.study_id);
      if (study?.state === "running") void this.systemPause(study.id, `the study thread was ${why}`);
    }
  }

  async onTurnFailed(event: { threadId: string; requestId: string; attemptNumber: number; errorInfo: { category?: string | null } | null; rateLimits: { windows: Array<{ resetsAtMs: number | null }> } | null }): Promise<void> {
    const row = this.store.threadById(event.threadId);
    if (!row || event.errorInfo?.category !== "rate-limit" || event.attemptNumber >= 4) return;
    const reset = event.rateLimits?.windows.find((w) => w.resetsAtMs !== null)?.resetsAtMs ?? null;
    await this.ctx.bb.retryTurn(event.threadId, event.requestId, reset === null ? this.ctx.now() + 60_000 : reset + 15_000);
    this.store.event(row.study_id, "turn.retry", "plugin", { thread: event.threadId, attempt: event.attemptNumber, sendAt: reset });
  }

  // --------------------------------------------------------- control loop

  kick(): void {
    void this.tick().catch((e) => this.ctx.bb.log("error", `tick: ${errText(e)}`));
  }

  /** One control-loop pass over running studies. Concurrent callers share one pass; a kick during a pass runs another. */
  tick(): Promise<void> {
    if (this.currentTick) {
      this.tickAgain = true;
      return this.currentTick;
    }
    this.currentTick = (async () => {
      await Promise.resolve(); // let the assignment land before any synchronous finally
      try {
        do {
          this.tickAgain = false;
          for (const study of this.store.studies(["running", "paused"])) {
            try {
              await this.tickStudy(study.id);
            } catch (e) {
              this.ctx.bb.log("warn", `study ${study.slug}: ${errText(e)}`);
            }
          }
        } while (this.tickAgain);
      } finally {
        this.currentTick = null;
      }
      this.pipeline.kick();
    })();
    return this.currentTick;
  }

  /** Wait until the control loop and pipeline have nothing left to do (tests, CLI --wait). */
  async settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await this.tick();
      await this.pipeline.pump();
    }
  }

  /** Recent think samples: from spawn (or the previous verdict) to each submission. */
  private thinkSamples(study: StudyRow): ThinkSample[] {
    const workers = this.store.threads(study.id, { role: "worker" }).slice(-30);
    const out: ThinkSample[] = [];
    for (const w of workers) {
      if (!w.thread_id) continue;
      let startedAt = w.spawned_at;
      for (const c of this.store.candidates(study.id, { threadId: w.thread_id })) {
        out.push({ startedAt, submittedAt: c.submitted_at });
        startedAt = c.reported_at ?? c.decided_at ?? c.submitted_at;
      }
    }
    return out.sort((a, b) => a.submittedAt - b.submittedAt).slice(-20);
  }

  /** Mean seconds from spawn (or the previous verdict) to a submission; null until learned. */
  thinkSeconds(study: StudyRow): number | null {
    return meanThinkSeconds(this.thinkSamples(study));
  }

  /** Adaptive W, learned from think and eval times; records changes as events. */
  workerTarget(study: StudyRow): { w: number; tThink: number | null; tEval: number | null } {
    const tEval = this.pipeline.recentEvalSeconds(study);
    const tThink = this.thinkSeconds(study);
    const w = targetWorkers({ maxWorkers: this.maxWorkers(study), tThink, tEval, ceiling: this.ctx.config.workerCeiling });
    if (study.target_workers !== w) {
      this.store.tx(() => {
        this.store.updateStudy(study.id, { target_workers: w });
        this.store.event(study.id, "scheduler.target", "plugin", { w, t_think: tThink, t_eval: tEval, max_workers: this.maxWorkers(study) });
      });
    }
    return { w, tThink, tEval };
  }

  /** Candidates gating, queued, or on the bench: the backpressure signal. */
  benchDepth(studyId: string): number {
    return this.store.candidates(studyId, { stages: [...BENCH_BOUND_STAGES] }).length;
  }

  private async tickStudy(studyId: string): Promise<void> {
    const study = this.store.study(studyId)!;
    const spec = this.store.spec(study);
    const now = this.ctx.now();
    const workers = this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] });

    // Finishing workers whose turn already ended (missed idle event), or that never end their turn.
    for (const w of workers.filter((x) => x.state === "finishing" && x.thread_id)) {
      const t = await this.ctx.bb.getThread(w.thread_id!).catch(() => null);
      const overdue = w.finishing_at !== null && now - w.finishing_at > this.ctx.config.finishingTimeoutMs;
      if (!t || t.status === "idle" || t.status === "error" || t.archivedAt || overdue) await this.endWorker(w, "finished", overdue ? "finished (turn did not end; stopped)" : "finished");
    }

    // Idle nudge, then abandon.
    for (const w of workers.filter((x) => x.state === "active" && x.thread_id)) {
      const awaiting = this.store.candidates(study.id, { threadId: w.thread_id! }).some((c) => c.stage !== "decided" || c.reported_at === null);
      const threadIdle = w.last_idle_at !== null && (w.last_active_at === null || w.last_idle_at >= w.last_active_at);
      const action = idleAction(w, {
        now,
        awaitingVerdict: awaiting,
        threadIdle,
        nudgeMs: spec.agents.idle_nudge_minutes * 60_000,
        abandonMs: spec.agents.idle_abandon_minutes * 60_000,
      });
      if (action.kind === "nudge") {
        this.store.updateThread(w.id, { nudged_at: now });
        this.store.event(study.id, "worker.nudged", "plugin", { thread: w.thread_id });
        await this.ctx.bb.send(w.thread_id!, nudgeMessage((now - w.last_idle_at!) / 60_000)).catch(() => undefined);
      } else if (action.kind === "abandon") {
        await this.endWorker(w, "abandoned", "idle after nudge");
      }
    }

    await this.refreshBenchHosts(study);
    const { w } = this.workerTarget(this.store.study(study.id)!);
    if (study.state === "running") {
      const exhausted = budgetExhausted({
        candidates: this.store.candidateCount(study.id),
        maxCandidates: spec.budget.max_candidates,
        benchSeconds: this.store.budget(study).bench_seconds,
        maxBenchHours: spec.budget.max_bench_hours,
        deadline: spec.budget.deadline,
        now,
      });
      // Finishing workers still count: a new worker never starts while the previous one is wrapping up.
      const live = this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] }).length;
      if (exhausted) {
        const inFlight = this.store.candidates(study.id, { stages: [...IN_FLIGHT_STAGES] });
        if (!live && !inFlight.length) await this.systemPause(study.id, `budget exhausted: ${exhausted}. Harvest arrives in M3; review results with \`bb study show ${study.slug}\`.`);
      } else {
        let slots = spawnSlots({ live, w, benchDepth: this.benchDepth(study.id), candidates: this.store.candidateCount(study.id), maxCandidates: spec.budget.max_candidates });
        const lostTitles = this.lostTitles(study.id);
        while (slots-- > 0) {
          const fresh = this.store.study(study.id)!;
          if (fresh.state !== "running") break;
          const idea = pickIdea(this.store.ideas(study.id, ["queued"]), this.store.ideas(study.id, ["running"]), w, { lostTitles });
          if (!idea) break;
          if (!(await this.spawnWorker(fresh, spec, idea))) break;
        }
      }
    }

    // Strategist rounds.
    const fresh = this.store.study(study.id)!;
    if (fresh.round_in_flight && fresh.study_thread_id && fresh.last_round_at && now - fresh.last_round_at > 5 * 60_000) {
      const t = await this.ctx.bb.getThread(fresh.study_thread_id).catch(() => null);
      if (!t || t.status === "idle" || t.status === "error") this.store.updateStudy(study.id, { round_in_flight: 0 });
    }
    const decided = this.store.decided(study.id, Math.max(spec.agents.stall_after, 50));
    const trigger = roundTrigger({
      roundInFlight: Boolean(this.store.study(study.id)!.round_in_flight),
      verdictsSinceRound: fresh.verdicts_since_round,
      k: spec.agents.strategist_every,
      readyIdeas: this.store.ideas(study.id, ["queued"]).length,
      w,
      recentVerdicts: decided,
      stallAfter: spec.agents.stall_after,
      stallSignaledAt: fresh.stall_signaled_at_verdict,
      totalVerdicts: this.store.candidates(study.id, { stages: ["decided"] }).length,
      rounds: fresh.rounds,
    });
    if (trigger && fresh.study_thread_id) await this.sendRound(fresh, trigger);
  }

  /** Spawn one worker for `idea`; false when the spawn failed (the study is paused). */
  private async spawnWorker(study: StudyRow, spec: StudySpec, idea: IdeaRow): Promise<boolean> {
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    let baseBranch = bestBranch(study.slug);
    let forkSha = study.best_sha!;
    if (idea.start_ref) {
      const n = Number(/c\/(\d+)$/u.exec(idea.start_ref)?.[1]);
      const c = Number.isFinite(n) ? this.store.candidateByN(study.id, n) : undefined;
      if (c) {
        baseBranch = `studies/${study.slug}/start/${idea.id}`;
        await runner.updateRef(study.repo_path!, `refs/heads/${baseBranch}`, c.sha, null).catch(() => undefined);
        forkSha = c.parent_sha;
      }
    }
    const token = randomUUID();
    const row = this.store.tx(() => {
      const r = this.store.insertThread({ study_id: study.id, role: "worker", spawn_token: token, idea_id: idea.id, state: "spawning", fork_sha: forkSha });
      this.store.setIdeaStatus(idea.id, "running", "plugin");
      return r;
    });
    let sectionId = study.section_id;
    if (!sectionId) {
      sectionId = await this.ctx.bb.ensureSection(`Study: ${study.slug}`).catch(() => null);
      if (sectionId) this.store.updateStudy(study.id, { section_id: sectionId });
    }
    const related = this.store.searchFindings(study.id, { theme: idea.theme || undefined, limit: 6 });
    const bestRun = safeJson<{ diag?: string[] }>(study.best_run_json);
    const prompt = workerBrief({
      study,
      spec,
      idea,
      dossier: this.store.dossier(study.id)?.text ?? null,
      bestDiag: bestRun?.diag ?? [],
      relatedFindings: related,
      mde: this.store.segment(study.id, study.segment)?.mde ?? null,
    });
    try {
      const spawned = await this.ctx.bb.spawnWorker({
        projectId: study.project_id,
        hostId: study.host_id!,
        baseBranch,
        title: clip(`${study.slug} · idea #${idea.id}: ${idea.title}`, 120),
        prompt,
        sectionId,
        metadata: { study: study.slug, role: "worker", idea: idea.id, spawnToken: token },
        ...(spec.agents.worker.provider ? { providerId: spec.agents.worker.provider } : {}),
        ...(spec.agents.worker.model ? { model: spec.agents.worker.model } : {}),
        ...(spec.agents.worker.permission_mode ? { permissionMode: spec.agents.worker.permission_mode } : {}),
      });
      const current = this.store.threadRow(row.id)!;
      this.store.updateThread(row.id, {
        thread_id: current.thread_id ?? spawned.threadId,
        environment_id: spawned.environmentId,
        state: current.state === "spawning" ? "active" : current.state,
        last_active_at: this.ctx.now(),
      });
      this.store.event(study.id, "worker.spawned", "plugin", { thread: spawned.threadId, idea: idea.id, base: baseBranch, theme: idea.theme });
      this.publish(study.id);
      return true;
    } catch (e) {
      this.store.tx(() => {
        this.store.updateThread(row.id, { state: "failed", ended_at: this.ctx.now(), end_reason: clip(errText(e), 300) });
        this.store.setIdeaStatus(idea.id, "queued", "plugin", "spawn failed");
        this.store.event(study.id, "worker.spawn_failed", "plugin", { idea: idea.id, error: clip(errText(e), 500) });
      });
      await this.systemPause(study.id, `could not spawn a worker: ${clip(errText(e), 300)}`);
      return false;
    }
  }

  private async resolveWorktree(worker: ThreadRow): Promise<void> {
    if (!worker.thread_id) return;
    const t = await this.ctx.bb.getThread(worker.thread_id);
    const envId = t?.environmentId ?? worker.environment_id;
    if (!envId) return;
    const env = await this.ctx.bb.getEnvironment(envId);
    const study = this.store.study(worker.study_id)!;
    if (env?.path && env.hostId === study.host_id) this.store.updateThread(worker.id, { worktree_path: env.path, environment_id: envId });
  }

  /** Archive + stop the worker thread, release its worktree, and close the idea. */
  private async endWorker(w: ThreadRow, state: "finished" | "abandoned", reason: string): Promise<void> {
    const fresh = this.store.threadRow(w.id)!;
    if (fresh.state === "finished" || fresh.state === "abandoned" || fresh.state === "failed") return;
    this.store.tx(() => {
      this.store.updateThread(w.id, { state, ended_at: this.ctx.now(), end_reason: reason });
      if (state === "abandoned" && fresh.idea_id !== null) {
        const idea = this.store.idea(fresh.idea_id);
        if (idea?.status === "running") this.store.setIdeaStatus(fresh.idea_id, "abandoned", "plugin", reason);
      }
      this.store.event(w.study_id, `worker.${state}`, "plugin", { thread: fresh.thread_id, idea: fresh.idea_id, reason });
    });
    // The spawn response can omit the environment (it provisions asynchronously),
    // and only a submission resolves it otherwise: look it up before archiving.
    let environmentId = fresh.environment_id;
    if (!environmentId && fresh.thread_id) environmentId = (await this.ctx.bb.getThread(fresh.thread_id).catch(() => null))?.environmentId ?? null;
    if (fresh.thread_id) {
      await this.ctx.bb.archive(fresh.thread_id).catch((e) => this.ctx.bb.log("warn", `archive ${fresh.thread_id}: ${errText(e)}`));
      await this.ctx.bb.stop(fresh.thread_id).catch(() => undefined);
    }
    if (environmentId) {
      // Remove the worktree, then the worker's branch. Candidate refs keep its commits.
      const env = await this.ctx.bb.getEnvironment(environmentId).catch(() => null);
      await this.ctx.bb.releaseEnvironment(environmentId).catch((e) => this.ctx.bb.log("warn", `release env: ${errText(e)}`));
      const study = this.store.study(w.study_id);
      if (env?.branchName && study?.repo_path && env.hostId === study.host_id) {
        await this.ctx.bb.hostRunner(env.hostId).deleteRef(study.repo_path, `refs/heads/${env.branchName}`).catch(() => undefined);
      }
    }
    this.publish(w.study_id);
    this.kick();
  }

  private onDecided(_c: CandidateRow): void {
    this.kick();
  }

  /**
   * Best moved: tell the other live workers without starting turns. A worker
   * mid-turn gets the notice steered into that turn; one that is idle or
   * waiting gets it prepended to the next plugin message it receives (verdict
   * or submission ticket). Their next submission is rebased automatically.
   */
  private async notifyBestMoved(study: StudyRow, winner: CandidateRow, promoted: string): Promise<void> {
    const text = `[autoresearch] FYI: best moved to ${promoted.slice(0, 10)} (c/${winner.n}, ${formatPct(winner.effect)}). Your next submission is rebased onto it automatically; only a CONFLICT verdict needs you to \`git rebase studies/${study.slug}/best\`.`;
    for (const w of this.store.threads(study.id, { role: "worker", states: ["active"] })) {
      if (!w.thread_id || w.thread_id === winner.thread_id) continue;
      const pending = this.store.candidates(study.id, { threadId: w.thread_id }).some((c) => c.stage !== "decided");
      let via: "steer" | "deferred" = "deferred";
      if (!pending) {
        const t = await this.ctx.bb.getThread(w.thread_id).catch(() => null);
        if (t?.status === "active") {
          try {
            await this.ctx.bb.steer(w.thread_id, text);
            via = "steer";
          } catch {
            via = "deferred";
          }
        }
      }
      if (via === "deferred") {
        const cur = this.store.threadRow(w.id)!;
        // Only the latest best matters; replace an older notice.
        this.store.updateThread(w.id, { pending_notice: text });
        void cur;
      }
      this.store.event(study.id, "worker.notified", "plugin", { thread: w.thread_id, via, best: promoted });
    }
  }

  private async sendRound(study: StudyRow, trigger: RoundTrigger): Promise<void> {
    if (!study.study_thread_id) return;
    const spec = this.store.spec(study);
    const since = study.last_round_at ?? 0;
    const verdicts = this.store.decided(study.id, 200).filter((c) => (c.decided_at ?? 0) > since);
    const findings = this.store.findings(study.id, { limit: 50 }).filter((f) => f.created_at > since);
    const notices = this.store.notices(study.id, { undelivered: true, limit: 20 }).reverse();
    if (trigger === "human" && !verdicts.length && !findings.length && !notices.length && study.rounds > 0) {
      // Nothing new to tell; still hold the round slot until the turn ends.
      this.store.updateStudy(study.id, { round_in_flight: 1, last_round_at: study.last_round_at });
      return;
    }
    const ideas = this.store.ideas(study.id);
    const titles = new Map(ideas.map((i) => [i.id, i.title] as const));
    const total = this.store.candidates(study.id, { stages: ["decided"] }).length;
    const digest = strategistDigest({
      study,
      spec,
      trigger,
      round: study.rounds + 1,
      w: this.workerTarget(study).w,
      verdicts,
      findings,
      ideas,
      workers: this.store.threads(study.id, { role: "worker", states: ["spawning", "active"] }),
      dossier: this.store.dossier(study.id),
      bestDiag: safeJson<{ diag?: string[] }>(study.best_run_json)?.diag ?? [],
      cumulative: this.cumulative(study),
      budgetLine: this.budgetLine(study, spec),
      ideaTitles: titles,
      notices,
    });
    this.store.tx(() => {
      this.store.updateStudy(study.id, {
        round_in_flight: 1,
        rounds: study.rounds + 1,
        verdicts_since_round: 0,
        last_round_at: this.ctx.now(),
        last_round_event_id: this.store.lastEventId(),
        ...(trigger === "stall" ? { stall_signaled_at_verdict: total } : {}),
      });
      this.store.markNoticesDelivered(notices.map((n) => n.id), study.rounds + 1);
      this.store.event(study.id, "strategist.round", "plugin", { round: study.rounds + 1, trigger, verdicts: verdicts.length, findings: findings.length, notices: notices.length });
    });
    try {
      await this.ctx.bb.send(study.study_thread_id, digest);
    } catch (e) {
      this.store.updateStudy(study.id, { round_in_flight: 0 });
      throw e;
    }
  }

  /**
   * Milestones for the human, without starting an agent turn: recorded as a
   * notice (study page, header badge, `bb study show`), the study thread is
   * marked unread, and the notice rides along in the next strategist round.
   */
  async notify(studyId: string, kind: string, text: string, opts: { quiet?: boolean } = {}): Promise<void> {
    const study = this.store.study(studyId);
    if (!study) return;
    this.store.tx(() => {
      const id = this.store.addNotice(studyId, kind, clip(text, 4000));
      this.store.event(studyId, "notice.added", "plugin", { notice: id, kind });
    });
    this.publish(studyId);
    if (study.study_thread_id && !opts.quiet) await this.ctx.bb.markUnread(study.study_thread_id).catch((e) => this.ctx.bb.log("warn", `mark unread: ${errText(e)}`));
  }

  /** A host worker exited (server.ts): measurements on it restart from scratch. */
  onHostWorkerExit(hostId: string): void {
    const n = this.pipeline.hostWorkerExited(hostId);
    for (const h of this.store.benchHostsOn(hostId)) this.store.event(h.study_id, "bench.worker_exit", "plugin", { host: hostId, cancelled: n });
    this.kick();
  }

  /** Refresh bench host connection states (cached per host for hostStatusTtlMs). */
  private async refreshBenchHosts(study: StudyRow): Promise<void> {
    const now = this.ctx.now();
    for (const h of this.pipeline.benchHosts(study)) {
      if (h.status_at !== null && now - h.status_at < this.ctx.config.hostStatusTtlMs && h.status !== "offline") continue;
      const status = await this.ctx.bb.hostStatus(h.host_id).catch(() => "unknown" as const);
      this.pipeline.noteHostStatus(study, h, status);
    }
  }

  /** Request a drift check on every bench host now (human control). */
  requestDrift(slug: string, actor: string): string {
    const study = this.study(slug);
    if (study.state !== "running") throw new EngineError(`${slug} is ${study.state}; drift checks run while Running`);
    if (this.store.spec(study).oracle.noise === "deterministic") throw new EngineError("deterministic oracles have no drift check");
    this.pipeline.requestDrift(study.id);
    this.store.event(study.id, "drift.requested", actor, {});
    return `${slug}: a drift check (A/A on best) runs on each bench host at its next free slot.`;
  }

  async systemPause(studyId: string, reason: string): Promise<void> {
    const study = this.store.study(studyId);
    if (!study || study.state !== "running") return;
    this.store.setStudyState(studyId, "paused", "plugin", { reason, system: true });
    this.publish(studyId);
    await this.notify(studyId, "study.paused", `Study \`${study.slug}\` paused by the system: ${reason}. The human decides what happens next (\`bb study resume ${study.slug}\`).`);
  }

  cumulative(study: StudyRow): number | null {
    if (!study.base_sha || !study.best_sha || study.base_sha === study.best_sha) return null;
    // Compound the promoted effects (each measured against the best before it).
    const wins = this.store.candidates(study.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.effect !== null);
    return wins.reduce((acc, c) => 1 - (1 - acc) * (1 - c.effect!), 0);
  }

  budgetLine(study: StudyRow, spec: StudySpec): string {
    const b = this.store.budget(study);
    return `${this.store.candidateCount(study.id)}/${spec.budget.max_candidates} candidates · bench ${formatDuration(b.bench_seconds)} of ${spec.budget.max_bench_hours} h${spec.budget.deadline ? ` · deadline ${spec.budget.deadline}` : ""}`;
  }

  // ------------------------------------------------------ reconciliation

  /** Run once on load, after every handler is registered. Safe to repeat. */
  async reconcile(): Promise<{ requeued: number; workers: number; calibrations: number }> {
    const { requeued } = this.pipeline.reconcile();
    let calibrations = 0;
    for (const study of this.store.studies(["calibrating"])) {
      if (study.calibration_status === "running" && !this.calibrations.has(study.id)) {
        this.store.event(study.id, "calibration.restarted", "plugin", { reason: "reconcile" });
        this.startCalibrationJob(study.id);
        calibrations += 1;
      }
    }
    let workers = 0;
    for (const study of this.store.studies()) {
      for (const w of this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] })) {
        workers += 1;
        if (!w.thread_id) {
          const found = w.spawn_token ? await this.ctx.bb.findSpawnedThread(w.spawn_token).catch(() => null) : null;
          if (found) {
            this.store.updateThread(w.id, { thread_id: found, state: "active", last_active_at: this.ctx.now() });
          } else {
            this.store.tx(() => {
              this.store.updateThread(w.id, { state: "failed", ended_at: this.ctx.now(), end_reason: "spawn interrupted" });
              if (w.idea_id !== null) this.store.setIdeaStatus(w.idea_id, "queued", "plugin", "spawn interrupted");
            });
          }
          continue;
        }
        const t = await this.ctx.bb.getThread(w.thread_id).catch(() => null);
        if (!t || t.deletedAt || t.archivedAt) {
          await this.endWorker(w, w.state === "finishing" ? "finished" : "abandoned", "thread gone (reconcile)");
        } else if (t.status === "idle" || t.status === "error") {
          if (w.state === "finishing") await this.endWorker(w, "finished", "finished");
          else if (w.last_idle_at === null || (w.last_active_at ?? 0) > w.last_idle_at) this.store.updateThread(w.id, { last_idle_at: this.ctx.now() });
        } else {
          this.store.updateThread(w.id, { last_active_at: this.ctx.now() });
        }
      }
      if (study.round_in_flight && study.study_thread_id) {
        const t = await this.ctx.bb.getThread(study.study_thread_id).catch(() => null);
        if (!t || t.status === "idle" || t.status === "error") this.store.updateStudy(study.id, { round_in_flight: 0 });
      }
    }
    this.store.event(null, "plugin.reconciled", "plugin", { requeued, workers, calibrations });
    this.kick();
    return { requeued, workers, calibrations };
  }

  private publish(studyId: string): void {
    this.ctx.bb.publish("study-changed", { study: studyId });
  }
}

/** Bounded profile output for an agent: DIAG lines first, then the tail. */
export function profileSummary(stdout: string, stderr: string): string {
  const diag = stdout.split("\n").filter((l) => /^\s*DIAG\s/u.test(l)).slice(0, 40).join("\n");
  const rest = `${stdout}\n${stderr}`.trim().split("\n").filter((l) => !/^\s*DIAG\s/u.test(l));
  const tailLines = rest.slice(-60).join("\n");
  return clip([diag && `DIAG lines:\n${diag}`, tailLines && `Output (last ${Math.min(60, rest.length)} of ${rest.length} lines):\n${tailLines}`].filter(Boolean).join("\n\n") || "(no output)", 6000);
}

function calibrationNotice(study: StudyRow, report: CalibrationReport): string {
  if (!report.ok) {
    return `Calibration of \`${study.slug}\` failed; the study is back in Draft.\n${report.problems.map((p) => `- ${clip(p, 500)}`).join("\n")}\nFix the spec or oracle (ask the study thread's agent to call study_propose with a revised spec), then re-run \`bb study calibrate ${study.slug}\`.`;
  }
  return `Calibration of \`${study.slug}\` is ready. ${report.report}\nApprove and start the run with \`bb study start ${study.slug}\`.`;
}
