// Single-machine mode (v0.2.2): gates take the same per-host bench lock as
// measurements, in one oldest-first queue; gate spans are bench intervals;
// W uses gate + measure time; quiet bench holds new worker turns while a
// measurement runs.
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { singleMachineMode } from "../src/single-machine.ts";
import { oracleHash, parseSpec, type StudySpec } from "../src/spec.ts";
import { seededRng } from "../src/stats.ts";
import { benchHostsView, oracleView, statusLine, utilization } from "../src/views.ts";
import { liveView } from "../src/live.ts";
import { evalTimes } from "../src/pipeline.ts";
import { Clock, FakeHost, makeCtx, waitFor } from "./helpers.ts";

const SLUG = "toy-sm";

function spec(opts: { single?: string; quiet?: boolean; benchHosts?: string; noise?: string; maxWorkers?: number; gate?: boolean } = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy program faster under the noisy benchmark."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
${opts.gate === false ? "" : 'gate = ["gate run"]'}
measure = "measure run"
noise = "${opts.noise ?? "noisy"}"
${opts.single ? `single_machine = "${opts.single}"` : ""}
${opts.quiet ? "quiet_bench = true" : ""}
${opts.benchHosts ? `bench_hosts = ${opts.benchHosts}` : ""}

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 4
calibration_pairs = 4
bootstrap = 200
confirm = false

[oracle.drift]
every = 0

[budget]
max_workers = ${opts.maxWorkers ?? 3}
max_candidates = 20

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

function parsed(toml: string): StudySpec {
  const r = parseSpec(toml);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
}

/** A clock that follows real time, so bench intervals have real spans (overlap audits). */
function realClock(): Clock {
  const c = new Clock();
  c.now = () => Date.now();
  return c;
}

async function setup(toml: string, opts: { clock?: Clock; ideas?: number } = {}) {
  const host = new FakeHost();
  const made = makeCtx(host, opts.clock ?? new Clock());
  const engine = new Engine(made.ctx);
  const base = host.commit("T0", null, "base");
  host.refs.set("main", base);
  host.metric.set("T0", 1000);
  made.port.addThread("thr_study");
  await engine.proposeStudy("thr_study", "proj_1", toml);
  await engine.calibrate(SLUG, "human");
  await engine.waitForCalibration(SLUG, 5_000);
  expect(made.store.study(SLUG)!.calibration_status).toBe("ready");
  for (let i = 0; i < (opts.ideas ?? 3); i++) engine.addIdea(SLUG, { title: `Idea ${String.fromCharCode(65 + i)}`, theme: `t${i}`, pinned: false }, "human");
  await engine.start(SLUG, "human");
  await engine.settle();
  const id = made.store.study(SLUG)!.id;
  const submit = async (thread: string, tree: string, value: number) => {
    host.nextSnapshotFor.set(`/wt/${thread}`, { tree });
    host.metric.set(tree, value);
    return await engine.submit(thread, { title: `change ${tree} for speed` });
  };
  return { host, engine, id, submit, ...made };
}

describe("single-machine mode: detection and spec", () => {
  const editHost = "host_edit";
  it("auto is on when a bench host is the edit machine (local, or its host id), off otherwise", () => {
    expect(singleMachineMode(parsed(spec()), editHost, [editHost]).on).toBe(true);
    expect(singleMachineMode(parsed(spec()), editHost, [editHost]).reason).toMatch(/auto: a bench host is the edit machine/u);
    // Before the bench hosts are resolved, the spec entries decide: empty or "local" share the machine.
    expect(singleMachineMode(parsed(spec()), editHost, null).on).toBe(true);
    expect(singleMachineMode(parsed(spec({ benchHosts: '["local"]' })), editHost, null).on).toBe(true);
    expect(singleMachineMode(parsed(spec({ benchHosts: '["bench-x86"]' })), editHost, null).on).toBe(false);
    // A remote bench host: off. The edit host listed by id among others: on.
    expect(singleMachineMode(parsed(spec({ benchHosts: '["bench-x86"]' })), editHost, ["host_remote"]).on).toBe(false);
    expect(singleMachineMode(parsed(spec({ benchHosts: '["bench-x86", "me"]' })), editHost, ["host_remote", editHost]).on).toBe(true);
    // Deterministic measurements don't need a quiet machine: auto stays off.
    const det = singleMachineMode(parsed(spec({ noise: "deterministic" })), editHost, [editHost]);
    expect(det.on).toBe(false);
    expect(det.reason).toMatch(/deterministic/u);
    // Explicit settings win.
    expect(singleMachineMode(parsed(spec({ single: "off" })), editHost, [editHost]).on).toBe(false);
    expect(singleMachineMode(parsed(spec({ single: "on", benchHosts: '["bench-x86"]' })), editHost, ["host_remote"]).on).toBe(true);
  });

  it("validates single_machine and quiet_bench, defaults them, and leaves them out of the oracle hash", () => {
    const d = parsed(spec());
    expect(d.oracle.single_machine).toBe("auto");
    expect(d.oracle.quiet_bench).toBe(false);
    const bad = parseSpec(spec({ single: "always" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/oracle\.single_machine/u);
    const badQuiet = parseSpec(spec().replace('noise = "noisy"', 'noise = "noisy"\nquiet_bench = "yes"'));
    expect(badQuiet.ok).toBe(false);
    // Scheduling, not measurement: toggling either is not a new segment.
    expect(oracleHash(parsed(spec({ single: "off", quiet: true })))).toBe(oracleHash(d));
    expect(oracleHash(parsed(spec({ single: "on" })))).toBe(oracleHash(d));
    // A spec stored before v0.2.2 (no keys) reads as auto/false and hashes the same.
    const old = JSON.parse(JSON.stringify(d)) as StudySpec;
    delete (old.oracle as Partial<StudySpec["oracle"]>).single_machine;
    delete (old.oracle as Partial<StudySpec["oracle"]>).quiet_bench;
    expect(oracleHash(old)).toBe(oracleHash(d));
    // Warnings for settings that do nothing useful.
    const w = parseSpec(spec({ single: "on", noise: "deterministic" }));
    expect(w.ok && w.warnings.join(" ")).toMatch(/deterministic oracle/u);
    const w2 = parseSpec(spec({ single: "on", gate: false }));
    expect(w2.ok && w2.warnings.join(" ")).toMatch(/nothing to serialize/u);
  });
});

describe("single-machine mode: the shared bench lock (fake host)", () => {
  it("gates and measurements never overlap, over random arrival orders (property)", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rng = seededRng(seed);
      const t = await setup(spec(), { clock: realClock() });
      t.host.delays = { gate: 2 + Math.floor(rng() * 6), measure: 1 + Math.floor(rng() * 3) };
      // Three workers submit in a random order with random gaps; values make some wins (best moves, rebases).
      const order = [1, 2, 3].sort(() => rng() - 0.5);
      const subs: Array<Promise<unknown>> = [];
      for (const w of order) {
        subs.push(t.submit(`thr_w${w}`, `T${seed}-${w}`, 900 + Math.floor(rng() * 300)));
        await new Promise((r) => setTimeout(r, Math.floor(rng() * 12)));
      }
      await Promise.all(subs);
      await t.engine.settle();
      expect(t.host.maxActiveAll, `seed ${seed}`).toBe(1);
      const study = t.store.study(t.id)!;
      expect(utilization(t.engine, study).overlaps, `seed ${seed}`).toBe(0);
      const intervals = t.store.benchIntervals(t.id);
      expect(intervals.some((i) => i.kind === "gate")).toBe(true);
      // One lock key for gates and measurements: the edit host's.
      expect(new Set(intervals.map((i) => i.lock_key))).toEqual(new Set(["host_test"]));
      // Every gated candidate's gate ran inside a gate interval of its own.
      for (const c of t.store.candidates(t.id)) {
        if (c.verdict === "rejected") continue;
        expect(intervals.some((i) => i.kind === "gate" && i.candidate_id === c.id), `seed ${seed} c/${c.n}`).toBe(true);
        expect(c.stage).toBe("decided");
      }
      // Pairwise: no two intervals overlap at all (not only adjacent ones).
      const spans = intervals.map((i) => [i.started_at, i.ended_at ?? Infinity] as const);
      for (let a = 0; a < spans.length; a++) for (let b = a + 1; b < spans.length; b++) expect(spans[a]![0] < spans[b]![1] && spans[b]![0] < spans[a]![1] && spans[a]![1] > spans[a]![0] && spans[b]![1] > spans[b]![0], `seed ${seed} intervals ${a}/${b}`).toBe(false);
      t.engine.dispose();
    }
  }, 60_000);

  it("is one FIFO with measurements: the oldest waiter takes the bench next", async () => {
    const t = await setup(spec());
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let held = false;
    t.host.onMeasure = async () => {
      if (held) return;
      held = true;
      await hold;
    };
    // c/1 gates and is being measured (held); c/2 and c/3 arrive while it measures.
    void t.submit("thr_w1", "TA", 1100);
    await waitFor(() => t.host.active.measure > 0);
    t.clock.advance(1000);
    await t.submit("thr_w2", "TB", 1100);
    t.clock.advance(1000);
    await t.submit("thr_w3", "TC", 1100);
    await new Promise((r) => setTimeout(r, 20));
    // Waiting candidates are bench queue (backpressure counts them).
    expect(t.store.candidates(t.id, { stages: ["gating"] })).toHaveLength(2);
    expect(t.engine.benchDepth(t.id)).toBe(3);
    expect(t.host.active.gate).toBe(0);
    t.clock.advance(1000);
    release();
    await t.engine.settle();
    const seq = t.store
      .benchIntervals(t.id)
      .filter((i) => (i.kind === "gate" || i.kind === "measure") && i.candidate_id !== null)
      .map((i) => `${i.kind}:c/${t.store.candidate(i.candidate_id!)!.n}`);
    // c/2's gate (waiting since its submission) goes before c/3's, and c/3's gate before c/2's
    // measurement (queued after c/3 arrived).
    expect(seq).toEqual(["gate:c/1", "measure:c/1", "gate:c/2", "gate:c/3", "measure:c/2", "measure:c/3"]);
    expect(t.host.maxActiveAll).toBe(1);
  });

  it("off keeps gates parallel and outside the lock", async () => {
    const t = await setup(spec({ single: "off" }));
    t.host.delays = { gate: 30, measure: 2 };
    await Promise.all([t.submit("thr_w1", "TA", 900), t.submit("thr_w2", "TB", 1100), t.submit("thr_w3", "TC", 1000)]);
    await t.engine.settle();
    expect(t.host.maxActive.gate).toBeGreaterThanOrEqual(2);
    expect(t.store.benchIntervals(t.id).some((i) => i.kind === "gate")).toBe(false);
    // Gate time is still recorded per candidate, but T_eval is measurement only.
    expect(evalTimes(t.store, t.store.study(t.id)!).serialized).toBe(false);
  });

  it("calibration runs the baseline gates under the lock, before the A/A pairs, and says so", async () => {
    const t = await setup(spec(), { ideas: 0 });
    const kinds = t.store.benchIntervals(t.id).map((i) => i.kind);
    expect(kinds.slice(0, 2)).toEqual(["gate", "calibration"]);
    const o = oracleView(t.engine, t.store.study(t.id)!);
    expect(o.calibration.report).toMatch(/Single-machine mode is on \(auto: a bench host is the edit machine\)/u);
    expect(o.calibration.report).toMatch(/holding the bench/u);
    expect(o.singleMachine).toMatchObject({ on: true, serialized: true, setting: "auto", quietBench: false });
    expect(o.singleMachine!.text).toMatch(/one queue with measurements \(oldest first\)/u);
  });

  it("utilization counts gate spans, and the overlap audit counts a gate overlapping a measurement", async () => {
    const t = await setup(spec(), { ideas: 0 });
    const s = () => t.store.study(t.id)!;
    const before = utilization(t.engine, s());
    const open = (kind: "gate" | "measure") => t.store.openBenchInterval({ study_id: t.id, host_id: "host_test", lock_key: "host_test", kind, candidate_id: null });
    t.clock.advance(1000);
    const g = open("gate");
    t.clock.advance(2000);
    t.store.closeBenchInterval(g);
    const m = open("measure");
    t.clock.advance(3000);
    t.store.closeBenchInterval(m);
    t.clock.advance(4000);
    const u = utilization(t.engine, s());
    expect(u.busySeconds - before.busySeconds).toBeCloseTo(5, 6);
    expect(u.gateSeconds).toBeCloseTo(2, 6);
    expect(u.overlaps).toBe(0);
    // A gate that overlaps a measurement on the same lock is an overlap (it should never happen).
    const m2 = open("measure");
    t.clock.advance(500);
    const g2 = open("gate");
    t.clock.advance(500);
    t.store.closeBenchInterval(g2);
    t.store.closeBenchInterval(m2);
    expect(utilization(t.engine, s()).overlaps).toBe(1);
  });

  it("W uses gate + measure seconds per candidate when gates are serialized (and only measure when not)", async () => {
    for (const single of ["auto", "off"] as const) {
      const t = await setup(spec({ single, maxWorkers: 4 }), { ideas: 1 });
      const s = () => t.store.study(t.id)!;
      // Before any candidate: calibration's eval estimate, plus the calibrated gate time when serialized.
      const seg = t.store.segment(t.id, s().segment)!;
      t.store.db.prepare(`UPDATE segments SET eval_seconds = 30, gate_seconds = 30 WHERE study_id = ? AND k = ?`).run(t.id, seg.k);
      expect(evalTimes(t.store, s()).tEval).toBe(single === "auto" ? 60 : 30);
      const w1 = t.store.threadById("thr_w1")!;
      t.clock.advance(60_000);
      await t.submit("thr_w1", "TA", 1100);
      await t.engine.settle();
      const c1 = t.store.candidateByN(t.id, 1)!;
      expect((c1.submitted_at - w1.spawned_at) / 1000).toBe(60);
      t.store.updateCandidate(c1.id, { bench_seconds: 30, gate_seconds: 30 });
      const target = t.engine.workerTarget(s());
      // think 60 s; serialized: eval 30 + 30 = 60 → W = ceil(60/60)+1 = 2. Parallel gates: eval 30 → W = 3.
      expect(target).toMatchObject(single === "auto" ? { w: 2, tThink: 60, tEval: 60 } : { w: 3, tThink: 60, tEval: 30 });
      // A candidate whose gate failed still occupied the bench (serialized): it counts.
      t.store.insertCandidate({ study_id: t.id, n: 2, idea_id: null, thread_id: null, sha: "x", parent_sha: "y", summary: "s", stage: "decided", changed_paths_json: "[]", lines_added: 1, lines_deleted: 0 });
      const c2 = t.store.candidateByN(t.id, 2)!;
      t.store.updateCandidate(c2.id, { gate_seconds: 20, verdict: "gate_failed", decided_at: t.clock.now() });
      expect(evalTimes(t.store, s()).tEval).toBe(single === "auto" ? 40 : 30);
      t.engine.dispose();
    }
  });

  it("the gate occupies the bench on the surfaces: bench host, status line, live view", async () => {
    const t = await setup(spec());
    t.host.delays = { gate: 200, measure: 1 };
    void t.submit("thr_w1", "TA", 1100);
    await waitFor(() => t.host.active.gate > 0);
    const s = t.store.study(t.id)!;
    expect(benchHostsView(t.engine, s)[0]!.gating).toBe(1);
    expect(statusLine(t.engine, s)).toMatch(/testing c\/1 on the bench/u);
    const v = liveView(t.engine, s);
    expect(v.bench[0]!.current).toMatchObject({ kind: "gate", n: 1 });
    expect(v.singleMachine?.text).toMatch(/Single-machine mode is on/u);
    expect(v.feed.map((f) => f.text).join("\n")).toMatch(/c\/1 tests started on .*holding the bench/u);
    // A second candidate waiting to test is in the bench queue, marked as tests.
    await t.submit("thr_w2", "TB", 1100);
    const v2 = liveView(t.engine, t.store.study(t.id)!);
    expect(v2.queue).toEqual([2]);
    expect(v2.queueTests).toEqual([2]);
    await t.engine.settle();
    expect(benchHostsView(t.engine, t.store.study(t.id)!)[0]!.gating).toBeNull();
    expect(t.store.events(t.id, { kinds: ["gate.started", "gate.finished"] }).length).toBe(4);
    expect(t.store.candidateByN(t.id, 1)!.gate_seconds).toBeGreaterThanOrEqual(0);
  });
});

describe("quiet bench: hold new worker turns while a measurement runs", () => {
  it("holds start-turn dispatches of workers on the measuring host, never join-turn or other threads; rechecks when it ends", async () => {
    const t = await setup(spec({ quiet: true }), { ideas: 1 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    t.host.onMeasure = () => hold;
    const q = (over: Partial<Parameters<Engine["dispatchDecision"]>[0]> = {}) => t.engine.dispatchDecision({ threadId: "thr_w1", attempt: "start-turn", hostId: "host_test", ...over });
    expect(q()).toEqual({ action: "proceed" });
    const rechecks0 = t.port.rechecks;
    void t.submit("thr_w1", "TA", 1100);
    await waitFor(() => t.host.active.measure > 0);
    t.clock.advance(1000);
    const d = q();
    expect(d.action).toBe("wait");
    if (d.action === "wait") {
      expect(d.reason).toMatch(/quiet bench: waits for c\/1's measurement on .* \(study toy-sm\) to end/u);
      expect(d.sendAt).toBeGreaterThan(t.clock.now());
    }
    // Running turns are never interrupted; other threads (the study thread, a human's) are not workers.
    expect(q({ attempt: "join-turn" })).toEqual({ action: "proceed" });
    expect(q({ threadId: "thr_study" })).toEqual({ action: "proceed" });
    expect(q({ threadId: "thr_someone_else" })).toEqual({ action: "proceed" });
    // Another machine isn't measuring.
    expect(q({ hostId: "host_other" })).toEqual({ action: "proceed" });
    // A worker whose spawn is still in flight (no row has its thread id yet): BB says the plugin created it.
    expect(q({ threadId: "thr_spawning", spawnedByPlugin: true }).action).toBe("wait");
    expect(q({ threadId: "thr_not_ours", spawnedByPlugin: false })).toEqual({ action: "proceed" });
    expect(t.store.events(t.id, { kinds: ["quiet.held"] })).toHaveLength(2);
    t.clock.advance(1000);
    release();
    await t.engine.settle();
    expect(t.port.rechecks).toBeGreaterThan(rechecks0);
    expect(q()).toEqual({ action: "proceed" });
    expect(q({ threadId: "thr_spawning", spawnedByPlugin: true })).toEqual({ action: "proceed" });
    expect(t.store.events(t.id, { kinds: ["quiet.released"] })).toHaveLength(2);
  });

  it("a held turn waits for at most one measurement (a busy bench never starves workers)", async () => {
    const t = await setup(spec({ quiet: true }), { ideas: 1 });
    const open = () => t.store.openBenchInterval({ study_id: t.id, host_id: "host_test", lock_key: "host_test", kind: "measure", candidate_id: null });
    const q = () => t.engine.dispatchDecision({ threadId: "thr_w1", attempt: "start-turn", hostId: "host_test" });
    t.clock.advance(1000);
    const a = open();
    t.clock.advance(1000);
    expect(q().action).toBe("wait");
    t.clock.advance(1000);
    t.store.closeBenchInterval(a);
    t.clock.advance(1);
    open(); // the next measurement starts before BB re-asks
    t.clock.advance(1);
    expect(q()).toEqual({ action: "proceed" });
    // A fresh dispatch during the same measurement waits again.
    expect(q().action).toBe("wait");
  });

  it("gates don't hold turns, and quiet_bench off never holds", async () => {
    const off = await setup(spec(), { ideas: 1 });
    off.store.openBenchInterval({ study_id: off.id, host_id: "host_test", lock_key: "host_test", kind: "measure", candidate_id: null });
    expect(off.engine.dispatchDecision({ threadId: "thr_w1", attempt: "start-turn", hostId: "host_test" })).toEqual({ action: "proceed" });
    off.engine.dispose();
    const on = await setup(spec({ quiet: true }), { ideas: 1 });
    on.store.openBenchInterval({ study_id: on.id, host_id: "host_test", lock_key: "host_test", kind: "gate", candidate_id: null });
    expect(on.engine.dispatchDecision({ threadId: "thr_w1", attempt: "start-turn", hostId: "host_test" })).toEqual({ action: "proceed" });
  });
});
