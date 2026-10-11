// RemoteBenchRunner against the example provider (local temp dirs, real
// processes) and real git: the shallow base bundle, delta bundles through
// ensureCommit, reused checkouts, runs with progress and cancellation,
// seeds, health, and a machine that leaves mid-run.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBenchProvider, type LocalBenchProvider } from "../examples/bench-provider-local/provider.ts";
import { BenchProviderClient } from "../src/bench-provider/client.ts";
import { benchProviderContract, type BenchProviderMethod } from "../src/bench-provider/contract.ts";
import { RemoteBenchRunner, RemoteHostLostError, parseHealth } from "../src/bench-provider/runner.ts";
import { RunAbortedError } from "../src/host/runner.ts";
import { ensureCommit } from "../src/transfer.ts";
import { localRunner } from "./helpers.ts";

const CALLER = { experimental_caller: { kind: "plugin" as const, pluginId: "bb-autoresearch" } };

/** A client that reaches the example provider in-process, validating inputs like bb.rpc would. */
export function providerClient(p: LocalBenchProvider, pluginId = "bench-provider-local"): BenchProviderClient {
  return new BenchProviderClient(
    pluginId,
    async (method, input) => {
      const m = method as BenchProviderMethod;
      const parsed = benchProviderContract[m].input.parse(input);
      return await (p.handlers[m] as (i: unknown, c: typeof CALLER) => Promise<unknown>)(parsed, CALLER);
    },
    { retryMs: 5 },
  );
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

describe("RemoteBenchRunner (example provider, real git)", () => {
  let root: string;
  let repo: string;
  let provider: LocalBenchProvider;
  let runner: RemoteBenchRunner;
  let remoteId: string;
  const edit = () => localRunner(join(root, "edit-data"), "host_test", { pollMs: 10 });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ar-remote-runner-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/a.txt"), "100\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "one");
    writeFileSync(join(repo, "src/a.txt"), "90\n");
    sh(repo, "commit", "-qam", "two");
    provider = createLocalBenchProvider({ root: join(root, "provider"), sweepMs: 0 });
    const client = providerClient(provider);
    const created = await client.call("benchProvider.create", { key: "k1", cores: 1, lifetimeSeconds: 600, labels: { owner: "bb-autoresearch" } });
    remoteId = created.hostId;
    runner = new RemoteBenchRunner(client, remoteId, "remote-1", { home: null, stagingDir: join(root, "staging"), pollMs: 20, env: { STUDY_ENV: "yes" } });
  });
  afterEach(() => {
    provider.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts from a shallow base bundle, then receives best and candidates as delta bundles", async () => {
    const home = await runner.init();
    expect(home.startsWith("/")).toBe(true);
    const e = edit();
    const base = sh(repo, "rev-parse", "HEAD");
    const bundle = await e.baseBundle(repo, base);
    expect(bundle.cached).toBe(false);
    expect((await e.baseBundle(repo, base)).cached).toBe(true);
    await runner.initRepo(bundle.path, bundle.sha256, base);
    const r1 = await runner.benchRepo("toy");
    expect(r1.tips).toEqual([base]);
    // Shallow: the parent of base never arrived.
    const shallow = await runner.exec({ cwd: r1.path, command: "git rev-parse --is-shallow-repository; git rev-list --count HEAD 2>/dev/null || git rev-list --count refs/bench/s/" + base, timeoutMs: 30_000 });
    expect(shallow.stdout.split("\n")[0]).toBe("true");
    // A new commit on top of base travels as a delta bundle.
    writeFileSync(join(repo, "src/a.txt"), "80\n");
    sh(repo, "commit", "-qam", "three");
    const best = sh(repo, "rev-parse", "HEAD");
    const t = await ensureCommit({ edit: e, editRepo: repo, bench: runner, benchRepo: r1.path, benchTips: r1.tips, sha: best, ref: `refs/bench/s/${best}`, maxBytes: 1 << 20 });
    expect(t.skipped).toBe(false);
    expect(t.bytes).toBeLessThan(2000);
    expect(await runner.hasCommits(r1.path, [best, base, "f".repeat(40)])).toEqual([best, base]);
    // Reused checkouts.
    const dir = await runner.checkout(r1.path, "toy-bench-best", best);
    const cat = await runner.exec({ cwd: dir, command: "cat src/a.txt; echo $STUDY_ENV", timeoutMs: 10_000 });
    expect(cat.stdout).toBe("80\nyes\n");
    await runner.exec({ cwd: dir, command: "echo junk > untracked.txt; mkdir -p out", timeoutMs: 10_000 });
    expect(await runner.checkout(r1.path, "toy-bench-best", base)).toBe(dir);
    const after = await runner.exec({ cwd: dir, command: "cat src/a.txt; ls", timeoutMs: 10_000 });
    expect(after.stdout).toBe("90\nsrc\n");
    expect(await runner.removeCheckouts(r1.path, "toy-bench-")).toBe(1);
    // Already there: skipped.
    const again = await ensureCommit({ edit: e, editRepo: repo, bench: runner, benchRepo: r1.path, benchTips: (await runner.benchRepo("toy")).tips, sha: best, ref: `refs/bench/s/${best}`, maxBytes: 1 << 20 });
    expect(again.skipped).toBe(true);
  });

  it("runs commands with exit codes, progress, timeouts and cancellation", async () => {
    await runner.init();
    const lines: string[] = [];
    const r = await runner.run({ cwd: "/tmp", command: "for i in 1 2 3; do echo step $i; sleep 0.05; done; echo err >&2; exit 3", timeoutMs: 30_000 }, { onProgress: (l) => lines.push(l) });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("step 3");
    expect(r.stderr).toContain("err");
    expect(lines.at(-1)).toBe("step 3");
    const slow = await runner.exec({ cwd: "/tmp", command: "sleep 5", timeoutMs: 1000 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
    const ac = new AbortController();
    const p = runner.run({ cwd: "/tmp", command: "sleep 10", timeoutMs: 30_000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toBeInstanceOf(RunAbortedError);
    const big = await runner.exec({ cwd: "/tmp", command: "head -c 600000 /dev/zero | tr '\\0' 'x'; echo; echo END", timeoutMs: 30_000, tailBytes: 1000 });
    expect(big.stdout.endsWith("END\n")).toBe(true);
  });

  it("installs a seed once and reads health", async () => {
    await runner.init();
    const src = join(root, "seed");
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin/tool.sh"), "echo tool\n");
    const packed = await edit().seedPack({ source: src, cwd: root, allow: [] });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const s1 = await runner.installSeed(packed.path, packed.fileSha256);
    expect(s1.uploaded).toBe(true);
    const s2 = await runner.installSeed(packed.path, packed.fileSha256);
    expect(s2.uploaded).toBe(false);
    const r = await runner.exec({ cwd: s1.dir, command: "sh bin/tool.sh", timeoutMs: 10_000 });
    expect(r.stdout).toBe("tool\n");
    const h = await runner.health();
    expect(h.cpus).toBeGreaterThan(0);
    expect(h.loadavg).toHaveLength(3);
    expect(parseHealth("hostname=x\nplatform=linux\ncpus=4\nload=0.5 0.4 0.3\nproc=12 55.0 /usr/bin/ruby\n")).toMatchObject({ cpus: 4, loadavg: [0.5, 0.4, 0.3], topProcesses: [{ pid: 12, cpu: 55, command: "ruby" }] });
  });

  it("a machine that leaves mid-run fails the run with RemoteHostLostError", async () => {
    await runner.init();
    const p = runner.run({ cwd: "/tmp", command: "sleep 5", timeoutMs: 30_000 });
    setTimeout(() => provider.kill(remoteId), 100);
    await expect(p).rejects.toBeInstanceOf(RemoteHostLostError);
    await expect(runner.exec({ cwd: "/tmp", command: "true", timeoutMs: 1000 })).rejects.toBeInstanceOf(RemoteHostLostError);
  });
});
