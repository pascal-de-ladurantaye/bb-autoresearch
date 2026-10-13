import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import * as ops from "../src/host/ops.ts";
import type { SpawnWorkerArgs } from "../src/ports.ts";
import { DETERMINISTIC_SPEC, localRunner, makeCtx } from "./helpers.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ar-test-"));
  repo = join(root, "repo");
  execFileSync("mkdir", ["-p", join(repo, "src"), join(repo, "bench")]);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/data.txt"), "hello      world      padding      \n");
  writeFileSync(join(repo, "bench/measure.sh"), 'printf "METRIC size=%s\\nMETRIC rss=100\\nDIAG bytes counted\\n" "$(wc -c < src/data.txt | tr -d " ")"\n');
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("host ops against real git", () => {
  it("exec returns exit codes, bounded tails, and enforces timeouts", async () => {
    const ok = await ops.exec({ cwd: repo, command: "echo hi; echo err >&2", timeoutMs: 5000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false, stdout: "hi\n", stderr: "err\n" });
    const big = await ops.exec({ cwd: repo, command: "head -c 100000 /dev/zero | tr '\\0' x", timeoutMs: 5000, tailBytes: 1000 });
    expect(big.stdout.length).toBeLessThanOrEqual(1001 + 3);
    const slow = await ops.exec({ cwd: repo, command: "sleep 5", timeoutMs: 1000 });
    expect(slow.timedOut).toBe(true);
  });

  it("snapshot commits the worktree, pins a candidate ref, and lists changed paths", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src/data.txt"), "hello world\n");
    writeFileSync(join(repo, "src/new.txt"), "x\n");
    const snap = await ops.snapshot({ worktreePath: repo, message: "c1", candidateRef: "refs/studies/t/c/1", baseSha: base });
    expect(snap.committed).toBe(true);
    expect(snap.changedPaths.sort()).toEqual(["src/data.txt", "src/new.txt"]);
    expect(snap.linesAdded).toBe(2);
    expect(sh(repo, "rev-parse", "refs/studies/t/c/1")).toBe(snap.sha);
    // Clean tree: no new commit, same sha.
    const again = await ops.snapshot({ worktreePath: repo, message: "c2", candidateRef: "refs/studies/t/c/2", baseSha: base });
    expect(again).toMatchObject({ committed: false, sha: snap.sha });
  });

  it("prepareCandidate squashes onto best, three-way merges when best moved, and reports conflicts", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    sh(repo, "checkout", "-qb", "work");
    writeFileSync(join(repo, "src/data.txt"), "hello world\n");
    sh(repo, "commit", "-qam", "w1");
    writeFileSync(join(repo, "src/other.txt"), "o\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "w2");
    const cand = sh(repo, "rev-parse", "HEAD");
    const fast = await ops.prepareCandidate({ repoPath: repo, bestSha: base, forkSha: base, candidateSha: cand, message: "squash" });
    if (fast.status !== "ok") throw new Error("expected ok");
    expect(sh(repo, "rev-parse", `${fast.sha}^`)).toBe(base);
    expect(fast.tree).toBe(sh(repo, "rev-parse", `${cand}^{tree}`));
    // Best moved with a non-overlapping change: merge applies cleanly.
    sh(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "bench/notes.txt"), "n\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "best moved");
    const best = sh(repo, "rev-parse", "HEAD");
    const merged = await ops.prepareCandidate({ repoPath: repo, bestSha: best, forkSha: base, candidateSha: cand, message: "rebased" });
    expect(merged.status).toBe("ok");
    if (merged.status === "ok") expect(sh(repo, "show", `${merged.sha}:bench/notes.txt`)).toBe("n");
    // Best moved with an overlapping change: conflict.
    writeFileSync(join(repo, "src/data.txt"), "totally different\n");
    sh(repo, "commit", "-qam", "conflicting best");
    const conflict = await ops.prepareCandidate({ repoPath: repo, bestSha: sh(repo, "rev-parse", "HEAD"), forkSha: base, candidateSha: cand, message: "x" });
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") expect(conflict.paths).toContain("src/data.txt");
  });

  it("updateRef is compare-and-swap; checkout reuses plugin-owned worktrees; removeCheckouts cleans up", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    expect((await ops.updateRef(repo, "refs/heads/studies/t/best", base, null)).ok).toBe(true);
    expect((await ops.updateRef(repo, "refs/heads/studies/t/best", base, null)).ok).toBe(false);
    const dataDir = join(root, "data");
    const p1 = (await ops.checkout(dataDir, repo, "t-best", base)).path;
    const p2 = (await ops.checkout(dataDir, repo, "t-best", base)).path;
    expect(p1).toBe(p2);
    expect((await ops.exec({ cwd: p1, command: "sh bench/measure.sh", timeoutMs: 5000 })).stdout).toContain("METRIC size=");
    expect(await ops.removeCheckouts(dataDir, repo, "t-")).toEqual({ removed: 1 });
    expect(sh(repo, "worktree", "list")).not.toContain("t-best");
  });
});

