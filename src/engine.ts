// The study engine: lifecycle transitions, the control loop (spawn, idle
// handling, strategist rounds, budget), worker tools, and reconciliation.
// Only this module and the pipeline change study state.
import { randomUUID } from "node:crypto";
import { resolveBenchHosts } from "./bench.ts";
import { recordCalibration, runAutoRecalibration, runCalibration, type AutoRecalibration, type CalibrationReport } from "./calibration.ts";
import type { Ctx } from "./context.ts";
import type { BenchHostRow, CandidateRow, HarvestRow, IdeaRow, ResolvedBenchHost, StudyRow, ThreadRow } from "./db/store.ts";
import { applyProposal, harvestBranch, harvestExportKey, prOrder, type Promotion } from "./harvest-math.ts";
import { RemoteFleet } from "./remote/fleet.ts";
import { Harvester, harvestReadyText } from "./harvest.ts";
import { checkHealth } from "./health.ts";
import type { DispatchDecision, DispatchQuery } from "./ports.ts";
import { LiveRecorder } from "./live.ts";
import { classifyItem, type Activity } from "./live-model.ts";
import { GithubPublisher, PublishRefused, type PrDraft } from "./publisher.ts";
import { studyReport } from "./report.ts";
import { BENCH_BOUND_STAGES, bestGuardrailPositions, errText, IN_FLIGHT_STAGES, Pipeline, withBench } from "./pipeline.ts";
import { ciText, compound, improvementText, type MetricInfo } from "./present.ts";
import { clip, formatDuration, harvestRoundPrompt, nudgeMessage, safeJson, strategistDigest, workerBrief, type CodeInfo } from "./prompts.ts";
import { actionLabel, itemLabel } from "./action.ts";
import { budgetExhausted, budgetShares, idleAction, newBudgetThresholds, rateLimitedTarget, meanThinkSeconds, pickIdea, repeatsLostIdea, roundTrigger, spawnSlots, targetWorkers, titleKey, type RoundTrigger, type ThinkSample } from "./scheduler.ts";
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
/** BB caps a thread events page at 100 rows. */
const THREAD_EVENTS_PAGE = 100;

/** The last provider usage reading stored on the study. */
export interface UsageReading {
  providers: Array<{ providerId: string; windows: Array<{ label: string; usedPercent: number; resetsAt: number | null }> }>;
}

export class Engine {
  readonly pipeline: Pipeline;
  readonly harvester: Harvester;
  private currentTick: Promise<void> | null = null;
  private tickAgain = false;
  private calibrations = new Map<string, Promise<void>>();
  /** Live view: records worker phases and sends throttled realtime deltas. */
  readonly live: LiveRecorder;
  private activityReads = new Map<string, Promise<void>>();
  private activityAgain = new Set<string>();
  private activitySeen = new Map<string, number>();

  constructor(readonly ctx: Ctx) {
    this.pipeline = new Pipeline(ctx, {
      onDecided: (c) => this.onDecided(c),
      systemPause: (study, reason) => this.systemPause(study.id, reason),
      maxWorkers: (study) => this.maxWorkers(study),
      bestMoved: (study, winner, promoted) => void this.notifyBestMoved(study, winner, promoted).catch((e) => this.ctx.bb.log("warn", `best-moved notice: ${errText(e)}`)),
      notify: (study, kind, text) => this.notify(study.id, kind, text),
      onSample: (studyId, candidateId) => this.live.onSample(studyId, candidateId),
      onMeasured: (candidateId) => this.live.storeBand(candidateId),
      recalibrate: async (study) => void (await this.autoRecalibrate(study.id)),
    });
    this.harvester = new Harvester(ctx, this.pipeline, {
      notify: (study, kind, text, opts) => this.notify(study.id, kind, text, opts),
      sendGroupingRound: (study, harvest, promotions) => this.sendGroupingRound(study, harvest, promotions),
      publish: (studyId) => this.publish(studyId),
    });
    this.live = new LiveRecorder(ctx);
    this.fleet = new RemoteFleet(ctx, this.pipeline, {
      notify: (study, kind, text, opts) => this.notify(study.id, kind, text, opts),
      publish: (studyId) => this.publish(studyId),
      kick: () => this.kick(),
    });
    this.pipeline.remote = this.fleet;
    ctx.remoteRunner = (h) => this.fleet.runnerForBench(h);
  }

  /** Remote bench hosts lent by bench provider plugins. */
  readonly fleet: RemoteFleet;

  private get store() {
    return this.ctx.store;
  }

