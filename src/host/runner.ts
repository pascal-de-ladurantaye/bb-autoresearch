// Server-side view of the host contract. The pipeline only talks to a
// HostRunner bound to one host id; it never touches the server's disk.
//
// - BbHostRunner: the real path, bb.host entry via bb.hosts.experimental_client.
// - LocalHostRunner: the same ops in-process (tests; also the escape hatch if
//   host RPC is unavailable on a machine).
import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type {
  BundleInfo,
  CommitInfo,
  ComposeInput,
  ComposeResult,
  DiffSummary,
  ExecInput,
  ExecResult,
  GitIdentity,
  HealthReport,
  HostContract,
  JobInput,
  JobStatus,
  PrepareInput,
  PrepareResult,
  SnapshotInput,
  SnapshotResult,
  hostSignals,
} from "./contract.ts";
import * as bundle from "./bundle.ts";
import { health } from "./health.ts";
import { JobRegistry } from "./jobs.ts";
import * as ops from "./ops.ts";

/** The host lost a background job: its worker restarted mid-command. */
export class HostJobLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostJobLostError";
  }
}

/** A run was cancelled through its AbortSignal. */
export class RunAbortedError extends Error {
  constructor(message = "run cancelled") {
    super(message);
    this.name = "RunAbortedError";
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Latest output line while the job runs (host signals and/or polling). */
  onProgress?: (line: string) => void;
}

interface JobApi {
  start(input: JobInput): Promise<string>;
  wait(jobId: string, waitMs: number): Promise<JobStatus>;
  cancel(jobId: string): Promise<boolean>;
  subscribe?(jobId: string, fn: (line: string) => void): () => void;
}

/**
 * Run a long command as a host background job: one short call to start it,
 * short polls until it ends, and a cancel call on abort. No call comes near
 * the 30-minute host call cap, however long the command runs.
 */
export async function runJob(api: JobApi, input: JobInput, opts: RunOptions = {}, pollMs = 20_000): Promise<ExecResult> {
  const { signal } = opts;
  if (signal?.aborted) throw new RunAbortedError();
  const jobId = await api.start(input);
  let last = "";
  const progress = (line: string) => {
    if (line && line !== last) {
      last = line;
      opts.onProgress?.(line);
    }
  };
  const unsubscribe = api.subscribe?.(jobId, progress);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    abortListener = () => resolve("aborted");
    signal?.addEventListener("abort", abortListener, { once: true });
  });
  try {
    for (;;) {
      const status = await Promise.race([api.wait(jobId, pollMs), aborted]);
      if (status === "aborted") {
        await api.cancel(jobId).catch(() => false);
        throw new RunAbortedError();
      }
      if (status.state === "unknown") throw new HostJobLostError(`host lost job ${jobId} (its worker restarted)`);
      progress(status.tail);
      if (status.state === "done" && status.result) return status.result;
    }
  } finally {
    unsubscribe?.();
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

/** Fan-out of host `progress` signals by job id (server.ts feeds it). */
export class ProgressBus {
  private subs = new Map<string, Set<(line: string) => void>>();
  subscribe(key: string, fn: (line: string) => void): () => void {
    const set = this.subs.get(key) ?? new Set();
    set.add(fn);
    this.subs.set(key, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(key);
    };
  }
  emit(key: string, line: string): void {
    for (const fn of this.subs.get(key) ?? []) fn(line);
  }
}

export interface HostRunner {
  readonly hostId: string;
  exec(input: ExecInput, signal?: AbortSignal): Promise<ExecResult>;
  resolveRef(repoPath: string, ref: string): Promise<string | null>;
  updateRef(repoPath: string, ref: string, newSha: string, oldSha: string | null): Promise<{ ok: boolean; current: string | null }>;
  deleteRef(repoPath: string, ref: string): Promise<boolean>;
  snapshot(input: SnapshotInput): Promise<SnapshotResult>;
  prepareCandidate(input: PrepareInput): Promise<PrepareResult>;
  rewordCommit(repoPath: string, sha: string, message: string, identity?: GitIdentity): Promise<string>;
  /** The identity git resolves in `repoPath` on this host (nulls when none is configured). */
  gitIdentity(repoPath: string): Promise<{ name: string | null; email: string | null }>;
  checkout(repoPath: string, key: string, sha: string): Promise<string>;
  removeCheckouts(repoPath: string, keyPrefix: string): Promise<number>;
  diffSummary(repoPath: string, from: string, to: string, maxPatchBytes: number): Promise<DiffSummary>;
  /** A long command as a background job (see runJob). */
  run(input: JobInput, opts?: RunOptions): Promise<ExecResult>;
  health(): Promise<HealthReport>;
  benchRepo(key: string): Promise<{ path: string; tips: string[] }>;
  removeBenchRepo(key: string): Promise<boolean>;
  hasCommits(repoPath: string, shas: string[]): Promise<string[]>;
  bundleCreate(repoPath: string, tip: string, basis: string[]): Promise<BundleInfo>;
  bundleRead(id: string, offset: number, length: number): Promise<{ data: string; eof: boolean }>;
  bundleWrite(id: string, offset: number, data: string): Promise<number>;
  bundleApply(input: { repoPath: string; id: string; sha: string; ref: string; sha256: string }): Promise<{ ok: boolean; detail: string }>;
  bundleDiscard(id: string): Promise<void>;
  commitLog(repoPath: string, from: string, to: string): Promise<CommitInfo[]>;
  composeCommits(input: ComposeInput): Promise<ComposeResult>;
  gitRemotes(repoPath: string): Promise<Array<{ name: string; url: string }>>;
  writeExport(key: string, files: Array<{ path: string; content: string }>): Promise<string>;
}

const GIT_TIMEOUT = 5 * 60_000;

export class BbHostRunner implements HostRunner {
  constructor(
    private readonly client: ExperimentalHostClient<HostContract, typeof hostSignals>,
    readonly hostId: string,
    private readonly progress?: ProgressBus,
  ) {}
  private opts(timeoutMs = GIT_TIMEOUT, signal?: AbortSignal) {
    return { hostId: this.hostId, timeoutMs, ...(signal ? { signal } : {}) };
  }
  async exec(input: ExecInput, signal?: AbortSignal): Promise<ExecResult> {
    // Leave headroom over the command's own timeout for the RPC round trip.
    return await this.client.call("exec", input, this.opts(Math.min(input.timeoutMs + 30_000, 30 * 60_000), signal));
  }
  async resolveRef(repoPath: string, ref: string) {
    return (await this.client.call("resolveRef", { repoPath, ref }, this.opts())).sha;
  }
  async updateRef(repoPath: string, ref: string, newSha: string, oldSha: string | null) {
    return await this.client.call("updateRef", { repoPath, ref, newSha, oldSha }, this.opts());
  }
  async deleteRef(repoPath: string, ref: string) {
    return (await this.client.call("deleteRef", { repoPath, ref }, this.opts())).deleted;
  }
  async snapshot(input: SnapshotInput) {
    return await this.client.call("snapshot", input, this.opts());
  }
  async prepareCandidate(input: PrepareInput) {
    return await this.client.call("prepareCandidate", input, this.opts());
  }
  async rewordCommit(repoPath: string, sha: string, message: string, identity?: GitIdentity) {
    return (await this.client.call("rewordCommit", { repoPath, sha, message, ...(identity ? { identity } : {}) }, this.opts())).sha;
  }
  async gitIdentity(repoPath: string) {
    return await this.client.call("gitIdentity", { repoPath }, this.opts(60_000));
  }
  async checkout(repoPath: string, key: string, sha: string) {
    return (await this.client.call("checkout", { repoPath, key, sha }, this.opts())).path;
  }
  async removeCheckouts(repoPath: string, keyPrefix: string) {
    return (await this.client.call("removeCheckouts", { repoPath, keyPrefix }, this.opts())).removed;
  }
  async diffSummary(repoPath: string, from: string, to: string, maxPatchBytes: number) {
    return await this.client.call("diffSummary", { repoPath, from, to, maxPatchBytes }, this.opts(60_000));
  }
  async run(input: JobInput, opts: RunOptions = {}) {
    return await runJob(
      {
        start: async (i) => (await this.client.call("jobStart", i, this.opts(60_000))).jobId,
        wait: async (jobId, waitMs) => await this.client.call("jobWait", { jobId, waitMs }, this.opts(waitMs + 30_000)),
        cancel: async (jobId) => (await this.client.call("jobCancel", { jobId }, this.opts(30_000))).cancelled,
        ...(this.progress ? { subscribe: (jobId: string, fn: (line: string) => void) => this.progress!.subscribe(jobId, fn) } : {}),
      },
      input,
      opts,
    );
  }
  async health() {
    return await this.client.call("health", null, this.opts(60_000));
  }
  async benchRepo(key: string) {
    return await this.client.call("benchRepo", { key }, this.opts());
  }
  async removeBenchRepo(key: string) {
    return (await this.client.call("removeBenchRepo", { key }, this.opts())).removed;
  }
  async hasCommits(repoPath: string, shas: string[]) {
    return (await this.client.call("hasCommits", { repoPath, shas }, this.opts(60_000))).present;
  }
  async bundleCreate(repoPath: string, tip: string, basis: string[]) {
    return await this.client.call("bundleCreate", { repoPath, tip, basis }, this.opts(15 * 60_000));
  }
  async bundleRead(id: string, offset: number, length: number) {
    return await this.client.call("bundleRead", { id, offset, length }, this.opts(5 * 60_000));
  }
  async bundleWrite(id: string, offset: number, data: string) {
    return (await this.client.call("bundleWrite", { id, offset, data }, this.opts(5 * 60_000))).bytes;
  }
  async bundleApply(input: { repoPath: string; id: string; sha: string; ref: string; sha256: string }) {
    return await this.client.call("bundleApply", input, this.opts(15 * 60_000));
  }
  async bundleDiscard(id: string) {
    await this.client.call("bundleDiscard", { id }, this.opts());
  }
  async commitLog(repoPath: string, from: string, to: string) {
    return (await this.client.call("commitLog", { repoPath, from, to }, this.opts())).commits;
  }
  async composeCommits(input: ComposeInput) {
    return await this.client.call("composeCommits", input, this.opts());
  }
  async gitRemotes(repoPath: string) {
    return (await this.client.call("gitRemotes", { repoPath }, this.opts(60_000))).remotes;
  }
  async writeExport(key: string, files: Array<{ path: string; content: string }>) {
    return (await this.client.call("writeExport", { key, files }, this.opts(60_000))).dir;
  }
}

export class LocalHostRunner implements HostRunner {
  private jobs: JobRegistry;
  constructor(
    private readonly dataDir: string,
    readonly hostId = "local",
    opts: { progressMs?: number; pollMs?: number; health?: () => Promise<HealthReport> } = {},
  ) {
    this.jobs = new JobRegistry(opts.progressMs ?? 5_000);
    this.pollMs = opts.pollMs ?? 1_000;
    this.probe = opts.health ?? health;
  }
  private readonly pollMs: number;
  /** The health probe: the real one by default; tests inject fixed readings so they never depend on machine load. */
  private readonly probe: () => Promise<HealthReport>;
  exec(input: ExecInput, signal?: AbortSignal) {
    return ops.exec(input, signal);
  }
  async resolveRef(repoPath: string, ref: string) {
    return (await ops.resolveRef(repoPath, ref)).sha;
  }
  updateRef(repoPath: string, ref: string, newSha: string, oldSha: string | null) {
    return ops.updateRef(repoPath, ref, newSha, oldSha);
  }
  async deleteRef(repoPath: string, ref: string) {
    return (await ops.deleteRef(repoPath, ref)).deleted;
  }
  snapshot(input: SnapshotInput) {
    return ops.snapshot(input);
  }
  prepareCandidate(input: PrepareInput) {
    return ops.prepareCandidate(input);
  }
  async rewordCommit(repoPath: string, sha: string, message: string, identity?: GitIdentity) {
    return (await ops.rewordCommit(repoPath, sha, message, identity)).sha;
  }
  gitIdentity(repoPath: string) {
    return ops.gitIdentityOf(repoPath);
  }
  async checkout(repoPath: string, key: string, sha: string) {
    return (await ops.checkout(this.dataDir, repoPath, key, sha)).path;
  }
  async removeCheckouts(repoPath: string, keyPrefix: string) {
    return (await ops.removeCheckouts(this.dataDir, repoPath, keyPrefix)).removed;
  }
  diffSummary(repoPath: string, from: string, to: string, maxPatchBytes: number) {
    return ops.diffSummary(repoPath, from, to, maxPatchBytes);
  }
  async run(input: JobInput, opts: RunOptions = {}) {
    const progress = new ProgressBus();
    return await runJob(
      {
        start: async (i) => this.jobs.start(i, { onProgress: (id, _label, line) => progress.emit(id, line) }),
        wait: (jobId, waitMs) => this.jobs.wait(jobId, waitMs),
        cancel: async (jobId) => this.jobs.cancel(jobId),
        subscribe: (jobId, fn) => progress.subscribe(jobId, fn),
      },
      input,
      opts,
      this.pollMs,
    );
  }
  /** Simulate a host worker restart: every job is forgotten (tests). */
  loseJobs(): void {
    this.jobs.forgetAll();
  }
  health() {
    return this.probe();
  }
  benchRepo(key: string) {
    return bundle.benchRepo(this.dataDir, key);
  }
  async removeBenchRepo(key: string) {
    return (await bundle.removeBenchRepo(this.dataDir, key)).removed;
  }
  async hasCommits(repoPath: string, shas: string[]) {
    return (await bundle.hasCommits(repoPath, shas)).present;
  }
  bundleCreate(repoPath: string, tip: string, basis: string[]) {
    return bundle.bundleCreate(this.dataDir, repoPath, tip, basis);
  }
  async bundleRead(id: string, offset: number, length: number) {
    return bundle.bundleRead(this.dataDir, id, offset, length);
  }
  async bundleWrite(id: string, offset: number, data: string) {
    return bundle.bundleWrite(this.dataDir, id, offset, data).bytes;
  }
  bundleApply(input: { repoPath: string; id: string; sha: string; ref: string; sha256: string }) {
    return bundle.bundleApply(this.dataDir, input.repoPath, input.id, input.sha, input.ref, input.sha256);
  }
  async bundleDiscard(id: string) {
    bundle.bundleDiscard(this.dataDir, id);
  }
  async commitLog(repoPath: string, from: string, to: string) {
    return (await ops.commitLog(repoPath, from, to)).commits;
  }
  composeCommits(input: ComposeInput) {
    return ops.composeCommits(input);
  }
  async gitRemotes(repoPath: string) {
    return (await ops.gitRemotes(repoPath)).remotes;
  }
  async writeExport(key: string, files: Array<{ path: string; content: string }>) {
    return ops.writeExport(this.dataDir, key, files).dir;
  }
}
