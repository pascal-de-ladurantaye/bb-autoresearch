// Local bench provider: implements the bench provider contract against local
// temp directories and child processes. A "machine" is a directory on this
// machine; nothing is isolated and nothing costs anything. It exists for
// bb-autoresearch's tests and live smoke tests, and as a worked example of the
// contract (docs: ../../src/bench-provider/contract.ts).
//
// All logic lives here so tests can drive it without BB; server.ts only
// registers the handlers.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  BENCH_PROVIDER_CALLER,
  BENCH_PROVIDER_CONTRACT_VERSION,
  EXEC_POLL_MAX_BYTES,
  benchProviderContract,
  errorCode,
  providerError,
  type BenchProviderContract,
  type BenchProviderMethod,
  type ErrorCode,
  type HostState,
  type MethodOutput,
} from "../../src/bench-provider/contract.ts";

export interface LocalBenchProviderOptions {
  /** Where machines and the registry live. Default `<tmpdir>/bb-bench-provider-local`. */
  root?: string;
  /** Clock in ms for expiresAt, expiry and provisioning. Default Date.now. */
  now?: () => number;
  /** Plugin id accepted as caller. Default "bb-autoresearch". */
  allowedCaller?: string;
  /** Live (not gone) machines at once. Default 4. */
  maxHosts?: number;
  /** Lifetime cap in seconds. Default 7200. */
  maxLifetimeSeconds?: number;
  /** Accepted core counts. Default {min: 1, max: os.cpus().length}. */
  cores?: { min: number; max: number };
  displayName?: string;
  /** 0 (default): create returns "ready". >0: "provisioning" for this long. */
  provisionMs?: number;
  /** Expiry sweep period in ms (timer is unref'd; 0 disables). Default 1000. */
  sweepMs?: number;
}

export interface MachineSnapshot {
  hostId: string;
  key: string;
  labels: Record<string, string>;
  state: HostState;
  /** ms, provider clock. */
  createdAt: number;
  expiresAt: number;
  cores: number;
  /** The machine's directory; its home is `<dir>/home`. */
  dir: string;
  home: string;
  detail?: string;
}

type Handler<M extends BenchProviderMethod> = (
  input: z.output<BenchProviderContract[M]["input"]>,
  ctx: ExperimentalPluginRpcHandlerContext,
) => Promise<MethodOutput<M>>;
export type LocalBenchProviderHandlers = { [M in BenchProviderMethod]: Handler<M> };

export interface LocalBenchProvider {
  /** Keyed by contract method name; pass to `bb.rpc.register(benchProviderContract, handlers)`. */
  handlers: LocalBenchProviderHandlers;
  readonly root: string;
  /** Stop timers and kill running execs. Machines and state.json stay. */
  dispose(): void;
  // Test hooks.
  /** Mark a machine suspended (kills its processes, keeps its directory). */
  suspend(hostId: string): void;
  /** Mark a machine failed (kills its processes, keeps its directory). */
  fail(hostId: string, detail?: string): void;
  /** The machine disappears without a destroy call: gone, directory removed. */
  kill(hostId: string): void;
  machines(): MachineSnapshot[];
  setAvailable(available: boolean, reason?: string): void;
  /** The next call to `method` throws `[code] injected`. */
  failNext(method: BenchProviderMethod, code: ErrorCode): void;
  /** Calls per method that passed the caller check. */
  calls(): Record<BenchProviderMethod, number>;
  /** Run the expiry/provisioning sweep now. */
  sweep(): void;
}

interface Machine {
  hostId: string;
  key: string;
  labels: Record<string, string>;
  state: HostState;
  createdAt: number;
  expiresAt: number;
  readyAt: number;
  cores: number;
  detail?: string;
}

interface Exec {
  execId: string;
  hostId: string;
  dir: string;
  child: ChildProcess | null;
  pgid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
}

