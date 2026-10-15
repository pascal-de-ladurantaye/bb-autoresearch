// M2: remote bench hosts and trust, against fake hosts. The edit host and
// each bench host are separate FakeHosts: a bench host's clone only holds
// commits that arrived as bundles, and checkouts there fail otherwise.
import { beforeEach, describe, expect, it } from "vitest";
import { showStudy } from "../src/cli.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { HOLDOUT_FAIL, HOLDOUT_PASS } from "../src/holdout.ts";
import { expensiveStrategy, type Bench } from "../src/noise.ts";
import { parseSpec } from "../src/spec.ts";
import { seededRng } from "../src/stats.ts";
import { studyReport } from "../src/report.ts";
import { benchHostsView, benchView, candidateDetail, candidatesView, findingsView, harvestView, oracleView, overview } from "../src/views.ts";
import { FakeHost, healthyReport, makeCtx, waitFor, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-m2";

interface SpecOpts {
  benchHosts?: string[];
  noise?: "noisy" | "expensive" | "deterministic";
  drift?: string;
  holdout?: string;
  health?: string;
  protocol?: string;
  maxWorkers?: number;
  measure?: string;
  maxBundleMib?: number;
}

function m2Spec(o: SpecOpts = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy program faster on the remote bench."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"

[[guardrail]]
name = "rss"
max_regression = "5%"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
build = "build it"
gate = ["gate run"]
measure = "${o.measure ?? "measure run"}"
noise = "${o.noise ?? "noisy"}"
bench_hosts = ${JSON.stringify(o.benchHosts ?? ["bench-a"])}
${o.maxBundleMib ? `max_bundle_mib = ${o.maxBundleMib}` : ""}

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 6
calibration_pairs = 4
bootstrap = 200
${o.protocol ?? ""}

[oracle.drift]
${o.drift ?? "every = 0"}

[oracle.health]
notify_after_minutes = 0
${o.health ?? ""}
${o.holdout ? `\n[oracle.holdout]\n${o.holdout}` : ""}

[budget]
max_workers = ${o.maxWorkers ?? 2}
max_candidates = 20

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

describe("M2 remote bench (fake hosts)", () => {
  let edit: FakeHost;
  let benchA: FakeHost;
  let benchB: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;

  beforeEach(() => {
    edit = new FakeHost();
    const made = makeCtx(edit);
    ({ store, port, clock } = made);
    benchA = new FakeHost("host_a", edit);
    benchB = new FakeHost("host_b", edit);
    port.addHost(benchA, "bench-a");
    port.addHost(benchB, "bench-b");
    engine = new Engine(made.ctx);
    const base = edit.commit("T0", null, "base");
    edit.refs.set("main", base);
    edit.metric.set("T0", 1000);
    port.addThread("thr_study");
  });

  async function running(o: SpecOpts = {}, ideas = [{ title: "Idea A", theme: "a" }, { title: "Idea B", theme: "b" }]) {
    const r = await engine.proposeStudy("thr_study", "proj_1", m2Spec(o));
    expect(r).toContain("Draft ready:");
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    const s = store.study(SLUG)!;
    if (s.calibration_status !== "ready") throw new Error(`calibration: ${s.calibration_json}`);
    for (const i of ideas) engine.addIdea(SLUG, { ...i, pinned: false }, "human");
    await engine.start(SLUG, "human");
    await engine.settle();
    return s.id;
  }

  async function submit(thread: string, tree: string, value: number, summary = `change ${tree} for speed`) {
    edit.nextSnapshotFor.set(`/wt/${thread}`, { tree });
    edit.metric.set(tree, value);
    return await engine.submit(thread, { title: summary });
  }

  it("resolves bench hosts by name or id and rejects unknown machines", async () => {
    const bad = await engine.proposeStudy("thr_study", "proj_1", m2Spec({ benchHosts: ["bench-x86-01"] })).catch((e: Error) => e.message);
    expect(bad).toContain('no BB machine named or with id "bench-x86-01"');
    expect(bad).toContain("bench-a (host_a)");
    const ok = await engine.proposeStudy("thr_study", "proj_1", m2Spec({ benchHosts: ["bench-a", "host_b"] }));
    expect(ok).toContain("bench bench-a (own clone, git bundles), bench-b (own clone, git bundles)");
  });

  it("dispatches measurements across bench hosts, each fed only by bundles; nothing runs on the edit host's bench", async () => {
    const id = await running({ benchHosts: ["bench-a", "bench-b"] });
    expect(store.benchHosts(id).map((h) => [h.host_id, h.mode])).toEqual([
      ["host_a", "clone"],
      ["host_b", "clone"],
    ]);
    // Calibration bootstrapped both clones with the baseline.
    expect(store.transfers(id).filter((t) => t.purpose.includes("bootstrap")).map((t) => t.host_id).sort()).toEqual(["host_a", "host_b"]);
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    };
    benchA.onMeasure = slow;
    benchB.onMeasure = slow;
    await Promise.all([submit("thr_w1", "TA", 1300), submit("thr_w2", "TB", 1400)]);
    await engine.settle();
    const cands = store.candidates(id);
    expect(cands.map((c) => c.verdict)).toEqual(["lose", "lose"]);
    expect(new Set(cands.map((c) => c.bench_host_id))).toEqual(new Set(["host_a", "host_b"]));
    expect(peak).toBe(2); // the two hosts measured at the same time
    // Candidate commits reached each bench clone as a one-commit bundle.
    for (const c of cands) {
      const host = c.bench_host_id === "host_a" ? benchA : benchB;
      expect(host.present.has(c.prepared_sha!)).toBe(true);
      expect(host.bundlesCreated.length + edit.bundlesCreated.length).toBeGreaterThan(0);
    }
    expect(edit.bundlesCreated.filter((b) => b.commits === 1).length).toBeGreaterThanOrEqual(2);
    // The edit host never ran a measurement; its checkouts are gate slots only.
    expect(edit.commands.filter((c) => c.startsWith("measure"))).toEqual([]);
    expect([...edit.checkouts.keys()].every((k) => k.includes("-gate"))).toBe(true);
    const view = benchHostsView(engine, store.study(id)!);
    expect(view.map((h) => h.bundles)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(showStudy(engine, SLUG, 0)).toContain("  bench-b [own clone via git bundles] online");
  });

  it("caches the best build per bench host until a promotion invalidates it", async () => {
    const id = await running();
    const bestBuilds = () => benchA.builds.filter((d) => d.endsWith("-bench-best")).length;
    expect(bestBuilds()).toBe(1); // calibration built the baseline
    await submit("thr_w1", "TA", 1200);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("lose");
    expect(bestBuilds()).toBe(1); // cached
    await submit("thr_w2", "TB", 800);
    await engine.settle();
    expect(store.candidateByN(id, 2)!.verdict).toBe("win");
    expect(store.benchHost(id, "host_a")!.best_build_sha).toBeNull();
    expect(store.events(id, { kinds: ["bench.cache_invalidated"] })).toHaveLength(1);
    await submit("thr_w1", "TC", 900);
    await engine.settle();
    expect(bestBuilds()).toBe(2); // rebuilt once for the new best
    expect(store.benchHost(id, "host_a")!.best_build_sha).toBe(store.study(id)!.best_sha);
    // The promoted commit reached the bench clone as a tiny bundle (same tree as the measured candidate).
    expect(benchA.present.has(store.study(id)!.best_sha!)).toBe(true);
  });

  it("a failing health check defers the measurement, notifies, and measures once the host is healthy", async () => {
    const id = await running();
    benchA.healthReport = healthyReport({ loadavg: [12, 10, 8], topProcesses: [{ pid: 99, cpu: 380, command: "cc1plus" }] });
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    expect(c.stage).toBe("queued");
    expect(store.events(id, { kinds: ["measure.deferred"] })).toHaveLength(1);
    const h = store.benchHost(id, "host_a")!;
    expect(h.health_ok).toBe(0);
    expect(h.deferred_until).toBeGreaterThan(clock.now());
    const checks = store.healthChecks(id, { hostId: "host_a" });
    expect(checks[0]!.ok).toBe(0);
    expect(checks[0]!.problems_json).toContain("competing process cc1plus");
    expect(store.notices(id).map((n) => n.kind)).toContain("bench.unhealthy");
    expect(showStudy(engine, SLUG, 0)).toContain("health FAILING");
    // Still unhealthy within the retry window: nothing runs.
    await engine.settle();
    expect(store.candidateByN(id, 1)!.stage).toBe("queued");
    benchA.healthReport = healthyReport();
    clock.advance(61_000);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    expect(store.benchHost(id, "host_a")!.health_ok).toBe(1);
  });

  it("drift check: an A/A run on best every N evaluations; noise past 2x calibrated pauses the study", async () => {
    const rng = seededRng(5);
    benchA.noise = () => (rng() - 0.5) * 0.004; // ±0.2% at calibration
    const id = await running({ drift: "every = 2\npairs = 6" });
    const floor = store.benchHost(id, "host_a")!.noise_floor!;
    expect(floor).toBeGreaterThan(0);
    await submit("thr_w1", "TA", 1300);
    await engine.settle();
    expect(store.driftChecks(id)).toHaveLength(0);
    await submit("thr_w2", "TB", 1300);
    await engine.settle();
    // Two evaluations: the drift check ran with the machine still quiet.
    const first = store.driftChecks(id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "ok", host_id: "host_a", pairs: 6 });
    expect(store.study(id)!.state).toBe("running");
    // The bench machine gets disturbed.
    benchA.noise = () => (rng() - 0.5) * 0.2;
    await submit("thr_w1", "TC", 1300);
    await submit("thr_w2", "TD", 1300);
    await engine.settle();
    const last = store.driftChecks(id)[0]!;
    expect(last.status).toBe("drift");
    expect(last.ratio!).toBeGreaterThan(2);
    const s = store.study(id)!;
    expect(s.state).toBe("paused");
    expect(s.pause_reason).toContain("noise drift on bench host bench-a");
    expect(store.notices(id).map((n) => n.kind)).toContain("drift");
    expect(store.benchHost(id, "host_a")!.drift_status).toBe("drift");
  });

  it("holdout: evaluated only on wins about to be promoted; agents see pass/fail, never numbers or inputs", async () => {
    const SECRET_CMD = "holdout run --workload=holdout-secret-workload";
    const id = await running({ holdout: `measure = "${SECRET_CMD}"\nruns = 2` });
    // c/1 special-cases the benchmark: faster on it, much slower on the hidden workload.
    edit.holdoutMetric.set("TA", 1234.5);
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const a = store.candidateByN(id, 1)!;
    expect(a.verdict).toBe("lose");
    expect(a.holdout).toBe("fail");
    expect(JSON.parse(a.reasons_json!)).toContain(HOLDOUT_FAIL);
    // c/2 is a real improvement: it passes and is promoted.
    edit.holdoutMetric.set("TB", 801.25);
    await submit("thr_w2", "TB", 800);
    await engine.settle();
    const b = store.candidateByN(id, 2)!;
    expect(b.verdict).toBe("win");
    expect(b.holdout).toBe("pass");
    expect(JSON.parse(b.reasons_json!)).toContain(HOLDOUT_PASS);
    // Holdout only ran for those two wins (never on a lose).
    await submit("thr_w1", "TC", 1500);
    await engine.settle();
    expect(store.candidateByN(id, 3)!.holdout).toBeNull();
    const holdoutRuns = benchA.commands.filter((c) => c.startsWith("holdout"));
    expect(holdoutRuns.length).toBe(1 + 4 + 4); // calibration smoke run, then two pairs each for c/1 and c/2
    // The numbers exist only in the private table.
    const row = store.db.prepare(`SELECT * FROM holdout_results WHERE candidate_id = ?`).get(a.id) as { details_json: string };
    expect(row.details_json).toContain("1234.5");

    // Everything an agent can see: messages, tool results, RPC views, CLI, events, notices, samples.
    const study = store.study(id)!;
    const surfaces = [
      ...port.sent.map((m) => m.text),
      ...port.steered.map((m) => m.text),
      ...port.spawned.map((s) => s.prompt),
      JSON.stringify(overview(engine, study)),
      // M3 views: the Oracle tab shows the spec with the holdout removed; the report and other tabs never carry it.
      JSON.stringify(oracleView(engine, study)),
      JSON.stringify(benchView(engine, study)),
      JSON.stringify(findingsView(engine, study, {})),
      JSON.stringify(harvestView(engine, study)),
      studyReport(engine.ctx, study, store.spec(study), null),
      JSON.stringify(candidatesView(engine, study, {})),
      JSON.stringify(await candidateDetail(engine, study, 1)),
      JSON.stringify(await candidateDetail(engine, study, 2)),
      showStudy(engine, SLUG, 200),
      await engine.searchFindings("thr_study", { query: "change", verdict: "lose" }),
      JSON.stringify(store.events(id, { limit: 1000 })),
      JSON.stringify(store.notices(id, { limit: 100 })),
      JSON.stringify(store.db.prepare(`SELECT * FROM samples`).all()),
      JSON.stringify(store.db.prepare(`SELECT reasons_json, metrics_json, diag_json, gate_output FROM candidates`).all()),
    ].join("\n");
    for (const secret of ["1234.5", "801.25", "holdout-secret-workload", "holdout-secret-input", "/srv/holdout"]) {
      expect(surfaces).not.toContain(secret);
    }
    expect(surfaces).toContain("holdout: configured (hidden from agents)");
    expect(oracleView(engine, study).holdoutConfigured).toBe(true);
    expect(oracleView(engine, study).activeToml).toContain("[oracle.holdout] is configured and hidden here");
    expect(port.spawned[0]!.prompt).toContain("hidden holdout workload");
  });

  it("guardrails relative to best: a primary-metric win that breaks one is a lose with the reason attached", async () => {
    const id = await running();
    edit.rss.set("TA", 130); // +30% memory against a 5% limit
    await submit("thr_w1", "TA", 700);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    expect(c.verdict).toBe("lose");
    const reasons = JSON.parse(c.reasons_json!) as string[];
    expect(reasons[0]).toContain("primary metric improved");
    expect(reasons.some((r) => /guardrail rss: 30\.0% worse than best.*beyond the 5\.0% limit; 30\.0% worse than the segment base.*beyond the 5\.0% total limit/u.test(r))).toBe(true);
    const msg = port.sent.filter((m) => m.threadId === "thr_w1").at(-1)!.text;
    expect(msg).toContain("Lose: guardrail rss (30.0% worse). Not promoted.");
    expect(msg).toMatch(/Guardrails \(per step vs best; in total vs the segment base, with this candidate\): rss 30\.0% worse than best \(limit 5\.0%\) BROKEN; 30\.0% worse than the segment base \(total limit 5\.0%\) BROKEN/u);
    // Within the limit it is a win.
    edit.rss.set("TB", 103);
    await submit("thr_w2", "TB", 700);
    await engine.settle();
    expect(store.candidateByN(id, 2)!.verdict).toBe("win");
  });

  it("oracle change mid-run: pending spec, new segment after recalibration on best; non-oracle changes apply directly", async () => {
    const id = await running();
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const best1 = store.study(id)!.best_sha!;
    expect(store.study(id)!.segment).toBe(1);
    // A budget-only change needs no recalibration.
    const budgetOnly = await engine.proposeStudy("thr_study", "proj_1", m2Spec().replace("max_candidates = 20", "max_candidates = 25"));
    expect(budgetOnly).toContain("bb study approve");
    expect(store.study(id)!.pending_spec_version).toBe(2);
    expect(engine.approve(SLUG, "human")).toContain("oracle unchanged");
    expect(store.spec(store.study(id)!).budget.max_candidates).toBe(25);
    expect(store.study(id)!.segment).toBe(1);
    // An oracle change waits for approval; the study keeps running on the old spec.
    const changed = await engine.proposeStudy("thr_study", "proj_1", m2Spec({ measure: "measure run --v2" }).replace("max_candidates = 20", "max_candidates = 25"));
    expect(changed).toContain("The oracle changed");
    expect(store.spec(store.study(id)!).oracle.measure).toBe("measure run");
    expect(() => engine.approve(SLUG, "human")).toThrow(/changes the oracle/u);
    // A queued candidate when the human approves: it goes back to the gate.
    benchA.healthReport = healthyReport({ loadavg: [50, 50, 50] });
    await submit("thr_w2", "TB", 1300);
    await engine.settle();
    expect(store.candidateByN(id, 2)!.stage).toBe("queued");
    benchA.healthReport = healthyReport();
    clock.advance(61_000);
    const text = await engine.calibrate(SLUG, "human");
    expect(text).toContain("recalibrating on the current best");
    expect(store.study(id)!.state).toBe("calibrating");
    expect(store.candidateByN(id, 2)!.stage).toBe("gating");
    await engine.waitForCalibration(SLUG, 5_000);
    const s = store.study(id)!;
    expect(s.calibration_status).toBe("ready");
    expect(s.segment).toBe(2);
    const [seg1, seg2] = store.segments(id);
    expect(seg1!.oracle_hash).not.toBe(seg2!.oracle_hash);
    expect(seg2).toMatchObject({ k: 2, baseline_sha: best1, spec_version: 3 });
    expect(edit.refs.get(`refs/studies/${SLUG}/segment/2`)).toBe(best1);
    expect(edit.refs.get(`refs/studies/${SLUG}/segment/1`)).not.toBe(best1);
    expect(store.events(id, { kinds: ["segment.started"] })).toHaveLength(1);
    // Submissions keep arriving while it recalibrates; they wait at the gate.
    const ticket = await submit("thr_w1", "TC", 900);
    expect(ticket).toContain("Submitted as c/3");
    expect(await engine.start(SLUG, "human")).toContain("segment 2");
    await engine.settle();
    expect(store.candidateByN(id, 2)!.verdict).toBe("lose");
    expect(store.candidateByN(id, 3)!.verdict).toBe("lose"); // 900 vs best 800
    expect(benchA.commands).toContain("measure run --v2");
    expect(showStudy(engine, SLUG, 0)).toMatch(/Segment:\s+2 \(oracle/u);
  });

  it("an oracle change that fails calibration keeps the old spec and pauses", async () => {
    const id = await running();
    await engine.proposeStudy("thr_study", "proj_1", m2Spec({ measure: "broken measure" }));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    const s = store.study(id)!;
    expect(s.state).toBe("paused");
    expect(s.spec_version).toBe(1);
    expect(s.segment).toBe(1);
    expect(s.pause_reason).toContain("failed calibration");
  });

  it("cancels in-flight measurements when the oracle changes, and when the study is archived", async () => {
    const id = await running();
    let fire: (() => void) | null = null;
    benchA.onMeasure = async () => {
      if (fire) {
        const f = fire;
        fire = null;
        f();
      }
      await new Promise((r) => setTimeout(r, 5));
    };
    await engine.proposeStudy("thr_study", "proj_1", m2Spec({ measure: "measure run --v2" }));
    fire = () => void engine.calibrate(SLUG, "human");
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    await engine.waitForCalibration(SLUG, 5_000);
    const restarted = store.events(id, { kinds: ["measure.restarted"] });
    expect(restarted).toHaveLength(1);
    expect(restarted[0]!.data_json).toContain("oracle change");
    expect(store.candidateByN(id, 1)!.stage).toBe("gating");
    expect(store.sampleCount(store.candidateByN(id, 1)!.id)).toBe(0);
    await engine.start(SLUG, "human");
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    // Archive while measuring: the job is cancelled and the clone removed.
    fire = () => void engine.archiveStudy(SLUG, "human");
    await submit("thr_w2", "TB", 700);
    await engine.settle();
    expect(store.study(id)!.state).toBe("archived");
    expect(store.candidateByN(id, 2)!.verdict).toBe("inconclusive");
    expect(benchA.present.size).toBe(0);
  });

  it("host worker restart and lost jobs mid-measurement restart from scratch; partial samples are discarded", async () => {
    const id = await running();
    let runs = 0;
    benchA.onMeasure = () => {
      runs += 1;
      if (runs === 3) engine.onHostWorkerExit("host_a");
    };
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const a = store.candidateByN(id, 1)!;
    expect(a.verdict).toBe("win");
    expect(a.measure_restarts).toBe(1);
    const ev = store.events(id, { kinds: ["measure.restarted"] });
    expect(ev[0]!.data_json).toContain("host worker restarted");
    // Samples are only from the successful attempt: pair numbers restart at 0 with no duplicates.
    const pairs = store.samples(a.id).filter((s) => s.metric === "size" && s.run === "measure").map((s) => `${s.pair}:${s.side}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    // A job the host forgot (worker restarted between polls) is the same case.
    runs = 0;
    benchA.onMeasure = () => {
      if (++runs === 2) benchA.loseNextJob = true;
    };
    await submit("thr_w2", "TB", 1300);
    await engine.settle();
    expect(store.candidateByN(id, 2)!.measure_restarts).toBe(1);
    expect(store.candidateByN(id, 2)!.verdict).toBe("lose");
  });

  it("bench host offline: measurements wait at the measure step, the human is notified after the grace period", async () => {
    const id = await running();
    port.hostStatuses.set("host_a", "disconnected");
    edit.failNext = null;
    benchA.failNext = { method: "checkout", error: "host host_a is not connected" };
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    expect(c.stage).toBe("queued");
    expect(c.attempts).toBe(0); // an offline host is not a pipeline error
    expect(store.benchHost(id, "host_a")!.status).toBe("offline");
    expect(store.notices(id).map((n) => n.kind)).not.toContain("bench.offline");
    // Workers keep working; after the grace period the human hears about it.
    clock.advance(11 * 60_000);
    await engine.tick();
    expect(store.notices(id).map((n) => n.kind)).toContain("bench.offline");
    expect(store.study(id)!.state).toBe("running");
    port.hostStatuses.set("host_a", "connected");
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    expect(store.events(id, { kinds: ["bench.online"] })).toHaveLength(1);
  });

  it("plugin restart mid-measurement: reconcile from SQLite requeues it and discards partial samples", async () => {
    const id = await running();
    let block!: () => void;
    const blocked = new Promise<void>((r) => (block = r));
    let n = 0;
    benchA.onMeasure = async () => {
      if (++n === 2) await blocked;
    };
    await submit("thr_w1", "TA", 800);
    void engine.settle();
    await waitFor(() => store.candidateByN(id, 1)!.stage === "measuring");
    await waitFor(() => store.sampleCount(store.candidateByN(id, 1)!.id) > 0);
    expect(store.sampleCount(store.candidateByN(id, 1)!.id)).toBeGreaterThan(0);
    // "Restart": a fresh engine on the same database.
    const fresh = new Engine(engine.ctx);
    benchA.onMeasure = null;
    const r = await fresh.reconcile();
    expect(r.requeued).toBe(1);
    const c = store.candidateByN(id, 1)!;
    expect(c.stage).toBe("queued");
    expect(c.measure_restarts).toBe(1);
    expect(store.sampleCount(c.id)).toBe(0);
    expect(store.benchHost(id, "host_a")!.best_build_sha).toBeNull(); // the old process's build cache is not trusted
    block();
    await fresh.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
  });

  it("a bundle above max_bundle_mib fails clearly and nothing is measured", async () => {
    const id = await running({ maxBundleMib: 1 });
    edit.bundleSizeOverride = 5 * 1024 * 1024;
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    expect(c.verdict).toBe("rejected");
    expect(JSON.parse(c.reasons_json!)[0]).toMatch(/could not send the candidate to bench host bench-a: git bundle for [0-9a-f]+ is 5\.0 MiB, above the 1\.0 MiB limit/u);
    expect(store.transfers(id)[0]).toMatchObject({ ok: 0 });
    expect(store.sampleCount(c.id)).toBe(0);
  });

  it("study page overview shows bench hosts with health, queue, drift and segment", async () => {
    const id = await running({ drift: "every = 5" });
    await submit("thr_w1", "TA", 1200);
    await engine.settle();
    const o = overview(engine, store.study(id)!);
    expect(o.benchHosts).toHaveLength(1);
    expect(o.benchHosts[0]).toMatchObject({ name: "bench-a", mode: "clone", status: "online", healthOk: true, evalsSinceDrift: 1, driftEvery: 5, measuring: null });
    expect(o.segment).toMatchObject({ k: 1, count: 1, pendingSpecVersion: null });
    expect(o.benchHosts[0]!.bundles).toBeGreaterThanOrEqual(2);
  });

  it("local bench hosts keep the shared M1 path: no bundles, project checkouts", async () => {
    const id = await running({ benchHosts: ["local"] });
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    expect(store.transfers(id)).toHaveLength(0);
    expect(store.benchHosts(id)[0]).toMatchObject({ mode: "shared", host_id: "host_test" });
    expect([...edit.checkouts.keys()]).toContain(`/co/${SLUG}-best`);
  });
});

describe("M2 expensive class", () => {
  function spec(extra = "") {
    const r = parseSpec(m2Spec({ noise: "expensive", protocol: `confirm_runs = 3\ncalibration_runs = 5\n${extra}` }));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return r.spec;
  }
  /** A bench whose candidate is `effect` better with gaussian-ish noise sigma. */
  function bench(effect: number, sigma: number, seed: number): Bench & { order: string[] } {
    const rng = seededRng(seed);
    const gauss = () => (rng() + rng() + rng() + rng() - 2) * Math.sqrt(3);
    const order: string[] = [];
    return {
      order,
      async run(side) {
        order.push(side);
        const v = 1000 * (side === "candidate" ? 1 - effect : 1) * (1 + sigma * gauss());
        return { metrics: { size: v, rss: 100 }, diag: [], durationMs: 3_600_000 };
      },
    };
  }

  it("calibrates sigma from baseline runs and screens with one run; confirms wins with k=3 fresh runs", async () => {
    const s = spec();
    const cal = await expensiveStrategy.calibrate({ bench: bench(0, 0.01, 1), spec: s, rng: seededRng(1), record: () => {} });
    expect(cal.baselineRuns).toHaveLength(5);
    expect(cal.noiseFloor).toBeGreaterThan(0.002);
    expect(cal.report).toContain("confirmed with 3 more");
    const loser = bench(0, 0.01, 2);
    const o1 = await expensiveStrategy.measure({ bench: loser, spec: s, mde: cal.mde, rng: seededRng(1), record: () => {}, baseline: cal.baselineRuns!, noiseFloor: cal.noiseFloor });
    expect(loser.order).toEqual(["candidate"]); // one run, the baseline came from calibration
    expect(o1.decision).not.toBe("win");
    const winner = bench(0.1, 0.01, 3);
    const o2 = await expensiveStrategy.measure({ bench: winner, spec: s, mde: cal.mde, rng: seededRng(1), record: () => {}, baseline: cal.baselineRuns!, noiseFloor: cal.noiseFloor });
    expect(o2.decision).toBe("win");
    expect(winner.order).toEqual(["candidate", "candidate", "candidate", "candidate"]);
    expect(o2.confirmRuns).toHaveLength(3);
    expect(o2.effect).toBeGreaterThan(0.08);
  });

  it("false wins stay rare and real wins are found (simulation)", async () => {
    const s = spec();
    const sigma = 0.02;
    const baseline = (await expensiveStrategy.calibrate({ bench: bench(0, sigma, 7), spec: s, rng: seededRng(1), record: () => {} })).baselineRuns!;
    let falseWins = 0;
    let trueWins = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      const o = await expensiveStrategy.measure({ bench: bench(0, sigma, 100 + i), spec: s, mde: 0.01, rng: seededRng(i), record: () => {}, baseline, noiseFloor: sigma });
      if (o.decision === "win") falseWins += 1;
      const t = await expensiveStrategy.measure({ bench: bench(4 * sigma, sigma, 1000 + i), spec: s, mde: 0.01, rng: seededRng(i), record: () => {}, baseline, noiseFloor: sigma });
      if (t.decision === "win") trueWins += 1;
    }
    expect(falseWins / N).toBeLessThan(0.02);
    expect(trueWins / N).toBeGreaterThan(0.5);
  });
});

describe("M2 control clamping and audit", () => {
  it("concurrency can only go down to the spec's max_workers; every control is an audited event and notice", async () => {
    const edit = new FakeHost();
    const { ctx, store, port } = makeCtx(edit);
    const engine = new Engine(ctx);
    const base = edit.commit("T0", null, "base");
    edit.refs.set("main", base);
    edit.metric.set("T0", 1000);
    port.addThread("thr_study");
    await engine.proposeStudy("thr_study", "proj_1", m2Spec({ benchHosts: ["local"], maxWorkers: 3 }));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    engine.addIdea(SLUG, { title: "Idea A", theme: "a" }, "human");
    await engine.start(SLUG, "human");
    await engine.settle();
    const id = store.study(SLUG)!.id;
    expect(engine.setConcurrency(SLUG, 10, "rpc:client")).toContain("clamped from 10: the approved spec allows at most 3");
    expect(engine.maxWorkers(store.study(id)!)).toBe(3);
    expect(engine.setConcurrency(SLUG, 2, "rpc:client")).toContain("max workers set to 2.");
    expect(engine.maxWorkers(store.study(id)!)).toBe(2);
    // A worker turn is running when the RPC arrives: the audit names it and the study thread is flagged.
    expect(port.threads.get("thr_w1")!.status).toBe("active");
    const unreadBefore = port.unread.length;
    await engine.auditControl(SLUG, "concurrency", { via: "rpc" }, "max workers set to 2", { requested: 2 });
    const ev = store.events(id, { kinds: ["control.concurrency"] })[0]!;
    expect(ev.actor).toBe("rpc:client");
    expect(JSON.parse(ev.data_json)).toMatchObject({ via: "rpc", active_agent_turns: ["thr_w1 (worker)"] });
    const notice = store.notices(id)[0]!;
    expect(notice.kind).toBe("control.concurrency");
    expect(notice.text).toContain("thr_w1 (worker)");
    expect(port.unread.length).toBe(unreadBefore + 1);
    // No agent turn running: the notice is recorded quietly.
    port.threads.get("thr_w1")!.status = "idle";
    await engine.auditControl(SLUG, "pause", { via: "cli", threadId: null }, "study paused");
    expect(store.events(id, { kinds: ["control.pause"] })[0]!.actor).toBe("cli:human");
    expect(port.unread.length).toBe(unreadBefore + 1);
  });
});