describe("end to end with real git (LocalHostRunner)", () => {
  it("calibrates, spawns a worker on studies/<slug>/best, measures, and promotes a squashed win", async () => {
    const runner = localRunner(join(root, "data"), "host_test");
    const { ctx, store, port } = makeCtx(runner);
    port.projectCheckout = async () => repo;
    // Real managed-worktree stand-in: a git worktree on a new branch from the base branch.
    port.spawnWorker = async (args: SpawnWorkerArgs) => {
      const id = `thr_w${port.spawned.length + 1}`;
      port.spawned.push(args);
      const path = join(root, id);
      sh(repo, "worktree", "add", "-q", "-b", `bb/${id}`, path, args.baseBranch);
      port.threads.set(id, { id, status: "active", archivedAt: null, deletedAt: null, environmentId: `env_${id}`, metadata: { ...args.metadata } });
      port.envs.set(`env_${id}`, { id: `env_${id}`, hostId: "host_test", path, branchName: `bb/${id}` });
      return { threadId: id, environmentId: `env_${id}` };
    };
    port.addThread("thr_study");
    const spec = DETERMINISTIC_SPEC.replace('gate = ["gate.sh"]', 'gate = ["test -s src/data.txt"]').replace('measure = "measure.sh"', 'measure = "sh bench/measure.sh"');
    const engine = new Engine(ctx);
    await engine.proposeStudy("thr_study", "proj_1", spec);
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 20_000);
    const study = store.study("toy-size")!;
    expect(study.calibration_status).toBe("ready");
    const base = sh(repo, "rev-parse", "main");
    expect(sh(repo, "rev-parse", "studies/toy-size/best")).toBe(base);
    engine.onThreadIdle("thr_study");
    engine.addIdea("toy-size", { title: "Collapse whitespace" }, "human");
    await engine.start("toy-size", "human");
    await engine.settle();
    expect(port.spawned).toHaveLength(1);

    const wt = join(root, "thr_w1");
    writeFileSync(join(wt, "src/data.txt"), "hello world padding\n");
    const ticket = await engine.submit("thr_w1", { title: "Collapse runs of spaces" });
    expect(ticket).toContain("Submitted as c/1");
    await engine.settle();
    const c = store.candidateByN(study.id, 1)!;
    expect(c.verdict).toBe("win");
    const best = sh(repo, "rev-parse", "studies/toy-size/best");
    expect(best).not.toBe(base);
    expect(sh(repo, "rev-parse", `${best}^`)).toBe(base);
    expect(sh(repo, "show", `${best}:src/data.txt`)).toBe("hello world padding");
    expect(sh(repo, "log", "-1", "--format=%B", best)).toContain("Autoresearch-Candidate: c/1");
    expect(sh(repo, "rev-parse", "refs/studies/toy-size/c/1")).toBe(c.sha);

    // Second submission from the same worktree after its own promotion.
    writeFileSync(join(wt, "bench/measure.sh"), "echo METRIC size=1\n");
    const rejected = await engine.submit("thr_w1", { title: "Edit the benchmark (should be rejected)" });
    expect(rejected).toContain("REJECTED (scope)");
    // Hermetic: every health check used the injected readings, never the machine's load.
    expect(runner.probes).toBeGreaterThan(0);
    expect(store.healthChecks(study.id).every((h) => h.ok === 1)).toBe(true);
    await engine.archiveStudy("toy-size", "human");
    expect(sh(repo, "branch", "--list", "bb/thr_w1")).toBe("");
    expect(sh(repo, "rev-parse", "refs/studies/toy-size/c/1")).toBe(c.sha);
    expect(sh(repo, "worktree", "list")).not.toContain("toy-size-best");
  });
});
