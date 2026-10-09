// bb.host entry: runs on every machine a study uses (edit host and bench
// host). M0 uses the server's own machine for both roles.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./src/host/contract.ts";
import * as ops from "./src/host/ops.ts";

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
  },
});
