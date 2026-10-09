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
export type ExecResult = z.infer<typeof execOutput>;

export const snapshotInput = z
  .object({
    worktreePath: absPath,
    message: z.string().min(1).max(4096),
    candidateRef: ref,
    baseSha: sha,
  })
  .strict();
export const snapshotOutput = z
  .object({
    sha,
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
