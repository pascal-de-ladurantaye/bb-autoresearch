import Database from "better-sqlite3";
import { HostMutex, type Ctx } from "../src/context.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import { Store } from "../src/db/store.ts";
import type { DiffSummary, ExecInput, ExecResult, PrepareInput, PrepareResult, SnapshotInput, SnapshotResult } from "../src/host/contract.ts";
import type { HostRunner } from "../src/host/runner.ts";
import type { BbPort, EnvironmentInfo, SpawnWorkerArgs, ThreadInfo } from "../src/ports.ts";
import { seededRng } from "../src/stats.ts";

export function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
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

/** In-memory host: commits are {tree, parent}; a commit's "tree" is an opaque content id. */
export class FakeHost implements HostRunner {
  readonly hostId = "host_test";
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
  noise: () => number = () => 0;
  gateFailures = new Map<string, number>(); // tree -> how many times the gate fails
  conflicts = new Set<string>();
  worktreeHead = new Map<string, string>();
  failNext: { method: string; error: string } | null = null;
  /** Real-time delay per exec kind, to make concurrency observable. */
  delays: { gate: number; measure: number } = { gate: 0, measure: 0 };
  active = { gate: 0, measure: 0 };
  maxActive = { gate: 0, measure: 0 };
  /** Called before every measure run (tests mutate state mid-measurement). */
  onMeasure: ((cwd: string) => void | Promise<void>) | null = null;

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
  async exec(input: ExecInput): Promise<ExecResult> {
    this.maybeFail("exec");
    if (input.command.startsWith("gate")) return await this.timed("gate", () => this.execNow(input));
    if (input.command.startsWith("measure")) {
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
      return { exitCode: 0, timedOut: false, durationMs: 1000, stdout: `METRIC size=${v * (1 + this.noise())}\nMETRIC rss=100\nDIAG tree=${tree}\n`, stderr: "" };
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
  async snapshot(input: SnapshotInput): Promise<SnapshotResult> {
    this.maybeFail("snapshot");
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
    if (this.conflicts.has(input.candidateSha)) return { status: "conflict", paths: ["src/a.ts"], detail: "CONFLICT" };
    const tree = this.treeOf(input.candidateSha);
    const sha = this.commit(tree, input.bestSha, input.message);
    return { status: "ok", sha, tree };
  }
  async rewordCommit(_repo: string, sha: string, message: string) {
    this.maybeFail("rewordCommit");
    const c = this.commits.get(sha)!;
    return this.commit(c.tree, c.parent, message);
  }
  async checkout(_repo: string, key: string, sha: string) {
    this.maybeFail("checkout");
    const path = `/co/${key}`;
    this.checkouts.set(path, sha);
    return path;
  }
  async diffSummary(_repo: string, from: string, to: string, _max: number): Promise<DiffSummary> {
    this.maybeFail("diffSummary");
    return { files: [{ path: "src/a.ts", added: 3, deleted: 1 }], patch: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-${from.slice(0, 6)}\n+${to.slice(0, 6)}\n`, truncated: false };
  }
  async removeCheckouts(_repo: string, prefix: string) {
    let n = 0;
    for (const k of [...this.checkouts.keys()]) if (k.startsWith(`/co/${prefix}`)) {
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
  sent: Array<{ threadId: string; text: string }> = [];
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
  constructor(
    readonly host: HostRunner,
    readonly hostId = "host_test",
  ) {}
  async primaryHostId() {
    return this.hostId;
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
  async send(threadId: string, text: string) {
    this.sent.push({ threadId, text });
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
  async retryTurn() {}
  hostRunner() {
    return this.host;
  }
  log(level: string, message: string) {
    this.logs.push(`${level}: ${message}`);
  }
  publish() {}
}

export function makeCtx(host: HostRunner = new FakeHost(), clock = new Clock()): { ctx: Ctx; store: Store; port: FakePort; clock: Clock } {
  const store = new Store(makeDb(), clock.now);
  const port = new FakePort(host);
  const ctx: Ctx = { store, bb: port, now: clock.now, rng: seededRng(42), benchLock: new HostMutex(), config: { workerCeiling: 64, tickMs: 1000, retryDelayMs: 0, finishingTimeoutMs: 3 * 60_000 } };
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
