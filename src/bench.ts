// Bench hosts: resolution against BB machines, and the per-host "site" the
// pipeline, calibration, drift checks and profiles measure on.
//
// Two modes:
// - shared ("local" in the spec): plugin checkouts of the project repo on the
//   edit host. No transfer. The M0/M1 path.
// - clone (any BB host id or name, the server's own machine included): the
//   bench host keeps its OWN bare clone under the host entry's data dir
//   (`<dataDir>/bench/<slug>/repo.git`) and commits reach it only as git
//   bundles relayed by the server (transfer.ts). Checkouts are worktrees of
//   that clone, keyed `<slug>-bench-<role>`.
import type { Ctx } from "./context.ts";
import type { BenchHostRow, ResolvedBenchHost, StudyRow } from "./db/store.ts";
import type { ExecResult } from "./host/contract.ts";
import type { HostRunner, RunOptions } from "./host/runner.ts";
import { parseMeasureOutput } from "./metrics.ts";
import { BenchError, type Bench, type RunResult, type Side } from "./noise.ts";
import { clip } from "./prompts.ts";
import type { HostInfo } from "./ports.ts";
import type { StudySpec } from "./spec.ts";
import { ensureCommit, TransferError } from "./transfer.ts";

export type CheckoutRole = "best" | "cand" | "drift" | "profile";

/** Resolve the spec's bench_hosts against BB machines. Empty means ["local"]. */
export function resolveBenchHosts(entries: string[], hosts: HostInfo[], editHostId: string): { ok: true; hosts: ResolvedBenchHost[] } | { ok: false; errors: string[] } {
  const list = entries.length ? entries : ["local"];
  const out: ResolvedBenchHost[] = [];
  const errors: string[] = [];
  for (const entry of list) {
    if (entry === "local") {
      const self = hosts.find((h) => h.id === editHostId);
      out.push({ entry, hostId: editHostId, name: self ? `${self.name} (local)` : "local", mode: "shared" });
      continue;
    }
    const byId = hosts.find((h) => h.id === entry);
    const byName = hosts.filter((h) => h.name.toLowerCase() === entry.toLowerCase());
    const h = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!h) {
      errors.push(
        byName.length > 1
          ? `oracle.bench_hosts: ${JSON.stringify(entry)} matches ${byName.length} machines; use the host id (${byName.map((x) => x.id).join(", ")})`
          : `oracle.bench_hosts: no BB machine named or with id ${JSON.stringify(entry)}. Known: ${hosts.map((x) => `${x.name} (${x.id})`).join(", ") || "none"}`,
      );
      continue;
    }
    out.push({ entry, hostId: h.id, name: h.name, mode: "clone" });
  }
  const ids = out.map((h) => h.hostId);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`oracle.bench_hosts: machine ${dup} is listed twice (e.g. as "local" and by name)`);
  return errors.length ? { ok: false, errors } : { ok: true, hosts: out };
}

export interface BuildResult {
  ok: boolean;
  output: string;
  cached: boolean;
}

/** Where a failed transfer leaves the measurement. */
export class BenchTransferError extends TransferError {
  constructor(
    message: string,
    readonly purpose: "best" | "candidate",
  ) {
    super(message);
    this.name = "BenchTransferError";
  }
}

export class BenchSite {
  constructor(
    private readonly ctx: Ctx,
    readonly study: StudyRow,
    readonly host: BenchHostRow,
    private readonly bestDirs: Map<string, { sha: string; dir: string }>,
  ) {}

  get runner(): HostRunner {
    return this.ctx.bb.hostRunner(this.host.host_id);
  }
  get edit(): HostRunner {
    return this.ctx.bb.hostRunner(this.study.host_id!);
  }
  get remote(): boolean {
    return this.host.mode === "clone";
  }
  /** Checkout key prefix on this host. */
  get prefix(): string {
    return this.remote ? `${this.study.slug}-bench-` : `${this.study.slug}-`;
  }
  private get cacheKey(): string {
    return `${this.study.id}:${this.host.host_id}`;
  }

  /** The repository measurements check out from on this host. */
  async repo(): Promise<{ path: string; tips: string[] }> {
    if (!this.remote) return { path: this.study.repo_path!, tips: [] };
    const r = await this.runner.benchRepo(this.study.slug);
    if (this.host.repo_path !== r.path) this.ctx.store.updateBenchHost(this.study.id, this.host.host_id, { repo_path: r.path });
    return r;
  }

