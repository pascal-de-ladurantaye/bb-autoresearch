// Remote bench hosts: machines lent by bench provider plugins
// (docs/bench-providers.md), each its own bench host with its own
// calibration. The fleet keeps every `[[oracle.remote_bench]]` slot filled
// while the study can use it, and runs each machine's lifecycle:
//
//   creating → joining → calibrating → ready → retiring → gone
//
// - Join: the seed and the shallow base bundle are built on the edit host
//   first (a refused seed never costs a machine), then create → wait until
//   ready → upload the seed → unpack the repository → send best → setup.
// - Calibration on arrival: A/A on best on that machine alone, under its own
//   bench lock; it then measures with its own noise floor and win threshold
//   (never below min_effect). One much noisier than the study's other hosts
//   is replaced (a bounded number of times in a row). During the study's own calibration the
//   study calibrates its machines with every other bench host instead.
// - Rotation: a replacement starts `rotate_before_minutes` before a
//   machine's lifetime ends; once it has calibrated, the old machine takes no
//   new work (retiring) and is destroyed when nothing runs on it.
// - Leaving: lifetime over, suspended, gone or failed (provider status),
//   a lost exec, a failed join. A measurement on a machine that leaves
//   restarts from scratch elsewhere (Pipeline.cancelMeasurements).
// - Cost guard: at most one machine per slot plus one replacement.
// - Orphans: machines carry the study id and slot as labels; on load, pause
//   and archive the fleet lists them and destroys what isn't in use.
// - Plugin reload: unloading keeps calibrated machines (their rows stay
//   `ready` in the database); the next instance re-adopts each one the
//   provider still lists as ready and that answers a probe, and destroys the
//   rest. Archive and pause still destroy machines; a disabled plugin's
//   machines end with their lifetime (or at the next load).
// - Artifacts: seeds and base bundles on the edit host that no non-archived
//   study uses are deleted at load and on archive (host/artifacts.ts).
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchProviderClient, ProviderMissingError } from "../bench-provider/client.ts";
import { BenchProviderError, LEAVING_STATES, type DescribeOutput, type HostState } from "../bench-provider/contract.ts";
import { RemoteBenchRunner, RemoteHostLostError, q } from "../bench-provider/runner.ts";
import { HealthError, calibrateHost } from "../calibration.ts";
import { guardrailProblems } from "../guardrails.ts";
import { chanceRatio, noisyAgainstPeers, noisyHostText, NOISY_REPLACEMENTS } from "../host-choice.ts";
export { NOISY_REPLACEMENTS };
import { DEFAULT_REMOTE_CONFIG, type Ctx, type RemoteFleetConfig } from "../context.ts";
import { REMOTE_LIVE_STATES, type BenchHostRow, type RemoteArtifactRow, type RemoteHostRow, type StudyRow } from "../db/store.ts";
import type { ArtifactReport } from "../host/contract.ts";
import type { HostRunner } from "../host/runner.ts";
import { seedFindingsText } from "../host/seed.ts";
import type { CalibrationOutcome } from "../noise.ts";
import { benchLockKey, errText, type Pipeline } from "../pipeline.ts";
import { clip, formatDuration, safeJson } from "../prompts.ts";
import type { RemoteBenchSpec, StudySpec } from "../spec.ts";

/** Label every machine carries, so `list` finds this plugin's machines (and orphans). */
export const OWNER_LABEL = { owner: "bb-autoresearch" } as const;

export interface FleetHooks {
  notify(study: StudyRow, kind: string, text: string, opts?: { quiet?: boolean }): Promise<void>;
  publish(studyId: string): void;
  /** Something changed that the pipeline or control loop should act on. */
  kick(): void;
}

/** A seed that the credential scan refused (or whose command failed): no machine is created for its entry. */
export class SeedError extends Error {
  constructor(
    message: string,
    readonly refused: boolean,
  ) {
    super(message);
    this.name = "SeedError";
  }
}

interface Failure {
  n: number;
  /** No new machine for the entry before this (ctx clock). */
  until: number;
  notified: boolean;
  last: string;
  /** The seed was refused: blocked until the spec or the segment changes. */
  seedKey?: string;
}

/** How long calibrated machines wait for the human to approve a finished calibration. */
const KEEP_AFTER_CALIBRATION_MS = 30 * 60_000;

/** How often the fleet lists each provider's machines for orphans. */
const ORPHAN_SWEEP_MS = 10 * 60_000;


/** Machine states that are joining (not measuring yet). */
const JOINING = ["creating", "joining", "calibrating"] as const;

/** After a reload, how long a kept machine may stay unverified (its provider not loaded yet, say) before it is given up. */
const ADOPT_TIMEOUT_MS = 10 * 60_000;
/** How often an unverified kept machine is checked again. */
const ADOPT_RETRY_MS = 15_000;
const ADOPT_PHASE = "re-adopting after a plugin reload";

