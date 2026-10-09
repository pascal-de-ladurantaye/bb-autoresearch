// Host RPC contract shared by server.ts (client) and host.ts (entry).
//
// Every method names an explicit absolute path on the target host. Core does
// not infer a cwd or environment for host RPC, and M2 runs the same contract
// against a remote bench host, so nothing here may assume the server's disk.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

const absPath = z.string().min(1).refine((p) => p.startsWith("/"), "must be an absolute path");
const sha = z.string().regex(/^[0-9a-f]{7,64}$/u, "must be a git sha");
const ref = z.string().min(1).max(512);
const key = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,120}$/u);
const bundleId = z.string().regex(/^[a-f0-9]{16,64}$/u);
const jobId = z.string().regex(/^job_[a-f0-9]{8,64}$/u);

/** Host RPC limits (bb.hosts): 32 MiB of JSON input per call, 8 MiB of output. */
export const HOST_RPC_INPUT_LIMIT = 32 * 1024 * 1024;
export const HOST_RPC_OUTPUT_LIMIT = 8 * 1024 * 1024;
/**
 * Raw bytes per bundle chunk. Base64 makes it 5.33 MiB on the wire: under the
 * 8 MiB output limit (bundleRead) and far under the 32 MiB input limit
 * (bundleWrite), with room for the JSON envelope.
 */
export const BUNDLE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Longest a single background job may run (oracle.timeout_minutes is capped here). */
export const MAX_JOB_MS = 24 * 60 * 60_000;
/** Longest one jobWait call blocks; far below the 30-minute host call cap. */
export const MAX_JOB_WAIT_MS = 60_000;

export const execInput = z
  .object({
    cwd: absPath,
    command: z.string().min(1).max(16_384),
    timeoutMs: z.number().int().min(1_000).max(29 * 60_000),
    env: z.record(z.string(), z.string()).optional(),
    /** Bytes of stdout/stderr tail kept in the result. */
    tailBytes: z.number().int().min(256).max(256 * 1024).optional(),
  })
  .strict();
export const execOutput = z
  .object({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();
export type ExecInput = z.infer<typeof execInput>;

/** A long command run as a host background job: started, polled, cancelled in short calls. */
export const jobInput = z
  .object({
    cwd: absPath,
    command: z.string().min(1).max(16_384),
    timeoutMs: z.number().int().min(1_000).max(MAX_JOB_MS),
    env: z.record(z.string(), z.string()).optional(),
    tailBytes: z.number().int().min(256).max(256 * 1024).optional(),
    /** Shown with progress signals (e.g. "c/12 pair 3 best"). */
    label: z.string().max(200).optional(),
  })
  .strict();
export type JobInput = z.infer<typeof jobInput>;
export type ExecResult = z.infer<typeof execOutput>;

export const snapshotInput = z
  .object({
    worktreePath: absPath,
    message: z.string().min(1).max(4096),
    candidateRef: ref,
    baseSha: sha,
    /**
     * Current best. When given, the fork point is merge-base(HEAD, bestSha)
     * instead of `baseSha`, so a worker that rebased onto a newer best is
     * diffed (and scope-checked) against that best, not its original fork.
     */
    bestSha: sha.optional(),
  })
  .strict();
export const snapshotOutput = z
  .object({
    sha,
    /** The commit the changed paths are measured from (see `bestSha`). */
    forkSha: sha.optional(),
    committed: z.boolean(),
    changedPaths: z.array(z.string()),
    linesAdded: z.number().int(),
    linesDeleted: z.number().int(),
  })
  .strict();
export type SnapshotInput = z.infer<typeof snapshotInput>;
export type SnapshotResult = z.infer<typeof snapshotOutput>;

export const prepareInput = z
  .object({
    repoPath: absPath,
    bestSha: sha,
    forkSha: sha,
    candidateSha: sha,
    message: z.string().min(1).max(8192),
  })
  .strict();
export const prepareOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), sha, tree: sha }).strict(),
  z.object({ status: z.literal("conflict"), paths: z.array(z.string()), detail: z.string() }).strict(),
]);
export type PrepareInput = z.infer<typeof prepareInput>;
export type PrepareResult = z.infer<typeof prepareOutput>;

