// The bench provider contract: schemas, error codes (with BB's "HTTP nnn:"
// prefix), the client's retries, and the runner's reading of execPoll.
import { describe, expect, it } from "vitest";
import { BenchProviderClient, ProviderMissingError, toProviderError } from "../src/bench-provider/client.ts";
import { BENCH_PROVIDER_CONTRACT_VERSION, benchProviderContract, errorCode, providerError } from "../src/bench-provider/contract.ts";
import { RemoteBenchRunner, RemoteHostLostError } from "../src/bench-provider/runner.ts";

describe("bench provider contract", () => {
  it("has the eleven methods of v1", () => {
    expect(BENCH_PROVIDER_CONTRACT_VERSION).toBe(1);
    expect(Object.keys(benchProviderContract).sort()).toEqual(
      ["create", "describe", "destroy", "execCancel", "execPoll", "execStart", "getFile", "info", "list", "putFile", "status"].map((m) => `benchProvider.${m}`).sort(),
    );
  });

  it("validates inputs and outputs", () => {
    const start = benchProviderContract["benchProvider.execStart"].input;
    expect(start.safeParse({ hostId: "h", script: "true", timeoutSeconds: 5 }).success).toBe(true);
    expect(start.safeParse({ hostId: "h", argv: ["true"], timeoutSeconds: 5 }).success).toBe(true);
    expect(start.safeParse({ hostId: "h", argv: ["true"], script: "true", timeoutSeconds: 5 }).success).toBe(false);
    expect(start.safeParse({ hostId: "h", timeoutSeconds: 5 }).success).toBe(false);
    const d = benchProviderContract["benchProvider.describe"].output;
    expect(d.safeParse({ contractVersion: 1, displayName: "x", available: true, maxHosts: null, maxLifetimeSeconds: 7200, cores: { min: 1, max: 8 } }).success).toBe(true);
    expect(d.safeParse({ contractVersion: 2, displayName: "x", available: true, maxHosts: null, maxLifetimeSeconds: null, cores: null }).success).toBe(false);
    const st = benchProviderContract["benchProvider.status"].output;
    expect(st.safeParse({ state: "suspended", expiresAt: null }).success).toBe(true);
    expect(st.safeParse({ state: "sleeping", expiresAt: null }).success).toBe(false);
    const put = benchProviderContract["benchProvider.putFile"].output;
    expect(put.safeParse({ bytes: 3, sha256: "a".repeat(64) }).success).toBe(true);
    expect(put.safeParse({ bytes: 3, sha256: "nope" }).success).toBe(false);
  });

  it("machine options: optional on create, keys and values bounded, listed by describe", () => {
    const create = benchProviderContract["benchProvider.create"].input;
    const base = { key: "k", cores: 4, lifetimeSeconds: 60, labels: {} };
    expect(create.safeParse(base).success).toBe(true);
    expect(create.safeParse({ ...base, machine: {} }).success).toBe(true);
    expect(create.safeParse({ ...base, machine: { machine_type: "c3-standard-8", smt: false, threads_per_core: 1 } }).success).toBe(true);
    for (const bad of [{ "1type": "x" }, { "bad-key": "x" }, { ["k".repeat(65)]: "x" }, { image: "x".repeat(257) }, { nested: { a: 1 } }, { list: ["a"] }]) {
      expect(create.safeParse({ ...base, machine: bad }).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
    expect(create.safeParse({ ...base, machine: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i])) }).success).toBe(true);
    expect(create.safeParse({ ...base, machine: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])) }).success).toBe(false);
    const d = benchProviderContract["benchProvider.describe"].output;
    const v1 = { contractVersion: 1, displayName: "x", available: true, maxHosts: null, maxLifetimeSeconds: null, cores: null };
    expect(d.safeParse({ ...v1, machineOptions: [{ name: "machine_type", description: "The machine type" }] }).success).toBe(true);
    expect(d.safeParse({ ...v1, machineOptions: [{ name: "bad-name", description: "" }] }).success).toBe(false);
  });

  it("the example provider lists no machine options, accepts an empty machine, and rejects unknown keys", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createLocalBenchProvider } = await import("../examples/bench-provider-local/provider.ts");
    const root = mkdtempSync(join(tmpdir(), "ar-machine-opts-"));
    const p = createLocalBenchProvider({ root, sweepMs: 0 });
    const caller = { experimental_caller: { kind: "plugin" as const, pluginId: "bb-autoresearch" } };
    try {
      expect((await p.handlers["benchProvider.describe"]({}, caller)).machineOptions).toEqual([]);
      const ok = await p.handlers["benchProvider.create"]({ key: "a", cores: 1, lifetimeSeconds: 60, labels: {}, machine: {} }, caller);
      expect(ok.state).toBe("ready");
      await expect(p.handlers["benchProvider.create"]({ key: "b", cores: 1, lifetimeSeconds: 60, labels: {}, machine: { smt: false } }, caller)).rejects.toThrow(/^\[invalid\] unknown machine option smt$/u);
    } finally {
      p.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the error code after BB's prefix; no code is internal", () => {
    expect(errorCode(new Error("HTTP 500: [invalid] caller not allowed"))).toBe("invalid");
    expect(errorCode(providerError("capacity", "full"))).toBe("capacity");
    expect(errorCode(new Error("boom"))).toBeNull();
    expect(toProviderError(new Error("HTTP 500: [transient] try later"), "m", "p")).toMatchObject({ code: "transient", retryable: true });
    expect(toProviderError(new Error("boom"), "m", "p")).toMatchObject({ code: "internal", retryable: false });
    expect(toProviderError(new Error("plugin p is not installed"), "m", "p").code).toBe("not_found");
    expect(toProviderError(new Error("plugin p is not installed"), "m", "p")).toBeInstanceOf(ProviderMissingError);
    // A machine the provider doesn't know is not a missing provider (a reload waits for the latter).
    expect(toProviderError(new Error("[not_found] no machine h1"), "m", "p")).not.toBeInstanceOf(ProviderMissingError);
  });

  it("the client retries [capacity] and [transient], not the others", async () => {
    let n = 0;
    const flaky = new BenchProviderClient("p", async () => {
      n += 1;
      if (n < 3) throw new Error("HTTP 500: [transient] later");
      return { ok: true };
    }, { retryMs: 1 });
    expect(await flaky.call("benchProvider.destroy", { hostId: "h" })).toEqual({ ok: true });
    expect(n).toBe(3);
    let m = 0;
    const auth = new BenchProviderClient("p", async () => {
      m += 1;
      throw new Error("HTTP 500: [auth] no");
    }, { retryMs: 1 });
    await expect(auth.call("benchProvider.destroy", { hostId: "h" })).rejects.toMatchObject({ code: "auth" });
    expect(m).toBe(1);
    // Outputs are checked against the contract.
    const bad = new BenchProviderClient("p", async () => ({ ok: "yes" }), { retryMs: 1 });
    await expect(bad.call("benchProvider.destroy", { hostId: "h" })).rejects.toBeTruthy();
  });

  it("an exec the provider reports LOST, or a [not_found] machine, is a lost host", async () => {
    const poll = (signal: string | null) =>
      new BenchProviderClient("p", async (method) => {
        if (method === "benchProvider.execStart") return { execId: "e1" };
        if (method === "benchProvider.execPoll") return { done: true, exitCode: null, signal, stdout: "", stderr: "", stdoutOffset: 0, stderrOffset: 0, durationMs: 5 };
        throw new Error("unexpected");
      });
    const lost = new RemoteBenchRunner(poll("LOST"), "m1", "remote-1", { home: "/home/u", stagingDir: "/tmp/x", pollMs: 1 });
    await expect(lost.exec({ cwd: "/home/u", command: "true", timeoutMs: 1000 })).rejects.toBeInstanceOf(RemoteHostLostError);
    const timeout = new RemoteBenchRunner(poll("TIMEOUT"), "m1", "remote-1", { home: "/home/u", stagingDir: "/tmp/x", pollMs: 1 });
    expect(await timeout.exec({ cwd: "/home/u", command: "true", timeoutMs: 1000 })).toMatchObject({ timedOut: true, exitCode: null });
    const gone = new RemoteBenchRunner(new BenchProviderClient("p", async () => { throw new Error("HTTP 500: [not_found] no such machine"); }), "m1", "remote-1", { home: "/home/u", stagingDir: "/tmp/x", pollMs: 1 });
    await expect(gone.exec({ cwd: "/home/u", command: "true", timeoutMs: 1000 })).rejects.toBeInstanceOf(RemoteHostLostError);
    // Edit-host operations never run on a remote bench host.
    await expect(gone.snapshot()).rejects.toThrow(/edit host/u);
  });
});

describe("the example provider's copy of the contract", () => {
  it("is identical to src/bench-provider/contract.ts below its header", async () => {
    const { readFileSync } = await import("node:fs");
    const strip = (s: string) => s.slice(s.indexOf("// Bench provider contract v1:"));
    expect(strip(readFileSync("examples/bench-provider-local/contract.ts", "utf8"))).toBe(strip(readFileSync("src/bench-provider/contract.ts", "utf8")));
  });
});
