// Remote bench hosts end to end: the engine with a real git edit host and
// the example provider (local temp dirs, real processes). Machines join with a
// seed and a setup step, calibrate per host, measure, rotate, leave, and are
// cleaned up; a seed with credentials is refused before any machine exists.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBenchProvider, type LocalBenchProvider } from "../examples/bench-provider-local/provider.ts";
import { benchProviderContract, type BenchProviderMethod } from "../src/bench-provider/contract.ts";
import type Database from "better-sqlite3";
import { HostMutex, type Ctx } from "../src/context.ts";
import { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { gatesSerialized, measurementMde } from "../src/pipeline.ts";
import { liveView } from "../src/live.ts";
import { remoteLines } from "../src/remote/view.ts";
import { benchView } from "../src/views.ts";
import { artifactLine } from "../src/cli.ts";
import { Clock, localRunner, makeCtx, waitFor, type FakePort } from "./helpers.ts";

const SLUG = "toy-remote";
const CALLER = { experimental_caller: { kind: "plugin" as const, pluginId: "bb-autoresearch" } };

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

// The metric is the number in src/a.txt (no noise: A/A is exactly zero, so calibration never fails by chance);
// a "slow" marker in the machine's home makes each run take 0.25 s.
const MEASURE = `v=$(head -1 src/a.txt | tr -dc 0-9)
[ -f "$HOME/slow" ] && sleep 0.25
echo "METRIC t=$v"
`;
// The seed: a directory with a tool the setup step checks for; "bad" adds a credential file.
const SEED = `rm -rf .seed; mkdir -p .seed/bin; echo 'echo tool' > .seed/bin/tool.sh
if [ "$1" = bad ]; then printf 'machine example.com login me password hunter2\\n' > .seed/.netrc; fi
echo "$PWD/.seed"
`;
// v1: the same metric with ±4% noise on remote machines and ±0.1% on the edit host.
const NOISY_REMOTE_MEASURE = `v=$(head -1 src/a.txt | tr -dc 0-9)
n=0.002; [ -n "$AUTORESEARCH_REMOTE" ] && n=0.08
r=$(od -An -N2 -tu2 /dev/urandom | tr -dc 0-9)
awk -v v="$v" -v n="$n" -v r="$r" 'BEGIN { printf "METRIC t=%.6f\\n", v * (1 + n * (r / 65535 - 0.5)) }'
`;
const SETUP = `test -f "$AUTORESEARCH_SEED/bin/tool.sh" && echo "$AUTORESEARCH_CORES" > "$HOME/setup-ran"`;

function spec(opts: { benchHosts?: string; remote?: string; extra?: string } = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy number smaller on remote machines."
base = "main"

[metric]
name = "t"
direction = "lower"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
gate = ["sh bench/gate.sh"]
measure = "sh bench/measure.sh"
noise = "noisy"
bench_hosts = [${opts.benchHosts ?? ""}]

[oracle.health]
enabled = false

[oracle.drift]
every = 0

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 4
calibration_pairs = 4
side_runs = 1
min_side_seconds = 0
min_effect = "1%"
max_mde = "50%"
confirm = false
bootstrap = 200
early_lose_from = 0

[[oracle.remote_bench]]
provider = "bench-provider-local"
hosts = 2
cores = 1
lifetime_minutes = 30
seed = "sh bench/seed.sh"
setup = "sh bench/setup.sh"
env = { TOY_ENV = "on" }
${opts.remote ?? ""}

[budget]
max_workers = 1
max_candidates = 20
${opts.extra ?? ""}
`;
}

describe("remote bench hosts (example provider, real git)", () => {
  let root: string;
  let repo: string;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;
  let provider: LocalBenchProvider;
  let ctx: Ctx;
  let n = 0;
  /** Most live machines per slot seen at any tick (cost guard). */
  let maxPerSlot = 0;

  function setup(maxHosts = 6, measure = MEASURE) {
    n = 0;
    maxPerSlot = 0;
    root = mkdtempSync(join(tmpdir(), "ar-remote-fleet-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "bench"), { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/a.txt"), "100\n");
    writeFileSync(join(repo, "bench/measure.sh"), measure);
    writeFileSync(join(repo, "bench/gate.sh"), "exit 0\n");
    writeFileSync(join(repo, "bench/seed.sh"), SEED);
    writeFileSync(join(repo, "bench/setup.sh"), SETUP);
    writeFileSync(join(repo, ".gitignore"), ".seed/\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
    clock = new Clock();
    const runner = localRunner(join(root, "edit-data"), "host_test", { pollMs: 10, progressMs: 10 });
    const made = makeCtx(runner, clock);
    ({ store, port, ctx } = made);
    made.ctx.config.remote = { statusPollMs: 0, readyPollMs: 10, execPollMs: 10, retryMs: 0, joinTimeoutMs: 30_000, stagingDir: join(root, "staging") };
    port.projectCheckout = async () => repo;
    port.addThread("thr_study");
    provider = createLocalBenchProvider({ root: join(root, "provider"), now: clock.now, sweepMs: 0, maxHosts });
    port.plugins.set("bench-provider-local", async (method, input) => {
      const m = method as BenchProviderMethod;
      return await (provider.handlers[m] as (i: unknown, c: typeof CALLER) => Promise<unknown>)(benchProviderContract[m].input.parse(input), CALLER);
    });
    engine = new Engine(made.ctx);
  }

  afterEach(async () => {
    await engine.fleet.settle().catch(() => undefined);
    await engine.pipeline.pump().catch(() => undefined);
    await engine.dispose();
    provider.dispose();
    // Background work of the disposed instance stops quietly; give it a moment before removing its files.
    await new Promise((r) => setTimeout(r, 50));
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A plugin reload: the old instance is disposed (its store closes; the
   * database stays, as BB keeps the file), and a new engine on the same
   * database reconciles.
   */
  async function reload() {
    await engine.fleet.settle().catch(() => undefined);
    await engine.dispose();
    const handle = (store as unknown as { handle: Database.Database }).handle;
    store = new Store(handle, clock.now);
    ctx = { ...ctx, store, benchLock: new HostMutex(), disposed: false };
    delete ctx.remoteRunner;
    engine = new Engine(ctx);
    await engine.reconcile();
    await engine.fleet.settle();
  }

  const live = () => store.remoteHosts(store.study(SLUG)!.id, { live: true });
  const ready = () => live().filter((r) => r.state === "ready");
  const studyId = () => store.study(SLUG)!.id;
  const alive = () => provider.machines().filter((m) => m.state !== "gone");

  async function tick(times = 1) {
    for (let i = 0; i < times; i++) {
      await engine.tick();
      const perSlot = new Map<string, number>();
      for (const r of live()) perSlot.set(r.slot, (perSlot.get(r.slot) ?? 0) + 1);
      maxPerSlot = Math.max(maxPerSlot, ...perSlot.values(), 0);
    }
  }

  async function calibrated(toml = spec()) {
    await engine.proposeStudy("thr_study", "proj_1", toml);
    for (let attempt = 0; attempt < 3; attempt++) {
      await engine.calibrate(SLUG, "human");
      await engine.waitForCalibration(SLUG, 60_000);
      // A noisy A/A whose median CI misses zero by chance (about one calibration in twenty) fails it: try again, as a human would.
      const s = store.study(SLUG)!;
      const problems = (JSON.parse(s.calibration_json ?? "{}") as { problems?: string[] }).problems ?? [];
      if (s.calibration_status !== "failed" || !problems.length || !problems.every((p) => /excludes zero/u.test(p))) break;
    }
  }

  async function started(toml = spec()) {
    await calibrated(toml);
    const s = store.study(SLUG)!;
    expect(s.calibration_status, JSON.stringify(JSON.parse(s.calibration_json ?? "{}").problems)).toBe("ready");
    await engine.start(SLUG, "human");
  }

  /** A candidate on top of best whose number is `value`, queued for the bench. */
  function queue(value: number) {
    n += 1;
    const s = store.study(SLUG)!;
    const wt = join(root, `wt${n}`);
    sh(repo, "worktree", "add", "-q", "--detach", wt, s.best_sha!);
    writeFileSync(join(wt, "src/a.txt"), `${value}\n`);
    sh(wt, "commit", "-qam", `c${n}`);
    const sha = sh(wt, "rev-parse", "HEAD");
    sh(repo, "worktree", "remove", "--force", wt);
    const c = store.insertCandidate({ study_id: s.id, n, idea_id: null, thread_id: null, sha, parent_sha: s.best_sha!, summary: `set ${value}`, stage: "queued", changed_paths_json: '["src/a.txt"]' });
    store.updateCandidate(c.id, { prepared_sha: sha, against_sha: s.best_sha!, queued_at: clock.now() });
    return c.id;
  }

  async function decided(id: number, timeoutMs = 60_000) {
    const ok = await waitFor(() => {
      void engine.tick().catch(() => undefined);
      return store.candidate(id)!.stage === "decided";
    }, timeoutMs, 20);
    expect(ok, `c ${id} stage ${store.candidate(id)!.stage}`).toBe(true);
    return store.candidate(id)!;
  }

  it("joins every slot with the seed and setup, calibrates each machine, and measures on them", async () => {
    setup();
    await started();
    const s = store.study(SLUG)!;
    const machines = live();
    expect(machines).toHaveLength(2);
    expect(machines.every((r) => r.state === "ready")).toBe(true);
    // Per-host calibration on each machine's bench host row.
    for (const r of machines) {
      const b = store.benchHost(s.id, r.bench_host_id)!;
      expect(b.mode).toBe("remote");
      expect(b.active).toBe(1);
      expect(b.noise_floor).not.toBeNull();
      expect(b.mde).not.toBeNull();
      expect(JSON.parse(r.calibration_json!).noiseFloor).toBe(b.noise_floor);
      expect(r.seed_sha).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.base_sha).toBe(s.base_sha);
      // The joined event carries the join time the row records.
      const joined = store.events(s.id, { kinds: ["remote.joined"] }).map((e) => JSON.parse(e.data_json)).find((d) => d.remote === r.id);
      expect(joined.seconds).toBe(Math.round(r.join_seconds! * 10) / 10);
    }
    const seg = store.segment(s.id, s.segment)!;
    expect(JSON.parse(seg.details_json!).hosts).toHaveLength(2);
    // The seed was built once (one artifact) and uploaded to each machine; setup ran with the env.
    expect(store.artifacts(s.id).filter((a) => a.kind === "seed" && a.state === "ok")).toHaveLength(1);
    for (const m of alive()) {
      expect(existsSync(join(m.home, "setup-ran"))).toBe(true);
      expect(m.labels).toMatchObject({ owner: "bb-autoresearch", study: s.id });
      expect(m.cores).toBe(1);
    }
    expect(new Set(alive().map((m) => m.labels.slot))).toEqual(new Set(["0.1", "0.2"]));
    // The views: the Bench tab's remote section, the Live strip, `bb study bench` lines.
    const bv = benchView(engine, s);
    expect(bv.remote.live).toBe(2);
    expect(bv.remote.entries[0]).toMatchObject({ provider: "bench-provider-local", hosts: 2, cores: 1, setup: true, seed: { state: "ok" } });
    expect(bv.remote.machines.every((m) => m.state === "ready" && m.calibration?.noiseFloor !== null && m.rotation?.startsWith("replacement starts in"))).toBe(true);
    expect(bv.remote.baseBundle?.bytes).toBeGreaterThan(0);
    expect(bv.hosts.filter((h) => h.mode === "remote").every((h) => h.remote?.provider === "bench-provider-local")).toBe(true);
    const lv = liveView(engine, s);
    expect(lv.bench.filter((b) => b.remote?.state === "ready")).toHaveLength(2);
    expect(remoteLines(bv.remote, clock.now()).join("\n")).toMatch(/bench-provider-local #\d+ \(slot 0\.1, 1 cores.*ready, idle · ends in 30 min · noise/u);
    // A candidate is measured on a remote machine; its commit travelled as a small delta bundle.
    const id = queue(50);
    const c = await decided(id);
    expect(c.verdict).toBe("win");
    expect(c.bench_host_id).toMatch(/^remote-/u);
    const deltas = store.transfers(s.id).filter((t) => t.purpose.startsWith("candidate"));
    expect(deltas.length).toBeGreaterThan(0);
    expect(Math.max(...deltas.map((t) => t.bytes))).toBeLessThan(4096);
    expect(maxPerSlot).toBeLessThanOrEqual(2);
  });

  it("rotates a machine before its lifetime ends: the replacement calibrates first, and a measurement on the old one finishes", async () => {
    setup();
    await started(spec({ remote: "rotate_before_minutes = 5" }));
    const sid = studyId();
    const [a] = ready().sort((x, y) => x.id - y.id);
    // Make a's runs slow, and keep b busy so the candidate lands on a.
    const homeA = provider.machines().find((m) => m.hostId === a!.remote_id)!.home;
    writeFileSync(join(homeA, "slow"), "");
    const other = ready().find((r) => r.id !== a!.id)!;
    store.updateBenchHost(sid, other.bench_host_id, { active: 0 });
    const id = queue(60);
    expect(await waitFor(() => {
      void engine.tick().catch(() => undefined);
      return store.candidate(id)!.stage === "measuring";
    }, 30_000, 10)).toBe(true);
    store.updateBenchHost(sid, other.bench_host_id, { active: 1 });
    // 26 minutes in: inside a's 5-minute rotation lead.
    clock.advance(26 * 60_000);
    await tick();
    const slotA = () => store.remoteHosts(sid).filter((r) => r.slot === a!.slot);
    expect(await waitFor(() => slotA().some((r) => r.replaces === a!.id), 10_000)).toBe(true);
    // The replacement joins and calibrates on best (arrival calibration); a only then retires.
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return slotA().some((r) => r.replaces === a!.id && r.state === "ready");
    }, 60_000, 20)).toBe(true);
    const repl = slotA().find((r) => r.replaces === a!.id)!;
    expect(JSON.parse(repl.calibration_json!).sha).toBe(store.study(SLUG)!.best_sha);
    expect(store.events(sid, { kinds: ["remote.ready"] }).some((e) => JSON.parse(e.data_json).remote === repl.id)).toBe(true);
    // The measurement on a was not lost: it finishes there, then a is destroyed.
    const c = await decided(id);
    expect(c.measure_restarts).toBe(0);
    expect(c.bench_host_id).toBe(a!.bench_host_id);
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return store.remoteHost(a!.id)!.state === "gone";
    }, 20_000, 20)).toBe(true);
    expect(store.remoteHost(a!.id)!.left_reason).toMatch(/rotated out/u);
    await engine.fleet.settle();
    expect(provider.machines().find((m) => m.hostId === a!.remote_id)!.state).toBe("gone");
    expect(maxPerSlot).toBeLessThanOrEqual(2);
    expect(alive()).toHaveLength(2);
    // The seed was built once for the segment and reused for the replacement (cached, same content hash).
    expect(store.events(sid, { kinds: ["remote.seed_building"] })).toHaveLength(1);
    expect(new Set(store.remoteHosts(sid).filter((r) => r.seed_sha).map((r) => r.seed_sha)).size).toBe(1);
  });

  it("a machine lost mid-measurement: the measurement restarts from scratch elsewhere and the slot fills again", async () => {
    setup();
    await started();
    const sid = studyId();
    for (const m of alive()) writeFileSync(join(m.home, "slow"), "");
    const id = queue(70);
    expect(await waitFor(() => {
      void engine.tick().catch(() => undefined);
      return store.candidate(id)!.stage === "measuring" && store.samples(id).length > 0;
    }, 30_000, 10)).toBe(true);
    const on = store.candidate(id)!.bench_host_id!;
    const row = store.remoteHostByBench(sid, on)!;
    provider.kill(row.remote_id!);
    const c = await decided(id);
    expect(c.measure_restarts).toBe(1);
    expect(c.bench_host_id).not.toBe(on);
    expect(store.remoteHost(row.id)!.state).toBe("gone");
    expect(store.events(sid, { kinds: ["measure.restarted"] }).length).toBe(1);
    expect(store.notices(sid).some((x) => x.kind === "remote.lost")).toBe(true);
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return ready().length === 2;
    }, 60_000, 20)).toBe(true);
  });

  it("a machine lost between status polls leaves at its first failed call: nothing more is sent to it, and the candidate counts no error", async () => {
    setup();
    await started(spec({ remote: "gates = true" }));
    // No status poll after this: only the calls on the machine can notice that it is gone.
    (engine.fleet.config as { statusPollMs: number }).statusPollMs = 10 * 3_600_000;
    const sid = studyId();
    for (const m of alive()) writeFileSync(join(m.home, "slow"), "");
    const [a, b] = ready().sort((x, y) => x.id - y.id);
    // The candidate lands on a (the first bench host): b takes no work until it measures.
    store.updateBenchHost(sid, b!.bench_host_id, { active: 0 });
    const id = queue(70);
    expect(await waitFor(() => {
      void engine.tick().catch(() => undefined);
      return store.candidate(id)!.stage === "measuring" && store.samples(id).length > 0;
    }, 30_000, 10)).toBe(true);
    expect(store.candidate(id)!.bench_host_id).toBe(a!.bench_host_id);
    store.updateBenchHost(sid, b!.bench_host_id, { active: 1 });
    provider.kill(a!.remote_id!);
    const c = await decided(id);
    expect(c.measure_restarts).toBe(1);
    expect(c.bench_host_id).toBe(b!.bench_host_id);
    expect(c.attempts).toBe(0);
    expect(store.events(sid, { kinds: ["pipeline.error"] })).toEqual([]);
    const gone = store.remoteHost(a!.id)!;
    expect(gone.state).toBe("gone");
    expect(gone.left_reason).toMatch(/^remote machine .* (is gone|lost a running process)/u);
    expect(store.events(sid, { kinds: ["measure.started"] }).filter((e) => JSON.parse(e.data_json).host === a!.bench_host_id)).toHaveLength(1);
    expect(store.notices(sid).some((x) => x.kind === "remote.lost")).toBe(true);
  });

  it("a suspended machine leaves (never reused), and orphans are destroyed on load", async () => {
    setup();
    await started();
    const sid = studyId();
    const [a] = ready();
    provider.suspend(a!.remote_id!);
    await tick();
    await engine.fleet.settle();
    expect(store.remoteHost(a!.id)!.state).toBe("gone");
    expect(store.remoteHost(a!.id)!.left_reason).toMatch(/suspended/u);
    // An orphan: a machine with this plugin's labels that no row uses.
    const orphan = await provider.handlers["benchProvider.create"]({ key: "orphan-1", cores: 1, lifetimeSeconds: 600, labels: { owner: "bb-autoresearch", study: sid, slot: "9.9" } }, CALLER);
    expect(await engine.fleet.cleanupOrphans()).toBe(1);
    expect(provider.machines().find((m) => m.hostId === orphan.hostId)!.state).toBe("gone");
    // A load: rows that were not measuring yet are ended and their machines destroyed; a ready one is re-adopted.
    await engine.fleet.settle();
    const joining = live().filter((x) => x.state !== "ready" && x.remote_id);
    const readyIds = ready().map((x) => x.remote_id);
    const r = await engine.fleet.reconcile();
    expect(r.ended).toBe(joining.length);
    expect(r.adopted).toBe(readyIds.length);
    await engine.fleet.settle();
    for (const x of joining) expect(provider.machines().find((m) => m.hostId === x.remote_id)!.state).toBe("gone");
    for (const id of readyIds) expect(provider.machines().find((m) => m.hostId === id)!.state).toBe("ready");
  });

  it("pause releases the machines, resume brings new ones; archive and unload destroy everything", async () => {
    setup();
    await started();
    engine.pause(SLUG, "human");
    await tick();
    await engine.fleet.settle();
    expect(live()).toHaveLength(0);
    expect(alive()).toHaveLength(0);
    engine.resume(SLUG, "human");
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return ready().length === 2;
    }, 60_000, 20)).toBe(true);
    expect(alive()).toHaveLength(2);
    const text = await engine.archiveStudy(SLUG, "human");
    expect(text).toMatch(/2 remote machine\(s\) destroyed/u);
    expect(alive()).toHaveLength(0);
  });

  it("a plugin reload keeps calibrated machines: the new instance re-adopts them and measures on them without new ones", async () => {
    setup();
    await started();
    const sid = studyId();
    const before = ready().map((r) => ({ id: r.id, remote: r.remote_id, bench: r.bench_host_id, noise: store.benchHost(sid, r.bench_host_id)!.noise_floor }));
    expect(before).toHaveLength(2);
    const created = provider.calls()["benchProvider.create"];
    const seedBuilds = store.events(sid, { kinds: ["remote.seed_building"] }).length;
    await reload();
    // Nothing was destroyed or created: the same machines, still ready, with their own calibration.
    expect(alive().map((m) => m.hostId).sort()).toEqual(before.map((b) => b.remote).sort());
    expect(provider.calls()["benchProvider.create"]).toBe(created);
    for (const b of before) {
      const row = store.remoteHost(b.id)!;
      expect(row.state).toBe("ready");
      expect(row.phase).toBeNull();
      expect(engine.fleet.isAdopting(b.id)).toBe(false);
      const host = store.benchHost(sid, b.bench)!;
      expect(host.active).toBe(1);
      expect(host.noise_floor).toBe(b.noise);
    }
    expect(store.events(sid, { kinds: ["remote.readopted"] })).toHaveLength(2);
    expect(store.events(sid, { kinds: ["remote.left"] })).toHaveLength(0);
    // The new instance measures on them; nothing joins, and the seed is not built again.
    const id = queue(50);
    const c = await decided(id);
    expect(c.verdict).toBe("win");
    expect(before.map((b) => b.bench)).toContain(c.bench_host_id);
    await tick(3);
    await engine.fleet.settle();
    expect(provider.calls()["benchProvider.create"]).toBe(created);
    expect(store.events(sid, { kinds: ["remote.seed_building"] })).toHaveLength(seedBuilds);
    expect(ready()).toHaveLength(2);
    // Archive still destroys them.
    const text = await engine.archiveStudy(SLUG, "human");
    expect(text).toMatch(/2 remote machine\(s\) destroyed/u);
    expect(alive()).toHaveLength(0);
  });

  it("after a reload, a machine that died meanwhile or lost its repository is not re-adopted, and its slot fills again", async () => {
    setup();
    await started();
    const sid = studyId();
    const [a, b] = ready().sort((x, y) => x.id - y.id);
    await engine.fleet.settle();
    await engine.dispose();
    // While no instance runs: a dies, b loses its bench repository.
    provider.kill(a!.remote_id!);
    const homeB = provider.machines().find((m) => m.hostId === b!.remote_id)!.home;
    rmSync(join(homeB, "bb-autoresearch", "repo.git"), { recursive: true, force: true });
    await reload();
    expect(store.remoteHost(a!.id)!.state).toBe("gone");
    expect(store.remoteHost(b!.id)!.state).toBe("gone");
    expect(store.remoteHost(b!.id)!.left_reason).toMatch(/re-adopted.*repository or seed is missing/u);
    expect(provider.machines().find((m) => m.hostId === b!.remote_id)!.state).toBe("gone");
    expect(store.events(sid, { kinds: ["remote.readopted"] })).toHaveLength(0);
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return ready().length === 2;
    }, 60_000, 20)).toBe(true);
    expect(ready().every((r) => r.id !== a!.id && r.id !== b!.id)).toBe(true);
  });

  it("after a reload, a kept machine waits (and takes no work) until its provider answers", async () => {
    setup();
    await started();
    const sid = studyId();
    const kept = ready().map((r) => r.id);
    const handler = port.plugins.get("bench-provider-local")!;
    port.plugins.delete("bench-provider-local");
    await reload();
    for (const id of kept) {
      expect(engine.fleet.isAdopting(id)).toBe(true);
      const row = store.remoteHost(id)!;
      expect(row.state).toBe("ready");
      expect(row.phase).toMatch(/re-adopting after a plugin reload/u);
      expect(store.benchHost(sid, row.bench_host_id)!.active).toBe(0);
    }
    expect(benchView(engine, store.study(SLUG)!).remote.machines.filter((m) => m.state === "ready").every((m) => /re-adopting/u.test(m.stateText))).toBe(true);
    // The provider comes up: the next tick after the retry interval verifies them.
    port.plugins.set("bench-provider-local", handler);
    clock.advance(20_000);
    await tick();
    await engine.fleet.settle();
    for (const id of kept) {
      expect(engine.fleet.isAdopting(id)).toBe(false);
      expect(store.benchHost(sid, store.remoteHost(id)!.bench_host_id)!.active).toBe(1);
    }
    expect(store.events(sid, { kinds: ["remote.readopted"] })).toHaveLength(2);
  });

  it("an unload while machines join destroys the joining ones (only calibrated machines are kept)", async () => {
    setup();
    await started();
    const sid = studyId();
    const [a] = ready();
    provider.kill(a!.remote_id!);
    await tick();
    await engine.fleet.settle();
    // a left; its replacement starts joining. Unload before it is calibrated.
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return live().some((r) => r.slot === a!.slot && r.id !== a!.id && r.remote_id !== null && r.state !== "ready");
    }, 30_000, 5)).toBe(true);
    const joiningRow = live().find((r) => r.slot === a!.slot && r.id !== a!.id)!;
    await engine.dispose();
    const handle = (store as unknown as { handle: Database.Database }).handle;
    const after = new Store(handle, clock.now);
    expect(after.remoteHost(joiningRow.id)!.state).toBe("gone");
    expect(after.remoteHost(joiningRow.id)!.left_reason).toBe("plugin unloaded");
    expect(after.remoteHosts(sid, { live: true }).filter((r) => r.state === "ready")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(provider.machines().find((m) => m.hostId === joiningRow.remote_id)?.state ?? "gone").toBe("gone");
    // Keep afterEach's dispose harmless: a fresh instance on the same database.
    await reload();
  });

  it("a spec version that leaves the seed's inputs alone reuses the seed; one that changes them builds it again", async () => {
    setup();
    await started();
    const sid = studyId();
    expect(store.events(sid, { kinds: ["remote.seed_building"] })).toHaveLength(1);
    // Spec v2 changes the budget only (no recalibration): a replacement reuses the seed.
    await engine.proposeStudy("thr_study", "proj_1", spec().replace("max_candidates = 20", "max_candidates = 21"));
    engine.approve(SLUG, "human");
    expect(store.study(SLUG)!.spec_version).toBe(2);
    const [a] = ready();
    provider.kill(a!.remote_id!);
    expect(await waitFor(() => {
      void tick().catch(() => undefined);
      return ready().length === 2 && !ready().some((r) => r.id === a!.id);
    }, 60_000, 20)).toBe(true);
    expect(store.events(sid, { kinds: ["remote.seed_building"] })).toHaveLength(1);
    expect(store.artifacts(sid).filter((x) => x.kind === "seed")).toHaveLength(1);
    // The key changes with the seed command, its allowlist and the cores, not with the spec version.
    const s = store.study(SLUG)!;
    const k = engine.fleet.seedKey(s, 0, s.best_sha!);
    expect(k).toBe(store.artifacts(sid).find((x) => x.kind === "seed")!.key);
    expect(k.startsWith(`${s.best_sha}:`)).toBe(true);
  });

  it("seeds and base bundles no study uses are deleted on archive and at load, and \`bb study bench\` reports their size", async () => {
    setup();
    await started();
    const sid = studyId();
    const seedRow = store.artifacts(sid).find((a) => a.kind === "seed" && a.state === "ok")!;
    const baseRow = store.artifacts(sid).find((a) => a.kind === "base")!;
    expect(existsSync(seedRow.path!)).toBe(true);
    expect(existsSync(baseRow.path!)).toBe(true);
    // A stale seed from an earlier study, older than the grace period: deleted at load.
    const stale = join(root, "edit-data", "seeds", `${"a".repeat(64)}.tar.gz`);
    writeFileSync(stale, "old");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(stale, old, old);
    // `bb study bench`: the size line.
    const usage = await engine.fleet.artifactUsage(store.study(SLUG)!);
    expect(usage!.seeds.files).toBe(2);
    expect(usage!.bases.files).toBe(1);
    expect(usage!.study.files).toBe(2);
    expect(artifactLine(usage!)).toMatch(/^2 seed\(s\) and 1 base bundle\(s\) on the edit host, .* · this study uses 2 /u);
    await reload();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(seedRow.path!)).toBe(true);
    expect(existsSync(baseRow.path!)).toBe(true);
    const handle = (store as unknown as { handle: Database.Database }).handle;
    expect(handle.prepare(`SELECT COUNT(*) AS n FROM events WHERE study_id IS NULL AND kind = 'remote.artifacts_deleted'`).get()).toEqual({ n: 1 });
    expect((await engine.fleet.artifactUsage(store.study(SLUG)!))!.lastCleanup).toMatchObject({ reason: "plugin loaded", files: 1 });
    // Archive: nothing uses them any more (no other study): both are deleted.
    await engine.archiveStudy(SLUG, "human");
    await engine.fleet.settle();
    // Files built in the last 10 minutes are kept by the grace period; age them and archive's cleanup runs again at load.
    for (const p of [seedRow.path!, baseRow.path!]) utimesSync(p, old, old);
    await reload();
    expect(existsSync(seedRow.path!)).toBe(false);
    expect(existsSync(baseRow.path!)).toBe(false);
    expect(readdirSync(join(root, "edit-data", "seeds")).filter((f) => !f.startsWith("."))).toEqual([]);
  });

  it("refuses a seed with credentials before any machine exists, and accepts it with seed_allow", async () => {
    setup();
    await calibrated(spec().replace('seed = "sh bench/seed.sh"', 'seed = "sh bench/seed.sh bad"'));
    const s = store.study(SLUG)!;
    expect(s.calibration_status).toBe("failed");
    const problems = JSON.parse(s.calibration_json!).problems as string[];
    expect(problems.join("\n")).toMatch(/seed was refused/u);
    expect(provider.calls()["benchProvider.create"]).toBe(0);
    const notice = store.notices(s.id).find((x) => x.kind === "remote.seed_refused")!;
    expect(notice.text).toContain(".netrc (file:netrc");
    expect(notice.text).not.toContain("hunter2");
    await engine.proposeStudy("thr_study", "proj_1", spec({ remote: 'seed_allow = [".netrc"]' }).replace('seed = "sh bench/seed.sh"', 'seed = "sh bench/seed.sh bad"'));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 60_000);
    expect(store.study(SLUG)!.calibration_status).toBe("ready");
  });

  it("checks the spec against describe at calibration", async () => {
    setup(1);
    await calibrated();
    const s = store.study(SLUG)!;
    expect(s.calibration_status).toBe("failed");
    expect((JSON.parse(s.calibration_json!).problems as string[]).join("\n")).toMatch(/hosts = 2, but .* allows at most 1/u);
    port.plugins.delete("bench-provider-local");
    await engine.proposeStudy("thr_study", "proj_1", spec());
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 60_000);
    expect((JSON.parse(store.study(SLUG)!.calibration_json!).problems as string[]).join("\n")).toMatch(/did not answer describe/u);
  });

  it("gates = true: gates run on the remote machines (baseline and candidates), not on the edit host", async () => {
    setup();
    writeFileSync(join(repo, "bench/gate.sh"), `v=$(head -1 src/a.txt | tr -dc 0-9); [ -n "$AUTORESEARCH_REMOTE" ] || { echo "not remote" >&2; exit 9; }; [ "$v" != 13 ]\n`);
    sh(repo, "commit", "-qam", "remote-only gate");
    await started(spec({ benchHosts: '"local"', remote: "gates = true" }));
    const sid = studyId();
    expect(gatesSerialized(store, store.study(SLUG)!)).toBe(false);
    expect(store.benchIntervals(sid).some((i) => i.kind === "gate" && i.host_id.startsWith("remote-"))).toBe(true);
    const gateCand = (value: number) => {
      const id = queue(value);
      store.updateCandidate(id, { stage: "gating", prepared_sha: null, queued_at: null });
      return id;
    };
    const good = gateCand(40);
    const bad = gateCand(13);
    const g = await decided(good);
    expect(g.verdict).toBe("win");
    const b = await decided(bad);
    expect(b.verdict).toBe("gate_failed");
    const started2 = store.events(sid, { kinds: ["gate.started"] }).map((e) => JSON.parse(e.data_json).host as string);
    expect(started2.length).toBeGreaterThanOrEqual(2);
    expect(started2.every((h) => h.startsWith("remote-"))).toBe(true);
  });

  it("v1: a remote machine much noisier than the other hosts is replaced, a bounded number of times in a row; then it is kept", async () => {
    // Remote machines are ±4% noisy, the edit host ±0.1%: every machine is far beyond max_host_noise_ratio (and chance).
    setup(6, NOISY_REMOTE_MEASURE);
    await started(spec({ benchHosts: '"local"' }).replace("hosts = 2", "hosts = 1").replace("calibration_pairs = 4", "calibration_pairs = 12"));
    const sid = studyId();
    // The study's calibration: the machine is not used, and leaves when the calibration ends (its slot refills once running).
    const report = JSON.parse(store.study(SLUG)!.calibration_json!) as { warnings: string[]; hosts: Array<{ mode: string; excluded?: string }> };
    expect(report.warnings.some((w) => /is much noisier than the other bench hosts \(.*\): it is replaced by a new machine/u.test(w))).toBe(true);
    expect(report.hosts.find((h) => h.mode === "remote")!.excluded).toMatch(/median of the other bench hosts/u);
    const first = store.remoteHosts(sid)[0]!;
    expect(first.state).toBe("gone");
    expect(first.left_reason).toMatch(/^much noisier than the other bench hosts/u);
    // Running: two replacements in a row calibrate on arrival and leave; the third is kept, with a notice.
    const kept = await waitFor(() => {
      void tick().catch(() => undefined);
      return ready().length === 1;
    }, 60_000, 20);
    expect(kept).toBe(true);
    const all = store.remoteHosts(sid).sort((a, b) => a.id - b.id);
    // Under a loaded test machine a join can fail or time out and its slot fill again: those rows don't count.
    const rows = all.filter((r) => r.state !== "gone" || /^much noisier/u.test(r.left_reason ?? ""));
    expect(rows.map((r) => `${r.state}: ${r.left_reason}`), all.map((r) => `${r.state}: ${r.left_reason}`).join(" | ")).toHaveLength(4);
    expect(rows.slice(1, 3).map((r) => r.state)).toEqual(["gone", "gone"]);
    for (const r of rows.slice(1, 3)) expect(r.left_reason).toMatch(/^much noisier than the other bench hosts: noise floor/u);
    expect(store.events(sid, { kinds: ["bench.noisy_host"] }).map((e) => JSON.parse(e.data_json).action).reverse()).toEqual(["replaced", "replaced", "replaced", "kept"]);
    expect(store.notices(sid).some((n) => n.kind === "bench.noisy_host" && n.text.includes("after 2 replacement(s) in a row"))).toBe(true);
    // From now on the entry's machines are kept (a recalibration keeps this one too).
    expect(engine.fleet.acceptsNoisy(store.study(SLUG)!, rows[3]!.bench_host_id)).toBe(true);
    // 1.0: the count is kept on the study, so a plugin reload doesn't start the replacements over.
    expect(JSON.parse(store.study(SLUG)!.remote_noisy_json!)).toEqual({ "0": 3 });
    await reload();
    expect(engine.fleet.acceptsNoisy(store.study(SLUG)!, rows[3]!.bench_host_id)).toBe(true);
    // The quiet edit host measures first; the kept machine measures with its own (larger) win threshold.
    const local = store.benchHosts(sid).find((h) => h.mode !== "remote")!;
    const remote = store.benchHosts(sid).find((h) => h.mode === "remote")!;
    expect(remote.mde!).toBeGreaterThan(local.mde!);
    const c = await decided(queue(50));
    expect(c.bench_host_id).toBe(local.host_id);
  });

  /** Let the fleet and the pipeline run until `cond` holds. */
  async function until(cond: () => boolean, timeoutMs = 60_000) {
    const ok = await waitFor(() => {
      void tick().catch(() => undefined);
      return cond();
    }, timeoutMs, 20);
    expect(ok).toBe(true);
  }

  it("1.0: a remote-only study paused at budget end has no machines; the freeze brings them up and `bb study measure` waits for them", async () => {
    setup();
    await started();
    const sid = studyId();
    expect((await decided(queue(50))).verdict).toBe("win");
    const seedBuilds = store.events(sid, { kinds: ["remote.seed_building"] }).length;
    engine.pause(SLUG, "human");
    await until(() => live().length === 0);
    await engine.fleet.settle();
    // Paused: the machines are released, so there is no bench host; the refusal names the fix.
    await expect(engine.requestMeasure(SLUG, { refA: "base", refB: "best" }, "human")).rejects.toThrow(/no online bench host \(its remote machines are released while it is paused; freeze it for harvest/u);
    // A reload while paused: seeds and the base bundle of a study that isn't archived stay, however old.
    const kept = store.artifacts(sid).filter((a) => a.state === "ok" && a.path).map((a) => a.path!);
    const old = new Date(Date.now() - 3_600_000);
    for (const p of kept) utimesSync(p, old, old);
    await reload();
    for (const p of kept) expect(existsSync(p)).toBe(true);
    // The freeze: best is pinned and the fleet brings machines up again.
    engine.startHarvest(SLUG, "human");
    // Asked before any machine is ready: the run waits instead of failing.
    expect(ready()).toHaveLength(0);
    const row = await engine.requestMeasure(SLUG, { refA: "base", refB: "best" }, "human");
    expect(row.state).toBe("queued");
    await until(() => store.latestHarvest(sid)?.state === "frozen");
    expect(sh(repo, "rev-parse", "refs/studies/toy-remote/harvest/h1")).toBe(store.study(SLUG)!.best_sha);
    await until(() => /^waiting for a bench host: remote machines (being requested|on their way \(\d+ joining)/u.test(store.adhocRun(row.id)!.progress ?? ""));
    await until(() => ["done", "failed"].includes(store.adhocRun(row.id)!.state));
    const done = store.adhocRun(row.id)!;
    expect(done.state, done.error ?? "").toBe("done");
    const result = JSON.parse(done.result_json!) as { host: { id: string }; threshold: number; classification: string };
    const host = store.benchHost(sid, result.host.id)!;
    expect(host.mode).toBe("remote");
    // The machine calibrated on arrival and the measurement used its own threshold.
    expect(result.threshold).toBeCloseTo(measurementMde(store, store.study(SLUG)!, store.spec(store.study(SLUG)!), host), 9);
    expect(result.classification).toBe("win");
    // The machines that joined after the freeze reused the seed: it was not built again.
    expect(store.events(sid, { kinds: ["remote.seed_building"] })).toHaveLength(seedBuilds);
    // An agent's own branch (a split of best, built on base) reaches the machines as a delta bundle too.
    const wt = join(root, "split");
    sh(repo, "worktree", "add", "-q", "-b", "split/1", wt, store.study(SLUG)!.base_sha!);
    writeFileSync(join(wt, "src/a.txt"), "75\n");
    sh(wt, "commit", "-qam", "Half of the change");
    sh(repo, "worktree", "remove", "--force", wt);
    const split = await engine.requestMeasure(SLUG, { refA: "base", refB: "split/1" }, "human");
    await until(() => ["done", "failed"].includes(store.adhocRun(split.id)!.state));
    expect(store.adhocRun(split.id)!.state, store.adhocRun(split.id)!.error ?? "").toBe("done");
    expect(store.benchHost(sid, store.adhocRun(split.id)!.host_id!)!.mode).toBe("remote");
    // Gates run on the edit host.
    const gate = await engine.requestGate(SLUG, { ref: "split/1" }, "human");
    await engine.primitives.wait(gate.id, 30_000);
    expect(store.adhocRun(gate.id)!.state).toBe("done");
  });

  it("1.0: a plugin reload during a requested measurement re-adopts the machines with their own thresholds; the next request measures there", async () => {
    setup(6, `${MEASURE}sleep 0.05\n`);
    await started();
    const sid = studyId();
    expect((await decided(queue(50))).verdict).toBe("win");
    engine.startHarvest(SLUG, "human");
    await until(() => store.latestHarvest(sid)?.state === "frozen" && ready().length === 2);
    const before = new Map(ready().map((r) => [r.bench_host_id, store.benchHost(sid, r.bench_host_id)!.mde] as const));
    const row = await engine.requestMeasure(SLUG, { refA: "base", refB: "best", pairs: 4 }, "human");
    await until(() => store.adhocRun(row.id)!.state === "running");
    await reload();
    // The run belonged to the old instance; the machines did not.
    expect(store.adhocRun(row.id)).toMatchObject({ state: "failed", error: expect.stringContaining("interrupted by a plugin reload") });
    expect(store.events(sid, { kinds: ["remote.readopted"] })).toHaveLength(2);
    for (const [id, mde] of before) expect(store.benchHost(sid, id)).toMatchObject({ active: 1, mde });
    const again = await engine.requestMeasure(SLUG, { refA: "base", refB: "best" }, "human");
    await until(() => ["done", "failed"].includes(store.adhocRun(again.id)!.state));
    const done = store.adhocRun(again.id)!;
    expect(done.state, done.error ?? "").toBe("done");
    expect(before.has(done.host_id!)).toBe(true);
    const result = JSON.parse(done.result_json!) as { threshold: number };
    expect(result.threshold).toBeCloseTo(Math.max(0.01, before.get(done.host_id!)!), 9);
    expect(store.events(sid, { kinds: ["remote.left"] })).toHaveLength(0);
  });

  it("1.0: a machine lost during a requested measurement: the run starts again on another host (not when the host was named)", async () => {
    setup();
    await started();
    const sid = studyId();
    expect((await decided(queue(50))).verdict).toBe("win");
    engine.startHarvest(SLUG, "human");
    await until(() => store.latestHarvest(sid)?.state === "frozen" && ready().length === 2);
    for (const m of alive()) writeFileSync(join(m.home, "slow"), "");
    const row = await engine.requestMeasure(SLUG, { refA: "base", refB: "best" }, "human");
    await until(() => store.adhocRun(row.id)!.state === "running" && /pair/u.test(store.adhocRun(row.id)!.progress ?? ""));
    const on = store.adhocRun(row.id)!.host_id!;
    provider.kill(store.remoteHostByBench(sid, on)!.remote_id!);
    await until(() => ["done", "failed"].includes(store.adhocRun(row.id)!.state));
    const done = store.adhocRun(row.id)!;
    expect(done.state, done.error ?? "").toBe("done");
    expect(done.host_id).not.toBe(on);
    // Named with --host, it fails with the reason instead.
    await until(() => ready().length === 2);
    for (const m of alive()) writeFileSync(join(m.home, "slow"), "");
    const target = ready()[0]!;
    const pinned = await engine.requestMeasure(SLUG, { refA: "base", refB: "best", host: target.bench_host_id }, "human");
    await until(() => store.adhocRun(pinned.id)!.state === "running" && /pair/u.test(store.adhocRun(pinned.id)!.progress ?? ""));
    provider.kill(target.remote_id!);
    await until(() => ["done", "failed"].includes(store.adhocRun(pinned.id)!.state));
    expect(store.adhocRun(pinned.id)).toMatchObject({ state: "failed", error: expect.stringContaining("left during the measurement") });
  });

  it("measures on local and remote hosts together, each with its own calibration", async () => {
    setup();
    await started(spec({ benchHosts: '"local"' }));
    const s = store.study(SLUG)!;
    const hosts = store.benchHosts(s.id);
    expect(hosts.map((h) => h.mode).sort()).toEqual(["remote", "remote", "shared"]);
    expect(hosts.every((h) => h.noise_floor !== null)).toBe(true);
    const ids = [queue(80), queue(81), queue(82)];
    for (const id of ids) expect((await decided(id)).stage).toBe("decided");
  });
});
