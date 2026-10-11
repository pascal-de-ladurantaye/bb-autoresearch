import Database from "better-sqlite3";
import { HostMutex, type Ctx } from "../src/context.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import { Store } from "../src/db/store.ts";
import { createHash, randomBytes } from "node:crypto";
import type { BundleInfo, DiffSummary, ExecInput, ExecResult, HealthReport, JobInput, PrepareInput, PrepareResult, SnapshotInput, SnapshotResult } from "../src/host/contract.ts";
import { HostJobLostError, LocalHostRunner, RunAbortedError, type HostRunner, type RunOptions } from "../src/host/runner.ts";
import type { BbPort, EnvironmentInfo, HostInfo, ProviderUsage, SpawnWorkerArgs, ThreadActivityItem, ThreadInfo } from "../src/ports.ts";
import { seededRng } from "../src/stats.ts";

export function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

/** Poll `cond` until it holds (real time). Generous by default so a loaded machine never flakes. */
export async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 5): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}

export class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

let shaCounter = 0x1000;
export function fakeSha(): string {
  shaCounter += 1;
  return shaCounter.toString(16).padStart(12, "a");
}

export function healthyReport(over: Partial<HealthReport> = {}): HealthReport {
  return {
    hostname: "fake",
    platform: "linux",
    arch: "x64",
    cpus: 8,
    loadavg: [0.2, 0.2, 0.2],
    freeMemMb: 8000,
    totalMemMb: 16000,
    topProcesses: [{ pid: 10, cpu: 3, command: "sshd" }],
    governor: "performance",
    turbo: false,
    onAcPower: null,
    cpuSpeedLimit: null,
    notDetectable: ["power source"],
    at: 0,
    ...over,
  };
}

/**
 * A real in-process host (real git, real jobs) whose health probe returns
 * fixed healthy readings: tests must never depend on the load of the machine
 * running them (other vitest workers, a busy laptop). `probes` counts calls.
 */
export function localRunner(dataDir: string, hostId = "host_test", opts: { progressMs?: number; pollMs?: number; report?: () => HealthReport } = {}): LocalHostRunner & { probes: number } {
  const holder = { probes: 0 };
  const runner = new LocalHostRunner(dataDir, hostId, {
    ...(opts.progressMs !== undefined ? { progressMs: opts.progressMs } : {}),
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    health: async () => {
      holder.probes += 1;
      return { ...(opts.report ? opts.report() : healthyReport()), at: Date.now() };
    },
  });
  return Object.defineProperty(runner, "probes", { get: () => holder.probes }) as LocalHostRunner & { probes: number };
}

/**
 * In-memory host: commits are {tree, parent}; a commit's "tree" is an opaque
 * content id. A bench FakeHost built with `shareWith` sees the edit host's
 * commits/metrics (the "same code") but its bench clone only holds commits
 * that arrived by bundle.
 */