interface ExitRecord {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

const METHODS = Object.keys(benchProviderContract) as BenchProviderMethod[];
const EXEC_ID_RE = /^lbx_[0-9a-f]{8,64}$/u;

export function createLocalBenchProvider(opts: LocalBenchProviderOptions = {}): LocalBenchProvider {
  const root = resolve(opts.root ?? join(os.tmpdir(), "bb-bench-provider-local"));
  const now = opts.now ?? Date.now;
  const allowedCaller = opts.allowedCaller ?? BENCH_PROVIDER_CALLER;
  const maxHosts = opts.maxHosts ?? 4;
  const maxLifetimeSeconds = opts.maxLifetimeSeconds ?? 7200;
  const cores = opts.cores ?? { min: 1, max: Math.max(1, os.cpus().length) };
  const displayName = opts.displayName ?? "Local temp directories (example)";
  const provisionMs = opts.provisionMs ?? 0;
  const sweepMs = opts.sweepMs ?? 1000;
  const statePath = join(root, "state.json");

  let available = true;
  let unavailableReason: string | undefined;
  const injected = new Map<BenchProviderMethod, ErrorCode>();
  const counts = Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<BenchProviderMethod, number>;
  const machines = new Map<string, Machine>();
  const execs = new Map<string, Exec>();
  let disposed = false;

  fs.mkdirSync(join(root, "machines"), { recursive: true });
  load();

  const machineDir = (id: string) => join(root, "machines", id);
  const homeOf = (id: string) => join(machineDir(id), "home");
  const iso = (ms: number) => new Date(ms).toISOString();

  function load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { machines?: Machine[] };
      for (const m of parsed.machines ?? []) machines.set(m.hostId, m);
    } catch {
      // A corrupt registry starts empty; machine directories stay until removed by hand.
    }
  }

  function save(): void {
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, machines: [...machines.values()] }, null, 2));
    fs.renameSync(tmp, statePath);
  }

  function killGroup(e: Exec, signal: NodeJS.Signals): void {
    if (e.pgid === null) return;
    try {
      process.kill(-e.pgid, signal);
    } catch {
      // Already gone.
    }
  }

  /** Kill every process a machine started (including stragglers of finished execs). */
  function killMachineProcesses(hostId: string): void {
    for (const e of execs.values()) {
      if (e.hostId !== hostId) continue;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      killGroup(e, "SIGKILL");
    }
  }

  function goGone(m: Machine, detail: string): void {
    killMachineProcesses(m.hostId);
    for (const [id, e] of execs) if (e.hostId === m.hostId && e.endedAt !== null) execs.delete(id);
    m.state = "gone";
    m.detail = detail;
    fs.rmSync(machineDir(m.hostId), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    save();
  }

  function sweep(): void {
    const t = now();
    let changed = false;
    for (const m of machines.values()) {
      if (m.state === "gone") continue;
      if (t >= m.expiresAt) {
        goGone(m, "expired");
        continue;
      }
      if (m.state === "provisioning" && t >= m.readyAt) {
        m.state = "ready";
        changed = true;
      }
    }
    if (changed) save();
  }

  const sweepTimer = sweepMs > 0 ? setInterval(() => sweep(), sweepMs) : null;
  sweepTimer?.unref();

  function getMachine(hostId: string): Machine {
    const m = machines.get(hostId);
    if (!m || m.state === "gone") throw providerError("not_found", `no machine ${hostId}`);
    return m;
  }

  /** A machine that can take files and processes. */
  function usable(hostId: string): Machine {
    const m = getMachine(hostId);
    if (m.state !== "ready") throw providerError("invalid", `machine is ${m.state}`);
    return m;
  }

  function remote(hostId: string, p: string): string {
    return isAbsolute(p) ? p : resolve(homeOf(hostId), p);
  }

  function sha256File(path: string): { bytes: number; sha256: string } {
    const buf = fs.readFileSync(path);
    return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  function copy(from: string, to: string, mode?: number): { bytes: number; sha256: string } {
    fs.mkdirSync(dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (mode !== undefined) fs.chmodSync(to, mode);
    return sha256File(to);
  }

  function finish(e: Exec, exitCode: number | null, signal: string | null): void {
    if (e.endedAt !== null) return;
    e.endedAt = Date.now();
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.exitCode = exitCode;
    e.signal = e.timedOut ? "TIMEOUT" : signal;
    e.child = null;
    const rec: ExitRecord = { exitCode: e.exitCode, signal: e.signal, durationMs: e.endedAt - e.startedAt };
    try {
      fs.writeFileSync(join(e.dir, "exit.json"), JSON.stringify(rec));
    } catch {
      // The machine directory may already be gone.
    }
  }

  /** Read up to maxBytes from offset, cut back to a UTF-8 character boundary. */
  function readChunk(path: string, offset: number, maxBytes: number): { text: string; next: number; size: number } {
    let fd: number;
    try {
      fd = fs.openSync(path, "r");
    } catch {
      return { text: "", next: offset, size: 0 };
    }
    try {
      const size = fs.fstatSync(fd).size;
      const want = Math.max(0, Math.min(maxBytes, size - offset));
      if (want === 0) return { text: "", next: offset, size };
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, offset);
      const len = utf8Boundary(buf, n);
      return { text: buf.subarray(0, len).toString("utf8"), next: offset + len, size };
    } finally {
      fs.closeSync(fd);
    }
  }

  function guard<M extends BenchProviderMethod>(method: M, fn: (input: z.output<BenchProviderContract[M]["input"]>) => MethodOutput<M>): Handler<M> {
    return async (input, ctx) => {
      const caller = ctx?.experimental_caller;
      if (!caller || caller.kind !== "plugin" || caller.pluginId !== allowedCaller) {
        throw providerError("invalid", "caller not allowed");
      }
      if (disposed) throw providerError("transient", "provider is shutting down");
      counts[method] += 1;
      const code = injected.get(method);
      if (code) {
        injected.delete(method);
        throw providerError(code, "injected");
      }
      const parsed = benchProviderContract[method].input.safeParse(input);
      if (!parsed.success) throw providerError("invalid", parsed.error.issues.map((i) => i.message).join("; "));
      try {
        sweep();
        return fn(parsed.data as z.output<BenchProviderContract[M]["input"]>);
      } catch (e) {
        if (errorCode(e) !== null) throw e;
        throw providerError("internal", e instanceof Error ? e.message : String(e));
      }
    };
  }

  const handlers: LocalBenchProviderHandlers = {
    "benchProvider.describe": guard("benchProvider.describe", () => ({
      contractVersion: BENCH_PROVIDER_CONTRACT_VERSION as 1,
      displayName,
      available,
      ...(available || unavailableReason === undefined ? {} : { reason: unavailableReason }),
      maxHosts,
      maxLifetimeSeconds,
      cores: { ...cores },
    })),

    "benchProvider.create": guard("benchProvider.create", (input) => {
      for (const m of machines.values()) {
        if (m.key === input.key) return { hostId: m.hostId, state: m.state, expiresAt: iso(m.expiresAt) };
      }
      if (!available) throw providerError("transient", `provider unavailable${unavailableReason ? `: ${unavailableReason}` : ""}`);
      if (input.cores < cores.min || input.cores > cores.max) {
        throw providerError("invalid", `cores must be between ${cores.min} and ${cores.max}`);
      }
      const live = [...machines.values()].filter((m) => m.state !== "gone").length;
      if (live >= maxHosts) throw providerError("capacity", `all ${maxHosts} machines are in use`);
      const t = now();
      const lifetime = Math.min(input.lifetimeSeconds, maxLifetimeSeconds);
      const m: Machine = {
        hostId: `lbp_${randomBytes(8).toString("hex")}`,
        key: input.key,
        labels: { ...input.labels },
        state: provisionMs > 0 ? "provisioning" : "ready",
        createdAt: t,
        expiresAt: t + lifetime * 1000,
        readyAt: t + provisionMs,
        cores: input.cores,
      };
      fs.mkdirSync(homeOf(m.hostId), { recursive: true });
      fs.mkdirSync(join(machineDir(m.hostId), "tmp"), { recursive: true });
      fs.mkdirSync(join(machineDir(m.hostId), "execs"), { recursive: true });
      machines.set(m.hostId, m);
      save();
      return { hostId: m.hostId, state: m.state, expiresAt: iso(m.expiresAt) };
    }),

    "benchProvider.status": guard("benchProvider.status", (input) => {
      const m = machines.get(input.hostId);
      if (!m) throw providerError("not_found", `no machine ${input.hostId}`);
      return { state: m.state, expiresAt: iso(m.expiresAt), ...(m.detail ? { detail: m.detail } : {}) };
    }),

    "benchProvider.list": guard("benchProvider.list", (input) => {
      const want = Object.entries(input.labels);
      const hosts = [...machines.values()]
        .filter((m) => want.every(([k, v]) => m.labels[k] === v))
        .map((m) => ({ hostId: m.hostId, state: m.state, expiresAt: iso(m.expiresAt), labels: { ...m.labels } }));
      return { hosts };
    }),

    "benchProvider.destroy": guard("benchProvider.destroy", (input) => {
      const m = machines.get(input.hostId);
      if (m && m.state !== "gone") goGone(m, "destroyed");
      return { ok: true };
    }),

    "benchProvider.info": guard("benchProvider.info", (input) => {
      const m = usable(input.hostId);
      const cpus = os.cpus();
      return {
        os: os.platform(),
        arch: os.arch(),
        cpuModel: cpus[0]?.model?.trim() || null,
        nproc: m.cores || cpus.length,
        cpuQuotaCores: m.cores,
        memoryBytes: os.totalmem(),
        extra: { kind: "local-temp-dir" },
      };
    }),

    "benchProvider.putFile": guard("benchProvider.putFile", (input) => {
      usable(input.hostId);
      if (!isAbsolute(input.localPath)) throw providerError("invalid", "localPath must be absolute");
      let st: fs.Stats;
      try {
        st = fs.statSync(input.localPath);
      } catch {
        throw providerError("invalid", `local file not found: ${input.localPath}`);
      }
      if (!st.isFile()) throw providerError("invalid", `not a file: ${input.localPath}`);
      return copy(input.localPath, remote(input.hostId, input.remotePath), input.mode);
    }),

    "benchProvider.getFile": guard("benchProvider.getFile", (input) => {
      usable(input.hostId);
      if (!isAbsolute(input.localPath)) throw providerError("invalid", "localPath must be absolute");
      const from = remote(input.hostId, input.remotePath);
      let st: fs.Stats;
      try {
        st = fs.statSync(from);
      } catch {
        throw providerError("not_found", `no remote file ${input.remotePath}`);
      }
      if (!st.isFile()) throw providerError("invalid", `not a file: ${input.remotePath}`);
      if (st.size > input.maxBytes) throw providerError("invalid", `file is ${st.size} bytes, over maxBytes ${input.maxBytes}`);
      return copy(from, input.localPath);
    }),

    "benchProvider.execStart": guard("benchProvider.execStart", (input) => {
      const m = usable(input.hostId);
      const home = homeOf(m.hostId);
      const cwd = input.cwd ? remote(m.hostId, input.cwd) : home;
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw providerError("invalid", `cwd does not exist: ${input.cwd}`);
      const execId = `lbx_${randomBytes(8).toString("hex")}`;
      const dir = join(machineDir(m.hostId), "execs", execId);
      fs.mkdirSync(dir, { recursive: true });
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        LANG: process.env.LANG ?? "C.UTF-8",
        TMPDIR: join(machineDir(m.hostId), "tmp"),
        ...input.env,
      };
      const [cmd, ...args] = input.script !== undefined ? ["bash", "-lc", input.script] : (input.argv as [string, ...string[]]);
      const out = fs.openSync(join(dir, "stdout"), "w");
      const err = fs.openSync(join(dir, "stderr"), "w");
      const e: Exec = {
        execId,
        hostId: m.hostId,
        dir,
        child: null,
        pgid: null,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        timer: null,
      };
      try {
        const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", out, err] });
        e.child = child;
        e.pgid = child.pid ?? null;
        child.on("exit", (code, signal) => finish(e, code, signal));
        child.on("error", (error) => {
          try {
            fs.appendFileSync(join(dir, "stderr"), `${error.message}\n`);
          } catch {
            // Machine removed.
          }
          finish(e, 127, null);
        });
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      e.timer = setTimeout(() => {
        e.timer = null;
        if (e.endedAt !== null) return;
        e.timedOut = true;
        killGroup(e, "SIGKILL");
      }, input.timeoutSeconds * 1000);
      e.timer.unref();
      execs.set(execId, e);
      return { execId };
    }),

    "benchProvider.execPoll": guard("benchProvider.execPoll", (input) => {
      const m = usable(input.hostId);
      const e = findExec(m.hostId, input.execId);
      const maxBytes = input.maxBytes ?? EXEC_POLL_MAX_BYTES;
      const out = readChunk(join(e.dir, "stdout"), input.stdoutOffset, maxBytes);
      const err = readChunk(join(e.dir, "stderr"), input.stderrOffset, maxBytes);
      const exited = e.endedAt !== null;
      const drained = out.next >= out.size && err.next >= err.size;
      return {
        // Done once the process exited and this poll reached the end of both streams.
        done: exited && drained,
        exitCode: exited ? e.exitCode : null,
        signal: exited ? e.signal : null,
        stdout: out.text,
        stderr: err.text,
        stdoutOffset: out.next,
        stderrOffset: err.next,
        durationMs: Math.max(0, (e.endedAt ?? Date.now()) - e.startedAt),
      };
    }),

    "benchProvider.execCancel": guard("benchProvider.execCancel", (input) => {
      const m = usable(input.hostId);
      const e = findExec(m.hostId, input.execId);
      if (e.endedAt === null) {
        killGroup(e, "SIGTERM");
        const grace = setTimeout(() => killGroup(e, "SIGKILL"), 2000);
        grace.unref();
      }
      return { ok: true };
    }),
  };

  /** An exec of this machine: live, finished, or left over from a previous provider process. */
  function findExec(hostId: string, execId: string): Exec {
    const e = execs.get(execId);
    if (e && e.hostId === hostId) return e;
    if (!EXEC_ID_RE.test(execId)) throw providerError("not_found", `no exec ${execId}`);
    const dir = join(machineDir(hostId), "execs", execId);
    if (!fs.existsSync(dir)) throw providerError("not_found", `no exec ${execId}`);
    // From an earlier process of this provider: finished if it recorded an exit, else lost.
    let rec: ExitRecord = { exitCode: null, signal: "LOST", durationMs: 0 };
    try {
      rec = JSON.parse(fs.readFileSync(join(dir, "exit.json"), "utf8")) as ExitRecord;
    } catch {
      // No exit record: the process was lost with the provider.
    }
    const t = Date.now();
    const old: Exec = {
      execId,
      hostId,
      dir,
      child: null,
      pgid: null,
      startedAt: t - rec.durationMs,
      endedAt: t,
      exitCode: rec.exitCode,
      signal: rec.signal,
      timedOut: false,
      timer: null,
    };
    execs.set(execId, old);
    return old;
  }

  function setState(hostId: string, state: HostState, detail?: string): void {
    const m = getMachine(hostId);
    killMachineProcesses(hostId);
    m.state = state;
    if (detail !== undefined) m.detail = detail;
    save();
  }

  return {
    handlers,
    root,
    dispose() {
      disposed = true;
      if (sweepTimer) clearInterval(sweepTimer);
      for (const e of execs.values()) {
        if (e.timer) clearTimeout(e.timer);
        e.timer = null;
        if (e.endedAt === null) killGroup(e, "SIGKILL");
      }
    },
    suspend: (hostId) => setState(hostId, "suspended"),
    fail: (hostId, detail) => setState(hostId, "failed", detail ?? "failed (injected)"),
    kill(hostId) {
      goGone(getMachine(hostId), "machine disappeared");
    },
    machines: () =>
      [...machines.values()].map((m) => ({
        hostId: m.hostId,
        key: m.key,
        labels: { ...m.labels },
        state: m.state,
        createdAt: m.createdAt,
        expiresAt: m.expiresAt,
        cores: m.cores,
        dir: machineDir(m.hostId),
        home: homeOf(m.hostId),
        ...(m.detail ? { detail: m.detail } : {}),
      })),
    setAvailable(a, reason) {
      available = a;
      unavailableReason = a ? undefined : reason;
    },
    failNext(method, code) {
      injected.set(method, code);
    },
    calls: () => ({ ...counts }),
    sweep,
  };
}

/** Length of the longest prefix of buf[0..n) that doesn't end inside a UTF-8 sequence. */
function utf8Boundary(buf: Buffer, n: number): number {
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > back) return n - back > 0 ? n - back : n; // incomplete; never return 0 bytes for a non-empty read
    return n;
  }
  return n;
}
