// Server-side view of the host contract. The pipeline only talks to a
// HostRunner bound to one host id; it never touches the server's disk.
//
// - BbHostRunner: the real path, bb.host entry via bb.hosts.experimental_client.
// - LocalHostRunner: the same ops in-process (tests; also the escape hatch if
//   host RPC is unavailable on a machine).
import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type {
  DiffSummary,
  ExecInput,
  ExecResult,
  HostContract,
  PrepareInput,
  PrepareResult,
  SnapshotInput,
  SnapshotResult,
  hostSignals,
} from "./contract.ts";
import * as ops from "./ops.ts";

export interface HostRunner {
  readonly hostId: string;
  exec(input: ExecInput, signal?: AbortSignal): Promise<ExecResult>;
  resolveRef(repoPath: string, ref: string): Promise<string | null>;
  updateRef(repoPath: string, ref: string, newSha: string, oldSha: string | null): Promise<{ ok: boolean; current: string | null }>;
  deleteRef(repoPath: string, ref: string): Promise<boolean>;
  snapshot(input: SnapshotInput): Promise<SnapshotResult>;
  prepareCandidate(input: PrepareInput): Promise<PrepareResult>;
  rewordCommit(repoPath: string, sha: string, message: string): Promise<string>;
  checkout(repoPath: string, key: string, sha: string): Promise<string>;
  removeCheckouts(repoPath: string, keyPrefix: string): Promise<number>;
  diffSummary(repoPath: string, from: string, to: string, maxPatchBytes: number): Promise<DiffSummary>;
}

const GIT_TIMEOUT = 5 * 60_000;

export class BbHostRunner implements HostRunner {
  constructor(
    private readonly client: ExperimentalHostClient<HostContract, typeof hostSignals>,
    readonly hostId: string,
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
  async rewordCommit(repoPath: string, sha: string, message: string) {
    return (await this.client.call("rewordCommit", { repoPath, sha, message }, this.opts())).sha;
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
}

export class LocalHostRunner implements HostRunner {
  constructor(
    private readonly dataDir: string,
    readonly hostId = "local",
  ) {}
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
  async rewordCommit(repoPath: string, sha: string, message: string) {
    return (await ops.rewordCommit(repoPath, sha, message)).sha;
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
}