  /** Make `sha` present in the bench clone (bundle transfer). No-op in shared mode. */
  async ensure(sha: string, purpose: "best" | "candidate", label: string, signal?: AbortSignal): Promise<string> {
    const repo = await this.repo();
    if (!this.remote) return repo.path;
    const spec = this.ctx.store.spec(this.study);
    try {
      const r = await ensureCommit({
        edit: this.edit,
        editRepo: this.study.repo_path!,
        bench: this.runner,
        benchRepo: repo.path,
        benchTips: repo.tips,
        sha,
        ref: `refs/bench/s/${sha}`,
        maxBytes: Math.round(spec.oracle.max_bundle_mib * 1024 * 1024),
        ...(this.ctx.config.bundleChunkBytes ? { chunkBytes: this.ctx.config.bundleChunkBytes } : {}),
        ...(signal ? { signal } : {}),
        now: this.ctx.now,
      });
      if (!r.skipped) {
        this.ctx.store.addTransfer({ study_id: this.study.id, host_id: this.host.host_id, sha, purpose: `${purpose} ${label}${repo.tips.length ? "" : " (bootstrap)"}`, bytes: r.bytes, chunks: r.chunks, ms: r.ms, ok: 1, error: null });
        this.ctx.store.event(this.study.id, "bench.transfer", "plugin", { host: this.host.host_id, sha, purpose, label, bytes: r.bytes, chunks: r.chunks, bootstrap: repo.tips.length === 0 });
      }
      return repo.path;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof TransferError)) throw e;
      this.ctx.store.addTransfer({ study_id: this.study.id, host_id: this.host.host_id, sha, purpose: `${purpose} ${label}`, bytes: 0, chunks: 0, ms: 0, ok: 0, error: clip(msg, 500) });
      throw new BenchTransferError(msg, purpose);
    }
  }

  async checkout(role: CheckoutRole, sha: string, purpose: "best" | "candidate", label: string, signal?: AbortSignal): Promise<string> {
    const repo = await this.ensure(sha, purpose, label, signal);
    return await this.runner.checkout(repo, `${this.prefix}${role}`, sha);
  }

  /**
   * Check out and build `sha` as best. The build is cached per bench host
   * until a promotion invalidates it (best_build_sha), and the checkout is
   * left alone while the cache is valid so build outputs survive.
   */
  async bestCheckout(sha: string, spec: StudySpec, signal?: AbortSignal): Promise<{ dir: string } & BuildResult> {
    const mem = this.bestDirs.get(this.cacheKey);
    const row = this.ctx.store.benchHost(this.study.id, this.host.host_id)!;
    if (mem && mem.sha === sha && row.best_build_sha === sha) return { dir: mem.dir, ok: true, output: "", cached: true };
    const dir = await this.checkout("best", sha, "best", "current best", signal);
    const built = await this.build(dir, spec, `best ${sha.slice(0, 10)}`, signal);
    if (built.ok) {
      this.bestDirs.set(this.cacheKey, { sha, dir });
      this.ctx.store.updateBenchHost(this.study.id, this.host.host_id, { best_build_sha: sha });
    } else {
      this.bestDirs.delete(this.cacheKey);
      this.ctx.store.updateBenchHost(this.study.id, this.host.host_id, { best_build_sha: null });
    }
    return { dir, ...built };
  }

  /** `dir` holds a built checkout of `sha` (calibration builds the baseline there). */
  markBestBuilt(sha: string, dir: string): void {
    this.bestDirs.set(this.cacheKey, { sha, dir });
    this.ctx.store.updateBenchHost(this.study.id, this.host.host_id, { best_build_sha: sha });
  }

  /** Forget the cached best build (promotion, recalibration). */
  invalidateBest(): void {
    this.bestDirs.delete(this.cacheKey);
    this.ctx.store.updateBenchHost(this.study.id, this.host.host_id, { best_build_sha: null });
  }

  async build(dir: string, spec: StudySpec, label: string, signal?: AbortSignal): Promise<BuildResult> {
    if (!spec.oracle.build) return { ok: true, output: "", cached: false };
    const r = await this.runner.run({ cwd: dir, command: spec.oracle.build, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: `build ${label}` }, signal ? { signal } : {});
    return { ok: r.exitCode === 0, output: tail(r), cached: false };
  }

  /** A Bench over two checkouts on this host. Each run is one host job. */
  bench(spec: StudySpec, dirs: Record<Side, string>, opts: { signal?: AbortSignal; label: string; onProgress?: (line: string) => void }): Bench {
    return makeBench(this.runner, spec, dirs, opts);
  }
}

export function makeBench(runner: HostRunner, spec: StudySpec, dirs: Record<Side, string>, opts: { signal?: AbortSignal; label?: string; onProgress?: (line: string) => void } = {}): Bench {
  return {
    run: async (side: Side): Promise<RunResult> => {
      const runOpts: RunOptions = {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      };
      const r = await runner.run({ cwd: dirs[side], command: spec.oracle.measure, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: `${opts.label ?? "measure"} ${side}` }, runOpts);
      if (r.exitCode !== 0) throw new BenchError(side, `measure exited ${r.exitCode}${r.timedOut ? " (timeout)" : ""}`, tail(r));
      const parsed = parseMeasureOutput(r.stdout);
      if (parsed.metrics[spec.metric.name] === undefined) {
        throw new BenchError(side, `measure printed no "METRIC ${spec.metric.name}=<value>" line`, tail(r));
      }
      return { metrics: parsed.metrics, diag: parsed.diag, durationMs: r.durationMs };
    },
  };
}

export function tail(r: Pick<ExecResult, "stdout" | "stderr">): string {
  const both = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  return both.length > 3000 ? `…${both.slice(-3000)}` : both;
}
