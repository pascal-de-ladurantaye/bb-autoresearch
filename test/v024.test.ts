// v0.2.4 engine fixes against fake hosts: side runs per pair (A4), the
// automatic recalibration when best's runs get much shorter (A4) versus a
// genuine drift pause, and measurements held while a study is paused for
// drift (A5).
import { beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { autoSideRuns, combineRuns, repeatBench, type Bench } from "../src/noise.ts";
import { parseSpec, oracleHash, normalizeSpec, type StudySpec } from "../src/spec.ts";
import { seededRng } from "../src/stats.ts";
import { FakeHost, makeCtx, type FakePort } from "./helpers.ts";
import { bestView, candidateDetail, harvestView } from "../src/views.ts";
import { liveView } from "../src/live.ts";
import { showStudy } from "../src/cli.ts";
import { studyReport } from "../src/report.ts";

const SLUG = "toy-v024";

function v024Spec(o: { protocol?: string; drift?: string } = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy program faster on the bench."
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
measure = "measure run"
noise = "noisy"
bench_hosts = ["bench-a"]

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

[budget]
max_workers = 2
max_candidates = 20

[agents]
max_submissions_per_worker = 5
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

describe("side runs", () => {
  const spec = (p: string): StudySpec => {
    const r = parseSpec(v024Spec({ protocol: p }));
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.spec;
  };
  it("auto picks enough runs for a side to last min_side_seconds, capped", () => {
    expect(autoSideRuns(5, 5)).toBe(1);
    expect(autoSideRuns(6, 5)).toBe(1);
    expect(autoSideRuns(1, 5)).toBe(5);
    expect(autoSideRuns(1.2, 5)).toBe(5);
    expect(autoSideRuns(0.4, 5)).toBe(13);
    expect(autoSideRuns(0.01, 5)).toBe(30);
    expect(autoSideRuns(2, 0)).toBe(1);
  });
  it("keeps each metric's best value in its own direction (min for lower, max for higher)", () => {
    const s = spec("");
    const higher = { ...s, guardrail: [{ ...s.guardrail[0]!, direction: "higher" as const }] };
    const runs = [
      { metrics: { size: 10, rss: 5, other: 3 }, diag: ["a"], durationMs: 100 },
      { metrics: { size: 8, rss: 7, other: 4 }, diag: ["b"], durationMs: 120 },
    ];
    expect(combineRuns(runs, s)).toEqual({ metrics: { size: 8, rss: 5, other: 3 }, diag: ["b"], durationMs: 220, reps: 2 });
    expect(combineRuns(runs, higher).metrics.rss).toBe(7);
  });
  it("repeats every side n times", async () => {
    let calls = 0;
    const b: Bench = { run: async () => ({ metrics: { size: 10 - calls++ }, diag: [], durationMs: 1 }) };
    const r = await repeatBench(b, spec(""), 3).run("best");
    expect(calls).toBe(3);
    expect(r).toMatchObject({ metrics: { size: 8 }, reps: 3 });
  });
  it("new protocol keys at their defaults leave the oracle hash of an older spec unchanged", () => {
    const s = spec("");
    const old = JSON.parse(JSON.stringify(s)) as StudySpec;
    for (const k of ["futility", "early_lose_from", "early_lose_confidence", "skip_confirm_factor", "side_runs", "min_side_seconds"]) delete (old.oracle.protocol as Record<string, unknown>)[k];
    delete (old.oracle.drift as Record<string, unknown>).recalibrate_below;
    expect(oracleHash(normalizeSpec(old))).toBe(oracleHash(s));
    expect(oracleHash(spec("side_runs = 3"))).not.toBe(oracleHash(s));
    expect(oracleHash(spec("futility = false"))).not.toBe(oracleHash(s));
  });
});

describe("v0.2.4 engine (fake hosts)", () => {
  let edit: FakeHost;
  let benchA: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;

  beforeEach(() => {
    edit = new FakeHost();
    const made = makeCtx(edit);
    ({ store, port } = made);
    benchA = new FakeHost("host_a", edit);
    port.addHost(benchA, "bench-a");
    engine = new Engine(made.ctx);
    const base = edit.commit("T0", null, "base");
    edit.refs.set("main", base);
    edit.metric.set("T0", 1000);
    port.addThread("thr_study");
  });

  async function running(o: { protocol?: string; drift?: string } = {}) {
    const r = await engine.proposeStudy("thr_study", "proj_1", v024Spec(o));
    expect(r).toContain("Draft ready:");
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    const s = store.study(SLUG)!;
    if (s.calibration_status !== "ready") throw new Error(`calibration: ${s.calibration_json}`);
    for (const t of ["Idea A", "Idea B", "Idea C", "Idea D"]) engine.addIdea(SLUG, { title: t, theme: t, pinned: false }, "human");
    await engine.start(SLUG, "human");
    await engine.settle();
    return s.id;
  }

  async function submit(thread: string, tree: string, value: number, runMs?: number) {
    edit.nextSnapshotFor.set(`/wt/${thread}`, { tree });
    edit.metric.set(tree, value);
    if (runMs !== undefined) edit.runMs.set(tree, runMs);
    return await engine.submit(thread, { title: `change ${tree} for speed` });
  }

  const measures = () => benchA.commands.filter((c) => c.startsWith("measure")).length;

  it("side_runs = \"auto\" picks the runs per side at calibration and measures with them", async () => {
    edit.runMs.set("T0", 1000); // 1 s runs: 5 make a 5 s side
    const id = await running();
    const h = store.benchHost(id, "host_a")!;
    expect(h).toMatchObject({ side_runs: 5, run_seconds: 1 });
    expect(store.segment(id, 1)!.report).toContain("Each side of a pair is 5 runs of the measure command");
    const before = measures();
    await submit("thr_w1", "TA", 1300, 1000);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    expect(c.verdict).toBe("lose");
    // Every pair is 2 sides × 5 runs.
    const pairs = store.samples(c.id).filter((x) => x.metric === "size" && x.side === "best").length;
    expect(measures() - before).toBe(pairs * 2 * 5);
    expect(JSON.parse(c.metrics_json!)).toMatchObject({ sideRuns: 5 });
  });

  it("a fixed side_runs is used as is", async () => {
    const id = await running({ protocol: "side_runs = 2" });
    expect(store.benchHost(id, "host_a")).toMatchObject({ side_runs: 2, run_seconds: 5 });
  });

  it("recalibrates automatically (new segment, same oracle, no pause) when a promotion makes best's runs much shorter", async () => {
    // Runs of best take 5 s at calibration; the candidate is 5× faster, so its runs take 1 s.
    const id = await running({ drift: "every = 0\nrecalibrate_below = 0.6" });
    const seg1 = store.segment(id, 1)!;
    await submit("thr_w1", "TA", 200, 1000);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    const s = store.study(id)!;
    expect(s.state).toBe("running");
    expect(s.recalibrate_due).toBeNull();
    expect(s.segment).toBe(2);
    const seg2 = store.segment(id, 2)!;
    expect(seg2.oracle_hash).toBe(seg1.oracle_hash);
    expect(seg2.baseline_sha).toBe(s.best_sha);
    expect(JSON.parse(seg2.details_json!)).toMatchObject({ auto: true });
    expect(store.benchHost(id, "host_a")).toMatchObject({ side_runs: 5, run_seconds: 1 });
    expect(store.events(id, { kinds: ["recalibration.due"] })[0]!.data_json).toContain('"source":"promotion"');
    expect(store.events(id, { kinds: ["segment.started"] }).some((e) => e.data_json.includes('"auto":true'))).toBe(true);
    const notice = store.notices(id).find((n) => n.kind === "segment.recalibrated")!;
    expect(notice.text).toContain("recalibrated itself on best");
    expect(notice.text).toContain("side runs 1 → 5");
    expect(store.notices(id).map((n) => n.kind)).not.toContain("drift");
    // The next candidate is measured in segment 2, 5 runs a side.
    const before = measures();
    await submit("thr_w2", "TB", 260, 1000);
    await engine.settle();
    const c2 = store.candidateByN(id, 2)!;
    expect(c2.verdict).toBe("lose");
    const pairs = store.samples(c2.id).filter((x) => x.metric === "size" && x.side === "best").length;
    expect(measures() - before).toBe(pairs * 10);
    // Guardrails keep counting from the first segment of this oracle (an automatic segment doesn't reset the total limit).
    const { guardrailChainBase } = await import("../src/pipeline.ts");
    expect(guardrailChainBase(store, store.study(id)!)).toBe(seg1.baseline_sha);
  });

  it("a drift check that sees noisier but much shorter runs recalibrates instead of pausing; noise up at the same run time pauses", async () => {
    const rng = seededRng(5);
    benchA.noise = () => (rng() - 0.5) * 0.004;
    const id = await running({ drift: "every = 1\npairs = 6\nrecalibrate_below = 0.6" });
    // Promoted with 5 s runs (no trigger), then the same code runs in 1 s and is noisier relative to itself.
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    edit.runMs.set("TA", 1000);
    benchA.noise = () => (rng() - 0.5) * 0.1;
    store.updateBenchHost(id, "host_a", { evals_since_drift: 1 });
    engine.pipeline.requestDrift(id);
    await engine.settle();
    let s = store.study(id)!;
    expect(store.events(id, { kinds: ["drift.explained"] })).toHaveLength(1);
    expect(s.state).toBe("running");
    expect(s.segment).toBe(2);
    expect(store.benchHost(id, "host_a")!.side_runs).toBe(5);
    // Genuine drift: the noise grows again with runs as long as at the new calibration.
    benchA.noise = () => (rng() - 0.5) * 0.6;
    engine.pipeline.requestDrift(id);
    await engine.settle();
    s = store.study(id)!;
    expect(s.state).toBe("paused");
    expect(s.pause_reason).toMatch(/^noise drift on bench host bench-a/u);
    expect(s.recalibrate_due).toBeNull();
    expect(s.segment).toBe(2);
  });

  it("while paused for drift, queued candidates on that host are not measured or promoted; resume measures them", async () => {
    const rng = seededRng(7);
    benchA.noise = () => (rng() - 0.5) * 0.004;
    const id = await running({ drift: "every = 1\npairs = 6" });
    await submit("thr_w1", "TA", 1300);
    await engine.settle();
    expect(store.driftChecks(id)[0]).toMatchObject({ status: "ok" });
    // The bench gets disturbed: the next drift check pauses the study.
    benchA.noise = () => (rng() - 0.5) * 0.3;
    await submit("thr_w2", "TB", 1300);
    await engine.settle();
    expect(store.study(id)!.state).toBe("paused");
    expect(store.benchHost(id, "host_a")!.drift_status).toBe("drift");
    // A big win submitted while paused waits in the queue: no measurement, no promotion.
    benchA.noise = () => 0;
    const bestBefore = store.study(id)!.best_sha;
    await submit("thr_w1", "TC", 500);
    await engine.settle();
    const c = store.candidateByN(id, 3)!;
    expect(c.stage).toBe("queued");
    expect(store.events(id, { kinds: ["measure.started"] }).filter((e) => e.data_json.includes(`"candidate":${c.id},`))).toHaveLength(0);
    expect(store.study(id)!.best_sha).toBe(bestBefore);
    expect(store.events(id, { kinds: ["best.promoted"] })).toHaveLength(0);
    engine.resume(SLUG, "human");
    await engine.settle();
    expect(store.candidateByN(id, 3)!.verdict).toBe("win");
    expect(store.benchHost(id, "host_a")!.drift_status).not.toBe("drift");
  });

  it("best vs base across segments: the headline compounds every segment and says so; raw values are this segment's (Overview, CLI, Live, report)", async () => {
    const id = await running({ drift: "every = 0\nrecalibrate_below = 0.6" });
    await submit("thr_w1", "TA", 500, 1000); // 50% lower, 5× shorter runs: segment 2 starts
    await engine.settle();
    expect(store.study(id)!.segment).toBe(2);
    let b = bestView(engine, store.study(id)!);
    expect(b.text).toBe("50.0% lower size (2.0×) across 2 segments");
    expect(b.raw).toBe("this segment: 500 ms, no promotion yet");
    await submit("thr_w2", "TB", 250, 1000); // another 50% in segment 2
    await engine.settle();
    expect(store.candidateByN(id, 2)!.verdict).toBe("win");
    b = bestView(engine, store.study(id)!);
    expect(b.text).toBe("75.0% lower size (4.0×) across 2 segments");
    expect(b.raw).toBe("this segment 500 → 250 ms");
    const s = store.study(id)!;
    expect(showStudy(engine, SLUG, 0)).toContain("75.0% lower size (4.0×) across 2 segments · this segment 500 → 250 ms");
    const live = liveView(engine, s);
    expect(live.best).toMatchObject({ text: "75.0% lower size (4.0×) across 2 segments", segments: 2, raw: "this segment 500 → 250 ms" });
    expect(studyReport(engine.ctx, s, store.spec(s), null)).toContain("75.0% lower size (4.0×) across 2 segments (compounded from the promoted candidates) · this segment 500 → 250 ms");
    // A harvest after a recalibration: the base's raw value comes from its own base-vs-best measurement, not the segment's baseline.
    const h = store.insertHarvest({ study_id: id, from_state: "paused" }, "human");
    store.updateHarvest(h.id, { state: "ready", base_sha: s.base_sha, best_sha: s.best_sha, total_effect: 3, total_ci_lo: 2.9, total_ci_hi: 3.1 });
    expect((harvestView(engine, store.study(id)!).harvest as { headline: { raw: string } }).headline.raw).toBe("≈ 1,000 → 250 ms");
  });

  it("a candidate's verdict reasons read like the rest of the page (CI +x% to +y%, n pairs)", async () => {
    const id = await running();
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const d = await candidateDetail(engine, store.study(id)!, 1);
    expect(d!.reasons[0]).toMatch(/^primary metric improved 20\.0% \((CI \+[\d.]+% to \+[\d.]+%, )?\d+ pairs?\)$/u);
    expect(d!.reasons.join(" ")).not.toMatch(/n=\d|\.\./u);
  });
});
