import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  benchProviderContract,
  errorCode,
  type BenchProviderMethod,
  type MethodInput,
  type MethodOutput,
} from "../src/bench-provider/contract.ts";
import { createLocalBenchProvider, type LocalBenchProvider, type LocalBenchProviderOptions } from "../examples/bench-provider-local/provider.ts";

const CALLER = { experimental_caller: { kind: "plugin", pluginId: "bb-autoresearch" } } as const;

const roots: string[] = [];
const providers: LocalBenchProvider[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

function make(opts: LocalBenchProviderOptions = {}): LocalBenchProvider {
  const p = createLocalBenchProvider({ root: tmp("lbp-test-"), sweepMs: 0, ...opts });
  providers.push(p);
  return p;
}

afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** Call a handler as bb-autoresearch would, and check the output against the contract. */
async function call<M extends BenchProviderMethod>(p: LocalBenchProvider, method: M, input: MethodInput<M>): Promise<MethodOutput<M>> {
  const handler = p.handlers[method] as (i: unknown, c: typeof CALLER) => Promise<unknown>;
  const out = await handler(input, CALLER);
  return benchProviderContract[method].output.parse(out) as MethodOutput<M>;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (e) {
    return errorCode(e);
  }
  throw new Error("expected a rejection");
}

async function ready(p: LocalBenchProvider, key = "k1", labels: Record<string, string> = { study: "s1" }, cores = 1): Promise<string> {
  const r = await call(p, "benchProvider.create", { key, cores, lifetimeSeconds: 600, labels });
  expect(r.state).toBe("ready");
  return r.hostId;
}

/** Poll until done, collecting all output. */
async function drain(p: LocalBenchProvider, hostId: string, execId: string, maxBytes?: number) {
  let stdout = "";
  let stderr = "";
  let so = 0;
  let se = 0;
  let polls = 0;
  for (;;) {
    const r = await call(p, "benchProvider.execPoll", { hostId, execId, stdoutOffset: so, stderrOffset: se, ...(maxBytes ? { maxBytes } : {}) });
    polls++;
    stdout += r.stdout;
    stderr += r.stderr;
    if (maxBytes) {
      expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(maxBytes);
      expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(maxBytes);
    }
    expect(r.stdoutOffset).toBe(so + Buffer.byteLength(r.stdout));
    so = r.stdoutOffset;
    se = r.stderrOffset;
    if (r.done) return { ...r, stdout, stderr, polls };
    if (polls > 2000) throw new Error("exec never finished");
    await new Promise((res) => setTimeout(res, 10));
  }
}

async function run(p: LocalBenchProvider, hostId: string, input: Omit<MethodInput<"benchProvider.execStart">, "hostId" | "timeoutSeconds"> & { timeoutSeconds?: number }) {
  const { execId } = await call(p, "benchProvider.execStart", { hostId, timeoutSeconds: 30, ...input } as MethodInput<"benchProvider.execStart">);
  return drain(p, hostId, execId);
}

describe("local bench provider", () => {
  it("refuses callers other than the allowed plugin", async () => {
    const p = make();
    const d = p.handlers["benchProvider.describe"];
    await expect(d({}, { experimental_caller: { kind: "client" } })).rejects.toThrow("[invalid] caller not allowed");
    await expect(d({}, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow("[invalid] caller not allowed");
    expect(p.calls()["benchProvider.describe"]).toBe(0);
    const q = make({ allowedCaller: "test-caller" });
    await expect(q.handlers["benchProvider.describe"]({}, CALLER)).rejects.toThrow("caller not allowed");
    await expect(q.handlers["benchProvider.describe"]({}, { experimental_caller: { kind: "plugin", pluginId: "test-caller" } })).resolves.toBeTruthy();
  });

  it("describes itself", async () => {
    const p = make({ maxHosts: 3, cores: { min: 1, max: 2 } });
    const d = await call(p, "benchProvider.describe", {});
    expect(d).toEqual({
      contractVersion: 1,
      displayName: "Local temp directories (example)",
      available: true,
      maxHosts: 3,
      maxLifetimeSeconds: 7200,
      cores: { min: 1, max: 2 },
      machineOptions: [],
    });
    p.setAvailable(false, "maintenance");
    expect(await call(p, "benchProvider.describe", {})).toMatchObject({ available: false, reason: "maintenance" });
    expect(await codeOf(call(p, "benchProvider.create", { key: "x", cores: 1, lifetimeSeconds: 60, labels: {} }))).toBe("transient");
    expect(p.calls()["benchProvider.describe"]).toBe(2);
  });

  it("creates idempotently by key and enforces capacity and cores", async () => {
    const p = make({ maxHosts: 2, cores: { min: 1, max: 2 } });
    const a = await call(p, "benchProvider.create", { key: "a", cores: 1, lifetimeSeconds: 60, labels: {} });
    const a2 = await call(p, "benchProvider.create", { key: "a", cores: 1, lifetimeSeconds: 60, labels: {} });
    expect(a2.hostId).toBe(a.hostId);
    expect(a.hostId).toMatch(/^lbp_[0-9a-f]+$/u);
    expect(await codeOf(call(p, "benchProvider.create", { key: "c", cores: 3, lifetimeSeconds: 60, labels: {} }))).toBe("invalid");
    await call(p, "benchProvider.create", { key: "b", cores: 2, lifetimeSeconds: 60, labels: {} });
    expect(await codeOf(call(p, "benchProvider.create", { key: "c", cores: 1, lifetimeSeconds: 60, labels: {} }))).toBe("capacity");
    // The same key still answers at capacity.
    expect((await call(p, "benchProvider.create", { key: "a", cores: 1, lifetimeSeconds: 60, labels: {} })).hostId).toBe(a.hostId);
    await call(p, "benchProvider.destroy", { hostId: a.hostId });
    await call(p, "benchProvider.create", { key: "c", cores: 1, lifetimeSeconds: 60, labels: {} });
    expect(p.machines().filter((m) => m.state !== "gone")).toHaveLength(2);
  });

  it("injects failures for the next call", async () => {
    const p = make();
    p.failNext("benchProvider.list", "transient");
    await expect(call(p, "benchProvider.list", { labels: {} })).rejects.toThrow("[transient] injected");
    expect((await call(p, "benchProvider.list", { labels: {} })).hosts).toEqual([]);
    expect(p.calls()["benchProvider.list"]).toBe(2);
  });

  it("lists machines matching all labels", async () => {
    const p = make();
    const a = await ready(p, "a", { study: "s1", role: "bench" });
    const b = await ready(p, "b", { study: "s1", role: "spare" });
    await ready(p, "c", { study: "s2", role: "bench" });
    const ids = async (labels: Record<string, string>) => (await call(p, "benchProvider.list", { labels })).hosts.map((h) => h.hostId).sort();
    expect(await ids({ study: "s1" })).toEqual([a, b].sort());
    expect(await ids({ study: "s1", role: "bench" })).toEqual([a]);
    expect(await ids({ study: "s3" })).toEqual([]);
    expect(await ids({})).toHaveLength(3);
    const h = (await call(p, "benchProvider.list", { labels: { role: "spare" } })).hosts[0];
    expect(h?.labels).toEqual({ study: "s1", role: "spare" });
  });

  it("reports status, provisions, and expires machines with an injected clock", async () => {
    let t = 1_000_000;
    const p = make({ now: () => t, provisionMs: 5000, maxLifetimeSeconds: 100 });
    const c = await call(p, "benchProvider.create", { key: "a", cores: 1, lifetimeSeconds: 1000, labels: {} });
    expect(c.state).toBe("provisioning");
    expect(c.expiresAt).toBe(new Date(t + 100_000).toISOString()); // capped
    expect(await codeOf(call(p, "benchProvider.info", { hostId: c.hostId }))).toBe("invalid");
    t += 5000;
    expect((await call(p, "benchProvider.status", { hostId: c.hostId })).state).toBe("ready");
    const dir = p.machines()[0]!.dir;
    expect(fs.existsSync(dir)).toBe(true);
    t += 95_000;
    const s = await call(p, "benchProvider.status", { hostId: c.hostId });
    expect(s.state).toBe("gone");
    expect(fs.existsSync(dir)).toBe(false);
    expect(await codeOf(call(p, "benchProvider.status", { hostId: "lbp_nope" }))).toBe("not_found");
    expect(await call(p, "benchProvider.destroy", { hostId: c.hostId })).toEqual({ ok: true });
    expect(await call(p, "benchProvider.destroy", { hostId: "lbp_nope" })).toEqual({ ok: true });
  });

  it("expires machines from the sweep timer", async () => {
    let t = 0;
    const p = make({ now: () => t, sweepMs: 5 });
    const id = await ready(p);
    t += 601_000;
    for (let i = 0; i < 200 && p.machines()[0]?.state !== "gone"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(p.machines().find((m) => m.hostId === id)?.state).toBe("gone");
  });

  it("reports machine info", async () => {
    const p = make({ cores: { min: 1, max: 8 } });
    const id = await ready(p, "a", {}, 2);
    const info = await call(p, "benchProvider.info", { hostId: id });
    expect(info).toMatchObject({ os: os.platform(), arch: os.arch(), nproc: 2, cpuQuotaCores: 2, memoryBytes: os.totalmem(), extra: { kind: "local-temp-dir" } });
  });

  it("round-trips files with sha256 and parent directories", async () => {
    const p = make();
    const id = await ready(p);
    const local = tmp("lbp-local-");
    const src = join(local, "in.bin");
    const content = Buffer.from("hello bench\n".repeat(100));
    fs.writeFileSync(src, content);
    const sha = createHash("sha256").update(content).digest("hex");
    const put = await call(p, "benchProvider.putFile", { hostId: id, localPath: src, remotePath: "a/b/c/in.bin", mode: 0o700 });
    expect(put).toEqual({ bytes: content.length, sha256: sha });
    const home = p.machines()[0]!.home;
    expect(fs.statSync(join(home, "a/b/c/in.bin")).mode & 0o777).toBe(0o700);
    const dst = join(local, "out/deep/out.bin");
    const got = await call(p, "benchProvider.getFile", { hostId: id, remotePath: "a/b/c/in.bin", localPath: dst, maxBytes: content.length });
    expect(got).toEqual(put);
    expect(fs.readFileSync(dst)).toEqual(content);
    // Absolute remote paths are used as they are.
    const abs = join(home, "abs.bin");
    await call(p, "benchProvider.putFile", { hostId: id, localPath: src, remotePath: abs });
    expect(fs.existsSync(abs)).toBe(true);
    expect(await codeOf(call(p, "benchProvider.getFile", { hostId: id, remotePath: "a/b/c/in.bin", localPath: dst, maxBytes: content.length - 1 }))).toBe("invalid");
    expect(await codeOf(call(p, "benchProvider.getFile", { hostId: id, remotePath: "missing", localPath: dst, maxBytes: 10 }))).toBe("not_found");
    expect(await codeOf(call(p, "benchProvider.putFile", { hostId: id, localPath: join(local, "missing"), remotePath: "x" }))).toBe("invalid");
  });

  it("runs scripts and argv with cwd, env and HOME", async () => {
    const p = make();
    const id = await ready(p);
    const home = p.machines()[0]!.home;
    fs.mkdirSync(join(home, "work/sub"), { recursive: true });
    const s = await run(p, id, { script: 'echo "$HOME|$(pwd)|$FOO"; echo oops >&2; exit 3', cwd: "work/sub", env: { FOO: "bar" } });
    expect(s.stdout).toBe(`${home}|${fs.realpathSync(join(home, "work/sub"))}|bar\n`);
    expect(s.stderr).toBe("oops\n");
    expect(s).toMatchObject({ done: true, exitCode: 3, signal: null });
    const a = await run(p, id, { argv: ["sh", "-c", 'printf "%s" "$1"', "sh", "two words"], cwd: "work" });
    expect(a).toMatchObject({ stdout: "two words", exitCode: 0, signal: null });
    const missing = await run(p, id, { argv: ["definitely-not-a-command-xyz"] });
    expect(missing.exitCode).toBe(127);
    expect(await codeOf(call(p, "benchProvider.execStart", { hostId: id, script: "true", cwd: "nope", timeoutSeconds: 5 }))).toBe("invalid");
    expect(await codeOf(p.handlers["benchProvider.execStart"]({ hostId: id, script: "true", argv: ["true"], timeoutSeconds: 5 }, CALLER))).toBe("invalid");
  });

  it("pages output by byte offsets with a small maxBytes", async () => {
    const p = make();
    const id = await ready(p);
    // 2000 lines on stdout, multibyte characters on stderr.
    const script = 'for i in $(seq 1 2000); do echo "line $i"; done; for i in $(seq 1 50); do printf "é✓"; done >&2';
    const { execId } = await call(p, "benchProvider.execStart", { hostId: id, script, timeoutSeconds: 30 });
    const r = await drain(p, id, execId, 1000);
    const want = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}\n`).join("");
    expect(r.stdout).toBe(want);
    expect(r.stderr).toBe("é✓".repeat(50));
    expect(r.stdoutOffset).toBe(Buffer.byteLength(want));
    expect(r.polls).toBeGreaterThan(Buffer.byteLength(want) / 1000);
    // Polling past the end returns nothing new and stays done.
    const again = await call(p, "benchProvider.execPoll", { hostId: id, execId, stdoutOffset: r.stdoutOffset, stderrOffset: r.stderrOffset });
    expect(again).toMatchObject({ done: true, stdout: "", stderr: "", exitCode: 0 });
    // Re-reading from an earlier offset works.
    const mid = await call(p, "benchProvider.execPoll", { hostId: id, execId, stdoutOffset: 7, stderrOffset: 0, maxBytes: 7 });
    expect(mid.stdout).toBe("line 2\n");
    expect(mid.done).toBe(false);
  });

  it("keeps a detached exec running between polls", async () => {
    const p = make();
    const id = await ready(p);
    const { execId } = await call(p, "benchProvider.execStart", { hostId: id, script: "echo start; sleep 0.3; echo end", timeoutSeconds: 30 });
    let first: MethodOutput<"benchProvider.execPoll"> | undefined;
    for (let i = 0; i < 100; i++) {
      first = await call(p, "benchProvider.execPoll", { hostId: id, execId, stdoutOffset: 0, stderrOffset: 0 });
      if (first.stdout) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(first).toMatchObject({ done: false, stdout: "start\n", exitCode: null });
    const r = await drain(p, id, execId);
    expect(r.stdout).toBe("start\nend\n");
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(250);
  });

  it("kills an exec at its timeout", async () => {
    const p = make();
    const id = await ready(p);
    const r = await run(p, id, { script: "echo before; sleep 30; echo after", timeoutSeconds: 1 });
    expect(r).toMatchObject({ done: true, exitCode: null, signal: "TIMEOUT", stdout: "before\n" });
    expect(r.durationMs).toBeLessThan(5000);
  });

  it("cancels an exec and its process group", async () => {
    const p = make();
    const id = await ready(p);
    const { execId } = await call(p, "benchProvider.execStart", { hostId: id, script: "sleep 30 & sleep 30; wait", timeoutSeconds: 60 });
    expect(await call(p, "benchProvider.execCancel", { hostId: id, execId })).toEqual({ ok: true });
    const r = await drain(p, id, execId);
    expect(r.done).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe("SIGTERM");
    expect(await call(p, "benchProvider.execCancel", { hostId: id, execId })).toEqual({ ok: true });
    expect(await codeOf(call(p, "benchProvider.execCancel", { hostId: id, execId: "lbx_00000000" }))).toBe("not_found");
  });

  it("refuses work on gone, suspended and failed machines", async () => {
    const p = make();
    const a = await ready(p, "a");
    const b = await ready(p, "b");
    const c = await ready(p, "c");
    const { execId } = await call(p, "benchProvider.execStart", { hostId: a, script: "sleep 30", timeoutSeconds: 60 });
    p.kill(a);
    expect((await call(p, "benchProvider.status", { hostId: a })).state).toBe("gone");
    expect(await codeOf(call(p, "benchProvider.execStart", { hostId: a, script: "true", timeoutSeconds: 5 }))).toBe("not_found");
    expect(await codeOf(call(p, "benchProvider.execPoll", { hostId: a, execId, stdoutOffset: 0, stderrOffset: 0 }))).toBe("not_found");
    expect(await codeOf(call(p, "benchProvider.info", { hostId: a }))).toBe("not_found");
    p.suspend(b);
    p.fail(c, "disk on fire");
    expect((await call(p, "benchProvider.status", { hostId: b })).state).toBe("suspended");
    expect(await call(p, "benchProvider.status", { hostId: c })).toMatchObject({ state: "failed", detail: "disk on fire" });
    await expect(call(p, "benchProvider.execStart", { hostId: b, script: "true", timeoutSeconds: 5 })).rejects.toThrow("[invalid] machine is suspended");
    await expect(call(p, "benchProvider.info", { hostId: c })).rejects.toThrow("[invalid] machine is failed");
    expect(fs.existsSync(p.machines().find((m) => m.hostId === b)!.dir)).toBe(true);
    await call(p, "benchProvider.destroy", { hostId: b });
    expect(fs.existsSync(p.machines().find((m) => m.hostId === b)!.dir)).toBe(false);
  });

  it("keeps its registry across provider instances on the same root", async () => {
    const root = tmp("lbp-reload-");
    const p1 = createLocalBenchProvider({ root, sweepMs: 0 });
    providers.push(p1);
    const a = await ready(p1, "a", { study: "s1" });
    const b = await ready(p1, "b", { study: "s1" });
    const finished = await call(p1, "benchProvider.execStart", { hostId: a, script: "echo hi", timeoutSeconds: 10 });
    await drain(p1, a, finished.execId);
    const running = await call(p1, "benchProvider.execStart", { hostId: a, script: "sleep 30", timeoutSeconds: 60 });
    p1.dispose();

    const p2 = createLocalBenchProvider({ root, sweepMs: 0 });
    providers.push(p2);
    const hosts = (await call(p2, "benchProvider.list", { labels: { study: "s1" } })).hosts;
    expect(hosts.map((h) => h.hostId).sort()).toEqual([a, b].sort());
    expect((await call(p2, "benchProvider.create", { key: "a", cores: 1, lifetimeSeconds: 60, labels: {} })).hostId).toBe(a);
    const lost = await call(p2, "benchProvider.execPoll", { hostId: a, execId: running.execId, stdoutOffset: 0, stderrOffset: 0 });
    expect(lost).toMatchObject({ done: true, exitCode: null, signal: "LOST" });
    const old = await call(p2, "benchProvider.execPoll", { hostId: a, execId: finished.execId, stdoutOffset: 0, stderrOffset: 0 });
    expect(old).toMatchObject({ done: true, exitCode: 0, stdout: "hi\n" });
    await call(p2, "benchProvider.destroy", { hostId: b });
    expect((await call(p2, "benchProvider.status", { hostId: b })).state).toBe("gone");
    const p3 = createLocalBenchProvider({ root, sweepMs: 0 });
    providers.push(p3);
    expect((await call(p3, "benchProvider.status", { hostId: b })).state).toBe("gone");
  });
});
