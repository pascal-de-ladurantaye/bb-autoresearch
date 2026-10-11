// Remote bench hosts end to end: the engine with a real git edit host and
// the example provider (local temp dirs, real processes). Machines join with a
// seed and a setup step, calibrate per host, measure, rotate, leave, and are
// cleaned up; a seed with credentials is refused before any machine exists.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBenchProvider, type LocalBenchProvider } from "../examples/bench-provider-local/provider.ts";
import { benchProviderContract, type BenchProviderMethod } from "../src/bench-provider/contract.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { gatesSerialized } from "../src/pipeline.ts";
import { liveView } from "../src/live.ts";
import { remoteLines } from "../src/remote/view.ts";
import { benchView } from "../src/views.ts";
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
  let n = 0;
  /** Most live machines per slot seen at any tick (cost guard). */
  let maxPerSlot = 0;

  function setup(maxHosts = 6) {
    n = 0;
    maxPerSlot = 0;
    root = mkdtempSync(join(tmpdir(), "ar-remote-fleet-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "bench"), { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/a.txt"), "100\n");
    writeFileSync(join(repo, "bench/measure.sh"), MEASURE);
    writeFileSync(join(repo, "bench/gate.sh"), "exit 0\n");
    writeFileSync(join(repo, "bench/seed.sh"), SEED);
    writeFileSync(join(repo, "bench/setup.sh"), SETUP);
    writeFileSync(join(repo, ".gitignore"), ".seed/\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
    clock = new Clock();
    const runner = localRunner(join(root, "edit-data"), "host_test", { pollMs: 10, progressMs: 10 });
    const made = makeCtx(runner, clock);
    ({ store, port } = made);
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
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 60_000);
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
    // A reload: the previous instance's machines are ended and destroyed (new ones join as slots fill).
    await engine.fleet.settle();
    const before = live().map((x) => x.remote_id);
    expect(before.length).toBeGreaterThan(0);
    const r = await engine.fleet.reconcile();
    expect(r.ended).toBe(before.length);
    await engine.fleet.settle();
    for (const id of before) expect(provider.machines().find((m) => m.hostId === id)!.state).toBe("gone");
    expect(before.every((id) => !live().some((x) => x.remote_id === id))).toBe(true);
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

  it("plugin unload destroys the machines", async () => {
    setup();
    await started();
    expect(alive()).toHaveLength(2);
    await engine.dispose();
    expect(alive()).toHaveLength(0);
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