  /**
   * Plugin dispose (reload, disable, shutdown). BB closes the database right
   * after the dispose hooks, but this instance may still have measurements,
   * harvests and activity reads in flight. Stop them and close the store
   * first, so nothing touches the closed handle and nothing is logged; the
   * next instance reconciles (a measurement in progress restarts).
   */
  dispose(): Promise<void> {
    if (this.ctx.disposed) return Promise.resolve();
    // Remote machines: nothing uses them after this instance. Their rows are ended now (the store
    // closes below); the provider calls that destroy them finish on their own (bounded wait).
    const remote = this.fleet.dispose();
    this.ctx.disposed = true;
    this.pipeline.cancelMeasurements(() => true, "plugin disposed");
    this.harvester.abortAll();
    this.live.dispose();
    this.ctx.store.close();
    return remote;
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
    const resolved = resolveBenchHosts(spec.oracle.bench_hosts, await this.ctx.bb.listHosts().catch(() => []), hostId, { remote: (spec.oracle.remote_bench ?? []).length > 0 });
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
    const benchText = [
      ...resolved.hosts.map((h) => `${h.name} (${h.mode === "clone" ? "own clone, git bundles" : "local checkouts"})`),
      ...(spec.oracle.remote_bench ?? []).map((r) => `${r.hosts} remote machine(s) from ${r.provider} (${r.cores} cores, ${r.lifetime_minutes} min each${r.gates ? ", gates there too" : ""})`),
    ].join(", ");
    const hasRun = this.store.hasRun(study.id);
    if (hasRun) {
      // Mid-run: the study keeps its active spec until the human approves this one.
      const active = this.store.spec(study);
      const changed = oracleHash(active) !== oracleHash(spec);
      const version = this.store.addSpecVersion(study.id, toml, spec, oracleHash(spec), threadId, { bench: resolved.hosts, pending: true });
      this.publish(study.id);
      await this.notify(study.id, "spec.proposed", `Spec v${version} of \`${study.slug}\` waits for your approval (${changed ? "the oracle changed: approving recalibrates and starts a new segment" : "oracle unchanged: approving applies it as is"}). Next: review and approve it on the Oracle tab, or \`${changed ? "bb study calibrate" : "bb study approve"} ${study.slug}\`.`);
      return [
        `Spec v${version} recorded for \`${spec.study.slug}\`; the study keeps running on spec v${study.spec_version} until the human approves it.`,
        changed
          ? `The oracle changed (${oracleHash(active)} → ${oracleHash(spec)}). The human approves it on the Studies page (Oracle tab) or with \`bb study calibrate ${spec.study.slug}\`: in-flight measurements are cancelled, best is calibrated under the new oracle, and a new segment starts once the human approves that calibration.`
          : `The oracle is unchanged, so no recalibration is needed: the human applies it on the Studies page (Oracle tab) or with \`bb study approve ${spec.study.slug}\`.`,
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
      "Next steps are the human's, on the Studies page (sidebar → Studies → " + spec.study.slug + "): the Overview shows \"Needs you: Approve spec v" + version + " and calibrate\".",
      "Calibration runs the gates on the base commit and repeated A/A measurements on every bench host to find the noise floor; then the human reviews it and starts the study from the same page.",
      "CLI equivalents: `bb study calibrate " + spec.study.slug + "`, then `bb study start " + spec.study.slug + "`. Ideas can be seeded on the Ideas tab or with `bb study ideas add`.",
    ].join("\n");
  }

  /** Bench hosts of a spec version (pre-M2 versions: the edit host, shared). */
  private benchOf(study: StudyRow, version: number): ResolvedBenchHost[] {
    const r = this.store.resolvedBench(study.id, version);
    // An empty list stored with the version is deliberate: only remote machines measure.
    if (!r.length && this.store.hasResolvedBench(study.id, version)) return [];
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
    // [git] identity may have changed (not part of the oracle hash).
    this.pipeline.forgetIdentity(study.id);
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
      const remote = (this.store.spec(study).oracle.remote_bench ?? []).reduce((a, e) => a + e.hosts, 0);
      return `Spec v${study.spec_version} approved. Calibrating ${slug}: gates on the base commit, then A/A measurement on ${this.store.benchHosts(study.id).filter((h) => h.mode !== "remote").length} bench host(s)${remote ? ` and ${remote} remote machine(s), once they have joined` : ""}. Check progress with \`bb study show ${slug}\`.`;
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
        const s = this.store.study(studyId);
        if (s && !this.ctx.disposed) this.fleet.endCalibration(s);
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
      `Recalibration of \`${study.slug}\` under spec v${study.spec_version} failed: the study is back on spec v${prev} (segment ${study.segment}) and paused. Next: resume on the Overview (\`bb study resume ${study.slug}\`), or ask the study thread for a fixed spec.\n${report.problems.map((p) => `- ${clip(p, 500)}`).join("\n")}`,
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
    if (study.state === "harvesting") {
      // "Keep exploring": back to Running. A harvest still in progress is cancelled; a ready one stays for review.
      const h = this.store.latestHarvest(study.id);
      const cancelled = h && !["ready", "failed", "cancelled"].includes(h.state);
      if (h && cancelled) this.harvester.cancel(h.id);
      this.pipeline.resetAttempts(study.id);
      this.store.setStudyState(study.id, "running", actor, { from_harvest: h?.id ?? null });
      this.kick();
      return `${slug} is running again (keep exploring)${cancelled ? `; harvest h${h!.seq} was cancelled` : h?.state === "ready" ? `; harvest h${h.seq} stays available for review (a new \`bb study harvest\` starts a fresh one)` : ""}.`;
    }
    if (study.state !== "paused") throw new EngineError(`${slug} is ${study.state}, not paused`);
    this.pipeline.resetAttempts(study.id);
    // A host held after a drift pause measures again: the human resumed (or recalibrated).
    for (const h of this.store.benchHosts(study.id)) if (h.drift_status === "drift") this.store.updateBenchHost(study.id, h.host_id, { drift_status: null });
    this.store.setStudyState(study.id, "running", actor);
    this.kick();
    return `${slug} resumed.`;
  }

  // ------------------------------------------------------------ harvest

  /**
   * Start a harvest (Running/Paused → Harvesting), or report the current
   * one. Dry-run: local branches and files only; publishing is a separate,
   * explicit step (`publishHarvest`).
   */
  startHarvest(slug: string, actor: string, opts: { restart?: boolean; measureStandalone?: boolean; onePerPromotion?: boolean } = {}): { harvest: HarvestRow; text: string } {
    const study = this.study(slug);
    const latest = this.store.latestHarvest(study.id);
    if (study.state === "harvesting" && latest) {
      const active = !["ready", "failed", "cancelled"].includes(latest.state);
      if (!opts.restart || active) {
        if (active && !this.harvester.running(latest.id)) this.harvester.start(latest.id);
        return { harvest: latest, text: `${slug} is harvesting: harvest h${latest.seq} is ${latest.state}${latest.phase_detail ? ` (${latest.phase_detail})` : ""}.${active && opts.restart ? " It is still running; wait for it or `bb study resume` to cancel it." : ""}` };
      }
    } else if (!["running", "paused"].includes(study.state)) {
      throw new EngineError(`${slug} is ${study.state}; harvest starts from Running or Paused`);
    }
    if (!study.best_sha || !study.base_sha) throw new EngineError(`${slug} has no best commit yet`);
    const spec = this.store.spec(study);
    const from = study.state === "harvesting" ? (latest?.from_state ?? "paused") : (study.state as "running" | "paused");
    const h = this.store.insertHarvest({ study_id: study.id, from_state: from, measure_standalone: opts.measureStandalone === false ? 0 : 1, grouping_source: opts.onePerPromotion ? "fallback" : null }, actor);
    if (study.state !== "harvesting") this.store.setStudyState(study.id, "harvesting", actor, { harvest: h.id });
    this.harvester.start(h.id);
    this.publish(study.id);
    const inFlight = this.store.candidates(study.id, { stages: [...IN_FLIGHT_STAGES] }).length;
    const live = this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] }).length;
    return {
      harvest: h,
      text: [
        `${slug} is harvesting (h${h.seq}, dry run). No new workers start and submissions are closed${live ? `; ${live} live worker(s) finish their current idea` : ""}.`,
        inFlight ? `First, ${inFlight} in-flight candidate(s) finish so best is final.` : "",
        `Then: ${opts.onePerPromotion ? "one changeset per promotion (no strategist round)" : "the strategist groups the promotions into changesets (or one per promotion)"}, each changeset is ablated from best and measured (${spec.oracle.noise} protocol), checked alone on its PR base${spec.harvest.measure_standalone && opts.measureStandalone !== false ? " and measured" : ""}, and drafted as a local branch with a PR body. Nothing is pushed.`,
        `Follow it on the Harvest tab or with \`bb study harvest ${slug}\`.`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  async waitForHarvest(slug: string, timeoutMs: number): Promise<void> {
    const h = this.store.latestHarvest(this.study(slug).id);
    if (h) await this.harvester.wait(h.id, timeoutMs);
  }

  /**
   * Exactly what publishing the ready harvest would do: which branches go to
   * which remote, which draft PRs open on which base, which changesets are
   * skipped, and whether the preflight (GitHub remote, gh) passes. Reads
   * only; the confirmation dialog and `--publish` show it.
   */
  async publishPlan(slug: string, harvestId?: number) {
    const study = this.study(slug);
    const h = this.store.latestHarvest(study.id);
    if (!h || (harvestId !== undefined && h.id !== harvestId)) throw new EngineError(`${slug} has no such harvest${harvestId !== undefined ? ` (id ${harvestId})` : ""}; reload the Harvest tab`);
    const spec = this.store.spec(study);
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const publisher = new GithubPublisher(runner, study.repo_path!, spec.harvest.remote, true);
    let remoteUrl: string | null = null;
    let problem: string | null = null;
    if (h.state !== "ready") problem = `harvest h${h.seq} is ${h.state}, not ready`;
    else if (h.publish_state === "published") problem = `harvest h${h.seq} was already published`;
    else {
      try {
        remoteUrl = (await publisher.preflight()).remoteUrl;
      } catch (e) {
        problem = e instanceof PublishRefused ? e.message : errText(e);
      }
    }
    const drafts = this.publishDrafts(study, spec, h);
    return {
      harvestId: h.id,
      /** Shown as h<seq>. */
      seq: h.seq,
      remote: spec.harvest.remote,
      remoteUrl,
      ok: problem === null,
      problem,
      prs: drafts.map((d) => ({ k: d.draft.k, title: d.draft.title, branch: d.draft.branch, base: d.draft.baseBranch, stacked: d.draft.stacked, push: d.skip === null, skip: d.skip })),
    };
  }

  /**
   * The PR drafts of a harvest in publish order (PR order: each stack bottom
   * first), with the reason a changeset is skipped (no branch, dropped by the
   * human, or stacked on a skipped one). A changeset folded into another's PR
   * is listed with `folded` (it ships inside that PR, never on its own).
   */
  private publishDrafts(study: StudyRow, spec: StudySpec, h: HarvestRow): Array<{ draft: PrDraft; skip: string | null; folded: boolean }> {
    const changesets = this.store.changesets(h.id);
    const skipped = new Set<string>();
    return prOrder(changesets).map((c) => {
      const base = c.pr_base && c.pr_base !== "base" ? changesets.find((x) => `#${x.k}` === c.pr_base) : undefined;
      const host = c.folded_into !== null ? changesets.find((x) => x.id === c.folded_into) : undefined;
      const draft: PrDraft = { changesetId: c.id, k: c.k, branch: c.branch ?? harvestBranch(study, h, c), baseBranch: base ? (base.branch ?? harvestBranch(study, h, base)) : spec.study.base, title: c.pr_title ?? c.title, body: c.pr_body ?? "", sha: c.branch ? c.standalone_sha : null, stacked: Boolean(base) };
      const skip = host ? `ships inside #${host.k}'s PR` : !draft.sha ? "did not apply on its PR base: no branch" : c.human_choice === "drop" ? "dropped by you" : draft.stacked && skipped.has(draft.baseBranch) ? `its base ${draft.baseBranch} is not published` : null;
      if (skip && !host) skipped.add(draft.branch);
      return { draft, skip, folded: Boolean(host) };
    });
  }

  /** Human control: keep or drop a changeset when publishing (only one nothing else builds on). */
  setChangesetChoice(slug: string, harvestId: number, k: number, choice: "keep" | "drop" | null, actor: string): string {
    const study = this.study(slug);
    const h = this.store.latestHarvest(study.id);
    if (!h || h.id !== harvestId) throw new EngineError(`that harvest (id ${harvestId}) is not ${slug}'s latest harvest; reload the Harvest tab`);
    if (h.publish_state === "published") throw new EngineError(`harvest h${h.seq} was already published`);
    const all = this.store.changesets(h.id);
    const c = all.find((x) => x.k === k);
    if (!c) throw new EngineError(`harvest h${h.seq} has no changeset #${k}`);
    const host = c.folded_into !== null ? all.find((x) => x.id === c.folded_into) : undefined;
    if (choice === "drop" && host) throw new EngineError(`#${k} can't be dropped alone: it ships inside #${host.k}'s PR`);
    const inside = all.filter((x) => x.folded_into === c.id);
    if (choice === "drop" && inside.length) throw new EngineError(`#${k} can't be dropped: its PR also ships ${inside.map((x) => `#${x.k}`).join(", ")}`);
    const dependents = all.filter((o) => (safeJson<number[]>(o.depends_on_json) ?? []).includes(c.id));
    if (choice === "drop" && dependents.length) throw new EngineError(`#${k} can't be dropped: ${dependents.map((d) => `#${d.k}`).join(", ")} build${dependents.length === 1 ? "s" : ""} on it`);
    this.store.updateChangeset(c.id, { human_choice: choice });
    this.store.event(study.id, "harvest.choice", actor, { harvest: h.id, changeset: k, choice });
    this.publish(study.id);
    return choice === "drop" ? `#${k} will be skipped when publishing.` : choice === "keep" ? `#${k} will be published.` : `#${k}: choice cleared.`;
  }

  /** The human looked at the notices: they no longer count as new. */
  markNoticesSeen(slug: string): void {
    const study = this.study(slug);
    this.store.updateStudy(study.id, { notices_seen_at: this.ctx.now() });
    this.publish(study.id);
  }

  /**
   * The in-app approval of a spec, routed by state. `version` is the version
   * the human reviewed; a different one refuses (the page was stale).
   * Draft: approve and calibrate. Pending, oracle unchanged: apply. Pending,
   * oracle changed: approve and recalibrate (new segment).
   */
  async approveSpecVersion(slug: string, version: number, actor: string): Promise<{ text: string; kind: "calibrate" | "approve" }> {
    const study = this.study(slug);
    const expected = study.pending_spec_version ?? (study.state === "draft" ? study.spec_version : null);
    if (expected === null) throw new EngineError(`${slug} has no spec waiting for approval`);
    if (expected !== version) throw new EngineError(`spec v${version} is not the one waiting (v${expected} is); reload and review v${expected}`);
    if (study.pending_spec_version !== null) {
      const next = this.store.specOfVersion(study.id, study.pending_spec_version);
      if (oracleHash(next) === oracleHash(this.store.spec(study))) return { text: this.approve(slug, actor), kind: "approve" };
    }
    return { text: await this.calibrate(slug, actor), kind: "calibrate" };
  }

  /** Publish a ready harvest as DRAFT PRs on GitHub. Only behind an explicit confirmation (`--publish`, or the page's dialog); refuses without a GitHub remote. */
  async publishHarvest(slug: string, actor: string, confirmed: boolean, harvestId?: number): Promise<string> {
    const study = this.study(slug);
    const h = this.store.latestHarvest(study.id);
    if (!h || h.state !== "ready") throw new EngineError(`${slug} has no ready harvest to publish; run \`bb study harvest ${slug}\` (a dry run) first and review it`);
    if (harvestId !== undefined && h.id !== harvestId) throw new EngineError(`that harvest (id ${harvestId}) is not the latest (h${h.seq} is); review h${h.seq} first`);
    if (h.publish_state === "published") throw new EngineError(`harvest h${h.seq} was already published`);
    const spec = this.store.spec(study);
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const publisher = new GithubPublisher(runner, study.repo_path!, spec.harvest.remote, confirmed);
    try {
      await publisher.preflight();
    } catch (e) {
      if (e instanceof PublishRefused) {
        // Keep the refusal on the harvest so the page shows it (and what to fix).
        this.store.updateHarvest(h.id, { publish_state: "failed", error: clip(`publish refused: ${e.message}`, 500) });
        this.store.event(study.id, "harvest.publish_refused", actor, { harvest: h.id, reason: clip(e.message, 300) });
        this.publish(study.id);
        throw new EngineError(`publish refused: ${e.message}`);
      }
      throw e;
    }
    const changesets = this.store.changesets(h.id);
    // A dropped changeset goes in without a sha, so the publisher skips it (and anything stacked on it).
    const all: PrDraft[] = this.publishDrafts(study, spec, h).filter((d) => !d.folded).map(({ draft }) => ({ ...draft, sha: changesets.find((c) => c.id === draft.changesetId)?.human_choice === "drop" ? null : draft.sha }));
    this.store.updateHarvest(h.id, { publisher: "github", publish_state: "publishing", error: null });
    this.store.event(study.id, "harvest.publishing", actor, { harvest: h.id, prs: all.length });
    try {
      const out = await publisher.publish({ key: harvestExportKey(study, h), drafts: all, report: studyReport(this.ctx, study, spec, h) });
      // A dropped changeset has no sha in its draft, so the publisher skips it; say why.
      for (const p of out.prs) if (changesets.find((c) => c.id === p.changesetId)?.human_choice === "drop") Object.assign(p, { status: "skipped", detail: "dropped by you" });
      for (const p of out.prs) {
        this.store.updateChangeset(p.changesetId, { pr_url: p.url, pr_status: p.status === "opened" ? "opened" : p.status === "pushed" ? "pushed" : p.status === "failed" ? "failed" : this.store.changeset(p.changesetId)!.pr_status });
      }
      const opened = out.prs.filter((p) => p.status === "opened");
      this.store.updateHarvest(h.id, { publish_state: opened.length === out.prs.filter((p) => p.status !== "skipped").length ? "published" : "failed", publish_json: JSON.stringify(out) });
      this.store.event(study.id, "harvest.published", actor, { harvest: h.id, opened: opened.length, prs: out.prs.length });
      const failed = out.prs.filter((p) => p.status === "failed" || p.status === "pushed");
      await this.notify(study.id, "harvest.published", `Harvest h${h.seq} of \`${study.slug}\`: ${opened.length} draft PR(s) opened${failed.length ? `, ${failed.length} failed` : ""}.${failed.length ? " Next: see each PR's error on the Harvest tab." : ""}\n${out.prs.map((p) => `- #${p.k} ${p.status}${p.url ? ` ${p.url}` : ""}${p.detail && p.status !== "opened" ? ` (${clip(p.detail, 160)})` : ""}`).join("\n")}`);
      this.publish(study.id);
      return [`Harvest h${h.seq}: ${opened.length} draft PR(s) opened.`, ...out.prs.map((p) => `#${p.k} ${p.branch} → ${p.baseBranch}: ${p.status}${p.url ? ` ${p.url}` : ""}${p.detail && p.status !== "opened" ? ` (${clip(p.detail, 200)})` : ""}`)].join("\n");
    } catch (e) {
      this.store.updateHarvest(h.id, { publish_state: "failed", error: clip(errText(e), 500) });
      throw e;
    }
  }

  /** The grouping round: one strategist turn asking for study_propose_harvest. */
  private async sendGroupingRound(study: StudyRow, harvest: HarvestRow, promotions: Promotion[]): Promise<boolean> {
    const fresh = this.store.study(study.id)!;
    if (!fresh.study_thread_id) return false;
    const strategist = this.store.threadById(fresh.study_thread_id);
    if (!strategist || strategist.role !== "strategist" || strategist.state !== "active") return false;
    const spec = this.store.spec(fresh);
    const candidates = new Map(promotions.filter((p) => p.n !== null).map((p) => [p.n!, this.store.candidateByN(study.id, p.n!)] as const));
    const text = harvestRoundPrompt({ study: fresh, spec, harvest, promotions, candidates, dossier: this.store.dossier(study.id), code: this.codeInfo(fresh, spec) });
    this.store.tx(() => {
      this.store.updateStudy(study.id, { round_in_flight: 1, rounds: fresh.rounds + 1, last_round_at: this.ctx.now(), last_round_event_id: this.store.lastEventId() });
      this.store.event(study.id, "strategist.round", "plugin", { round: fresh.rounds + 1, trigger: "harvest", harvest: harvest.id, promotions: promotions.length });
    });
    try {
      await this.ctx.bb.send(fresh.study_thread_id, text);
    } catch (e) {
      this.store.updateStudy(study.id, { round_in_flight: 0 });
      throw e;
    }
    return true;
  }

  /**
   * End a study: stop and archive its workers, cancel a harvest and in-flight
   * measurements, remove bench checkouts and clones. With `archiveThread`, the
   * study thread (the conversation that created it) is archived too; on an
   * already archived study that is all it does.
   */
  async archiveStudy(slug: string, actor: string, opts: { archiveThread?: boolean } = {}): Promise<string> {
    const study = this.study(slug);
    if (study.state === "archived") {
      if (opts.archiveThread && study.study_thread_id) {
        const archived = await this.archiveStudyThread(study);
        return `${slug} is already archived${archived ? "; its study thread is archived now" : ""}.`;
      }
      return `${slug} is already archived.`;
    }
    // The state changes first, atomically: the scheduler only spawns for a Running study, so stopping
    // workers below (each end kicks a tick) can't make it start replacements while cleanup runs.
    this.store.tx(() => {
      for (const t of this.store.threads(study.id, { role: "strategist", states: ["active"] })) this.store.updateThread(t.id, { state: "finished", ended_at: this.ctx.now(), end_reason: "study archived" });
      this.store.setStudyState(study.id, "archived", actor);
    });
    this.publish(study.id);
    const harvest = this.store.latestHarvest(study.id);
    if (harvest) this.harvester.cancel(harvest.id);
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
    const machines = await this.fleet.releaseStudy(s, "study archived").catch((e) => {
      this.ctx.bb.log("warn", `remote bench cleanup: ${errText(e)}`);
      return 0;
    });
    if (s.host_id && s.repo_path) {
      await this.ctx.bb.hostRunner(s.host_id).removeCheckouts(s.repo_path, `${s.slug}-`).catch((e) => this.ctx.bb.log("warn", `checkout cleanup: ${errText(e)}`));
    }
    const threadArchived = opts.archiveThread ? await this.archiveStudyThread(s) : false;
    this.publish(study.id);
    return `${slug} archived: ${stopped} worker(s) stopped, bench checkouts removed${clones ? `, ${clones} bench clone(s) deleted` : ""}${machines ? `, ${machines} remote machine(s) destroyed` : ""}${threadArchived ? ", study thread archived" : ""}. Refs under refs/studies/${slug}/ and the branch ${bestBranch(slug)} are kept.`;
  }

  /** Archive (and stop) the study thread of an archived study; false when there is none or BB refused. */
  private async archiveStudyThread(study: StudyRow): Promise<boolean> {
    const id = study.study_thread_id;
    if (!id) return false;
    try {
      await this.ctx.bb.archive(id);
      await this.ctx.bb.stop(id).catch(() => undefined);
      this.store.event(study.id, "study_thread.archived", "plugin", { thread: id });
      return true;
    } catch (e) {
      this.ctx.bb.log("warn", `archive study thread ${id}: ${errText(e)}`);
      return false;
    }
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
    this.publish(study!.id);
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
    const h = this.store.latestHarvest(study!.id);
    if (!h || h.state !== "grouping" || !h.promotions_json) {
      const id = this.store.addHarvestProposal(study!.id, groups, threadId);
      return `Harvest proposal #${id} recorded (${groups.length} changesets), but no harvest is waiting for a grouping right now. When the human runs \`bb study harvest\`, you will be asked again with the final list of promotions.`;
    }
    const promotions = JSON.parse(h.promotions_json) as Promotion[];
    const r = applyProposal(promotions, groups);
    if (!r.ok) throw new EngineError(`Grouping not accepted; fix it and call study_propose_harvest again:\n${r.errors.map((e) => `- ${e}`).join("\n")}`);
    const id = this.store.addHarvestProposal(study!.id, groups, threadId, h.id);
    this.publish(study!.id);
    return [`Harvest grouping #${id} accepted for harvest h${h.seq}: ${r.changesets.length} changeset(s).`, ...r.notes.map((n) => `Note: ${n}.`), "The plugin now ablates and measures each changeset; end your turn."].join("\n");
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
    // The human's own controls are an audit trail, not notices for them (prompts.ts isControlNotice).
    const forHuman = notices.filter((n) => !n.kind.startsWith("control."));
    const controls = notices.filter((n) => n.kind.startsWith("control."));
    const text = [
      ...(forHuman.length ? [`[autoresearch] Notices for study \`${study.slug}\` (for the human; relay briefly):`, ...forHuman.map((n) => `- [${n.kind}] ${clip(n.text, 1500)}`)] : [`[autoresearch] Study \`${study.slug}\`: no notices for the human.`]),
      ...(controls.length ? [`The human's own controls (audit trail; nothing to relay unless one looks unexpected):`, ...controls.map((n) => `- [${n.kind}] ${clip(n.text, 300)}`)] : []),
    ].join("\n");
    await this.ctx.bb.steer(threadId, text).catch(() => this.ctx.bb.send(threadId, text));
  }

  /**
   * A worker's thread appended events (coalesced to one call per second by
   * BB): read the tool items it started since the last read and record what
   * the agent is doing (reading, editing, testing) for the live view.
   * Message text is never read.
   */
  onThreadEvents(threadId: string, sequence: number): void {
    const row = this.store.threadById(threadId);
    if (!row || row.role !== "worker" || !(row.state === "active" || row.state === "spawning")) return;
    // Only read when the thread moved past what was already read (BB notifies about every event, items or not).
    if (sequence <= row.activity_seq || sequence <= (this.activitySeen.get(threadId) ?? 0)) return;
    this.activitySeen.set(threadId, sequence);
    if (this.activityReads.has(threadId)) {
      this.activityAgain.add(threadId);
      return;
    }
    const run = (async () => {
      try {
        await this.readActivity(row.id);
      } catch (e) {
        this.ctx.bb.log("warn", `worker activity ${threadId}: ${errText(e)}`);
      } finally {
        this.activityReads.delete(threadId);
        if (this.activityAgain.delete(threadId)) {
          this.activitySeen.delete(threadId);
          this.onThreadEvents(threadId, Number.MAX_SAFE_INTEGER);
        }
      }
    })();
    this.activityReads.set(threadId, run);
  }

  /** Read new tool items of a worker's thread and record its activity (tests await this). */
  async readActivity(rowId: number): Promise<void> {
    for (let page = 0; page < 5; page++) {
      let w = this.store.threadRow(rowId);
      if (!w?.thread_id) return;
      // Labels show paths relative to the worktree, so learn where it is (once).
      if (!w.worktree_path) {
        await this.resolveWorktree(w).catch(() => undefined);
        w = this.store.threadRow(rowId)!;
      }
      const limit = THREAD_EVENTS_PAGE;
      const { seq, items } = await this.ctx.bb.threadActivity(w.thread_id!, w.activity_seq, limit);
      if (seq <= w.activity_seq) return;
      let latest: { activity: Activity; at: number } | null = null;
      for (let i = items.length - 1; i >= 0 && !latest; i--) {
        const a = classifyItem(items[i]!);
        if (a) latest = { activity: a, at: items[i]!.at };
      }
      // The "last action" line: a short, sanitized label of the latest item that says something.
      const label = actionLabel(items, w.worktree_path);
      let labelAt: number | null = null;
      if (label) for (let i = items.length - 1; i >= 0 && labelAt === null; i--) if (itemLabel(items[i]!, w.worktree_path)) labelAt = items[i]!.at;
      this.store.updateThread(rowId, {
        activity_seq: seq,
        ...(latest ? { activity: latest.activity, activity_at: latest.at } : {}),
        ...(label ? { last_action: label, last_action_at: labelAt } : {}),
      });
      if (latest || label) this.live.schedule(w.study_id);
      if (items.length < limit) return;
    }
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

  /**
   * A turn failed. Rate-limited turns of the study's threads (workers and the
   * study thread) are retried at the provider window's reset, at most
   * agents.max_rate_limit_retries times per thread; meanwhile the study holds
   * new spawns until that reset.
   */
  async onTurnFailed(event: { threadId: string; requestId: string; attemptNumber: number; errorInfo: { category?: string | null } | null; rateLimits: { status?: string; windows: Array<{ resetsAtMs: number | null; status?: string }> } | null }): Promise<void> {
    const row = this.store.threadById(event.threadId);
    if (!row || event.errorInfo?.category !== "rate-limit") return;
    const study = this.store.study(row.study_id);
    if (!study) return;
    let max = 3;
    try {
      max = this.store.spec(study).agents.max_rate_limit_retries;
    } catch {
      /* default */
    }
    const now = this.ctx.now();
    const windows = event.rateLimits?.windows ?? [];
    const blocked = windows.filter((w) => w.status === "blocked" && w.resetsAtMs !== null).map((w) => w.resetsAtMs!);
    const any = windows.filter((w) => w.resetsAtMs !== null).map((w) => w.resetsAtMs!);
    const reset = blocked.length ? Math.max(...blocked) : any.length ? Math.min(...any) : null;
    const sendAt = reset !== null && reset > now ? reset + 15_000 : now + 60_000 * Math.max(1, event.attemptNumber);
    const wasBlocked = study.rate_limited_until !== null && study.rate_limited_until > now;
    this.store.updateStudy(study.id, { rate_limited_until: Math.max(study.rate_limited_until ?? 0, sendAt) });
    if (row.rate_limit_retries >= max || event.attemptNumber > max) {
      this.store.event(study.id, "turn.rate_limit_gave_up", "plugin", { thread: event.threadId, attempt: event.attemptNumber, retries: row.rate_limit_retries });
      await this.notify(study.id, "rate_limit", `\`${study.slug}\`: a ${row.role === "worker" ? "worker" : "study thread"} turn stayed rate limited after ${row.rate_limit_retries} retries and is left idle. Next: ${row.role === "worker" ? "nothing (the idle timeout abandons it)" : "send the study thread a message to retry"}. New workers wait until ${new Date(sendAt).toISOString().slice(11, 16)} UTC.`);
      return;
    }
    await this.ctx.bb.retryTurn(event.threadId, event.requestId, sendAt);
    this.store.updateThread(row.id, { rate_limit_retries: row.rate_limit_retries + 1 });
    this.store.event(study.id, "turn.retry", "plugin", { thread: event.threadId, attempt: event.attemptNumber, sendAt, reset });
    if (!wasBlocked) {
      await this.notify(study.id, "rate_limit", `\`${study.slug}\` hit a provider rate limit: the ${row.role === "worker" ? "worker" : "study thread"} turn is retried at ${new Date(sendAt).toISOString().slice(11, 16)} UTC and no new worker starts until then. Nothing to do.`, { quiet: true });
    }
    this.publish(study.id);
  }

  // --------------------------------------------------------- control loop

  kick(): void {
    void this.tick().catch((e) => this.ctx.bb.log("error", `tick: ${errText(e)}`));
  }

  /** One control-loop pass over running studies. Concurrent callers share one pass; a kick during a pass runs another. */
  tick(): Promise<void> {
    if (this.ctx.disposed) return Promise.resolve();
    if (this.currentTick) {
      this.tickAgain = true;
      return this.currentTick;
    }
    this.currentTick = (async () => {
      await Promise.resolve(); // let the assignment land before any synchronous finally
      try {
        do {
          this.tickAgain = false;
          for (const study of this.store.studies(["running", "paused", "harvesting"])) {
            if (this.ctx.disposed) break;
            try {
              await this.tickStudy(study.id);
            } catch (e) {
              if (!this.ctx.disposed) this.ctx.bb.log("warn", `study ${study.slug}: ${errText(e)}`);
            }
          }
        } while (this.tickAgain && !this.ctx.disposed);
        // Remote machines: fill and rotate slots, retire and destroy what isn't needed (never blocks).
        if (!this.ctx.disposed) {
          try {
            this.fleet.tick();
          } catch (e) {
            this.ctx.bb.log("warn", `remote bench: ${errText(e)}`);
          }
        }
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
  workerTarget(study: StudyRow): { w: number; tThink: number | null; tEval: number | null; hold: boolean; limit: string | null } {
    const tEval = this.pipeline.recentEvalSeconds(study);
    const tThink = this.thinkSeconds(study);
    const base = targetWorkers({ maxWorkers: this.maxWorkers(study), tThink, tEval, ceiling: this.ctx.config.workerCeiling });
    const usage = this.usageState(study);
    const limited = rateLimitedTarget(base, { blocked: usage.blocked, tight: usage.tight });
    const w = limited.w;
    if (study.target_workers !== w) {
      this.store.tx(() => {
        this.store.updateStudy(study.id, { target_workers: w });
        this.store.event(study.id, "scheduler.target", "plugin", { w, t_think: tThink, t_eval: tEval, max_workers: this.maxWorkers(study), ...(limited.reason ? { unlimited_w: base, limit: limited.reason } : {}) });
      });
    }
    return { w, tThink, tEval, hold: limited.hold, limit: limited.reason };
  }

  /** Provider limits for the scheduler: blocked by a rate-limited turn (until its reset), or a usage window at or above usage_tight_percent. */
  usageState(study: StudyRow): { blocked: boolean; blockedUntil: number | null; tight: boolean; maxPercent: number | null; providers: UsageReading["providers"]; checkedAt: number | null } {
    const now = this.ctx.now();
    const reading = safeJson<UsageReading>(study.usage_json);
    const blocked = study.rate_limited_until !== null && study.rate_limited_until > now;
    let tightPct = 90;
    try {
      tightPct = this.store.spec(study).agents.usage_tight_percent;
    } catch {
      /* no spec yet */
    }
    const maxPercent = reading?.providers.length ? Math.max(...reading.providers.flatMap((p) => p.windows.map((w) => w.usedPercent)), 0) : null;
    return { blocked, blockedUntil: blocked ? study.rate_limited_until : null, tight: maxPercent !== null && maxPercent >= tightPct, maxPercent, providers: reading?.providers ?? [], checkedAt: study.usage_at };
  }

  /** Read provider usage windows for the providers this study's threads use (cached for usagePollMs). */
  private async refreshUsage(study: StudyRow, spec: StudySpec): Promise<void> {
    const now = this.ctx.now();
    if (study.usage_at !== null && now - study.usage_at < this.ctx.config.usagePollMs) return;
    const ids = new Set<string>();
    for (const p of [spec.agents.worker.provider, spec.agents.strategist.provider]) if (p) ids.add(p);
    for (const t of this.store.threads(study.id)) if (t.provider_id && (t.role === "strategist" || ["spawning", "active", "finishing"].includes(t.state))) ids.add(t.provider_id);
    let all: Awaited<ReturnType<Ctx["bb"]["usageLimits"]>> = [];
    try {
      all = await this.ctx.bb.usageLimits();
    } catch (e) {
      this.ctx.bb.log("warn", `usage limits: ${errText(e)}`);
    }
    const providers = all.filter((p) => p.status === "ok" && (ids.size === 0 || ids.has(p.providerId))).map((p) => ({ providerId: p.providerId, windows: p.windows.slice(0, 8) }));
    const before = this.usageState(study);
    this.store.updateStudy(study.id, { usage_json: JSON.stringify({ providers } satisfies UsageReading), usage_at: now });
    const after = this.usageState(this.store.study(study.id)!);
    if (after.tight && !before.tight) {
      this.store.event(study.id, "usage.tight", "plugin", { max_percent: after.maxPercent });
      await this.notify(study.id, "usage.tight", `\`${study.slug}\`: provider usage is at ${after.maxPercent?.toFixed(0)}% of a window (limit ${spec.agents.usage_tight_percent}%), so the study runs half as many workers until it eases. Nothing to do.`, { quiet: true });
    }
  }

  /** Read token usage for live threads (and the study thread), throttled per thread. */
  private async refreshTokens(study: StudyRow, force = false): Promise<void> {
    const now = this.ctx.now();
    const rows = this.store.threads(study.id).filter((t) => t.thread_id && (t.role === "strategist" ? t.state === "active" : ["active", "finishing"].includes(t.state)));
    for (const t of rows) {
      if (!force && t.tokens_at !== null && now - t.tokens_at < this.ctx.config.tokenPollMs) continue;
      await this.readTokens(t);
    }
  }

  private async readTokens(t: ThreadRow): Promise<void> {
    if (!t.thread_id) return;
    const tokens = await this.ctx.bb.threadTokens(t.thread_id).catch(() => null);
    this.store.updateThread(t.id, { tokens_at: this.ctx.now(), ...(tokens !== null ? { tokens, ...(t.tokens_base === null && t.role === "strategist" ? { tokens_base: t.tokens ?? tokens } : {}) } : {}) });
  }

  /** Budget shares crossing spec.budget.notify_at thresholds raise one notice each. */
  private async budgetNotices(study: StudyRow, spec: StudySpec): Promise<void> {
    const shares = budgetShares({
      candidates: this.store.candidateCount(study.id),
      maxCandidates: spec.budget.max_candidates,
      benchSeconds: this.store.budget(study).bench_seconds,
      maxBenchHours: spec.budget.max_bench_hours,
      deadline: spec.budget.deadline,
      now: this.ctx.now(),
      tokens: this.store.studyTokens(study.id),
      maxTokens: spec.budget.max_tokens,
      startedAt: this.firstRunningAt(study.id),
    });
    const announced = new Set(safeJson<string[]>(study.budget_notices_json) ?? []);
    const crossed = newBudgetThresholds(shares, spec.budget.notify_at, announced);
    if (!crossed.length) return;
    for (const c of crossed) announced.add(c.key);
    this.store.updateStudy(study.id, { budget_notices_json: JSON.stringify([...announced]) });
    const names: Record<string, string> = { candidates: "candidates", bench: "bench hours", tokens: "tokens", deadline: "time to the deadline" };
    for (const c of crossed) {
      this.store.event(study.id, "budget.threshold", "plugin", { dim: c.dim, pct: c.pct, share: c.share });
      await this.notify(study.id, "budget.threshold", `\`${study.slug}\` has used ${(c.share * 100).toFixed(0)}% of its ${names[c.dim]} budget (${this.budgetLine(study, spec)}). At 100% it pauses and proposes a harvest. Nothing to do yet; raise the budget with a spec change if you want more.`);
    }
  }

  private firstRunningAt(studyId: string): number | null {
    const r = this.store.db.prepare(`SELECT at FROM events WHERE study_id = ? AND kind = 'study.state' AND data_json LIKE '%"to":"running"%' ORDER BY id LIMIT 1`).get(studyId) as { at: number } | undefined;
    return r?.at ?? null;
  }

  /** Candidates gating, queued, or on the bench: the backpressure signal. */
  benchDepth(studyId: string): number {
    return this.store.candidates(studyId, { stages: [...BENCH_BOUND_STAGES] }).length;
  }

  private async tickStudy(studyId: string): Promise<void> {
    const study = this.store.study(studyId)!;
    // Safety net: worker phases follow plugin state even if no event announced a change.
    this.live.schedule(studyId);
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
    await this.refreshTokens(study);
    if (study.state !== "harvesting") {
      await this.refreshUsage(this.store.study(study.id)!, spec);
      await this.budgetNotices(this.store.study(study.id)!, spec);
    }
    const { w, hold } = this.workerTarget(this.store.study(study.id)!);
    // Re-read after the awaits above: the study may have been paused, harvested or archived meanwhile.
    if (this.store.study(study.id)?.state === "running") {
      const exhausted = budgetExhausted({
        candidates: this.store.candidateCount(study.id),
        maxCandidates: spec.budget.max_candidates,
        benchSeconds: this.store.budget(study).bench_seconds,
        maxBenchHours: spec.budget.max_bench_hours,
        deadline: spec.budget.deadline,
        now,
        tokens: this.store.studyTokens(study.id),
        maxTokens: spec.budget.max_tokens,
      });
      // Finishing workers still count: a new worker never starts while the previous one is wrapping up.
      const live = this.store.threads(study.id, { role: "worker", states: [...LIVE_WORKER_STATES] }).length;
      if (exhausted) {
        const inFlight = this.store.candidates(study.id, { stages: [...IN_FLIGHT_STAGES] });
        if (!live && !inFlight.length) await this.systemPause(study.id, `budget exhausted: ${exhausted}. Review the results and harvest them with \`bb study harvest ${study.slug}\` (or raise the budget with a spec change)`);
      } else if (hold) {
        // Rate limited: no new worker until the provider window resets.
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

    // Strategist rounds (not while harvesting: the harvest sends its own grouping round).
    const fresh = this.store.study(study.id)!;
    if (fresh.state === "harvesting") return;
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
    if (trigger === "stall") {
      await this.notify(study.id, "stall", `\`${study.slug}\` stalled: no win in the last ${spec.agents.stall_after} verdicts, so the strategist is asked for different directions. Next (optional): steer on the Ideas tab, or harvest what was found.`, { quiet: true });
    }
    if (trigger && fresh.study_thread_id) await this.sendRound(this.store.study(study.id)!, trigger);
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
    if (this.store.study(study.id)?.state !== "running") {
      // The study left Running while this spawn was being prepared: don't start the thread.
      this.store.tx(() => {
        this.store.updateThread(row.id, { state: "failed", ended_at: this.ctx.now(), end_reason: "study left Running before the spawn" });
        if (this.store.idea(idea.id)?.status === "running") this.store.setIdeaStatus(idea.id, "queued", "plugin", "study left Running before the spawn");
      });
      return false;
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
      guardrailPositions: bestGuardrailPositions(this.store, study, spec),
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
      if (current.state !== "spawning") {
        // The worker was ended while its spawn was in flight (the study was archived, say): stop and archive the new thread.
        this.store.event(study.id, "worker.spawn_discarded", "plugin", { thread: spawned.threadId, idea: idea.id, reason: current.end_reason });
        await this.endWorker(this.store.threadRow(row.id)!, "abandoned", current.end_reason ?? "ended while spawning", { alreadyEnded: true });
        return false;
      }
      const info = await this.ctx.bb.getThread(spawned.threadId).catch(() => null);
      if (info?.providerId) this.store.updateThread(row.id, { provider_id: info.providerId });
      const now = this.store.study(study.id);
      if (now?.state !== "running") {
        // The spawn resolved after the study left Running (paused, harvesting, archived): stop and archive
        // the new thread right away; its idea goes back to the queue unless the study is archived.
        this.store.event(study.id, "worker.spawn_discarded", "plugin", { thread: spawned.threadId, idea: idea.id, reason: `study ${now?.state ?? "gone"}` });
        await this.endWorker(this.store.threadRow(row.id)!, "abandoned", `study ${now?.state ?? "gone"} while the worker spawned`);
        if (now && now.state !== "archived" && this.store.idea(idea.id)?.status === "abandoned") this.store.setIdeaStatus(idea.id, "queued", "plugin", "study left Running while the worker spawned");
        return false;
      }
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
  private async endWorker(w: ThreadRow, state: "finished" | "abandoned", reason: string, opts: { alreadyEnded?: boolean } = {}): Promise<void> {
    const fresh = this.store.threadRow(w.id)!;
    const ended = fresh.state === "finished" || fresh.state === "abandoned" || fresh.state === "failed";
    // `alreadyEnded`: the row was ended while its spawn was in flight; only its new thread needs stopping.
    if (ended && !opts.alreadyEnded) return;
    if (!ended) this.store.tx(() => {
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
    await this.readTokens(fresh);
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
    const cum = this.cumulative(this.store.study(study.id)!);
    const idea = winner.idea_id ? this.store.idea(winner.idea_id) : undefined;
    const metric = this.metricInfo(study);
    await this.notify(
      study.id,
      "best.new",
      `New best for \`${study.slug}\`: c/${winner.n}${idea ? ` ${clip(idea.title, 100)}` : ""}, ${improvementText(winner.effect, metric, { digits: 1, factor: false })} than the previous best${winner.ci_lo !== null && winner.ci_hi !== null ? ` (${ciText(winner.ci_lo, winner.ci_hi)})` : ""}. Best vs base is now ${improvementText(cum, metric)}.`,
    );
    const text = `[autoresearch] FYI: best moved to ${promoted.slice(0, 10)} (c/${winner.n}, ${improvementText(winner.effect, metric, { factor: false })} than the best before it). Your next submission is rebased onto it automatically; only a CONFLICT verdict needs you to \`git rebase studies/${study.slug}/best\`.`;
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

  /** Where best's code is, for strategist rounds (prompts.ts codeLines). */
  codeInfo(study: StudyRow, spec: StudySpec): CodeInfo {
    const promotions = this.store.candidates(study.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.promoted_sha !== null).length;
    return { base: spec.study.base, baseSha: study.base_sha, best: bestBranch(study.slug), bestSha: study.best_sha, promotions, repoPath: study.repo_path };
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
      guardrailPositions: bestGuardrailPositions(this.store, study, spec),
      code: this.codeInfo(study, spec),
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
      if (h.mode === "remote") continue; // the fleet polls the provider
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
    // One notice kind per milestone the human cares about.
    const kind = /^oracle broken|could not send best|holdout check failed on best/u.test(reason)
      ? "oracle.broken"
      : /^noise drift|^automatic recalibration failed/u.test(reason)
        ? "drift"
        : /^budget exhausted/u.test(reason)
          ? "budget.exhausted"
          : "study.paused";
    const next =
      kind === "budget.exhausted"
        ? `Next: harvest the wins on the Harvest tab (\`bb study harvest ${study.slug}\`), or raise the budget with a spec change.`
        : kind === "drift" || kind === "oracle.broken"
          ? `Next: check the bench host on the Bench tab, then resume on the Overview (\`bb study resume ${study.slug}\`).`
          : `Next: resume on the Overview when it's fixed (\`bb study resume ${study.slug}\`).`;
    await this.notify(studyId, kind, `\`${study.slug}\` paused itself: ${reason}. ${next}`);
  }

  /**
   * The pipeline's automatic recalibration (best's runs got much shorter than
   * at calibration): A/A on best on every bench host and a new segment with
   * the same oracle. A failure (the oracle is too noisy at these run times)
   * pauses the study with the numbers.
   */
  async autoRecalibrate(studyId: string): Promise<AutoRecalibration | null> {
    const study = this.store.study(studyId);
    if (!study || study.state !== "running" || study.recalibrate_due === null || !study.best_sha) return null;
    const why = safeJson<{ reason?: string }>(study.recalibrate_due)?.reason ?? "best's runs got much shorter than at calibration";
    this.publish(studyId);
    const r = await runAutoRecalibration(this.ctx, this.pipeline, studyId, why);
    this.publish(studyId);
    this.kick();
    const fresh = this.store.study(studyId)!;
    if (!r.ok) {
      await this.systemPause(studyId, `automatic recalibration failed (${why}): ${r.problems.map((p) => clip(p, 300)).join("; ")}. Raise oracle.protocol side_runs or max_mde with a spec change, or resume to keep the old calibration`);
      return r;
    }
    await this.notify(studyId, "segment.recalibrated", recalibrationNotice(fresh, r, why));
    return r;
  }

  /** The primary metric's name, unit and direction (for text in the shared improvement convention). */
  metricInfo(study: StudyRow): MetricInfo {
    try {
      const m = this.store.spec(study).metric;
      return { name: m.name, unit: m.unit, direction: m.direction };
    } catch {
      return { name: "metric", unit: "", direction: "lower" };
    }
  }

  cumulative(study: StudyRow): number | null {
    if (!study.base_sha || !study.best_sha || study.base_sha === study.best_sha) return null;
    // Compound the promoted effects (each measured against the best before it).
    const wins = this.store.candidates(study.id, { stages: ["decided"] }).filter((c) => c.verdict === "win" && c.effect !== null);
    let direction: "lower" | "higher" = "lower";
    try {
      direction = this.store.spec(study).metric.direction;
    } catch {
      // no spec: lower is the default direction
    }
    return compound(wins.map((c) => c.effect!), direction);
  }

  budgetLine(study: StudyRow, spec: StudySpec): string {
    const b = this.store.budget(study);
    return `${this.store.candidateCount(study.id)}/${spec.budget.max_candidates} candidates · bench ${formatDuration(b.bench_seconds)} of ${spec.budget.max_bench_hours} h${spec.budget.deadline ? ` · deadline ${spec.budget.deadline}` : ""}`;
  }

  // ------------------------------------------------------ quiet bench

  /** When each held worker thread was first held (bounded wait: at most one measurement). */
  private quietHeld = new Map<string, { at: number; studyId: string }>();

  /**
   * The message.dispatch hook (server.ts). Quiet bench: while a measurement
   * of a study with `oracle.quiet_bench` runs on a machine, a NEW turn of an
   * autoresearch worker whose environment is on that machine waits. Turns
   * already running (join-turn) always proceed, and so does everything that
   * isn't a worker. A held turn waits for at most one measurement: once any
   * measurement on that machine has ended since it was first held, it starts
   * even if the next one already began, so a busy bench never starves workers.
   * Pipeline.withBench asks BB to re-decide when a quiet measurement ends.
   * Must decide in milliseconds: a few indexed SQLite reads.
   */
  dispatchDecision(q: DispatchQuery): DispatchDecision {
    if (this.ctx.disposed || q.attempt !== "start-turn") return { action: "proceed" };
    const row = this.store.threadById(q.threadId);
    // A worker's first turn arrives during its spawn call, before the row has the thread id.
    const spawning = !row && q.spawnedByPlugin === true;
    if (!spawning && (!row || row.role !== "worker" || !(LIVE_WORKER_STATES as readonly string[]).includes(row.state))) return { action: "proceed" };
    const own = row ? this.store.study(row.study_id) : undefined;
    const hostId = q.hostId ?? own?.host_id ?? null;
    if (!hostId) return { action: "proceed" };
    const now = this.ctx.now();
    const busy = this.store.openBenchIntervals(hostId).find((i) => {
      if (i.kind === "gate") return false;
      const study = this.store.study(i.study_id);
      if (!study) return false;
      try {
        return this.store.spec(study).oracle.quiet_bench;
      } catch {
        return false;
      }
    });
    const held = this.quietHeld.get(q.threadId);
    const lastEnd = this.store.lastMeasureEnd(hostId);
    if (!busy || (held !== undefined && lastEnd !== null && lastEnd >= held.at)) {
      if (held !== undefined) {
        this.quietHeld.delete(q.threadId);
        // Recorded on the worker's study, or (a worker still spawning) on the study that was measuring.
        if (this.store.study(own?.id ?? held.studyId)) this.store.event(own?.id ?? held.studyId, "quiet.released", "plugin", { thread: q.threadId, host: hostId, waited_ms: now - held.at, during: busy ? busy.kind : null, spawning });
      }
      return { action: "proceed" };
    }
    const study = this.store.study(busy.study_id)!;
    const what = busy.candidate_id !== null ? `c/${this.store.candidate(busy.candidate_id)?.n ?? "?"}'s measurement` : `a ${busy.kind === "measure" ? "measurement" : `${busy.kind} run`}`;
    const host = this.store.benchHost(study.id, hostId)?.name ?? "this machine";
    if (held === undefined) {
      this.quietHeld.set(q.threadId, { at: now, studyId: own?.id ?? study.id });
      this.store.event(own?.id ?? study.id, "quiet.held", "plugin", { thread: q.threadId, host: hostId, study: study.slug, kind: busy.kind, candidate: busy.candidate_id, spawning });
    }
    return {
      action: "wait",
      reason: `Autoresearch quiet bench: waits for ${what} on ${host} (study ${study.slug}) to end, then starts. Turns already running are not interrupted.`,
      // A safety net in case a recheck is missed: BB asks again then.
      sendAt: now + 10 * 60_000,
    };
  }

  // ------------------------------------------------------ reconciliation

  /** Run once on load, after every handler is registered. Safe to repeat. */
  async reconcile(): Promise<{ requeued: number; workers: number; calibrations: number }> {
    const { requeued } = this.pipeline.reconcile();
    // Remote machines of a previous instance are ended, and whatever a provider still lists is destroyed.
    await this.fleet.reconcile().catch((e) => this.ctx.bb.log("warn", `remote bench reconcile: ${errText(e)}`));
    // Worker turns held by a previous instance (quiet bench) are re-decided: no measurement runs now.
    this.ctx.bb.recheckDispatch().catch(() => undefined);
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
        if (study.state === "archived") {
          // An archive interrupted mid-cleanup (the state changes first): finish stopping its workers.
          await this.endWorker(w, "abandoned", "study archived (reconcile)");
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
    let harvests = 0;
    for (const h of this.store.activeHarvests()) {
      const s = this.store.study(h.study_id);
      if (s?.state !== "harvesting") {
        this.store.updateHarvest(h.id, { state: "cancelled", finished_at: this.ctx.now() });
        continue;
      }
      this.store.event(h.study_id, "harvest.resumed", "plugin", { harvest: h.id, state: h.state, reason: "reconcile" });
      this.harvester.start(h.id);
      harvests += 1;
    }
    this.store.event(null, "plugin.reconciled", "plugin", { requeued, workers, calibrations, harvests });
    this.kick();
    return { requeued, workers, calibrations };
  }

  private publish(studyId: string): void {
    this.ctx.bb.publish("study-changed", { study: studyId });
    this.live.schedule(studyId);
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
    return `Calibration of \`${study.slug}\` failed; the study is back in Draft. Next: ask the study thread to revise the spec, then approve the new version on the Oracle tab (\`bb study calibrate ${study.slug}\`).\n${report.problems.map((p) => `- ${clip(p, 500)}`).join("\n")}`;
  }
  const warnings = (report.warnings ?? []).map((w) => `- Warning: ${clip(w, 500)}`).join("\n");
  return `Calibration of \`${study.slug}\` is ready. Next: review it and start the study on the Oracle tab (\`bb study start ${study.slug}\`).\n${report.report}${warnings ? `\n${warnings}` : ""}`;
}

/** The notice after an automatic recalibration: why, and what changed per host (side runs, run time, noise floor, MDE). */
export function recalibrationNotice(study: StudyRow, r: AutoRecalibration, why: string): string {
  const pct = (f: number | null) => (f === null ? "?" : `${(f * 100).toFixed(2)}%`);
  const secs = (v: number | null) => (v === null ? "?" : v < 10 ? `${v.toFixed(2)} s` : `${v.toFixed(1)} s`);
  const lines = r.hosts.map(
    (h) =>
      `- ${h.name}: side runs ${h.before.sideRuns} → ${h.after?.sideRuns ?? "?"}, one run ${secs(h.before.runSeconds)} → ${secs(h.after?.runSeconds ?? null)}, noise floor ${pct(h.before.noiseFloor)} → ${pct(h.after?.noiseFloor ?? null)} per pair, win threshold ${pct(h.before.mde)} → ${pct(h.after?.mde ?? null)}`,
  );
  return [`\`${study.slug}\` recalibrated itself on best (${why}): segment ${r.segment} started, same oracle. Shorter runs are noisier relative to themselves; that isn't drift, so the study kept running. Nothing to do.`, ...lines].join("\n");
}
