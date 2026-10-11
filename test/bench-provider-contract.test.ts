// The bench provider contract: schemas, error codes (with BB's "HTTP nnn:"
// prefix), the client's retries, and the runner's reading of execPoll.
import { describe, expect, it } from "vitest";
import { BenchProviderClient, toProviderError } from "../src/bench-provider/client.ts";
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

  it("finds the error code after BB's prefix; no code is internal", () => {
    expect(errorCode(new Error("HTTP 500: [invalid] caller not allowed"))).toBe("invalid");
    expect(errorCode(providerError("capacity", "full"))).toBe("capacity");
    expect(errorCode(new Error("boom"))).toBeNull();
    expect(toProviderError(new Error("HTTP 500: [transient] try later"), "m", "p")).toMatchObject({ code: "transient", retryable: true });
    expect(toProviderError(new Error("boom"), "m", "p")).toMatchObject({ code: "internal", retryable: false });
    expect(toProviderError(new Error("plugin p is not installed"), "m", "p").code).toBe("not_found");
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
