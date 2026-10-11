// A bench host on a machine lent by a bench provider plugin. It implements
// the part of HostRunner that measurement needs (exec, background runs,
// checkouts, the bench clone, bundles, health) with the provider's contract:
// processes through execStart/execPoll/execCancel, files through putFile, and
// git as ordinary shell commands on the machine. Nothing else is shared with
// the machine: the edit host's commits reach it as git bundles, which this
// runner stages in a local file and uploads with putFile.
//
// Layout on the machine (under the remote user's home):
//   bb-autoresearch/repo.git          bare clone, shallow at the study base
//   bb-autoresearch/checkouts/<key>   worktrees, reused per key
//   bb-autoresearch/seed/<sha256>     the unpacked seed
//   bb-autoresearch/incoming/         uploads in transit
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BaseBundle, BundleInfo, CommitInfo, SeedPack, ComposeResult, DiffSummary, ExecInput, ExecResult, GitIdentity, HealthReport, JobInput, PrepareResult, SnapshotResult } from "../host/contract.ts";
import { BASE_REF } from "../host/base.ts";
import { RunAbortedError, type HostRunner, type RunOptions } from "../host/runner.ts";
import type { BenchProviderClient } from "./client.ts";
import { BenchProviderError, EXEC_POLL_MAX_BYTES, type InfoOutput } from "./contract.ts";

/** The machine left (destroyed, expired, suspended, failed) while a call ran. */
export class RemoteHostLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteHostLostError";
  }
}

/** Root of everything bb-autoresearch keeps on a remote machine, relative to its home. */
export const REMOTE_ROOT = "bb-autoresearch";
/** The ref a bundle's tip travels under (host/bundle.ts BUNDLE_REF). */
const BUNDLE_REF = "refs/autoresearch/bundle";

