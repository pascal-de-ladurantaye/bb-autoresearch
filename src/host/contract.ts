// Host RPC contract shared by server.ts (client) and host.ts (entry).
//
// Every method names an explicit absolute path on the target host. Core does
// not infer a cwd or environment for host RPC, and M2 runs the same contract
// against a remote bench host, so nothing here may assume the server's disk.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

const absPath = z.string().min(1).refine((p) => p.startsWith("/"), "must be an absolute path");
const sha = z.string().regex(/^[0-9a-f]{7,64}$/u, "must be a git sha");
/**
 * Who a commit the plugin makes is authored and committed by. The server
 * resolves it once on the edit host (the repo's own git identity, or the
 * plugin's) and passes it explicitly, so every host that commits uses the same one.
 */
export const gitIdentity = z
  .object({
    name: z.string().min(1).max(200).refine((v) => !/[<>\n]/u.test(v), "no angle brackets or newlines"),
    email: z.string().min(1).max(200).refine((v) => !/[<>\n]/u.test(v), "no angle brackets or newlines"),
  })
  .strict();
export type GitIdentity = z.infer<typeof gitIdentity>;
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
    /** The worker's commit message plus the plugin's trailers (title ≤ 72 + body ≤ 4000 characters). */
    message: z.string().min(1).max(8192),
    candidateRef: ref,
    baseSha: sha,
    /**
     * Current best. When given, the fork point is merge-base(HEAD, bestSha)
     * instead of `baseSha`, so a worker that rebased onto a newer best is
     * diffed (and scope-checked) against that best, not its original fork.
     */
    bestSha: sha.optional(),
    /**
     * `[scope] ignore` patterns (gitignore-style): untracked files matching
     * them are never committed. Changes to tracked files always are.
     */
    ignore: z.array(z.string().min(1).max(200)).max(64).optional(),
    /** Author and committer of the snapshot commit (default: the plugin's identity). */
    identity: gitIdentity.optional(),
  })
  .strict();
export const snapshotOutput = z
  .object({
    sha,
    /** The commit the changed paths are measured from (see `bestSha`). */
    forkSha: sha.optional(),
    committed: z.boolean(),
    changedPaths: z.array(z.string()),
    /** Paths the candidate adds relative to the fork point (the scope check rejects ignored ones). */
    addedPaths: z.array(z.string()).optional(),
    /** Untracked files the snapshot left out because they match `ignore` (at most 200). */
    ignoredPaths: z.array(z.string()).optional(),
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
    identity: gitIdentity.optional(),
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

export const commitInfo = z
  .object({
    sha,
    parent: sha.nullable(),
    subject: z.string(),
    /** Full message (trailers included), clipped to 8 KiB. */
    message: z.string(),
    paths: z.array(z.string()).max(2000),
  })
  .strict();
export type CommitInfo = z.infer<typeof commitInfo>;

export const composeInput = z
  .object({
    repoPath: absPath,
    onto: sha,
    /** Applied in order: a pick replays `sha`'s change, a revert undoes it. */
    steps: z.array(z.object({ sha, revert: z.boolean() }).strict()).min(1).max(500),
    message: z.string().min(1).max(16_384),
    identity: gitIdentity.optional(),
  })
  .strict();
export const composeOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), sha, tree: sha }).strict(),
  z.object({ status: z.literal("conflict"), at: sha, revert: z.boolean(), paths: z.array(z.string()), detail: z.string() }).strict(),
]);
export type ComposeInput = z.infer<typeof composeInput>;
export type ComposeResult = z.infer<typeof composeOutput>;

export const baseBundleOutput = z.object({ path: absPath, sha256: z.string(), bytes: z.number().int(), cached: z.boolean() }).strict();
export type BaseBundle = z.infer<typeof baseBundleOutput>;
const seedFinding = z.object({ path: z.string(), rule: z.string(), line: z.number().int().nullable() }).strict();
export const seedPackOutput = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), path: absPath, sha256: z.string(), fileSha256: z.string(), bytes: z.number().int(), files: z.number().int(), kind: z.enum(["dir", "tarball"]), cached: z.boolean(), allowed: z.array(seedFinding).max(5000) })
    .strict(),
  z.object({ ok: z.literal(false), findings: z.array(seedFinding).max(5000), allowed: z.array(seedFinding).max(5000), files: z.number().int(), error: z.string().optional() }).strict(),
]);
export type SeedPack = z.infer<typeof seedPackOutput>;

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
    input: z.object({ repoPath: absPath, sha, message: z.string().min(1).max(8192), identity: gitIdentity.optional() }).strict(),
    output: z.object({ sha }).strict(),
  },
  /**
   * Hash of the protected paths at `sha` (the oracle hash folds it in): the
   * whole tree, filtered with the scope check's own glob matcher, as sorted
   * `mode sha path` lines. `files` is how many entries matched.
   */
  protectedHash: {
    input: z.object({ repoPath: absPath, sha, globs: z.array(z.string().min(1).max(400)).max(64) }).strict(),
    output: z.object({ hash: z.string(), files: z.number().int() }).strict(),
  },
  /** The identity git resolves in `repoPath` (`user.name` / `user.email`: repo-local, then global), or nulls when none is configured. */
  gitIdentity: {
    input: z.object({ repoPath: absPath }).strict(),
    output: z.object({ name: z.string().nullable(), email: z.string().nullable() }).strict(),
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
  /** First-parent commits in `from..to`, oldest first, with their changed paths (harvest). */
  commitLog: {
    input: z.object({ repoPath: absPath, from: sha, to: sha }).strict(),
    output: z.object({ commits: z.array(commitInfo).max(5000) }).strict(),
  },
  /** Build one commit on `onto` by replaying and/or reverting commits with three-way merges, without a checkout (harvest ablation and standalone branches). */
  composeCommits: { input: composeInput, output: composeOutput },
  /** The repo's remotes (the GitHub publisher refuses without a GitHub remote). */
  gitRemotes: {
    input: z.object({ repoPath: absPath }).strict(),
    output: z.object({ remotes: z.array(z.object({ name: z.string(), url: z.string() }).strict()).max(50) }).strict(),
  },
  /** Write files under `<dataDir>/exports/<key>/` (harvest reports and PR bodies); returns the directory. */
  writeExport: {
    input: z
      .object({
        key,
        files: z
          .array(z.object({ path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u).refine((p) => !p.split("/").includes(".."), "no .."), content: z.string().max(4 * 1024 * 1024) }).strict())
          .max(200),
      })
      .strict(),
    output: z.object({ dir: absPath }).strict(),
  },
  /** A shallow git bundle of `sha` alone (remote bench machines start from it), cached under the data dir; the path is on this host. */
  baseBundle: {
    input: z.object({ repoPath: absPath, sha: z.string().regex(/^[0-9a-f]{40,64}$/u) }).strict(),
    output: baseBundleOutput,
  },
  /** Scan a seed (directory or tarball) for credentials and, when clean, pack it as a tarball cached by content hash (host/seed.ts). */
  seedPack: {
    input: z.object({ source: z.string().min(1).max(4096), cwd: absPath, allow: z.array(z.string().min(1).max(400)).max(256) }).strict(),
    output: seedPackOutput,
  },
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