export const diffSummaryOutput = z
  .object({
    files: z.array(z.object({ path: z.string(), added: z.number().int(), deleted: z.number().int() }).strict()),
    /** Unified patch, clipped to `maxPatchBytes`. */
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type DiffSummary = z.infer<typeof diffSummaryOutput>;

export const healthReport = z
  .object({
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    cpus: z.number().int(),
    /** 1, 5 and 15 minute load averages (os.loadavg; zeros on Windows). */
    loadavg: z.array(z.number()).length(3),
    freeMemMb: z.number(),
    totalMemMb: z.number(),
    /** Busiest processes by CPU share, excluding this host worker's own tree. */
    topProcesses: z.array(z.object({ pid: z.number().int(), cpu: z.number(), command: z.string() }).strict()).max(20),
    /** e.g. "performance", "powersave"; null when not detectable. */
    governor: z.string().nullable(),
    /** true = turbo/boost enabled, false = disabled, null = not detectable. */
    turbo: z.boolean().nullable(),
    /** macOS: on AC power; null elsewhere or not detectable. */
    onAcPower: z.boolean().nullable(),
    /** macOS pmset thermal/CPU speed limit (100 = unthrottled); null when not detectable. */
    cpuSpeedLimit: z.number().nullable(),
    /** Things this platform cannot report (shown to the human, not treated as failures). */
    notDetectable: z.array(z.string()).max(20),
    at: z.number(),
  })
  .strict();
export type HealthReport = z.infer<typeof healthReport>;

export const bundleInfo = z
  .object({
    id: bundleId,
    /** Size of the bundle file in bytes (0 when empty). */
    bytes: z.number().int(),
    sha256: z.string(),
    /** Nothing to send: `tip` is reachable from the basis already. */
    empty: z.boolean(),
  })
  .strict();
export type BundleInfo = z.infer<typeof bundleInfo>;

export const jobStatus = z
  .object({
    state: z.enum(["running", "done", "unknown"]),
    result: execOutput.nullable(),
    /** Last output line (progress). */
    tail: z.string(),
    elapsedMs: z.number(),
  })
  .strict();
export type JobStatus = z.infer<typeof jobStatus>;

export const hostContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ hostname: z.string(), platform: z.string(), gitVersion: z.string(), dataDir: z.string() }).strict(),
  },
  /** Run one shell command and return its exit status and bounded output tails. */
  exec: { input: execInput, output: execOutput },
  resolveRef: {
    input: z.object({ repoPath: absPath, ref }).strict(),
    output: z.object({ sha: sha.nullable() }).strict(),
  },
  /** Compare-and-swap a ref. `oldSha: null` means create-only. */
  updateRef: {
    input: z.object({ repoPath: absPath, ref, newSha: sha, oldSha: sha.nullable() }).strict(),
    output: z.object({ ok: z.boolean(), current: sha.nullable() }).strict(),
  },
  /** Delete a ref (used for a finished worker's branch). Missing refs are fine. */
  deleteRef: {
    input: z.object({ repoPath: absPath, ref }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  /** Commit the worker worktree (if dirty), pin it under `candidateRef`, and list paths changed since `baseSha`. */
  snapshot: { input: snapshotInput, output: snapshotOutput },
  /**
   * Build the commit that will be measured and, if it wins, promoted: the
   * candidate's changes since `forkSha` applied onto `bestSha` as one commit
   * whose parent is `bestSha` (a squash + rebase in one step).
   */
  prepareCandidate: { input: prepareInput, output: prepareOutput },
  /** Re-message a commit (same tree, same parents). Used for the promotion commit message. */
  rewordCommit: {
    input: z.object({ repoPath: absPath, sha, message: z.string().min(1).max(8192) }).strict(),
    output: z.object({ sha }).strict(),
  },
  /** Check out `sha` into a plugin-owned detached worktree keyed by `key`; returns its path. */
  checkout: {
    input: z.object({ repoPath: absPath, key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,120}$/u), sha }).strict(),
    output: z.object({ path: absPath }).strict(),
  },
  /** Per-file line counts and a clipped patch for `from..to` (the study page's diff view). */
  diffSummary: {
    input: z.object({ repoPath: absPath, from: sha, to: sha, maxPatchBytes: z.number().int().min(0).max(1024 * 1024) }).strict(),
    output: diffSummaryOutput,
  },
  /** Start a long command as a background job on the host (returns at once). */
  jobStart: { input: jobInput, output: z.object({ jobId }).strict() },
  /** Wait up to `waitMs` for a job; `unknown` means the host worker lost it (restart). */
  jobWait: { input: z.object({ jobId, waitMs: z.number().int().min(0).max(MAX_JOB_WAIT_MS) }).strict(), output: jobStatus },
  /** Kill a job's process group. */
  jobCancel: { input: z.object({ jobId }).strict(), output: z.object({ cancelled: z.boolean() }).strict() },
  /** Machine health: load, competing processes, CPU governor/turbo where detectable. */
  health: { input: z.null(), output: healthReport },
  /** Ensure the bench-owned bare clone for `key` exists under the host data dir; returns its path and the commits its refs pin. */
  benchRepo: {
    input: z.object({ key }).strict(),
    output: z.object({ path: absPath, tips: z.array(sha).max(4096) }).strict(),
  },
  /** Delete the bench-owned clone for `key` and its checkouts. */
  removeBenchRepo: { input: z.object({ key }).strict(), output: z.object({ removed: z.boolean() }).strict() },
  /** Which of `shas` exist as commits in `repoPath`. */
  hasCommits: {
    input: z.object({ repoPath: absPath, shas: z.array(sha).max(4096) }).strict(),
    output: z.object({ present: z.array(sha) }).strict(),
  },
  /** Write a git bundle with `tip` and its history minus everything reachable from `basis` to a host temp file. */
  bundleCreate: {
    input: z.object({ repoPath: absPath, tip: sha, basis: z.array(sha).max(4096) }).strict(),
    output: bundleInfo,
  },
  /** Read one chunk of a bundle file (base64). */
  bundleRead: {
    input: z.object({ id: bundleId, offset: z.number().int().min(0), length: z.number().int().min(1).max(BUNDLE_CHUNK_BYTES) }).strict(),
    output: z.object({ data: z.string(), eof: z.boolean() }).strict(),
  },
  /** Append one chunk (base64) to a bundle file being received; `offset` must equal the bytes written so far. */
  bundleWrite: {
    input: z.object({ id: bundleId, offset: z.number().int().min(0), data: z.string().max(Math.ceil(BUNDLE_CHUNK_BYTES / 3) * 4) }).strict(),
    output: z.object({ bytes: z.number().int() }).strict(),
  },
  /** Verify a received bundle (sha256 + git bundle verify), fetch it into `repoPath`, and pin `sha` under `ref`. */
  bundleApply: {
    input: z.object({ repoPath: absPath, id: bundleId, sha, ref, sha256: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), detail: z.string() }).strict(),
  },
  /** Delete a bundle file (sender or receiver side). */
  bundleDiscard: { input: z.object({ id: bundleId }).strict(), output: z.object({ removed: z.boolean() }).strict() },
  /** Remove plugin-owned checkouts whose key starts with `keyPrefix`. */
  removeCheckouts: {
    input: z.object({ repoPath: absPath, keyPrefix: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,120}$/u) }).strict(),
    output: z.object({ removed: z.number().int() }).strict(),
  },
});
export type HostContract = typeof hostContract;

export const hostSignals = {
  progress: {
    payload: z.object({ key: z.string(), message: z.string().max(2000) }).strict(),
  },
} satisfies ExperimentalHostSignals;
