// bb.host entry: runs on every machine a study uses. On the edit host it
// snapshots worktrees, prepares candidates and runs gates; on a bench host it
// keeps a bench-owned clone (fed by git bundles), builds, measures as
// background jobs, and reports machine health.
import { experimental_defineHostEntry, type ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./src/host/contract.ts";
import * as bundle from "./src/host/bundle.ts";
import { health } from "./src/host/health.ts";
import { JobRegistry } from "./src/host/jobs.ts";
import * as ops from "./src/host/ops.ts";

const jobs = new JobRegistry();
const leases = new Map<string, ExperimentalHostWorkerLease>();

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    ping: async (_input, ctx) => await ops.ping(ctx.experimental_paths.dataDir),
    exec: async (input, ctx) => await ops.exec(input, ctx.signal),
    resolveRef: async ({ repoPath, ref }) => await ops.resolveRef(repoPath, ref),
    updateRef: async ({ repoPath, ref, newSha, oldSha }) => await ops.updateRef(repoPath, ref, newSha, oldSha),
    deleteRef: async ({ repoPath, ref }) => await ops.deleteRef(repoPath, ref),
    snapshot: async (input) => await ops.snapshot(input),
    prepareCandidate: async (input) => await ops.prepareCandidate(input),
    rewordCommit: async ({ repoPath, sha, message }) => await ops.rewordCommit(repoPath, sha, message),
    checkout: async ({ repoPath, key, sha }, ctx) => await ops.checkout(ctx.experimental_paths.dataDir, repoPath, key, sha),
    diffSummary: async ({ repoPath, from, to, maxPatchBytes }) => await ops.diffSummary(repoPath, from, to, maxPatchBytes),
    removeCheckouts: async ({ repoPath, keyPrefix }, ctx) =>
      await ops.removeCheckouts(ctx.experimental_paths.dataDir, repoPath, keyPrefix),
    jobStart: (input, ctx) => {
      // A running job keeps the worker alive past the 5-minute idle stop.
      const lease = ctx.experimental_retainWorker();
      const jobId = jobs.start(input, {
        onProgress: (id, label, line) => {
          void ctx.experimental_emitSignal("progress", { key: id, message: `${label ? `${label}: ` : ""}${line}`.slice(0, 2000) }).catch(() => undefined);
        },
        onEnd: (id) => {
          leases.get(id)?.dispose();
          leases.delete(id);
        },
      });
      leases.set(jobId, lease);
      ctx.lifecycle.signal.addEventListener("abort", () => jobs.cancelAll(), { once: true });
      return { jobId };
    },
    jobWait: async ({ jobId, waitMs }, ctx) => {
      // Never block past this call's own cancellation.
      return await Promise.race([
        jobs.wait(jobId, waitMs),
        new Promise<never>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("jobWait cancelled")), { once: true })),
      ]);
    },
    jobCancel: ({ jobId }) => ({ cancelled: jobs.cancel(jobId) }),
    health: async () => await health(),
    benchRepo: async ({ key }, ctx) => await bundle.benchRepo(ctx.experimental_paths.dataDir, key),
    // The server cancels the study's jobs before it removes the clone.
    removeBenchRepo: async ({ key }, ctx) => await bundle.removeBenchRepo(ctx.experimental_paths.dataDir, key),
    hasCommits: async ({ repoPath, shas }) => await bundle.hasCommits(repoPath, shas),
    bundleCreate: async ({ repoPath, tip, basis }, ctx) => await bundle.bundleCreate(ctx.experimental_paths.dataDir, repoPath, tip, basis),
    bundleRead: ({ id, offset, length }, ctx) => bundle.bundleRead(ctx.experimental_paths.dataDir, id, offset, length),
    bundleWrite: ({ id, offset, data }, ctx) => bundle.bundleWrite(ctx.experimental_paths.dataDir, id, offset, data),
    bundleApply: async ({ repoPath, id, sha, ref, sha256 }, ctx) => await bundle.bundleApply(ctx.experimental_paths.dataDir, repoPath, id, sha, ref, sha256),
    bundleDiscard: ({ id }, ctx) => bundle.bundleDiscard(ctx.experimental_paths.dataDir, id),
    commitLog: async ({ repoPath, from, to }) => await ops.commitLog(repoPath, from, to),
    composeCommits: async (input) => await ops.composeCommits(input),
    gitRemotes: async ({ repoPath }) => await ops.gitRemotes(repoPath),
    writeExport: ({ key, files }, ctx) => ops.writeExport(ctx.experimental_paths.dataDir, key, files),
  },
  dispose: () => jobs.cancelAll(),
});