export interface RemoteRunnerOptions {
  /** The remote user's home (absolute); null until the machine is initialized. */
  home: string | null;
  /** Environment for every command (the spec entry's `env` plus what the fleet adds). */
  env?: Record<string, string>;
  /** Local directory for bundles in transit (on the BB server's machine). */
  stagingDir: string;
  /** Longest wait between two execPoll calls (they start at 50 ms and double). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Single-quote a string for a POSIX shell. */
export function q(s: string): string {
  return `'${s.replace(/'/gu, `'\\''`)}'`;
}

const SHA = /^[0-9a-f]{7,64}$/u;
function sha(s: string): string {
  if (!SHA.test(s)) throw new Error(`not a git sha: ${JSON.stringify(s)}`);
  return s;
}
const KEY = /^[a-z0-9][a-z0-9._-]{0,120}$/u;

/** Keeps the last `max` bytes of a stream that arrives in pieces. */
class TextTail {
  private parts: string[] = [];
  private size = 0;
  private dropped = false;
  constructor(private readonly max: number) {}
  push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.size += s.length;
    while (this.size > this.max * 2 && this.parts.length > 1) {
      this.size -= this.parts.shift()!.length;
      this.dropped = true;
    }
  }
  toString(): string {
    const all = this.parts.join("");
    if (all.length <= this.max && !this.dropped) return all;
    return `…${all.slice(-this.max)}`;
  }
}

export class RemoteBenchRunner implements HostRunner {
  private home: string | null;
  private readonly env: Record<string, string>;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Set when the fleet knows the machine left: every later call fails fast. */
  private lost: string | null = null;

  constructor(
    readonly client: BenchProviderClient,
    /** The provider's host id. */
    readonly remoteId: string,
    /** Its bench host id in bb-autoresearch ("remote-<n>"). */
    readonly hostId: string,
    private readonly opts: RemoteRunnerOptions,
  ) {
    this.home = opts.home;
    this.env = { ...(opts.env ?? {}) };
    this.pollMs = opts.pollMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The fleet saw the machine leave: calls in flight and later ones fail with RemoteHostLostError. */
  markLost(reason: string): void {
    this.lost = reason;
  }
  get root(): string {
    return this.home ? `${this.home}/${REMOTE_ROOT}` : REMOTE_ROOT;
  }
  get repoPath(): string {
    return `${this.root}/repo.git`;
  }
  setEnv(extra: Record<string, string>): void {
    Object.assign(this.env, extra);
  }

  private wrap(e: unknown): never {
    if (e instanceof BenchProviderError && e.code === "not_found") throw new RemoteHostLostError(`remote machine ${this.remoteId} is gone (${e.message})`);
    throw e;
  }

  // ---- processes ----

  /** One script on the machine, polled until it ends; output tails like a host job. */
  private async script(command: string, o: { cwd?: string; env?: Record<string, string>; timeoutMs: number; tailBytes?: number; signal?: AbortSignal; onProgress?: (line: string) => void }): Promise<ExecResult> {
    if (this.lost) throw new RemoteHostLostError(`remote machine ${this.remoteId} left: ${this.lost}`);
    if (o.signal?.aborted) throw new RunAbortedError();
    const started = Date.now();
    let execId: string;
    try {
      ({ execId } = await this.client.call("benchProvider.execStart", {
        hostId: this.remoteId,
        script: command,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        env: { ...this.env, ...(o.env ?? {}) },
        timeoutSeconds: Math.max(1, Math.ceil(o.timeoutMs / 1000)),
      }));
    } catch (e) {
      this.wrap(e);
    }
    const tailBytes = o.tailBytes ?? 16 * 1024;
    const out = new TextTail(tailBytes);
    const err = new TextTail(tailBytes);
    let so = 0;
    let se = 0;
    let wait = 50;
    let partial = "";
    let lastLine = "";
    let transient = 0;
    for (;;) {
      if (this.lost) {
        await this.client.call("benchProvider.execCancel", { hostId: this.remoteId, execId }, { retries: 0 }).catch(() => undefined);
        throw new RemoteHostLostError(`remote machine ${this.remoteId} left: ${this.lost}`);
      }
      if (o.signal?.aborted) {
        await this.client.call("benchProvider.execCancel", { hostId: this.remoteId, execId }, { retries: 1 }).catch(() => undefined);
        throw new RunAbortedError();
      }
      let p;
      try {
        p = await this.client.call("benchProvider.execPoll", { hostId: this.remoteId, execId, stdoutOffset: so, stderrOffset: se, maxBytes: EXEC_POLL_MAX_BYTES }, { retries: 0 });
        transient = 0;
      } catch (e) {
        // A poll that fails transiently is retried a few times: the process keeps running on the machine.
        if (e instanceof BenchProviderError && e.retryable && transient < 5) {
          transient += 1;
          await this.sleep(Math.min(this.pollMs * transient, 10_000));
          continue;
        }
        this.wrap(e);
      }
      const more = p.stdoutOffset - so >= EXEC_POLL_MAX_BYTES || p.stderrOffset - se >= EXEC_POLL_MAX_BYTES;
      so = p.stdoutOffset;
      se = p.stderrOffset;
      out.push(p.stdout);
      err.push(p.stderr);
      if (o.onProgress && p.stdout) {
        const lines = (partial + p.stdout).split("\n");
        partial = lines.pop() ?? "";
        const line = lines.map((l) => l.trim()).filter(Boolean).pop();
        if (line && line !== lastLine) {
          lastLine = line;
          o.onProgress(line);
        }
      }
      if (p.done && !more) {
        // The process died without an exit record (the machine was suspended, say): not a result, a lost host.
        if (p.signal === "LOST") throw new RemoteHostLostError(`remote machine ${this.remoteId} lost a running process (signal LOST)`);
        return {
          exitCode: p.exitCode,
          timedOut: p.signal === "TIMEOUT",
          durationMs: p.durationMs || Date.now() - started,
          stdout: out.toString(),
          stderr: err.toString(),
        };
      }
      if (!more) {
        await this.sleep(wait);
        wait = Math.min(wait * 2, this.pollMs);
      }
    }
  }

  async exec(input: ExecInput, signal?: AbortSignal): Promise<ExecResult> {
    return await this.script(input.command, { cwd: input.cwd, timeoutMs: input.timeoutMs, ...(input.env ? { env: input.env } : {}), ...(input.tailBytes ? { tailBytes: input.tailBytes } : {}), ...(signal ? { signal } : {}) });
  }

  async run(input: JobInput, opts: RunOptions = {}): Promise<ExecResult> {
    return await this.script(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
      ...(input.tailBytes ? { tailBytes: input.tailBytes } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  }

  /** A plugin script that must succeed: throws with its output otherwise. */
  private async must(command: string, what: string, timeoutMs = 10 * 60_000, signal?: AbortSignal): Promise<string> {
    const r = await this.script(`set -e\n${command}`, { timeoutMs, tailBytes: 1024 * 1024, env: { GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" }, ...(signal ? { signal } : {}) });
    if (r.exitCode !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().slice(-1500);
      throw new Error(`${what} failed on remote machine ${this.remoteId} (exit ${r.exitCode}${r.timedOut ? ", timeout" : ""}): ${tail}`);
    }
    return r.stdout;
  }

  // ---- files ----

  async putFile(localPath: string, remotePath: string, mode?: number): Promise<{ bytes: number; sha256: string }> {
    if (this.lost) throw new RemoteHostLostError(`remote machine ${this.remoteId} left: ${this.lost}`);
    try {
      return await this.client.call("benchProvider.putFile", { hostId: this.remoteId, localPath, remotePath, ...(mode !== undefined ? { mode } : {}) });
    } catch (e) {
      this.wrap(e);
    }
  }

  // ---- joining (the fleet calls these once per machine) ----

  /** The remote user's home, and the plugin's directories. */
  async init(): Promise<string> {
    const out = await this.must(`printf '%s' "$HOME"; mkdir -p "$HOME/${REMOTE_ROOT}/incoming" "$HOME/${REMOTE_ROOT}/checkouts" "$HOME/${REMOTE_ROOT}/seed"`, "init");
    const home = out.trim();
    if (!home.startsWith("/")) throw new Error(`remote machine ${this.remoteId}: $HOME is not an absolute path (${JSON.stringify(home.slice(0, 200))})`);
    this.home = home;
    return home;
  }

  /** Upload and unpack the seed (a tarball) into `seed/<sha256>`; skipped when it is there already. Returns the directory. */
  async installSeed(localPath: string, sha256: string, signal?: AbortSignal): Promise<{ dir: string; uploaded: boolean; bytes: number }> {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("seed sha256 must be 64 hex characters");
    const dir = `${this.root}/seed/${sha256}`;
    const have = await this.must(`if [ -f ${q(`${dir}/.autoresearch-seed-ok`)} ]; then echo yes; else echo no; fi`, "seed check", 60_000, signal);
    if (have.trim() === "yes") return { dir, uploaded: false, bytes: 0 };
    const remote = `${this.root}/incoming/seed-${sha256}.tar`;
    const put = await this.putFile(localPath, remote);
    if (put.sha256 !== sha256) throw new Error(`seed upload to ${this.remoteId} is corrupt (sha256 ${put.sha256.slice(0, 12)} != ${sha256.slice(0, 12)})`);
    await this.must(
      [`d=${q(dir)}`, `rm -rf "$d.tmp"`, `mkdir -p "$d.tmp"`, `tar -xf ${q(remote)} -C "$d.tmp"`, `rm -f ${q(remote)}`, `rm -rf "$d"`, `mv "$d.tmp" "$d"`, `touch "$d/.autoresearch-seed-ok"`, `ln -sfn "$d" ${q(`${this.root}/seed/current`)}`].join("\n"),
      "unpacking the seed",
      30 * 60_000,
      signal,
    );
    return { dir, uploaded: true, bytes: put.bytes };
  }

  /**
   * A bare clone holding the study base from a shallow bundle (host/base.ts):
   * the shallow boundary is written first, so the fetch accepts a commit whose
   * parents it never receives. The base is pinned under refs/bench/s/.
   */
  async initRepo(localPath: string, sha256: string, baseSha: string, signal?: AbortSignal): Promise<{ bytes: number }> {
    const base = sha(baseSha);
    const remote = `${this.root}/incoming/base-${base}.bundle`;
    const put = await this.putFile(localPath, remote);
    if (put.sha256 !== sha256) throw new Error(`repository upload to ${this.remoteId} is corrupt (sha256 ${put.sha256.slice(0, 12)} != ${sha256.slice(0, 12)})`);
    const r = q(this.repoPath);
    await this.must(
      [
        `for d in ${q(`${this.root}/checkouts`)}/*; do [ -e "$d" ] && rm -rf "$d"; done`,
        `rm -rf ${r}`,
        `mkdir -p ${r}`,
        `git init --bare -q ${r}`,
        `git -C ${r} config gc.auto 0`,
        `printf '%s\\n' ${base} > ${r}/shallow`,
        `git -C ${r} fetch -q --no-tags --no-write-fetch-head ${q(remote)} '+${BASE_REF}/${base}:refs/bench/s/${base}'`,
        `git -C ${r} cat-file -e ${base}^{commit}`,
        `rm -f ${q(remote)}`,
      ].join("\n"),
      "unpacking the repository",
      30 * 60_000,
      signal,
    );
    return { bytes: put.bytes };
  }

  async info(): Promise<InfoOutput> {
    try {
      return await this.client.call("benchProvider.info", { hostId: this.remoteId });
    } catch (e) {
      this.wrap(e);
    }
  }

  // ---- the bench clone (HostRunner) ----

  async benchRepo(_key: string): Promise<{ path: string; tips: string[] }> {
    const r = q(this.repoPath);
    const out = await this.must(`[ -f ${r}/HEAD ] || { mkdir -p ${r}; git init --bare -q ${r}; git -C ${r} config gc.auto 0; }\ngit -C ${r} for-each-ref --sort=-committerdate --format='%(objectname)' refs/bench/`, "listing the bench clone");
    return { path: this.repoPath, tips: [...new Set(out.split("\n").map((l) => l.trim()).filter((l) => SHA.test(l)))].slice(0, 4096) };
  }

  async removeBenchRepo(_key: string): Promise<boolean> {
    await this.must(`rm -rf ${q(this.root)}`, "removing the bench clone");
    return true;
  }

  async hasCommits(repoPath: string, shas: string[]): Promise<string[]> {
    if (!shas.length) return [];
    shas.forEach(sha);
    const out = await this.must(`printf '%s\\n' ${shas.map((s) => `${s}^{commit}`).join(" ")} | git -C ${q(repoPath)} cat-file --batch-check='%(objectname) %(objecttype)'`, "checking commits");
    const lines = out.split("\n");
    return shas.filter((_, i) => (lines[i] ?? "").endsWith(" commit"));
  }

  async checkout(repoPath: string, key: string, at: string): Promise<string> {
    if (!KEY.test(key)) throw new Error(`bad checkout key ${key}`);
    const d = `${this.root}/checkouts/${key}`;
    const s = sha(at);
    // A reused worktree: check the commit out in place and drop untracked files (ignored build outputs stay).
    await this.must(
      [
        `d=${q(d)}`,
        `if [ -e "$d/.git" ]; then git -C "$d" checkout --detach --force -q ${s}; git -C "$d" clean -fdq;`,
        `else rm -rf "$d"; mkdir -p ${q(`${this.root}/checkouts`)}; git -C ${q(repoPath)} worktree prune; git -C ${q(repoPath)} worktree add -q --detach -f "$d" ${s}; fi`,
      ].join("\n"),
      `checking out ${s.slice(0, 10)}`,
    );
    return d;
  }

  async removeCheckouts(repoPath: string, keyPrefix: string): Promise<number> {
    if (!KEY.test(keyPrefix)) throw new Error(`bad checkout prefix ${keyPrefix}`);
    const out = await this.must(
      [`n=0`, `for d in ${q(`${this.root}/checkouts/${keyPrefix}`)}*; do [ -e "$d" ] || continue; git -C ${q(repoPath)} worktree remove --force "$d" 2>/dev/null || true; rm -rf "$d"; n=$((n+1)); done`, `git -C ${q(repoPath)} worktree prune 2>/dev/null || true`, `echo $n`].join("\n"),
      "removing checkouts",
    );
    return Number(out.trim().split("\n").pop()) || 0;
  }

  // ---- bundles: staged locally, uploaded with putFile, fetched on the machine ----

  private staged(id: string): string {
    if (!/^[a-f0-9]{16,64}$/u.test(id)) throw new Error(`bad bundle id ${id}`);
    mkdirSync(this.opts.stagingDir, { recursive: true });
    return join(this.opts.stagingDir, `${this.hostId}-${id}.bundle`);
  }

  async bundleWrite(id: string, offset: number, data: string): Promise<number> {
    const file = this.staged(id);
    const have = existsSync(file) ? statSync(file).size : 0;
    if (offset === 0 && have > 0) rmSync(file, { force: true });
    else if (offset !== have) throw new Error(`bundle ${id}: chunk at ${offset} but ${have} bytes staged (out of order)`);
    appendFileSync(file, Buffer.from(data, "base64"));
    return statSync(file).size;
  }

  async bundleApply(input: { repoPath: string; id: string; sha: string; ref: string; sha256: string }): Promise<{ ok: boolean; detail: string }> {
    const file = this.staged(input.id);
    if (!existsSync(file)) return { ok: false, detail: `bundle ${input.id} was never staged` };
    const got = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (got !== input.sha256) return { ok: false, detail: `bundle ${input.id} is corrupt (sha256 ${got.slice(0, 12)} != ${input.sha256.slice(0, 12)})` };
    if (!/^refs\/bench\/s\/[0-9a-f]{7,64}$/u.test(input.ref)) return { ok: false, detail: `unexpected ref ${input.ref}` };
    const remote = `${this.root}/incoming/${input.id}.bundle`;
    try {
      const put = await this.putFile(file, remote);
      if (put.sha256 !== input.sha256) return { ok: false, detail: `bundle ${input.id} arrived corrupt (sha256 ${put.sha256.slice(0, 12)})` };
      const r = q(input.repoPath);
      const s = sha(input.sha);
      const res = await this.script(
        [`git -C ${r} fetch -q --no-tags --no-write-fetch-head ${q(remote)} '+${BUNDLE_REF}/${input.id}:${input.ref}' && git -C ${r} cat-file -e ${s}^{commit} && git -C ${r} update-ref ${q(input.ref)} ${s}`, `st=$?`, `rm -f ${q(remote)}`, `exit $st`].join("\n"),
        { timeoutMs: 15 * 60_000, tailBytes: 8 * 1024, env: { GIT_LFS_SKIP_SMUDGE: "1" } },
      );
      if (res.exitCode !== 0) return { ok: false, detail: `git fetch from bundle failed: ${`${res.stdout}\n${res.stderr}`.trim().slice(-800)}` };
      return { ok: true, detail: `fetched ${put.bytes} bytes` };
    } finally {
      rmSync(file, { force: true });
    }
  }

  async bundleDiscard(id: string): Promise<void> {
    rmSync(this.staged(id), { force: true });
  }

  // ---- health ----

  async health(): Promise<HealthReport> {
    const out = await this.must(HEALTH_SCRIPT, "health probe", 60_000);
    return parseHealth(out);
  }

  // ---- edit-host operations: never on a remote bench host ----

  private unsupported(op: string): never {
    throw new Error(`${op} runs on the edit host, not on remote bench host ${this.hostId}`);
  }
  async resolveRef(): Promise<string | null> {
    return this.unsupported("resolveRef");
  }
  async updateRef(): Promise<{ ok: boolean; current: string | null }> {
    return this.unsupported("updateRef");
  }
  async deleteRef(): Promise<boolean> {
    return this.unsupported("deleteRef");
  }
  async snapshot(): Promise<SnapshotResult> {
    return this.unsupported("snapshot");
  }
  async prepareCandidate(): Promise<PrepareResult> {
    return this.unsupported("prepareCandidate");
  }
  async rewordCommit(_r: string, _s: string, _m: string, _i?: GitIdentity): Promise<string> {
    return this.unsupported("rewordCommit");
  }
  async gitIdentity(): Promise<{ name: string | null; email: string | null }> {
    return this.unsupported("gitIdentity");
  }
  async protectedHash(): Promise<{ hash: string; files: number }> {
    return this.unsupported("protectedHash");
  }
  async diffSummary(): Promise<DiffSummary> {
    return this.unsupported("diffSummary");
  }
  async bundleCreate(): Promise<BundleInfo> {
    return this.unsupported("bundleCreate");
  }
  async bundleRead(): Promise<{ data: string; eof: boolean }> {
    return this.unsupported("bundleRead");
  }
  async commitLog(): Promise<CommitInfo[]> {
    return this.unsupported("commitLog");
  }
  async composeCommits(): Promise<ComposeResult> {
    return this.unsupported("composeCommits");
  }
  async gitRemotes(): Promise<Array<{ name: string; url: string }>> {
    return this.unsupported("gitRemotes");
  }
  async writeExport(): Promise<string> {
    return this.unsupported("writeExport");
  }
  async baseBundle(): Promise<BaseBundle> {
    return this.unsupported("baseBundle");
  }
  async seedPack(): Promise<SeedPack> {
    return this.unsupported("seedPack");
  }
}

/**
 * Prints `key=value` lines: what the machine says about its load. Portable
 * across Linux (procfs, cgroups) and other Unixes (sysctl, ps); what it can't
 * read it leaves out. Inside a container, the load average usually counts the
 * whole physical host, and so does the visible CPU count.
 */
const HEALTH_SCRIPT = String.raw`
h=$(hostname 2>/dev/null || echo remote); echo "hostname=$h"
echo "platform=$(uname -s 2>/dev/null | tr 'A-Z' 'a-z')"
echo "arch=$(uname -m 2>/dev/null)"
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)"
if [ -r /proc/loadavg ]; then echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"; else echo "load=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"; fi
if [ -r /proc/meminfo ]; then
  echo "memtotal_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"; echo "memfree_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
else
  echo "memtotal_kb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 ))"
fi
g=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor; [ -r $g ] && echo "governor=$(cat $g)"
[ -r /sys/devices/system/cpu/intel_pstate/no_turbo ] && echo "no_turbo=$(cat /sys/devices/system/cpu/intel_pstate/no_turbo)"
[ -r /sys/devices/system/cpu/cpufreq/boost ] && echo "boost=$(cat /sys/devices/system/cpu/cpufreq/boost)"
[ -r /sys/fs/cgroup/cpu.max ] && echo "cpu_max=$(cat /sys/fs/cgroup/cpu.max)"
ps -Ao pid=,pcpu=,comm= 2>/dev/null | awk -v self=$$ '$1 != self && $3 !~ /(^|\/)(ps|awk|sort|head)$/' | sort -k2 -nr | head -n 8 | sed 's/^/proc=/'
`;

export function parseHealth(out: string): HealthReport {
  const kv = new Map<string, string>();
  const procs: HealthReport["topProcesses"] = [];
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === "proc") {
      const m = /^(\d+)\s+([\d.]+)\s+(.+)$/u.exec(v);
      if (m && procs.length < 20) procs.push({ pid: Number(m[1]), cpu: Number(m[2]), command: (m[3] ?? "").split("/").pop()!.slice(0, 80) });
    } else kv.set(k, v);
  }
  const load = (kv.get("load") ?? "").split(/\s+/u).map(Number).filter((n) => Number.isFinite(n));
  const total = Number(kv.get("memtotal_kb") ?? 0) / 1024;
  const free = Number(kv.get("memfree_kb") ?? 0) / 1024;
  const noTurbo = kv.get("no_turbo");
  const boost = kv.get("boost");
  const turbo = noTurbo !== undefined ? noTurbo === "0" : boost !== undefined ? boost === "1" : null;
  const notDetectable = [kv.has("governor") ? null : "CPU governor", turbo === null ? "turbo" : null, "power source"].filter((x): x is string => x !== null);
  return {
    hostname: (kv.get("hostname") ?? "remote").slice(0, 200),
    platform: kv.get("platform") || "unknown",
    arch: kv.get("arch") || "unknown",
    cpus: Math.max(0, Math.round(Number(kv.get("cpus") ?? 0)) || 0),
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    freeMemMb: Number.isFinite(free) ? free : 0,
    totalMemMb: Number.isFinite(total) ? total : 0,
    topProcesses: procs,
    governor: kv.get("governor") ?? null,
    turbo,
    onAcPower: null,
    cpuSpeedLimit: null,
    notDetectable,
    at: Date.now(),
  };
}