export class FakeHost implements HostRunner {
  readonly hostId: string;
  refs = new Map<string, string>();
  commits = new Map<string, { tree: string; parent: string | null; message: string }>();
  checkouts = new Map<string, string>();
  calls: string[] = [];
  /** Changed paths reported by the next snapshot of a worktree. */
  nextSnapshot: Partial<SnapshotResult> & { tree?: string } = {};
  /** Per-worktree override of nextSnapshot (concurrent submissions). */
  nextSnapshotFor = new Map<string, Partial<SnapshotResult> & { tree?: string }>();
  /** Metric value by tree id. */
  metric = new Map<string, number>();
  /** Milliseconds a measure run reports, by tree (default 5000: one side run under side_runs = "auto"). */
  runMs = new Map<string, number>();
  /** Guardrail metric rss by tree id (default 100). */
  rss = new Map<string, number>();
  noise: () => number = () => 0;
  /** Relative noise on the rss guardrail of every run. */
  rssNoise: () => number = () => 0;
  gateFailures = new Map<string, number>(); // tree -> how many times the gate fails
  conflicts = new Set<string>();
  worktreeHead = new Map<string, string>();
  failNext: { method: string; error: string } | null = null;
  /** Real-time delay per exec kind, to make concurrency observable. */
  delays: { gate: number; measure: number } = { gate: 0, measure: 0 };
  active = { gate: 0, measure: 0 };
  maxActive = { gate: 0, measure: 0 };
  /** Most gate and measure commands running at once, together (single-machine mode: 1). */
  maxActiveAll = 0;
  /** Start order of gate and measure commands, with the cwd ("gate:/co/x" or "measure:/co/y"). */
  started: string[] = [];
  /** Called before every measure run (tests mutate state mid-measurement). */
  onMeasure: ((cwd: string) => void | Promise<void>) | null = null;
  /** Health report returned by health(). */
  healthReport: HealthReport = healthyReport();
  healthCalls = 0;
  /** Commits in this host's bench clone (clone mode), and the refs pinning them. */
  present = new Set<string>();
  benchRefs = new Map<string, string>();
  /** Bundle files on this host (sender: payload; receiver: received base64). */
  bundles = new Map<string, string>();
  received = new Map<string, string>();
  bundlesCreated: Array<{ tip: string; bytes: number; commits: number }> = [];
  /** Pretend bundles are this many bytes (size-limit tests). */
  bundleSizeOverride: number | null = null;
  /** The next run() loses its job (host worker restart). */
  loseNextJob = false;
  /** Runs of the build command, by cwd. */
  builds: string[] = [];
  /** Commands seen by run()/exec (holdout secrecy checks look at these). */
  commands: string[] = [];
  /** Extra metric value for the holdout command, by tree. */
  holdoutMetric = new Map<string, number>();

  constructor(hostId = "host_test", shareWith?: FakeHost) {
    this.hostId = hostId;
    if (shareWith) {
      this.commits = shareWith.commits;
      this.metric = shareWith.metric;
      this.holdoutMetric = shareWith.holdoutMetric;
      this.rss = shareWith.rss;
      this.runMs = shareWith.runMs;
    }
  }
  private isBenchRepo(repo: string): boolean {
    return repo.startsWith("/bench/");
  }
  private coPath(key: string): string {
    return this.hostId === "host_test" ? `/co/${key}` : `/co/${this.hostId}/${key}`;
  }

