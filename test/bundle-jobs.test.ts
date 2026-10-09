// M2 host plumbing against real git and real processes: bundle round trips
// into a fresh bench-owned clone, size limits, chunking, and long commands
// as background jobs with progress and cancellation.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_CHUNK_BYTES, HOST_RPC_INPUT_LIMIT, HOST_RPC_OUTPUT_LIMIT } from "../src/host/contract.ts";
import * as ops from "../src/host/ops.ts";
import { HostJobLostError, LocalHostRunner, RunAbortedError, type HostRunner } from "../src/host/runner.ts";
import { ensureCommit, TransferError } from "../src/transfer.ts";
import { localRunner } from "./helpers.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

let root: string;
let repo: string;
let edit: LocalHostRunner;
let bench: LocalHostRunner;

/** Records every bundle chunk crossing the "wire" so tests can check sizes against the host RPC limits. */
function spy(r: HostRunner, log: Array<{ method: string; bytes: number }>): HostRunner {
  return new Proxy(r, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "bundleRead") {
        return async (...a: [string, number, number]) => {
          const out = await (v as HostRunner["bundleRead"]).apply(target, a);
          log.push({ method: "bundleRead", bytes: JSON.stringify(out).length });
          return out;
        };
      }
      if (prop === "bundleWrite") {
        return async (...a: [string, number, string]) => {
          log.push({ method: "bundleWrite", bytes: JSON.stringify({ id: a[0], offset: a[1], data: a[2] }).length });
          return await (v as HostRunner["bundleWrite"]).apply(target, a);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ar-m2-"));
  repo = join(root, "repo");
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/data.txt"), "hello world\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
  edit = localRunner(join(root, "edit-data"), "host_edit");
  bench = localRunner(join(root, "bench-data"), "host_bench", { pollMs: 50, progressMs: 20 });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git bundle transfer into a bench-owned clone", () => {
  it("bootstraps a fresh bench clone, then sends only best..candidate", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    const clone = await bench.benchRepo("toy");
    expect(clone.path).toBe(join(root, "bench-data", "bench", "toy", "repo.git"));
    expect(clone.path.startsWith(repo)).toBe(false);
    expect(clone.tips).toEqual([]);

    const boot = await ensureCommit({ edit, editRepo: repo, bench, benchRepo: clone.path, benchTips: clone.tips, sha: base, ref: `refs/bench/s/${base}`, maxBytes: 1 << 20 });
    expect(boot.skipped).toBe(false);
    expect(boot.bytes).toBeGreaterThan(0);
    expect(sh(clone.path, "rev-parse", `refs/bench/s/${base}`)).toBe(base);
    // The bench clone is its own repository: no alternates, no shared refs.
    expect(existsSync(join(clone.path, "objects/info/alternates"))).toBe(false);
    expect(sh(clone.path, "for-each-ref", "--format=%(refname)")).not.toContain("refs/heads/main");

    // A candidate on top of base: the bundle carries only the new commit.
    writeFileSync(join(repo, "src/data.txt"), "hello\n");
    sh(repo, "commit", "-qam", "candidate");
    const cand = sh(repo, "rev-parse", "HEAD");
    const tips = (await bench.benchRepo("toy")).tips;
    expect(tips).toEqual([base]);
    const delta = await ensureCommit({ edit, editRepo: repo, bench, benchRepo: clone.path, benchTips: tips, sha: cand, ref: `refs/bench/s/${cand}`, maxBytes: 1 << 20 });
    expect(delta.skipped).toBe(false);
    expect(delta.chunks).toBe(1);
    // Thin bundle: it has a prerequisite (base) instead of the whole history.
    expect(sh(clone.path, "cat-file", "-t", cand)).toBe("commit");

    // Checkouts come from the bench clone, not the project repository.
    const dir = await bench.checkout(clone.path, "toy-bench-cand", cand);
    expect(readFileSync(join(dir, "src/data.txt"), "utf8")).toBe("hello\n");
    expect(sh(repo, "worktree", "list")).not.toContain("toy-bench-cand");

    // Already present: nothing is sent.
    const again = await ensureCommit({ edit, editRepo: repo, bench, benchRepo: clone.path, benchTips: [base, cand], sha: cand, ref: `refs/bench/s/${cand}`, maxBytes: 1 << 20 });
    expect(again).toMatchObject({ skipped: true, bytes: 0 });
    // No bundle files are left on either side.
    for (const d of ["edit-data", "bench-data"]) {
      const dirPath = join(root, d, "bundles");
      if (existsSync(dirPath)) expect(execFileSync("ls", [dirPath], { encoding: "utf8" }).trim()).toBe("");
    }
    expect(await bench.removeBenchRepo("toy")).toBe(true);
    expect(existsSync(clone.path)).toBe(false);
  });

  it("fails clearly above the size limit and sends nothing", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    const clone = await bench.benchRepo("big");
    const err = await ensureCommit({ edit, editRepo: repo, bench, benchRepo: clone.path, benchTips: [], sha: base, ref: `refs/bench/s/${base}`, maxBytes: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(String((err as Error).message)).toMatch(/git bundle for [0-9a-f]{12} is .* MiB, above the .* MiB limit \(oracle\.max_bundle_mib\)/u);
    expect((await bench.hasCommits(clone.path, [base])).length).toBe(0);
  });

  it("chunks large bundles within the host RPC limits", async () => {
    // ~3 MiB of incompressible content.
    writeFileSync(join(repo, "src/blob.bin"), randomBytes(3 * 1024 * 1024));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "blob");
    const tip = sh(repo, "rev-parse", "HEAD");
    const clone = await bench.benchRepo("chunky");
    const log: Array<{ method: string; bytes: number }> = [];
    const r = await ensureCommit({ edit: spy(edit, log), editRepo: repo, bench: spy(bench, log), benchRepo: clone.path, benchTips: [], sha: tip, ref: `refs/bench/s/${tip}`, maxBytes: 64 << 20, chunkBytes: 1 << 20 });
    expect(r.chunks).toBeGreaterThanOrEqual(3);
    expect(r.bytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(sh(clone.path, "rev-parse", `refs/bench/s/${tip}`)).toBe(tip);
    for (const l of log) expect(l.bytes).toBeLessThan(l.method === "bundleRead" ? HOST_RPC_OUTPUT_LIMIT : HOST_RPC_INPUT_LIMIT);
    // The default chunk's base64 fits the 8 MiB output limit.
    expect(Math.ceil(BUNDLE_CHUNK_BYTES / 3) * 4).toBeLessThan(HOST_RPC_OUTPUT_LIMIT);
  });

  it("rejects out-of-order chunks and corrupt bundles", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    const clone = await bench.benchRepo("bad");
    const info = await edit.bundleCreate(repo, base, []);
    const part = await edit.bundleRead(info.id, 0, 64);
    await expect(bench.bundleWrite(info.id, 64, part.data)).rejects.toThrow(/out of order/u);
    await bench.bundleWrite(info.id, 0, part.data);
    const r = await bench.bundleApply({ repoPath: clone.path, id: info.id, sha: base, ref: "refs/bench/x", sha256: info.sha256 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/corrupt/u);
  });
});

describe("long commands as host background jobs", () => {
  it("runs a command in short polls and streams progress", async () => {
    const lines: string[] = [];
    const r = await bench.run({ cwd: repo, command: "for i in 1 2 3 4 5; do echo pair $i; sleep 0.1; done; echo METRIC x=1", timeoutMs: 10_000, label: "c/1" }, { onProgress: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("METRIC x=1");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => /pair \d/u.test(l))).toBe(true);
  });

  it("cancellation kills the job's process group", async () => {
    const marker = join(root, "still-running");
    const ac = new AbortController();
    const run = bench.run({ cwd: repo, command: `sleep 1.5; touch ${marker}`, timeoutMs: 10_000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(run).rejects.toBeInstanceOf(RunAbortedError);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(existsSync(marker)).toBe(false);
  });

  it("a host worker restart loses the job: the caller gets HostJobLostError", async () => {
    const run = bench.run({ cwd: repo, command: "sleep 2", timeoutMs: 10_000 });
    setTimeout(() => bench.loseJobs(), 100);
    await expect(run).rejects.toBeInstanceOf(HostJobLostError);
  });

  it("exec still enforces its own timeout through the shared spawner", async () => {
    const slow = await ops.exec({ cwd: repo, command: "sleep 5", timeoutMs: 1000 });
    expect(slow.timedOut).toBe(true);
  });
});