export class RemoteFleet {
  readonly config: RemoteFleetConfig;
  private clients = new Map<string, BenchProviderClient>();
  private runners = new Map<number, RemoteBenchRunner>();
  private jobs = new Map<string, Promise<void>>();
  private aborts = new Map<number, AbortController>();
  private describes = new Map<string, { at: number; value: DescribeOutput | null; error: string | null }>();
  private failures = new Map<string, Failure>();
  private artifactJobs = new Map<string, Promise<RemoteArtifactRow>>();
  /** Studies whose calibration waits for machines, with the commit it calibrates. */
  private calibrating = new Map<string, string>();
  /** Machines that joined and wait for the study's calibration to calibrate them. */
  private joined = new Set<number>();
  /** Machines the study's calibration found much noisier than their peers: they leave when it ends, with this reason. */
  private noisy = new Map<number, string>();
  private polledAt = new Map<number, number>();
  private sweptAt = 0;
  /** When each row learned its machine's id (real time): a list started before that can't judge it. */
  private assignedAt = new Map<number, number>();
  /** Machines kept across a reload that are not verified yet (row id → when adoption started, ctx clock). No work goes to them. */
  private adopting = new Map<number, number>();
  private adoptTriedAt = 0;
  /** The latest artifact report per edit host (views). */
  private artifactReports = new Map<string, { at: number; report: ArtifactReport; reason: string }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pipeline: Pipeline,
    private readonly hooks: FleetHooks,
  ) {
    this.config = { ...DEFAULT_REMOTE_CONFIG, ...(ctx.config.remote ?? {}) };
  }

  private get store() {
    return this.ctx.store;
  }

  entries(study: StudyRow, spec: StudySpec = this.store.spec(study)): RemoteBenchSpec[] {
    return spec.oracle.remote_bench ?? [];
  }

  client(provider: string): BenchProviderClient {
    let c = this.clients.get(provider);
    if (!c) {
      c = new BenchProviderClient(provider, (method, input, schema) => this.ctx.bb.callPlugin(provider, method, input, schema), { retryMs: 1000 });
      this.clients.set(provider, c);
    }
    return c;
  }

  // ---------------------------------------------------------------- runners

  private runnerOf(row: RemoteHostRow): RemoteBenchRunner {
    let r = this.runners.get(row.id);
    if (!r) {
      const study = this.store.study(row.study_id);
      const entry = study ? this.entries(study)[row.entry] : undefined;
      r = new RemoteBenchRunner(this.client(row.provider), row.remote_id ?? "", row.bench_host_id, {
        home: row.home,
        env: this.machineEnv(row, entry),
        stagingDir: this.config.stagingDir ?? join(tmpdir(), "bb-autoresearch-staging"),
        pollMs: this.config.execPollMs,
        onLost: (reason) => this.lostByRunner(row.id, reason),
      });
      this.runners.set(row.id, r);
    }
    return r;
  }

  /**
   * A call on the machine found it gone. A machine that measures, gates or
   * calibrates leaves now (its work restarts elsewhere); a join in progress
   * fails through its own path, which counts the failure and backs off.
   */
  private lostByRunner(rowId: number, reason: string): void {
    const row = this.store.remoteHost(rowId);
    if (!row || row.state === "gone" || row.state === "creating" || row.state === "joining") return;
    this.leave(row, reason, { notify: true });
  }

  /** Environment of every command on a machine: the entry's env, plus what the plugin tells the benchmark. */
  private machineEnv(row: RemoteHostRow, entry: RemoteBenchSpec | undefined): Record<string, string> {
    return {
      ...(entry?.env ?? {}),
      AUTORESEARCH_REMOTE: "1",
      AUTORESEARCH_CORES: String(row.cores),
      ...(row.home && row.seed_sha ? { AUTORESEARCH_SEED: `${row.home}/bb-autoresearch/seed/${row.seed_sha}` } : {}),
    };
  }

  /** The runner of a remote bench host row (bench.ts benchRunner). A machine that left fails fast. */
  runnerForBench(host: BenchHostRow): HostRunner {
    const row = this.store.remoteHostByBench(host.study_id, host.host_id);
    if (!row) throw new RemoteHostLostError(`remote bench host ${host.name} is unknown`);
    const r = this.runnerOf(row);
    if (row.state === "gone") r.markLost(row.left_reason ?? "left");
    return r;
  }

  /** Connection status the pipeline sees for a remote bench host. */
  status(host: BenchHostRow): "connected" | "disconnected" {
    const row = this.store.remoteHostByBench(host.study_id, host.host_id);
    return row && row.state !== "gone" ? "connected" : "disconnected";
  }

  // ------------------------------------------------------------ validation

  /** The provider's describe (cached for a minute). */
  async describe(provider: string, fresh = false): Promise<{ value: DescribeOutput | null; error: string | null }> {
    const now = this.ctx.now();
    const c = this.describes.get(provider);
    if (c && !fresh && now - c.at < 60_000) return c;
    let out: { at: number; value: DescribeOutput | null; error: string | null };
    try {
      out = { at: now, value: await this.client(provider).call("benchProvider.describe", {}, { retries: 1 }), error: null };
    } catch (e) {
      out = { at: now, value: null, error: errText(e) };
    }
    this.describes.set(provider, out);
    return out;
  }

  /**
   * Check every entry against its provider's describe: available, contract
   * version, how many machines and cores it allows. The lifetime is capped
   * by the provider's maximum (a warning, not a problem).
   */
  async validate(study: StudyRow, spec: StudySpec = this.store.spec(study)): Promise<{ problems: string[]; warnings: string[] }> {
    const problems: string[] = [];
    const warnings: string[] = [];
    for (const [i, e] of this.entries(study, spec).entries()) {
      const where = `remote bench ${i + 1} (${e.provider})`;
      const d = await this.describe(e.provider, true);
      if (!d.value) {
        problems.push(`${where}: the provider plugin did not answer describe: ${clip(d.error ?? "no answer", 300)}. Is the plugin "${e.provider}" installed and enabled?`);
        continue;
      }
      const v = d.value;
      if (!v.available) {
        problems.push(`${where}: ${v.displayName} is not available${v.reason ? `: ${clip(v.reason, 300)}` : ""}`);
        continue;
      }
      if (v.maxHosts !== null && e.hosts + e.hosts > v.maxHosts && e.hosts <= v.maxHosts) {
        warnings.push(`${where}: hosts = ${e.hosts} needs up to ${2 * e.hosts} machines while one rotates; ${v.displayName} allows ${v.maxHosts}, so a replacement may wait for capacity`);
      }
      if (v.maxHosts !== null && e.hosts > v.maxHosts) problems.push(`${where}: hosts = ${e.hosts}, but ${v.displayName} allows at most ${v.maxHosts} machines`);
      if (v.cores && (e.cores < v.cores.min || e.cores > v.cores.max)) problems.push(`${where}: cores = ${e.cores}, but ${v.displayName} offers ${v.cores.min} to ${v.cores.max}`);
      // Machine options: checked against the keys the provider lists (a provider that lists none checks them itself at create).
      if (v.machineOptions && e.machine) {
        const known = new Set(v.machineOptions.map((o) => o.name));
        const unknown = Object.keys(e.machine).filter((k) => !known.has(k));
        if (unknown.length) problems.push(`${where}: unknown machine option${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; ${v.displayName} accepts ${v.machineOptions.length ? v.machineOptions.map((o) => o.name).join(", ") : "no machine options"}`);
      }
      if (v.maxLifetimeSeconds !== null && e.lifetime_minutes * 60 > v.maxLifetimeSeconds) {
        warnings.push(`${where}: lifetime_minutes = ${e.lifetime_minutes} is capped at ${v.displayName}'s maximum of ${Math.floor(v.maxLifetimeSeconds / 60)} minutes`);
      }
    }
    return { problems, warnings };
  }

  private lifetimeSeconds(entry: RemoteBenchSpec): number {
    const max = this.describes.get(entry.provider)?.value?.maxLifetimeSeconds ?? null;
    const want = Math.round(entry.lifetime_minutes * 60);
    return max !== null ? Math.min(want, max) : want;
  }

  /** How long before a machine's end its replacement starts. */
  rotationLeadMs(study: StudyRow, entryIndex: number, entry: RemoteBenchSpec): number {
    const life = this.lifetimeSeconds(entry) * 1000;
    if (entry.rotate_before_minutes !== undefined) return Math.min(entry.rotate_before_minutes * 60_000, life * 0.9);
    // A replacement must join and calibrate, then the old machine must finish what it measures.
    const joins = this.store.remoteHosts(study.id, { limit: 50 }).filter((r) => r.entry === entryIndex && r.join_seconds !== null);
    const join = joins.length ? Math.max(...joins.slice(0, 5).map((r) => r.join_seconds!)) : 0;
    const seg = this.store.segment(study.id, study.segment);
    const evalS = seg?.eval_seconds ?? 0;
    return Math.min(Math.max(life * 0.2, 1.5 * (join + evalS) * 1000), life * 0.5);
  }

  // ------------------------------------------------------------ control loop

  /** Whether a study puts machines to work now (and so fills its slots). */
  private wants(study: StudyRow): boolean {
    if (study.state === "running" || study.state === "harvesting") return true;
    // While a calibration runs, machines are kept (an oracle change calibrates them where they are).
    return study.state === "calibrating" && (this.calibrating.has(study.id) || study.calibration_status === "running");
  }

  /**
   * One pass: fill and rotate slots, retire and destroy what isn't needed,
   * poll statuses. Never waits for the provider: everything slow runs as a
   * background job.
   */
  tick(): void {
    if (this.ctx.disposed) return;
    const now = this.ctx.now();
    // A periodic sweep catches orphans a provider couldn't list at load (not loaded yet, unavailable).
    if (now - this.sweptAt >= ORPHAN_SWEEP_MS && this.allProviders().length) {
      this.sweptAt = now;
      this.startJob("orphans", () => this.cleanupOrphans().then(() => undefined));
    }
    if (this.adopting.size && now - this.adoptTriedAt >= ADOPT_RETRY_MS) {
      this.adoptTriedAt = now;
      this.startJob("adopt", () => this.verifyAdoptions().then(() => undefined));
    }
    const studies = new Map<string, StudyRow>();
    for (const s of this.store.studies()) {
      if (s.state === "archived") {
        if (this.store.remoteHosts(s.id, { live: true }).length) studies.set(s.id, s);
        continue;
      }
      studies.set(s.id, s);
    }
    for (const study of studies.values()) {
      let spec: StudySpec;
      try {
        spec = this.store.spec(study);
      } catch {
        continue;
      }
      const live = this.store.remoteHosts(study.id, { live: true });
      if (!live.length && !this.entries(study, spec).length) continue;
      for (const row of live) this.pollStatus(study, row, now);
      for (const row of live) {
        if (row.state === "gone") continue;
        if (row.expires_at !== null && now >= row.expires_at) this.leave(row, "its lifetime ended", { notify: this.pipeline.lockKeyBusy(benchLockKey(study, spec, row.bench_host_id)) });
      }
      const current = this.store.remoteHosts(study.id, { live: true });
      if (study.state === "harvesting") {
        // Frozen: machines only while requested measurements need them (and an idle grace after), per entry.
        const wanted = this.entries(study, spec).map((e) => this.harvestWants(study, e, now));
        this.fillSlots(study, spec, current, now, wanted);
        const idle = current.filter((r) => wanted[r.entry] === false && (r.state === "ready" || (JOINING as readonly string[]).includes(r.state)));
        if (idle.length) this.release(study, spec, idle, "idle while frozen for harvest: no requested measurement for a while (the next one brings machines up again)");
      } else if (this.wants(study)) this.fillSlots(study, spec, current, now);
      else if (this.keeps(study, now)) {
        // A finished calibration waits for the human: its machines stay (no new ones) for a while.
      } else this.release(study, spec, current, study.state === "archived" ? "study archived" : study.state === "paused" ? "study paused" : `study ${study.state}`);
      // Retiring machines go once nothing runs on them.
      for (const row of this.store.remoteHosts(study.id, { live: true })) {
        if (row.state === "retiring" && !this.pipeline.lockKeyBusy(benchLockKey(study, spec, row.bench_host_id))) this.leave(row, row.left_reason ?? "retired", { expected: true });
      }
    }
  }

  /**
   * Frozen for harvest, an entry's machines are wanted while best is still
   * freezing (in-flight candidates), while a requested measurement or gate is
   * queued or running, and for `idle_release_minutes` after the last one (or
   * after the freeze). Then they are released; the next request brings them
   * up again and waits for them.
   */
  private harvestWants(study: StudyRow, entry: RemoteBenchSpec, now: number): boolean {
    const h = this.store.latestHarvest(study.id);
    if (!h || h.state === "waiting") return true;
    if (this.store.adhocRuns(study.id, { states: ["queued", "running"], limit: 1 }).length) return true;
    const last = this.store.adhocRuns(study.id, { limit: 1 })[0];
    const lastActive = Math.max(h.started_at ?? 0, h.finished_at ?? 0, last ? (last.finished_at ?? last.requested_at) : 0);
    return now - lastActive < (entry.idle_release_minutes ?? 10) * 60_000;
  }

  private fillSlots(study: StudyRow, spec: StudySpec, live: RemoteHostRow[], now: number, wanted?: boolean[]): void {
    const entries = this.entries(study, spec);
    const slots = new Set<string>();
    entries.forEach((entry, i) => {
      for (let k = 1; k <= entry.hosts; k++) {
        const slot = `${i}.${k}`;
        slots.add(slot);
        if (wanted && !wanted[i]) continue;
        const mine = live.filter((r) => r.slot === slot && r.provider === entry.provider);
        const ready = mine.filter((r) => r.state === "ready");
        const joining = mine.filter((r) => (JOINING as readonly string[]).includes(r.state));
        if (ready.length > 1) for (const r of ready.slice(0, -1)) this.retire(r, "a newer machine took its slot");
        if (!this.mayCreate(study, i, now) || !this.targetSha(study)) continue;
        // Cost guard: one machine per slot, plus one replacement while it rotates.
        if (!mine.length) this.create(study, i, entry, slot, null);
        else if (mine.length === 1 && ready.length === 1 && !joining.length) {
          const m = ready[0]!;
          if (m.expires_at !== null && m.expires_at - now <= this.rotationLeadMs(study, i, entry)) this.create(study, i, entry, slot, m.id);
        }
      }
    });
    // Slots the spec no longer has (fewer hosts, an entry removed or changed provider).
    for (const r of live) {
      const entry = entries[r.entry];
      if (!slots.has(r.slot) || !entry || entry.provider !== r.provider) {
        if ((JOINING as readonly string[]).includes(r.state)) this.leave(r, "its slot was removed from the spec", { expected: true });
        else if (r.state === "ready") this.retire(r, "its slot was removed from the spec");
      }
    }
  }

  /** Not wanted now: joining machines go at once, measuring ones finish first. */
  private release(study: StudyRow, _spec: StudySpec, live: RemoteHostRow[], why: string): void {
    if (!live.length) return;
    for (const r of live) {
      if ((JOINING as readonly string[]).includes(r.state)) this.leave(r, why, { expected: true });
      else if (r.state === "ready") this.retire(r, why);
    }
    if (study.state !== "draft") this.startJob(`orphans:${study.id}`, () => this.cleanupOrphans([...new Set(live.map((r) => r.provider))]).then(() => undefined));
  }

  /** Calibrated machines are kept for half an hour while a finished calibration waits for approval. */
  private keeps(study: StudyRow, now: number): boolean {
    if (study.state !== "calibrating" || study.calibration_status !== "ready") return false;
    const finished = (JSON.parse(study.calibration_json ?? "{}") as { finishedAt?: number }).finishedAt ?? 0;
    return now - finished < KEEP_AFTER_CALIBRATION_MS;
  }

  private failureKey(studyId: string, entry: number): string {
    return `${studyId}:${entry}`;
  }

  private mayCreate(study: StudyRow, entry: number, now: number): boolean {
    const f = this.failures.get(this.failureKey(study.id, entry));
    if (!f) return true;
    if (f.seedKey !== undefined) return f.seedKey !== this.seedKey(study, entry, this.seedBaseline(study));
    return now >= f.until;
  }

  private create(study: StudyRow, entryIndex: number, entry: RemoteBenchSpec, slot: string, replaces: number | null): void {
    const live = this.store.remoteHosts(study.id, { live: true }).filter((r) => r.slot === slot);
    if (live.length >= (replaces === null ? 1 : 2)) return;
    const row = this.store.insertRemoteHost({
      study_id: study.id,
      entry: entryIndex,
      slot,
      provider: entry.provider,
      create_key: "",
      cores: entry.cores,
      memory_gb: entry.memory_gb ?? null,
      lifetime_seconds: this.lifetimeSeconds(entry),
      replaces,
      name: "",
      // An empty table is the provider's default: not sent, so a provider whose schema predates `machine` keeps working.
      machine_json: entry.machine && Object.keys(entry.machine).length ? JSON.stringify(entry.machine) : null,
    });
    const name = `${entry.provider} #${row.id}`;
    this.store.tx(() => {
      this.store.updateRemoteHost(row.id, { create_key: `${study.id}-${slot}-${row.id}`, phase: "preparing the seed and repository" });
      this.store.updateBenchHost(study.id, row.bench_host_id, { name });
      this.store.event(study.id, "remote.requested", "plugin", { remote: row.id, host: row.bench_host_id, slot, provider: entry.provider, cores: entry.cores, replaces });
    });
    this.hooks.publish(study.id);
    const controller = new AbortController();
    this.aborts.set(row.id, controller);
    this.startJob(`join:${row.id}`, () => this.joinAndCalibrate(row.id, controller.signal));
  }

  private retire(row: RemoteHostRow, why: string): void {
    if (row.state !== "ready") return;
    this.store.tx(() => {
      this.store.updateRemoteHost(row.id, { state: "retiring", retiring_at: this.ctx.now(), left_reason: why, phase: "finishing what it measures" });
      this.store.updateBenchHost(row.study_id, row.bench_host_id, { active: 0 });
      this.store.event(row.study_id, "remote.retiring", "plugin", { remote: row.id, host: row.bench_host_id, slot: row.slot, reason: why });
    });
    this.hooks.publish(row.study_id);
  }

  /**
   * A machine leaves: no more work, in-flight measurements on it restart
   * from scratch elsewhere, and the provider destroys it.
   */
  leave(row: RemoteHostRow, reason: string, opts: { notify?: boolean; expected?: boolean } = {}): void {
    const fresh = this.store.remoteHost(row.id);
    if (!fresh || fresh.state === "gone") return;
    this.aborts.get(row.id)?.abort();
    this.aborts.delete(row.id);
    this.joined.delete(row.id);
    this.adopting.delete(row.id);
    this.runners.get(row.id)?.markLost(reason);
    const study = this.store.study(row.study_id);
    const name = this.store.benchHost(row.study_id, row.bench_host_id)?.name ?? row.bench_host_id;
    this.store.tx(() => {
      this.store.updateRemoteHost(row.id, { state: "gone", left_at: this.ctx.now(), left_reason: clip(reason, 500), phase: null });
      this.store.updateBenchHost(row.study_id, row.bench_host_id, { active: 0, best_build_sha: null });
      this.store.event(row.study_id, "remote.left", "plugin", { remote: row.id, host: row.bench_host_id, slot: row.slot, reason: clip(reason, 300), expected: Boolean(opts.expected) });
    });
    const cancelled = this.pipeline.cancelMeasurements((e) => e.hostId === row.bench_host_id && e.studyId === row.study_id, `remote bench host ${name} left (${clip(reason, 200)})`);
    if (row.remote_id) this.startJob(`destroy:${row.id}`, () => this.destroy(row.provider, row.remote_id!));
    if (study && (opts.notify || (!opts.expected && cancelled > 0))) {
      void this.hooks.notify(study, "remote.lost", `Remote bench host ${name} (${row.provider}) left: ${clip(reason, 300)}.${cancelled ? ` ${cancelled} measurement(s) on it restart from scratch on another bench host.` : ""} A replacement joins on its own. Nothing to do unless this keeps happening (Bench tab).`, { quiet: true });
    }
    this.hooks.publish(row.study_id);
    this.hooks.kick();
  }

  private async destroy(provider: string, remoteId: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      try {
        await this.client(provider).call("benchProvider.destroy", { hostId: remoteId }, { retries: 1 });
        return;
      } catch (e) {
        if (e instanceof BenchProviderError && e.code === "not_found") return;
        if (i === 2) this.ctx.bb.log("warn", `remote bench: destroying ${provider} machine ${remoteId} failed: ${errText(e)} (orphan cleanup retries on the next load)`);
      }
    }
  }

  private startJob(key: string, fn: () => Promise<void>): void {
    if (this.jobs.has(key) || this.ctx.disposed) return;
    const job = (async () => {
      await Promise.resolve();
      try {
        await fn();
      } catch (e) {
        if (!this.ctx.disposed) this.ctx.bb.log("warn", `remote bench ${key}: ${errText(e)}`);
      } finally {
        this.jobs.delete(key);
      }
    })();
    this.jobs.set(key, job);
  }

  /** Wait for the fleet's background jobs (tests). */
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]);
  }

  private pollStatus(study: StudyRow, row: RemoteHostRow, now: number): void {
    // A machine kept across a reload is checked by verifyAdoptions (its provider may not be loaded yet).
    if (!row.remote_id || row.state === "creating" || this.adopting.has(row.id)) return;
    if (now - (this.polledAt.get(row.id) ?? 0) < this.config.statusPollMs) return;
    this.polledAt.set(row.id, now);
    this.startJob(`status:${row.id}`, async () => {
      let state: HostState;
      let detail: string | undefined;
      let expiresAt: string | null;
      try {
        ({ state, detail, expiresAt } = await this.client(row.provider).call("benchProvider.status", { hostId: row.remote_id! }, { retries: 1 }));
      } catch (e) {
        if (e instanceof BenchProviderError && e.code === "not_found") this.leave(row, "the provider no longer knows the machine", { notify: true });
        return;
      }
      this.store.updateRemoteHost(row.id, { status_at: this.ctx.now() });
      const exp = expiresAt ? Date.parse(expiresAt) : NaN;
      const fresh = this.store.remoteHost(row.id);
      if (fresh && Number.isFinite(exp) && (fresh.expires_at === null || exp < fresh.expires_at)) this.store.updateRemoteHost(row.id, { expires_at: exp });
      // A suspended machine may come back on other hardware: treat it as gone, never reuse it.
      if (LEAVING_STATES.includes(state)) this.leave(row, `the machine is ${state}${detail ? ` (${clip(detail, 200)})` : ""}`, { notify: true });
      void study;
    });
  }

  // ------------------------------------------------------------ joining

  /** The commit a machine joins on: the calibration's baseline while the study calibrates, else best. */
  private targetSha(study: StudyRow): string {
    return this.calibrating.get(study.id) ?? study.best_sha ?? "";
  }
  /** The study base every machine's shallow clone starts from. */
  private baseSha(study: StudyRow): string {
    return study.base_sha ?? this.targetSha(study);
  }
  /** The commit an entry's seed is built on: the calibration's baseline, else the current segment's. */
  private seedBaseline(study: StudyRow): string {
    return this.calibrating.get(study.id) ?? this.store.segment(study.id, study.segment)?.baseline_sha ?? this.targetSha(study);
  }
  /**
   * What an entry's seed is built from: the baseline it runs in, the seed
   * command, its allowlist and the cores it is told about. A spec version
   * that changes none of them (a budget, the protocol, another entry) reuses
   * the seed instead of building it again.
   */
  seedKey(study: StudyRow, entryIndex: number, baseline: string): string {
    let entry: RemoteBenchSpec | undefined;
    try {
      entry = this.entries(study)[entryIndex];
    } catch {
      entry = undefined;
    }
    const inputs = JSON.stringify({ seed: entry?.seed ?? null, allow: [...(entry?.seed_allow ?? [])].sort(), cores: entry?.cores ?? null });
    return `${baseline}:${createHash("sha256").update(inputs).digest("hex").slice(0, 16)}`;
  }

  private async joinAndCalibrate(rowId: number, signal: AbortSignal): Promise<void> {
    const row0 = this.store.remoteHost(rowId)!;
    const study0 = this.store.study(row0.study_id)!;
    const entry = this.entries(study0)[row0.entry];
    if (!entry) return this.leave(row0, "its spec entry is gone", { expected: true });
    const started = this.ctx.now();
    try {
      await this.join(rowId, entry, signal);
      if (signal.aborted) return;
      const seconds = (this.ctx.now() - started) / 1000;
      this.store.updateRemoteHost(rowId, { join_seconds: seconds });
      this.store.event(row0.study_id, "remote.joined", "plugin", { remote: rowId, host: row0.bench_host_id, seconds: Math.round(seconds * 10) / 10 });
      this.failures.delete(this.failureKey(row0.study_id, row0.entry));
      const study = this.store.study(row0.study_id)!;
      if (this.calibrating.has(study.id)) {
        // The study's calibration calibrates it with every other bench host.
        this.joined.add(rowId);
        this.store.updateRemoteHost(rowId, { state: "calibrating", phase: "joined: waits for the study's calibration" });
        this.hooks.publish(study.id);
        return;
      }
      await this.arrivalCalibration(rowId, signal);
    } catch (e) {
      // Ended meanwhile: make sure the machine doesn't outlive its row.
      const now = this.store.remoteHost(rowId);
      if (now?.state === "gone" && now.remote_id && !this.ctx.disposed) await this.destroy(now.provider, now.remote_id);
      if (signal.aborted || this.ctx.disposed) return;
      this.joinFailed(rowId, e);
    }
  }

  private phase(rowId: number, text: string, patch: Partial<RemoteHostRow> = {}): void {
    const row = this.store.remoteHost(rowId);
    if (!row || row.state === "gone") throw new RemoteHostLostError("left while joining");
    this.store.updateRemoteHost(rowId, { phase: text, ...patch });
    this.hooks.publish(row.study_id);
  }

  private async join(rowId: number, entry: RemoteBenchSpec, signal: AbortSignal): Promise<void> {
    const row0 = this.store.remoteHost(rowId)!;
    const study = this.store.study(row0.study_id)!;
    const target = this.targetSha(study);
    if (!target) throw new Error("the study has no baseline or best commit yet");
    const baseSha = this.baseSha(study);
    // Edit-host artifacts first: a refused seed costs no machine. The seed is built once per segment
    // (on its baseline), so replacements reuse it; during a calibration, the baseline being calibrated.
    const seed = entry.seed ? await this.seedFor(study, row0.entry, entry, this.seedBaseline(study)) : null;
    const base = await this.baseFor(study, baseSha);
    if (signal.aborted) return;
    const client = this.client(row0.provider);
    this.phase(rowId, "creating the machine", { state: "joining" });
    // The study's machine options, verbatim, as recorded when the row was made (a spec change applies to new machines).
    const machine = safeJson<Record<string, string | number | boolean>>(row0.machine_json);
    const created = await client.call("benchProvider.create", { key: row0.create_key, cores: row0.cores, ...(row0.memory_gb !== null ? { memoryGb: row0.memory_gb } : {}), lifetimeSeconds: row0.lifetime_seconds, labels: { ...OWNER_LABEL, study: study.id, slot: row0.slot }, ...(machine ? { machine } : {}) }, { retries: 3, signal });
    const providerExp = created.expiresAt ? Date.parse(created.expiresAt) : NaN;
    const ownExp = this.ctx.now() + row0.lifetime_seconds * 1000;
    this.assignedAt.set(rowId, Date.now());
    this.store.updateRemoteHost(rowId, { remote_id: created.hostId, expires_at: Number.isFinite(providerExp) ? Math.min(providerExp, ownExp) : ownExp });
    // Left while create was in flight (pause, archive, unload): the new machine has no use.
    if (signal.aborted || this.store.remoteHost(rowId)?.state === "gone") {
      await this.destroy(row0.provider, created.hostId);
      return;
    }
    this.store.event(study.id, "remote.created", "plugin", { remote: rowId, host: row0.bench_host_id, provider: row0.provider, slot: row0.slot, state: created.state });
    if (signal.aborted) return;
    let state = created.state;
    const deadline = this.ctx.now() + this.config.joinTimeoutMs;
    const t0 = Date.now();
    while (state !== "ready") {
      if (LEAVING_STATES.includes(state)) throw new Error(`the machine is ${state} while provisioning`);
      if (this.ctx.now() > deadline || Date.now() - t0 > this.config.joinTimeoutMs) throw new Error(`the machine was not ready after ${formatDuration(this.config.joinTimeoutMs / 1000)}`);
      this.phase(rowId, "waiting for the machine to be ready");
      await new Promise((r) => setTimeout(r, this.config.readyPollMs));
      if (signal.aborted) return;
      state = (await client.call("benchProvider.status", { hostId: created.hostId }, { retries: 2, signal })).state;
    }
    this.runners.delete(rowId);
    const runner = this.runnerOf(this.store.remoteHost(rowId)!);
    const info = await runner.info();
    const home = await runner.init();
    this.phase(rowId, "connected", { home, info_json: JSON.stringify(info) });
    if (info.nproc !== null && info.nproc !== row0.cores && info.cpuQuotaCores !== row0.cores) {
      this.store.event(study.id, "remote.shape", "plugin", { remote: rowId, cores: row0.cores, nproc: info.nproc, quota: info.cpuQuotaCores });
    }
    if (seed) {
      this.phase(rowId, `uploading the seed (${mib(seed.bytes ?? 0)})`);
      await runner.installSeed(seed.path!, seed.sha256!, signal);
      this.store.updateRemoteHost(rowId, { seed_sha: seed.sha256 });
      runner.setEnv({ AUTORESEARCH_SEED: `${home}/bb-autoresearch/seed/${seed.sha256}` });
    }
    this.phase(rowId, `uploading the repository (${mib(base.bytes ?? 0)}, shallow at the study base)`);
    await runner.initRepo(base.path!, base.sha256!, baseSha, signal);
    this.store.updateRemoteHost(rowId, { base_sha: baseSha });
    this.store.addTransfer({ study_id: study.id, host_id: row0.bench_host_id, sha: baseSha, purpose: "base (shallow bootstrap)", bytes: base.bytes ?? 0, chunks: 1, ms: 0, ok: 1, error: null });
    this.phase(rowId, "sending best");
    const benchRow = this.store.benchHost(study.id, row0.bench_host_id)!;
    const site = this.pipeline.site(study, benchRow);
    const dir = await site.checkout("best", target, "best", "join", signal);
    if (entry.setup) {
      this.phase(rowId, "running setup");
      const spec = this.store.spec(study);
      const r = await runner.run({ cwd: dir, command: entry.setup, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: "setup", tailBytes: 8 * 1024 }, { signal });
      if (r.exitCode !== 0) throw new Error(`setup exited ${r.exitCode}${r.timedOut ? " (timeout)" : ""}: ${clip(`${r.stdout}\n${r.stderr}`.trim().slice(-600), 600)}`);
    }
    this.store.updateRemoteHost(rowId, { state: "calibrating", phase: "joined" });
  }

  /** A/A on best on this machine alone, then it measures. */
  private async arrivalCalibration(rowId: number, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const row = this.store.remoteHost(rowId);
      const study = row ? this.store.study(row.study_id) : undefined;
      if (!row || row.state === "gone" || !study || signal.aborted) return;
      if (!["running", "harvesting"].includes(study.state) || !study.best_sha) {
        if (this.calibrating.has(study.id)) {
          this.joined.add(rowId);
          this.store.updateRemoteHost(rowId, { phase: "joined: waits for the study's calibration" });
        }
        return;
      }
      const spec = this.store.spec(study);
      this.phase(rowId, attempt > 1 ? `calibrating (A/A on best, try ${attempt})` : "calibrating (A/A on best)", { state: "calibrating" });
      const benchRow = this.store.benchHost(study.id, row.bench_host_id)!;
      try {
        const outcome = await calibrateHost(this.ctx, this.pipeline, study, benchRow, study.best_sha, spec.oracle.timeout_minutes * 60_000);
        if (signal.aborted) return;
        if (outcome.mde > spec.oracle.protocol.max_mde) {
          this.leave(row, `too noisy: its win threshold would be ${(outcome.mde * 100).toFixed(2)}%, above max_mde ${(spec.oracle.protocol.max_mde * 100).toFixed(2)}%`, { notify: true });
          return;
        }
        const unjudged = guardrailProblems([{ host: benchRow.name, guardrails: outcome.guardrails ?? [] }], spec);
        if (unjudged.length) {
          this.leave(row, `too noisy for a guardrail: ${clip(unjudged[0]!, 300)}`, { notify: true });
          return;
        }
        if (this.noisyOnArrival(study, spec, row, outcome)) return;
        this.markCalibrated(study, row.bench_host_id, outcome, study.best_sha);
        return;
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof HealthError && attempt < 5) {
          this.phase(rowId, `health check failed, calibrating again in ${spec.oracle.health.retry_seconds} s`);
          await new Promise((r) => setTimeout(r, Math.min(spec.oracle.health.retry_seconds * 1000, this.config.statusPollMs * 4)));
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * A machine that calibrated on arrival much noisier than the study's other
   * bench hosts (`max_host_noise_ratio` times their median noise floor) is
   * replaced, at most NOISY_REPLACEMENTS times in a row per entry; then it is
   * kept, with a notice. Returns whether it left.
   */
  private noisyOnArrival(study: StudyRow, spec: StudySpec, row: RemoteHostRow, outcome: CalibrationOutcome): boolean {
    const limit = spec.oracle.max_host_noise_ratio ?? 2;
    if (spec.oracle.noise === "deterministic" || !(limit > 0)) return false;
    const peers = this.pipeline.dispatchHosts(study, spec).filter((h) => h.host_id !== row.bench_host_id).map((h) => h.noise_floor);
    const samples = spec.oracle.noise === "expensive" ? spec.oracle.protocol.calibration_runs : spec.oracle.protocol.calibration_pairs;
    const hit = noisyAgainstPeers(outcome.noiseFloor, peers, limit, chanceRatio(spec.oracle.noise, samples));
    // Above the ratio but within what chance gives equal hosts: it measures (with its own threshold).
    if (!hit?.significant) {
      if (hit === null) this.setNoisyStreak(study.id, row.entry, 0);
      return false;
    }
    const name = this.store.benchHost(study.id, row.bench_host_id)?.name ?? row.bench_host_id;
    const why = noisyHostText({ hostId: row.bench_host_id, name, noise: outcome.noiseFloor, ...hit }, limit, spec.oracle.noise === "expensive" ? "per run" : "per pair");
    const streak = this.noisyStreak(study.id, row.entry);
    this.store.event(study.id, "bench.noisy_host", "plugin", { host: row.bench_host_id, mode: "remote", noise: outcome.noiseFloor, peers: hit.peers, ratio: Math.round(hit.ratio * 100) / 100, limit, action: streak < NOISY_REPLACEMENTS ? "replaced" : "kept", when: "arrival" });
    if (streak < NOISY_REPLACEMENTS) {
      this.setNoisyStreak(study.id, row.entry, streak + 1);
      this.leave(row, `much noisier than the other bench hosts: ${why}`, { notify: true });
      return true;
    }
    // From now on this entry's machines are kept as they come (and recalibrations keep them too): see acceptsNoisy.
    // The notice goes out once, not on every rotation.
    this.setNoisyStreak(study.id, row.entry, NOISY_REPLACEMENTS + 1);
    if (streak === NOISY_REPLACEMENTS) void this.hooks.notify(study, "bench.noisy_host", `Remote bench host ${name} (${row.provider}) is much noisier than the other bench hosts (${why}), after ${streak} replacement(s) in a row that were too: it is kept and measures with its own win threshold; candidates go to quieter hosts first. Nothing to do, unless the provider can lend quieter machines.`, { quiet: true });
    return false;
  }

  /**
   * Whether a noisy machine of this entry is kept rather than replaced: the
   * entry already replaced NOISY_REPLACEMENTS machines in a row for their
   * noise (its provider's machines are all noisier than the other hosts).
   */
  acceptsNoisy(study: StudyRow, benchHostId: string): boolean {
    const row = this.store.remoteHostByBench(study.id, benchHostId);
    return row ? this.noisyStreak(study.id, row.entry) >= NOISY_REPLACEMENTS : false;
  }

  /** Machines of an entry replaced in a row for their noise (persisted on the study: a plugin reload keeps the count). */
  private noisyStreak(studyId: string, entry: number): number {
    const map = safeJson<Record<string, number>>(this.store.study(studyId)?.remote_noisy_json ?? null) ?? {};
    return map[String(entry)] ?? 0;
  }

  private setNoisyStreak(studyId: string, entry: number, n: number): void {
    const study = this.store.study(studyId);
    if (!study) return;
    const map = safeJson<Record<string, number>>(study.remote_noisy_json) ?? {};
    if ((map[String(entry)] ?? 0) === n) return;
    if (n > 0) map[String(entry)] = n;
    else delete map[String(entry)];
    this.store.updateStudy(studyId, { remote_noisy_json: Object.keys(map).length ? JSON.stringify(map) : null });
  }

  /** The study's calibration found this machine much noisier than its peers: it leaves when the calibration ends, and is replaced. */
  markNoisy(study: StudyRow, benchHostId: string, reason: string): void {
    const row = this.store.remoteHostByBench(study.id, benchHostId);
    if (row && row.state !== "gone") this.noisy.set(row.id, reason);
  }

  /** A machine calibrated (on arrival, or with the study's calibration): it measures from now on. */
  markCalibrated(study: StudyRow, benchHostId: string, outcome: CalibrationOutcome, sha: string): void {
    const row = this.store.remoteHostByBench(study.id, benchHostId);
    if (!row || row.state === "gone") return;
    this.joined.delete(row.id);
    this.adopting.delete(row.id);
    const cal = { sha, noiseFloor: outcome.noiseFloor, mde: outcome.mde, evalSeconds: outcome.evalSeconds, sideRuns: outcome.sideRuns ?? null, runSeconds: outcome.runSeconds ?? null, guardrails: outcome.guardrails ?? [], problems: outcome.problems.slice(0, 5), report: clip(outcome.report, 2000), at: this.ctx.now() };
    const wasReady = row.state === "ready";
    this.store.tx(() => {
      this.store.updateRemoteHost(row.id, { state: "ready", phase: null, ready_at: row.ready_at ?? this.ctx.now(), calibration_json: JSON.stringify(cal) });
      this.store.updateBenchHost(study.id, benchHostId, { active: 1, status: "online", status_at: this.ctx.now() });
      this.store.event(study.id, "remote.ready", "plugin", { remote: row.id, host: benchHostId, slot: row.slot, noise_floor: outcome.noiseFloor, mde: outcome.mde, recalibrated: wasReady });
    });
    if (row.replaces !== null && !wasReady) {
      const old = this.store.remoteHost(row.replaces);
      if (old && old.state === "ready") this.retire(old, `rotated out: #${row.id} took its slot`);
    }
    this.hooks.publish(study.id);
    this.hooks.kick();
  }

  private joinFailed(rowId: number, e: unknown): void {
    const row = this.store.remoteHost(rowId);
    if (!row || row.state === "gone") return;
    const study = this.store.study(row.study_id);
    const msg = errText(e);
    const key = this.failureKey(row.study_id, row.entry);
    const f = this.failures.get(key) ?? { n: 0, until: 0, notified: false, last: "" };
    f.n += 1;
    f.last = msg;
    const now = this.ctx.now();
    if (e instanceof SeedError && e.refused && study) f.seedKey = this.seedKey(study, row.entry, this.seedBaseline(study));
    f.until = now + (f.n >= this.config.maxFailures ? this.config.blockedMs : this.config.retryMs * f.n);
    this.failures.set(key, f);
    this.store.updateRemoteHost(rowId, { error: clip(msg, 1000) });
    if (study) this.store.event(study.id, "remote.failed", "plugin", { remote: rowId, host: row.bench_host_id, slot: row.slot, provider: row.provider, failures: f.n, error: clip(msg, 500), seed: e instanceof SeedError });
    this.leave(row, `could not join: ${clip(msg, 300)}`, { expected: true });
    if (study && !(e instanceof SeedError) && (f.n === 1 || (f.n >= this.config.maxFailures && !f.notified))) {
      if (f.n >= this.config.maxFailures) f.notified = true;
      const next = f.n >= this.config.maxFailures ? `No new machine from it for ${formatDuration(this.config.blockedMs / 1000)}.` : "A new machine is tried shortly.";
      void this.hooks.notify(study, "remote.failed", `Remote bench (${row.provider}) could not add a machine${f.n > 1 ? ` (${f.n} failures in a row)` : ""}: ${clip(msg, 400)}. ${next} Next: check the provider plugin and the spec's setup on the Bench tab.`);
    }
  }

  // ------------------------------------------------------------ artifacts

  /** The shallow bundle of the study base, built once on the edit host. */
  private async baseFor(study: StudyRow, baseSha: string): Promise<RemoteArtifactRow> {
    const key = `base:${study.id}:${baseSha}`;
    let job = this.artifactJobs.get(key);
    if (!job) {
      job = (async () => {
        const edit = this.ctx.bb.hostRunner(study.host_id!);
        const b = await edit.baseBundle(study.repo_path!, baseSha);
        return this.store.upsertArtifact({ study_id: study.id, kind: "base", entry: -1, key: baseSha, state: "ok", path: b.path, sha256: b.sha256, bytes: b.bytes, files: null, detail_json: JSON.stringify({ cached: b.cached }) });
      })();
      this.artifactJobs.set(key, job);
      job.finally(() => this.artifactJobs.delete(key)).catch(() => undefined);
    }
    return await job;
  }

  /**
   * An entry's seed for a segment baseline: the seed command runs on the edit
   * host in a checkout of that commit, then the result is scanned for
   * credentials and packed (host/seed.ts). Built once per baseline and seed
   * inputs (seedKey), cached by content hash.
   */
  async seedFor(study: StudyRow, entryIndex: number, entry: RemoteBenchSpec, baseline: string): Promise<RemoteArtifactRow> {
    const k = this.seedKey(study, entryIndex, baseline);
    const cached = this.store.artifact(study.id, "seed", entryIndex, k);
    if (cached?.state === "refused") throw new SeedError(`the seed was refused: ${seedRefusalText(cached)}`, true);
    const edit = this.ctx.bb.hostRunner(study.host_id!);
    if (cached?.state === "ok" && cached.path) {
      const there = await edit.exec({ cwd: study.repo_path!, command: `test -f '${cached.path.replace(/'/gu, `'\\''`)}'`, timeoutMs: 30_000 }).catch(() => null);
      if (there?.exitCode === 0) return cached;
    }
    const jobKey = `seed:${study.id}:${entryIndex}:${k}`;
    let job = this.artifactJobs.get(jobKey);
    if (!job) {
      job = this.buildSeed(study, entryIndex, entry, baseline, k);
      this.artifactJobs.set(jobKey, job);
      job.finally(() => this.artifactJobs.delete(jobKey)).catch(() => undefined);
    }
    return await job;
  }

  private async buildSeed(study: StudyRow, entryIndex: number, entry: RemoteBenchSpec, baseline: string, key: string): Promise<RemoteArtifactRow> {
    const edit = this.ctx.bb.hostRunner(study.host_id!);
    const spec = this.store.spec(study);
    const dir = await edit.checkout(study.repo_path!, `${study.slug}-seed`, baseline);
    this.store.event(study.id, "remote.seed_building", "plugin", { entry: entryIndex, baseline });
    const r = await edit.run({ cwd: dir, command: entry.seed!, timeoutMs: spec.oracle.timeout_minutes * 60_000, tailBytes: 64 * 1024, label: "seed", env: { AUTORESEARCH_CORES: String(entry.cores) } });
    if (r.exitCode !== 0) {
      const detail = clip(`${r.stdout}\n${r.stderr}`.trim().slice(-600), 600);
      this.store.upsertArtifact({ study_id: study.id, kind: "seed", entry: entryIndex, key, state: "failed", path: null, sha256: null, bytes: null, files: null, detail_json: JSON.stringify({ error: `exit ${r.exitCode}`, output: detail }) });
      throw new SeedError(`the seed command exited ${r.exitCode}${r.timedOut ? " (timeout)" : ""}: ${detail}`, false);
    }
    const source = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (!source) throw new SeedError("the seed command printed no path (its last line of output must be the directory or tarball to ship)", false);
    const packed = await edit.seedPack({ source, cwd: dir, allow: entry.seed_allow });
    if (!packed.ok) {
      const row = this.store.upsertArtifact({ study_id: study.id, kind: "seed", entry: entryIndex, key, state: "refused", path: null, sha256: null, bytes: null, files: packed.files, detail_json: JSON.stringify({ findings: packed.findings.slice(0, 200), allowed: packed.allowed.length, error: packed.error ?? null }) });
      this.store.event(study.id, "remote.seed_refused", "plugin", { entry: entryIndex, findings: packed.findings.length, error: packed.error ?? null });
      await this.hooks.notify(
        study,
        "remote.seed_refused",
        packed.error
          ? `The seed of remote bench ${entryIndex + 1} (${entry.provider}) could not be read: ${clip(packed.error, 300)}. No machine was created. Next: fix the seed command with a spec change.`
          : `The seed of remote bench ${entryIndex + 1} (${entry.provider}) was not uploaded: the credential scan matched ${packed.findings.length} file(s):\n${seedFindingsText(packed.findings, 15)}\nNo machine was created. Next: remove them from the seed, or, if they are known test fixtures, list them in seed_allow with a spec change.`,
      );
      throw new SeedError(`the seed was refused: ${seedRefusalText(row)}`, true);
    }
    const row = this.store.upsertArtifact({ study_id: study.id, kind: "seed", entry: entryIndex, key, state: "ok", path: packed.path, sha256: packed.fileSha256, bytes: packed.bytes, files: packed.files, detail_json: JSON.stringify({ contentHash: packed.sha256, kind: packed.kind, cached: packed.cached, allowed: packed.allowed.length }) });
    this.store.event(study.id, "remote.seed_built", "plugin", { entry: entryIndex, bytes: packed.bytes, files: packed.files, cached: packed.cached, allowed: packed.allowed.length });
    return row;
  }

  // ------------------------------------------------------------ calibration

  /**
   * The study's calibration needs its machines: fill every slot (machines
   * join on `baseline`) and wait until each slot has one that joined, or
   * failed `maxFailures` times, or the join timeout passed. Returns the bench
   * host rows to calibrate with the others.
   */
  async joinForCalibration(study: StudyRow, baseline: string): Promise<{ hosts: BenchHostRow[]; problems: string[] }> {
    const entries = this.entries(study);
    if (!entries.length) return { hosts: [], problems: [] };
    this.calibrating.set(study.id, baseline);
    try {
      // Machines already measuring (an oracle change mid-run) are calibrated as they are.
      const t0 = Date.now();
      for (;;) {
        if (this.ctx.disposed) return { hosts: [], problems: ["plugin unloaded"] };
        this.tick();
        const live = this.store.remoteHosts(study.id, { live: true });
        const problems: string[] = [];
        let waiting = false;
        entries.forEach((e, i) => {
          for (let k = 1; k <= e.hosts; k++) {
            const slot = `${i}.${k}`;
            const mine = live.filter((r) => r.slot === slot);
            if (mine.some((r) => (r.state === "ready" && !this.adopting.has(r.id)) || this.joined.has(r.id))) continue;
            const f = this.failures.get(this.failureKey(study.id, i));
            const seedBlocked = f?.seedKey !== undefined && f.seedKey === this.seedKey(study, i, this.seedBaseline(study));
            if (f && (seedBlocked || (f.seedKey === undefined && f.n >= this.config.maxFailures))) problems.push(`remote bench ${i + 1} (${e.provider}) slot ${k}: ${clip(f.last, 400)}`);
            else waiting = true;
          }
        });
        if (!waiting) {
          const rows = live.filter((r) => (r.state === "ready" && !this.adopting.has(r.id)) || this.joined.has(r.id)).map((r) => this.store.benchHost(study.id, r.bench_host_id)!).filter(Boolean);
          return { hosts: rows, problems };
        }
        if (Date.now() - t0 > this.config.joinTimeoutMs) return { hosts: [], problems: [`remote bench: machines did not join within ${formatDuration(this.config.joinTimeoutMs / 1000)}`] };
        await new Promise((r) => setTimeout(r, Math.min(250, this.config.readyPollMs)));
      }
    } finally {
      // Joined machines keep waiting until the calibration calibrates them (or the study leaves calibrating).
    }
  }

  /** The study's calibration finished (or failed): stop holding machines for it. */
  endCalibration(study: StudyRow): void {
    this.calibrating.delete(study.id);
    for (const r of this.store.remoteHosts(study.id, { live: true })) {
      const noisy = this.noisy.get(r.id);
      this.noisy.delete(r.id);
      // A machine much noisier than its peers is replaced (the calibration report says so); its slot fills once the study runs.
      if (noisy) {
        this.joined.delete(r.id);
        this.leave(r, noisy, { expected: true });
      } else if (this.joined.has(r.id)) {
        this.joined.delete(r.id);
        this.leave(r, "not calibrated with the study", { expected: true });
      }
    }
    this.tick();
  }

  // ------------------------------------------------------------ cleanup

  /**
   * List this plugin's machines at each provider and destroy those that no
   * live row uses (orphans of a crash, a failed destroy, an interrupted
   * create). Live rows whose machine the provider no longer lists leave.
   */
  async cleanupOrphans(providers?: string[]): Promise<number> {
    const list = providers ?? this.allProviders();
    let destroyed = 0;
    for (const provider of list) {
      const listedFrom = Date.now();
      let hosts;
      try {
        hosts = (await this.client(provider).call("benchProvider.list", { labels: { ...OWNER_LABEL } }, { retries: 1 })).hosts;
      } catch (e) {
        this.ctx.bb.log("info", `remote bench: listing ${provider} machines failed: ${errText(e)}`);
        continue;
      }
      const live = this.store.liveRemoteHosts().filter((r) => r.provider === provider);
      const inUse = new Set(live.map((r) => r.remote_id).filter((x): x is string => x !== null));
      // Machines of rows that already left are ours (their destroy may still be in flight): destroyed, not orphans.
      const known = new Set(this.store.knownRemoteIds(provider));
      // A create still in flight: its machine may be listed before its row knows the id.
      const creating = new Set(live.filter((r) => r.remote_id === null).map((r) => `${r.study_id}/${r.slot}`));
      for (const h of hosts) {
        if (h.state === "gone" || inUse.has(h.hostId)) continue;
        if (creating.has(`${h.labels.study ?? ""}/${h.labels.slot ?? ""}`)) continue;
        await this.destroy(provider, h.hostId);
        if (known.has(h.hostId)) continue;
        destroyed += 1;
        const studyId = h.labels.study;
        if (studyId && this.store.study(studyId)) this.store.event(studyId, "remote.orphan_destroyed", "plugin", { provider, machine: h.hostId, slot: h.labels.slot ?? null });
      }
      const listed = new Set(hosts.filter((h) => h.state !== "gone").map((h) => h.hostId));
      // Rows whose create answered while the list was in flight aren't judged by that list.
      for (const r of live) if (r.remote_id && !listed.has(r.remote_id) && (this.assignedAt.get(r.id) ?? 0) < listedFrom) this.leave(r, "the provider no longer lists the machine", { notify: true });
    }
    return destroyed;
  }

  private allProviders(): string[] {
    const set = new Set(this.store.remoteProviders());
    for (const s of this.store.studies()) {
      if (s.state === "archived") continue;
      try {
        for (const e of this.entries(s)) set.add(e.provider);
      } catch {
        // no spec yet
      }
    }
    return [...set];
  }

  /** Archive: every machine of the study goes now (measurements were cancelled by the archive). */
  async releaseStudy(study: StudyRow, reason: string): Promise<number> {
    const live = this.store.remoteHosts(study.id, { live: true });
    for (const r of live) this.leave(r, reason, { expected: true });
    await this.settle();
    await this.cleanupOrphans([...new Set([...live.map((r) => r.provider), ...this.entries(study).map((e) => e.provider)])]);
    await this.gcArtifacts("study archived").catch((e) => this.ctx.bb.log("warn", `remote bench artifact cleanup: ${errText(e)}`));
    return live.length;
  }

  /**
   * Plugin load. Live rows belong to the previous instance. A machine it
   * kept (calibrated, `ready`) is re-adopted once verified: the provider
   * lists it as ready and a probe finds its repository there. Until then it
   * takes no work; one that can't be verified within ADOPT_TIMEOUT_MS leaves.
   * Rows that were joining, calibrating or retiring end, and every machine
   * the providers list that no live row uses is destroyed as an orphan.
   * Then seeds and base bundles no study uses are deleted.
   */
  async reconcile(): Promise<{ ended: number; adopting: number; adopted: number; destroyed: number }> {
    let ended = 0;
    const now = this.ctx.now();
    for (const r of this.store.liveRemoteHosts()) {
      if (r.state === "ready" && r.remote_id && r.home) {
        this.adopting.set(r.id, now);
        this.store.tx(() => {
          this.store.updateRemoteHost(r.id, { phase: ADOPT_PHASE });
          this.store.updateBenchHost(r.study_id, r.bench_host_id, { active: 0, best_build_sha: null });
        });
        continue;
      }
      this.store.tx(() => {
        this.store.updateRemoteHost(r.id, { state: "gone", left_at: now, left_reason: "plugin restarted", phase: null });
        this.store.updateBenchHost(r.study_id, r.bench_host_id, { active: 0, best_build_sha: null });
        this.store.event(r.study_id, "remote.left", "plugin", { remote: r.id, host: r.bench_host_id, slot: r.slot, reason: "plugin restarted", expected: true });
      });
      ended += 1;
    }
    const adopting = this.adopting.size;
    this.adoptTriedAt = now;
    const { adopted } = await this.verifyAdoptions();
    const destroyed = await this.cleanupOrphans();
    this.startJob("gc", () => this.gcArtifacts("plugin loaded").then(() => undefined));
    return { ended, adopting, adopted, destroyed };
  }

  /**
   * Check each kept machine: the provider's status must be ready, and a probe
   * on the machine must find the bench repository (and the seed it had). A
   * provider that can't answer yet (not loaded) is asked again on later
   * ticks, until ADOPT_TIMEOUT_MS.
   */
  private async verifyAdoptions(): Promise<{ adopted: number }> {
    let adopted = 0;
    for (const [rowId, since] of [...this.adopting]) {
      if (this.ctx.disposed) break;
      const row = this.store.remoteHost(rowId);
      if (!row || row.state === "gone") {
        this.adopting.delete(rowId);
        continue;
      }
      let status: { state: HostState; expiresAt: string | null; detail?: string };
      try {
        status = await this.client(row.provider).call("benchProvider.status", { hostId: row.remote_id! }, { retries: 1 });
      } catch (e) {
        if (e instanceof BenchProviderError && e.code === "not_found" && !(e instanceof ProviderMissingError)) {
          this.leave(row, "the provider no longer knows the machine (after a plugin reload)", { expected: true });
        } else if (this.ctx.now() - since >= ADOPT_TIMEOUT_MS) {
          this.leave(row, `could not be re-adopted after a plugin reload: ${clip(errText(e), 300)}`, { notify: true });
        } else this.store.updateRemoteHost(rowId, { phase: `${ADOPT_PHASE}: waiting for ${row.provider} (${clip(errText(e), 200)})` });
        continue;
      }
      if (status.state !== "ready") {
        this.leave(row, `the machine is ${status.state} after a plugin reload${status.detail ? ` (${clip(status.detail, 200)})` : ""}`, { expected: true });
        continue;
      }
      const exp = status.expiresAt ? Date.parse(status.expiresAt) : NaN;
      if (Number.isFinite(exp) && (row.expires_at === null || exp < row.expires_at)) this.store.updateRemoteHost(rowId, { expires_at: exp });
      const runner = this.runnerOf(row);
      const seedDir = row.seed_sha ? `${row.home}/bb-autoresearch/seed/${row.seed_sha}` : null;
      const probe = await runner
        .exec({ cwd: row.home!, command: `test -f ${q(`${runner.repoPath}/HEAD`)}${seedDir ? ` && test -f ${q(`${seedDir}/.autoresearch-seed-ok`)}` : ""} && echo ok`, timeoutMs: 60_000 })
        .catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: errText(e), timedOut: false, durationMs: 0 }));
      if (this.store.remoteHost(rowId)?.state === "gone") {
        this.adopting.delete(rowId);
        continue;
      }
      if (probe.exitCode !== 0 || !probe.stdout.includes("ok")) {
        this.leave(row, `could not be re-adopted after a plugin reload: ${probe.exitCode === -1 ? clip(probe.stderr, 300) : "its repository or seed is missing"}`, { expected: true });
        continue;
      }
      this.adopting.delete(rowId);
      this.store.tx(() => {
        this.store.updateRemoteHost(rowId, { phase: null, status_at: this.ctx.now() });
        this.store.updateBenchHost(row.study_id, row.bench_host_id, { active: 1, status: "online", status_at: this.ctx.now() });
        this.store.event(row.study_id, "remote.readopted", "plugin", { remote: row.id, host: row.bench_host_id, slot: row.slot, provider: row.provider });
      });
      adopted += 1;
      this.hooks.publish(row.study_id);
      this.hooks.kick();
    }
    return { adopted };
  }

  /** Whether a machine is kept across a reload but not verified yet (views). */
  isAdopting(rowId: number): boolean {
    return this.adopting.has(rowId);
  }

  /**
   * Plugin unload (reload, disable, shutdown). Calibrated machines are kept:
   * their rows stay `ready`, and the next instance re-adopts them (or, when
   * the plugin stays off, the provider ends them with their lifetime). This
   * instance stops using them at once: work in flight on them is cancelled.
   * Machines that were still joining, calibrating or retiring are destroyed
   * (best effort, bounded; the next load lists and destroys what is left).
   */
  async dispose(timeoutMs = 8_000): Promise<void> {
    const live = this.store.liveRemoteHosts();
    for (const a of this.aborts.values()) a.abort();
    const drop = live.filter((r) => !(r.state === "ready" && r.remote_id && r.home));
    for (const r of live) this.runners.get(r.id)?.markLost("plugin unloaded");
    for (const r of drop) {
      this.store.tx(() => {
        this.store.updateRemoteHost(r.id, { state: "gone", left_at: this.ctx.now(), left_reason: "plugin unloaded", phase: null });
        this.store.updateBenchHost(r.study_id, r.bench_host_id, { active: 0 });
      });
    }
    const destroys = drop.filter((r) => r.remote_id).map((r) => this.client(r.provider).call("benchProvider.destroy", { hostId: r.remote_id! }, { retries: 0 }).catch(() => undefined));
    await Promise.race([Promise.allSettled(destroys), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  // ------------------------------------------------------------ artifacts on disk

  /**
   * Paths of the seeds and base bundles a study still uses: the seed of each
   * spec entry for its current baseline and inputs (and the newest one built,
   * should the two differ), and the base bundle of its base.
   */
  private artifactsInUse(study: StudyRow): string[] {
    const rows = this.store.artifacts(study.id).filter((a) => a.state === "ok" && a.path).sort((x, y) => y.created_at - x.created_at || y.id - x.id);
    const keep = new Set<string>();
    const seen = new Set<number>();
    let entries: RemoteBenchSpec[] = [];
    try {
      entries = this.entries(study);
    } catch {
      // no spec yet
    }
    const baseline = this.seedBaseline(study);
    entries.forEach((_, i) => {
      const current = baseline ? this.store.artifact(study.id, "seed", i, this.seedKey(study, i, baseline)) : undefined;
      if (current?.state === "ok" && current.path) keep.add(current.path);
    });
    for (const a of rows) {
      if (a.kind === "seed" && !seen.has(a.entry)) {
        seen.add(a.entry);
        keep.add(a.path!);
      }
      if (a.kind === "base" && (a.key === study.base_sha || a.key === study.best_sha)) keep.add(a.path!);
    }
    return [...keep];
  }

  /**
   * Delete the seeds and base bundles on each edit host that no
   * non-archived study uses (at load, and when a study is archived).
   */
  async gcArtifacts(reason: string): Promise<Map<string, ArtifactReport>> {
    const keepByHost = new Map<string, Set<string>>();
    for (const s of this.store.studies()) {
      if (!s.host_id) continue;
      const keep = keepByHost.get(s.host_id) ?? new Set<string>();
      keepByHost.set(s.host_id, keep);
      if (s.state !== "archived") for (const p of this.artifactsInUse(s)) keep.add(p);
    }
    const out = new Map<string, ArtifactReport>();
    for (const [hostId, keep] of keepByHost) {
      if (this.ctx.disposed) break;
      let report: ArtifactReport;
      try {
        report = await this.ctx.bb.hostRunner(hostId).artifacts({ keep: [...keep], gc: true });
      } catch (e) {
        this.ctx.bb.log("info", `remote bench: artifact cleanup on ${hostId} failed: ${errText(e)}`);
        continue;
      }
      out.set(hostId, report);
      this.artifactReports.set(hostId, { at: this.ctx.now(), report, reason });
      if (report.deleted.files || report.scratch) {
        this.store.event(null, "remote.artifacts_deleted", "plugin", { host: hostId, reason, files: report.deleted.files, bytes: report.deleted.bytes, scratch: report.scratch, kept: report.seeds.files + report.bases.files - report.deleted.files });
        this.ctx.bb.log("info", `remote bench: deleted ${report.deleted.files} unused seed(s) and base bundle(s) (${mib(report.deleted.bytes)}) on ${hostId} (${reason})`);
      }
    }
    return out;
  }

  /**
   * What a study's edit host keeps on disk for remote bench hosts (a report,
   * nothing deleted), with what this study uses and what the last cleanup
   * deleted. Null when the host can't be asked.
   */
  async artifactUsage(study: StudyRow): Promise<ArtifactUsage | null> {
    if (!study.host_id) return null;
    let report: ArtifactReport;
    try {
      // A report for `bb study bench`: don't hold the command for long on a slow disk.
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000).unref?.());
      report = await Promise.race([this.ctx.bb.hostRunner(study.host_id).artifacts({ keep: [], gc: false }), timeout]);
    } catch {
      return null;
    }
    const mine = new Set(study.state === "archived" ? [] : this.artifactsInUse(study));
    const used = report.files.filter((f) => mine.has(f.path));
    const last = this.artifactReports.get(study.host_id);
    return {
      seeds: report.seeds,
      bases: report.bases,
      study: { files: used.length, bytes: used.reduce((a, f) => a + f.bytes, 0) },
      lastCleanup: last ? { at: last.at, reason: last.reason, files: last.report.deleted.files, bytes: last.report.deleted.bytes } : null,
    };
  }

  /** Live and recent machines of a study (views). */
  machines(studyId: string): RemoteHostRow[] {
    return this.store.remoteHosts(studyId, { limit: 40 });
  }

  /** Why an entry adds no machine now (views): failures, a refused seed. */
  entryBlock(studyId: string, entry: number): { failures: number; last: string; until: number | null; seedRefused: boolean } | null {
    const f = this.failures.get(this.failureKey(studyId, entry));
    if (!f) return null;
    return { failures: f.n, last: f.last, until: f.seedKey !== undefined ? null : f.until, seedRefused: f.seedKey !== undefined };
  }
}

/** Seeds and base bundles on a study's edit host (`bb study bench`, the Bench tab). */
export interface ArtifactUsage {
  seeds: { files: number; bytes: number };
  bases: { files: number; bytes: number };
  /** What this study uses of them (its newest seed per entry, its base bundle). */
  study: { files: number; bytes: number };
  lastCleanup: { at: number; reason: string; files: number; bytes: number } | null;
}

export function mib(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** What a refused seed matched, for notices and errors. */
export function seedRefusalText(row: RemoteArtifactRow): string {
  const d = JSON.parse(row.detail_json ?? "{}") as { findings?: Array<{ path: string; rule: string; line: number | null }>; error?: string | null };
  if (d.error) return d.error;
  return `${d.findings?.length ?? 0} credential-looking file(s), e.g. ${(d.findings ?? []).slice(0, 3).map((f) => `${f.path} (${f.rule})`).join(", ")}`;
}

export { REMOTE_LIVE_STATES };