  commit(tree: string, parent: string | null, message = "c"): string {
    const sha = fakeSha();
    this.commits.set(sha, { tree, parent, message });
    return sha;
  }
  treeOf(sha: string): string {
    return this.commits.get(sha)?.tree ?? sha;
  }
  private maybeFail(method: string) {
    this.calls.push(method);
    if (this.failNext?.method === method) {
      const e = this.failNext.error;
      this.failNext = null;
      throw new Error(e);
    }
  }
  private async timed<T>(kind: "gate" | "measure", fn: () => T | Promise<T>): Promise<T> {
    this.active[kind] += 1;
    this.maxActive[kind] = Math.max(this.maxActive[kind], this.active[kind]);
    this.maxActiveAll = Math.max(this.maxActiveAll, this.active.gate + this.active.measure);
    try {
      if (this.delays[kind] > 0) await new Promise((r) => setTimeout(r, this.delays[kind]));
      return await fn();
    } finally {
      this.active[kind] -= 1;
    }
  }
  isAncestor(ancestor: string, sha: string): boolean {
    let cur: string | null = sha;
    while (cur) {
      if (cur === ancestor) return true;
      cur = this.commits.get(cur)?.parent ?? null;
    }
    return false;
  }
  async run(input: JobInput, opts: RunOptions = {}): Promise<ExecResult> {
    if (opts.signal?.aborted) throw new RunAbortedError();
    if (this.loseNextJob) {
      this.loseNextJob = false;
      throw new HostJobLostError("host lost job (worker restarted)");
    }
    if (!opts.signal) return await this.exec({ cwd: input.cwd, command: input.command, timeoutMs: Math.min(input.timeoutMs, 29 * 60_000) });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new RunAbortedError());
      opts.signal!.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      const run = this.exec({ cwd: input.cwd, command: input.command, timeoutMs: Math.min(input.timeoutMs, 29 * 60_000) });
      return await Promise.race([run, aborted]);
    } finally {
      if (onAbort) opts.signal.removeEventListener("abort", onAbort);
    }
  }
  async health(): Promise<HealthReport> {
    this.healthCalls += 1;
    return { ...this.healthReport, at: Date.now() };
  }
  async benchRepo(key: string) {
    this.calls.push("benchRepo");
    return { path: `/bench/${this.hostId}/${key}`, tips: [...new Set(this.benchRefs.values())] };
  }
  async removeBenchRepo(_key: string) {
    const had = this.present.size > 0;
    this.present.clear();
    this.benchRefs.clear();
    return had;
  }
  async hasCommits(repo: string, shas: string[]) {
    if (this.isBenchRepo(repo)) return shas.filter((s) => this.present.has(s));
    return shas.filter((s) => this.commits.has(s));
  }
  async bundleCreate(_repo: string, tip: string, basis: string[]): Promise<BundleInfo> {
    this.calls.push("bundleCreate");
    const id = randomBytes(8).toString("hex");
    const stop = new Set<string>();
    for (const b of basis) {
      let cur: string | null = b;
      while (cur && !stop.has(cur)) {
        stop.add(cur);
        cur = this.commits.get(cur)?.parent ?? null;
      }
    }
    const chain: string[] = [];
    let cur: string | null = tip;
    while (cur && !stop.has(cur)) {
      chain.push(cur);
      cur = this.commits.get(cur)?.parent ?? null;
    }
    if (!chain.length) return { id, bytes: 0, sha256: "", empty: true };
    const data = Buffer.from(JSON.stringify({ commits: chain })).toString("base64");
    this.bundles.set(id, data);
    const bytes = this.bundleSizeOverride ?? Buffer.byteLength(data, "base64");
    this.bundlesCreated.push({ tip, bytes, commits: chain.length });
    return { id, bytes, sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"), empty: false };
  }
  async bundleRead(id: string, offset: number, length: number) {
    const raw = Buffer.from(this.bundles.get(id) ?? "", "base64");
    const part = raw.subarray(offset, offset + length);
    return { data: part.toString("base64"), eof: offset + part.length >= raw.length };
  }
  async bundleWrite(id: string, offset: number, data: string) {
    const have = Buffer.from(this.received.get(id) ?? "", "base64");
    if (offset !== have.length) throw new Error("out of order");
    const next = Buffer.concat([have, Buffer.from(data, "base64")]);
    this.received.set(id, next.toString("base64"));
    return next.length;
  }
  async bundleApply(input: { repoPath: string; id: string; sha: string; ref: string; sha256: string }) {
    this.calls.push("bundleApply");
    const raw = Buffer.from(this.received.get(input.id) ?? "", "base64");
    this.received.delete(input.id);
    if (createHash("sha256").update(raw).digest("hex") !== input.sha256) return { ok: false, detail: "corrupt" };
    for (const c of (JSON.parse(raw.toString("utf8")) as { commits: string[] }).commits) this.present.add(c);
    this.benchRefs.set(input.ref, input.sha);
    return { ok: true, detail: "ok" };
  }
  async bundleDiscard(id: string) {
    this.bundles.delete(id);
    this.received.delete(id);
  }
  async exec(input: ExecInput): Promise<ExecResult> {
    this.maybeFail("exec");
    this.commands.push(input.command);
    if (input.command.startsWith("gate")) {
      this.started.push(`gate:${input.cwd}`);
      return await this.timed("gate", () => this.execNow(input));
    }
    if (input.command.startsWith("measure")) {
      this.started.push(`measure:${input.cwd}`);
      return await this.timed("measure", async () => {
        if (this.onMeasure) await this.onMeasure(input.cwd);
        return this.execNow(input);
      });
    }
    return this.execNow(input);
  }
  private execNow(input: ExecInput): ExecResult {
    const sha = this.checkouts.get(input.cwd);
    const tree = sha ? this.treeOf(sha) : "";
    if (input.command.startsWith("git ls-tree")) return { exitCode: 0, timedOut: false, durationMs: 1, stdout: "100644 blob abc\tbench/run.sh\n", stderr: "" };
    if (input.command.startsWith("gate")) {
      const left = this.gateFailures.get(tree) ?? 0;
      if (left > 0) {
        this.gateFailures.set(tree, left - 1);
        return { exitCode: 1, timedOut: false, durationMs: 5, stdout: "FAIL test_x", stderr: "assertion failed" };
      }
      return { exitCode: 0, timedOut: false, durationMs: 5, stdout: "ok", stderr: "" };
    }
    if (input.command.startsWith("measure")) {
      const v = this.metric.get(tree);
      if (v === undefined) return { exitCode: 2, timedOut: false, durationMs: 5, stdout: "", stderr: "no such tree" };
      const rss = (this.rss.get(tree) ?? 100) * (1 + this.rssNoise());
      return { exitCode: 0, timedOut: false, durationMs: this.runMs.get(tree) ?? 5000, stdout: `METRIC size=${v * (1 + this.noise())}\nMETRIC rss=${rss}\nDIAG tree=${tree}\n`, stderr: "" };
    }
    if (input.command.startsWith("holdout")) {
      const v = this.holdoutMetric.get(tree) ?? this.metric.get(tree);
      if (v === undefined) return { exitCode: 3, timedOut: false, durationMs: 5, stdout: "", stderr: "holdout: no such tree" };
      return { exitCode: 0, timedOut: false, durationMs: 1000, stdout: `METRIC size=${v}\nDIAG holdout-secret-input=/srv/holdout\n`, stderr: "" };
    }
    if (input.command.startsWith("build")) {
      this.builds.push(input.cwd);
      return { exitCode: 0, timedOut: false, durationMs: 5, stdout: "built", stderr: "" };
    }
    return { exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "" };
  }
  async resolveRef(_repo: string, ref: string) {
    this.maybeFail("resolveRef");
    return this.refs.get(ref) ?? null;
  }
  async updateRef(_repo: string, ref: string, newSha: string, oldSha: string | null) {
    this.maybeFail("updateRef");
    const cur = this.refs.get(ref) ?? null;
    if (cur !== oldSha) return { ok: false, current: cur };
    this.refs.set(ref, newSha);
    return { ok: true, current: newSha };
  }
  async deleteRef(_repo: string, ref: string) {
    this.maybeFail("deleteRef");
    return this.refs.delete(ref);
  }
  /** The identity git resolves in the repo on this host (nulls: none configured). */
  repoIdentity: { name: string | null; email: string | null } = { name: "Repo Owner", email: "owner@example.com" };
  gitIdentityCalls = 0;
  /** Protected-content hash per baseline tree (default: a fixed value with one file). */
  protectedHashes = new Map<string, { hash: string; files: number }>();
  async protectedHash(_repo: string, sha: string, globs: readonly string[]) {
    if (!globs.length) return { hash: "", files: 0 };
    return this.protectedHashes.get(this.treeOf(sha)) ?? { hash: "fakeprotected", files: 1 };
  }
  async gitIdentity(_repo: string) {
    this.gitIdentityCalls += 1;
    return { ...this.repoIdentity };
  }
  /** The identity every commit-making call was given (op name, then "name <email>" or "default"). */
  commitIdentities: Array<{ op: string; identity: string }> = [];
  private noteIdentity(op: string, identity: { name: string; email: string } | undefined) {
    this.commitIdentities.push({ op, identity: identity ? `${identity.name} <${identity.email}>` : "default" });
  }
  /** Every snapshot call's input. */
  snapshotInputs: SnapshotInput[] = [];
  async snapshot(input: SnapshotInput): Promise<SnapshotResult> {
    this.maybeFail("snapshot");
    this.snapshotInputs.push(input);
    this.noteIdentity("snapshot", input.identity);
    const next = this.nextSnapshotFor.get(input.worktreePath) ?? this.nextSnapshot;
    this.nextSnapshotFor.delete(input.worktreePath);
    const tree = next.tree ?? fakeSha();
    const parent = this.worktreeHead.get(input.worktreePath) ?? input.baseSha;
    const sha = this.commit(tree, parent, input.message);
    this.worktreeHead.set(input.worktreePath, sha);
    this.refs.set(input.candidateRef, sha);
    const forkSha = input.bestSha && this.isAncestor(input.bestSha, sha) ? input.bestSha : input.baseSha;
    const r = { sha, forkSha, committed: true, changedPaths: ["src/a.ts"], linesAdded: 3, linesDeleted: 1, ...next };
    delete (r as { tree?: string }).tree;
    if (next === this.nextSnapshot) this.nextSnapshot = {};
    return r;
  }
  async prepareCandidate(input: PrepareInput): Promise<PrepareResult> {
    this.maybeFail("prepareCandidate");
    this.noteIdentity("prepareCandidate", input.identity);
    if (this.conflicts.has(input.candidateSha)) return { status: "conflict", paths: ["src/a.ts"], detail: "CONFLICT" };
    const tree = this.treeOf(input.candidateSha);
    const sha = this.commit(tree, input.bestSha, input.message);
    return { status: "ok", sha, tree };
  }
  async rewordCommit(_repo: string, sha: string, message: string, identity?: { name: string; email: string }) {
    this.maybeFail("rewordCommit");
    this.noteIdentity("rewordCommit", identity);
    const c = this.commits.get(sha)!;
    return this.commit(c.tree, c.parent, message);
  }
  async checkout(repo: string, key: string, sha: string) {
    this.maybeFail("checkout");
    if (this.isBenchRepo(repo) && !this.present.has(sha)) throw new Error(`checkout ${sha}: commit not in the bench clone ${repo} (it was never sent)`);
    const path = this.coPath(key);
    this.checkouts.set(path, sha);
    return path;
  }
  async diffSummary(_repo: string, from: string, to: string, _max: number): Promise<DiffSummary> {
    this.maybeFail("diffSummary");
    return { files: [{ path: "src/a.ts", added: 3, deleted: 1 }], patch: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-${from.slice(0, 6)}\n+${to.slice(0, 6)}\n`, truncated: false };
  }
  async commitLog(): Promise<never> {
    throw new Error("FakeHost: commitLog is real-git only (see harvest tests)");
  }
  async composeCommits(): Promise<never> {
    throw new Error("FakeHost: composeCommits is real-git only (see harvest tests)");
  }
  remotes: Array<{ name: string; url: string }> = [];
  async gitRemotes() {
    return this.remotes;
  }
  exports = new Map<string, Array<{ path: string; content: string }>>();
  async writeExport(key: string, files: Array<{ path: string; content: string }>) {
    this.exports.set(key, files);
    return `/exports/${key}`;
  }
  /** Remote bench: base bundles and seeds the edit host built (fake files). */
  baseBundles: string[] = [];
  async baseBundle(_repo: string, sha: string) {
    this.baseBundles.push(sha);
    return { path: `/fake/bundles/base-${sha}.bundle`, sha256: "0".repeat(64), bytes: 1000, cached: this.baseBundles.filter((x) => x === sha).length > 1 };
  }
  seedPacks: Array<{ source: string; cwd: string; allow: string[] }> = [];
  async seedPack(input: { source: string; cwd: string; allow: string[] }) {
    this.seedPacks.push(input);
    return { ok: true as const, path: "/fake/seeds/seed.tar.gz", sha256: "1".repeat(64), fileSha256: "1".repeat(64), bytes: 2000, files: 3, kind: "dir" as const, cached: false, allowed: [] };
  }
  async removeCheckouts(_repo: string, prefix: string) {
    let n = 0;
    for (const k of [...this.checkouts.keys()]) if (k.startsWith(this.coPath(prefix))) {
      this.checkouts.delete(k);
      n += 1;
    }
    return n;
  }
}

export interface FakeThread extends ThreadInfo {
  metadata: Record<string, unknown>;
}

export class FakePort implements BbPort {
  threads = new Map<string, FakeThread>();
  envs = new Map<string, EnvironmentInfo>();
  /** Sent messages; `text` is the whole message, `summary` the human-visible part, `agentOnly` the agent-only block. */
  sent: Array<{ threadId: string; text: string; summary: string; agentOnly: string | null }> = [];
  steered: Array<{ threadId: string; text: string }> = [];
  unread: string[] = [];
  spawned: SpawnWorkerArgs[] = [];
  stopped: string[] = [];
  released: string[] = [];
  logs: string[] = [];
  spawnError: string | null = null;
  /** Like core when the worktree is still provisioning: spawn returns no environment id. */
  spawnWithoutEnvironment = false;
  private n = 0;
  /** Other machines (bench hosts) by id; the edit host is `host`. */
  hosts = new Map<string, HostRunner>();
  hostNames = new Map<string, string>();
  hostStatuses = new Map<string, "connected" | "disconnected">();
  constructor(
    readonly host: HostRunner,
    readonly hostId = "host_test",
  ) {}
  /** Enroll a fake machine. */
  addHost(runner: HostRunner, name: string) {
    this.hosts.set(runner.hostId, runner);
    this.hostNames.set(runner.hostId, name);
  }
  /** Other plugins' rpc handlers by plugin id (bench providers), called like bb.sdk.plugins.callRpc. */
  plugins = new Map<string, (method: string, input: unknown) => Promise<unknown>>();
  async callPlugin(pluginId: string, method: string, input: unknown, outputSchema: import("zod").ZodType) {
    const p = this.plugins.get(pluginId);
    if (!p) throw new Error(`plugin ${pluginId} is not installed`);
    return outputSchema.parse(await p(method, input));
  }
  async primaryHostId() {
    return this.hostId;
  }
  async listHosts(): Promise<HostInfo[]> {
    return [
      { id: this.hostId, name: "edit-machine", status: this.hostStatuses.get(this.hostId) ?? "connected" },
      ...[...this.hosts.keys()].map((id) => ({ id, name: this.hostNames.get(id) ?? id, status: this.hostStatuses.get(id) ?? ("connected" as const) })),
    ];
  }
  async hostStatus(hostId: string) {
    return this.hostStatuses.get(hostId) ?? "connected";
  }
  async projectCheckout() {
    return "/repo";
  }
  async ensureSection() {
    return "sec_1";
  }
  addThread(id: string, status: ThreadInfo["status"] = "idle", metadata: Record<string, unknown> = {}) {
    this.threads.set(id, { id, status, archivedAt: null, deletedAt: null, environmentId: null, metadata });
  }
  async spawnWorker(args: SpawnWorkerArgs) {
    if (this.spawnError) throw new Error(this.spawnError);
    this.n += 1;
    const id = `thr_w${this.n}`;
    const env = `env_w${this.n}`;
    this.spawned.push(args);
    this.threads.set(id, { id, status: "active", archivedAt: null, deletedAt: null, environmentId: env, metadata: { ...args.metadata } });
    this.envs.set(env, { id: env, hostId: this.hostId, path: `/wt/${id}`, branchName: `bb/${id}` });
    return { threadId: id, environmentId: this.spawnWithoutEnvironment ? null : env };
  }
  async send(threadId: string, text: string | { summary: string; detail: string }) {
    if (typeof text === "string") this.sent.push({ threadId, text, summary: text, agentOnly: null });
    else this.sent.push({ threadId, text: `${text.summary}\n\n${text.detail}`, summary: text.summary, agentOnly: text.detail });
  }
  async steer(threadId: string, text: string) {
    if (this.threads.get(threadId)?.status !== "active") throw new Error("no turn is running");
    this.steered.push({ threadId, text });
  }
  async markUnread(threadId: string) {
    this.unread.push(threadId);
  }
  async getThread(threadId: string) {
    const t = this.threads.get(threadId);
    return t ? { ...t } : null;
  }
  async getEnvironment(id: string) {
    return this.envs.get(id) ?? null;
  }
  async setMetadata(threadId: string, set: Record<string, unknown>) {
    const t = this.threads.get(threadId);
    if (t) Object.assign(t.metadata, set);
  }
  async getMetadata(threadId: string) {
    return this.threads.get(threadId)?.metadata ?? {};
  }
  async findSpawnedThread(token: string) {
    for (const t of this.threads.values()) if (t.metadata.spawnToken === token) return t.id;
    return null;
  }
  async stop(threadId: string) {
    this.stopped.push(threadId);
    const t = this.threads.get(threadId);
    if (t) t.status = "idle";
  }
  async archive(threadId: string) {
    const t = this.threads.get(threadId);
    if (t) t.archivedAt = Date.now();
  }
  async releaseEnvironment(id: string) {
    this.released.push(id);
  }
  retries: Array<{ threadId: string; turnRequestId: string; sendAt: number | null }> = [];
  async retryTurn(threadId: string, turnRequestId: string, sendAt: number | null) {
    this.retries.push({ threadId, turnRequestId, sendAt });
  }
  /** Tokens per thread (thread/tokenUsage/updated); absent = the provider reports none. */
  tokens = new Map<string, number>();
  async threadTokens(threadId: string) {
    return this.tokens.get(threadId) ?? null;
  }
  /** Tool items per thread (item/started), as the live view reads them. */
  activity = new Map<string, ThreadActivityItem[]>();
  activityCalls = 0;
  async threadActivity(threadId: string, afterSeq: number, limit = 100) {
    this.activityCalls += 1;
    if (limit > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    const items = (this.activity.get(threadId) ?? []).filter((i) => i.seq > afterSeq).slice(0, limit);
    return { seq: items.length ? items[items.length - 1]!.seq : afterSeq, items };
  }
  /** Record a tool item on a fake thread (the live view classifies it). */
  addActivity(threadId: string, kind: string, opts: { command?: string; tool?: string; at?: number; paths?: string[] } = {}) {
    const list = this.activity.get(threadId) ?? [];
    list.push({ seq: (list.at(-1)?.seq ?? 0) + 1, at: opts.at ?? Date.now(), kind, command: opts.command ?? null, tool: opts.tool ?? null, paths: opts.paths ?? null });
    this.activity.set(threadId, list);
  }
  usage: ProviderUsage[] = [];
  usageCalls = 0;
  async usageLimits() {
    this.usageCalls += 1;
    return this.usage;
  }
  pluginId() {
    return "bb-autoresearch";
  }
  appUrl() {
    return null;
  }
  hostRunner(hostId?: string) {
    return (hostId && this.hosts.get(hostId)) || this.host;
  }
  log(level: string, message: string) {
    this.logs.push(`${level}: ${message}`);
  }
  /** Realtime signals the plugin published. */
  published: Array<{ channel: string; payload: unknown; at: number }> = [];
  publish(channel: string, payload: unknown) {
    this.published.push({ channel, payload, at: Date.now() });
  }
  /** recheckDispatch calls (quiet bench). */
  rechecks = 0;
  async recheckDispatch() {
    this.rechecks += 1;
  }
}

export function makeCtx(host: HostRunner = new FakeHost(), clock = new Clock()): { ctx: Ctx; store: Store; port: FakePort; clock: Clock } {
  const store = new Store(makeDb(), clock.now);
  const port = new FakePort(host);
  const ctx: Ctx = { store, bb: port, now: clock.now, rng: seededRng(42), benchLock: new HostMutex(), config: { workerCeiling: 64, tickMs: 1000, retryDelayMs: 0, finishingTimeoutMs: 3 * 60_000, hostStatusTtlMs: 0, harvestPollMs: 5, harvestGroupGraceMs: 0, harvestHealthTries: 2, usagePollMs: 0, tokenPollMs: 0, liveDwellMs: 0 } };
  return { ctx, store, port, clock };
}

export const DETERMINISTIC_SPEC = `
[study]
slug = "toy-size"
objective = "Make the toy program's output smaller."
base = "main"

[metric]
name = "size"
unit = "bytes"
direction = "lower"

[[guardrail]]
name = "rss"
max_regression = "5%"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
gate = ["gate.sh"]
measure = "measure.sh"
noise = "deterministic"

[budget]
max_workers = 1
max_candidates = 3

[agents]
max_submissions_per_worker = 2
idle_nudge_minutes = 10
idle_abandon_minutes = 20
`;

/** Rewrite oracle commands so FakeHost recognizes them. */
export function fakeHostSpec(toml = DETERMINISTIC_SPEC): string {
  return toml.replace('gate = ["gate.sh"]', 'gate = ["gate run"]').replace('measure = "measure.sh"', 'measure = "measure run"');
}
