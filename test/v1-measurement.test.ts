// v1, measurement quality (docs/release-notes.md, 1.0), against fake hosts:
// per-host win thresholds, dispatch to the quietest free host, hosts much
// noisier than their peers left out, and an automatic recalibration that
// waits for a healthy bench instead of pausing.
import { beforeEach, describe, expect, it } from "vitest";
import { showStudy } from "../src/cli.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { chanceRatio, hostThresholdsText, noisyAgainstPeers, noisyOutliers, quietestFirst } from "../src/host-choice.ts";
import { studyEvidence } from "../src/evidence.ts";
import { measurementMde } from "../src/pipeline.ts";
import type { MeasureResult } from "../src/primitives.ts";
import { oracleHash, parseSpec } from "../src/spec.ts";
import { seededRng } from "../src/stats.ts";
import { benchHostsView, oracleView, overview, statusLine } from "../src/views.ts";
import { FakeHost, healthyReport, makeCtx, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-v1";

function v1Spec(o: { benchHosts?: string[]; oracle?: string; health?: string; protocol?: string; drift?: string } = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy program faster on two bench machines."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
build = "build it"
gate = ["gate run"]
measure = "measure run"
noise = "noisy"
bench_hosts = ${JSON.stringify(o.benchHosts ?? ["bench-a", "bench-b"])}
${o.oracle ?? ""}

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 8
calibration_pairs = 12
bootstrap = 300
min_effect = "0.1%"
side_runs = 1
${o.protocol ?? ""}

[oracle.drift]
${o.drift ?? "every = 0"}

[oracle.health]
notify_after_minutes = 0
${o.health ?? ""}

[budget]
max_workers = 2
max_candidates = 20

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

/** Uniform noise of ±half `width` (relative), seeded. */
function uniform(seed: number, width: number): () => number {
  const rng = seededRng(seed);
  return () => (rng() - 0.5) * width;
}

describe("host choice (pure)", () => {
  it("a host is noisy against the median of its peers; with two hosts the peer is the other one, and the quietest always stays", () => {
    expect(noisyAgainstPeers(0.0544, [0.0242], 2)).toMatchObject({ peers: 0.0242, ratio: expect.closeTo(2.25, 2) });
    expect(noisyAgainstPeers(0.0242, [0.0544], 2)).toBeNull();
    expect(noisyAgainstPeers(0.04, [0.0242], 2)).toBeNull(); // 1.65×
    expect(noisyAgainstPeers(0.0544, [0.0242], 0)).toBeNull(); // off
    expect(noisyAgainstPeers(0.0544, [], 2)).toBeNull(); // no peers
    expect(noisyAgainstPeers(0.0544, [null, 0], 2)).toBeNull(); // peers without a noise floor
    const hosts = [
      { hostId: "a", name: "a", noiseFloor: 0.01 },
      { hostId: "b", name: "b", noiseFloor: 0.03 },
      { hostId: "c", name: "c", noiseFloor: 0.07 },
    ];
    // c: 7% against median(1%, 3%) = 2%: 3.5×. b: 3% against median(1%, 7%) = 4%: fine.
    expect(noisyOutliers(hosts, 2).map((h) => h.hostId)).toEqual(["c"]);
    expect(noisyOutliers(hosts, 4)).toEqual([]);
  });

  it("chance: with few calibration samples, a ratio two equal hosts reach by chance is not enough", () => {
    // About 1% of equal-host pairs exceed it (robust SD of n A/A pairs; sample SD of n runs).
    expect(chanceRatio("noisy", 12)).toBeCloseTo(3.44, 1);
    expect(chanceRatio("noisy", 40)).toBeCloseTo(1.97, 1);
    expect(chanceRatio("expensive", 5)).toBeGreaterThan(3);
    expect(chanceRatio("deterministic", 12)).toBe(1);
    // The real-world case: 5.44% against 2.42% (2.25×) is above the 2× limit, but 12 pairs can't tell it from chance.
    expect(noisyAgainstPeers(0.0544, [0.0242], 2, chanceRatio("noisy", 12))).toMatchObject({ significant: false, needed: expect.closeTo(3.44, 1) });
    expect(noisyAgainstPeers(0.0544, [0.0242], 2, chanceRatio("noisy", 40))).toMatchObject({ significant: true, needed: 2 });
    expect(noisyOutliers([{ hostId: "a", name: "a", noiseFloor: 0.0544 }, { hostId: "b", name: "b", noiseFloor: 0.0242 }], 2, chanceRatio("noisy", 12))).toEqual([expect.objectContaining({ hostId: "a", significant: false })]);
  });

  it("dispatch order: lowest threshold, then lowest noise, then spec order; uncalibrated last", () => {
    const rows = [
      { id: "a", mde: 0.03, noise_floor: 0.05 },
      { id: "b", mde: 0.014, noise_floor: 0.024 },
      { id: "c", mde: null, noise_floor: null },
      { id: "d", mde: 0.014, noise_floor: 0.02 },
      { id: "e", mde: 0.03, noise_floor: 0.05 },
    ];
    expect(quietestFirst(rows, (h) => h.mde).map((h) => h.id)).toEqual(["d", "b", "a", "e", "c"]);
  });

  it("thresholds in words, quietest first", () => {
    expect(hostThresholdsText([{ name: "gcp-a", mde: 0.0333 }, { name: "gcp-b", mde: 0.0142 }])).toBe("1.42% on gcp-b, 3.33% on gcp-a");
    expect(hostThresholdsText([{ name: "a", mde: 0.01 }, { name: "b", mde: 0.01 }])).toBe("1.00% on every host");
    expect(hostThresholdsText([{ name: "a", mde: 0.02 }])).toBe("2.00%");
    expect(hostThresholdsText([])).toBe("");
  });

  it("the new spec keys don't change the oracle hash (older specs keep theirs)", () => {
    const parsed = (extra: string) => {
      const r = parseSpec(v1Spec({ oracle: extra.split("|")[0], health: extra.split("|")[1] ?? "" }));
      if (!r.ok) throw new Error(r.errors.join("; "));
      return r.spec;
    };
    const base = parsed("");
    expect(base.oracle.max_host_noise_ratio).toBe(2);
    expect(base.oracle.health.recalibration_retries).toBe(30);
    expect(oracleHash(parsed("max_host_noise_ratio = 0|recalibration_retries = 3"))).toBe(oracleHash(base));
    expect(oracleHash(parsed("max_host_noise_ratio = 5"))).toBe(oracleHash(base));
    // A spec stored before 1.0 (no such keys at all) hashes the same.
    const { max_host_noise_ratio: _r, ...oracle } = base.oracle;
    const { recalibration_retries: _h, ...health } = base.oracle.health;
    expect(oracleHash({ ...base, oracle: { ...oracle, health } as never })).toBe(oracleHash(base));
    expect(parseSpec(v1Spec({ oracle: "max_host_noise_ratio = 0.5" })).ok).toBe(false);
  });
});

describe("v1 measurement quality (fake hosts)", () => {
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

  async function calibrated(toml: string) {
    const r = await engine.proposeStudy("thr_study", "proj_1", toml);
    expect(r).toContain("Draft ready:");
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 10_000);
    return store.study(SLUG)!;
  }

  async function running(toml: string) {
    const s = await calibrated(toml);
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

  it("each host decides with its own win threshold, and a candidate goes to the quietest free host first", async () => {
    // bench-a (listed first) is noisier than bench-b, but within the ratio: both measure.
    benchA.noise = uniform(1, 0.03);
    benchB.noise = uniform(2, 0.015);
    const id = await running(v1Spec({ oracle: "max_host_noise_ratio = 10" }));
    const a = store.benchHost(id, "host_a")!;
    const b = store.benchHost(id, "host_b")!;
    expect(a.mde!).toBeGreaterThan(b.mde!);
    const seg = store.segment(id, 1)!;
    // The segment's columns keep the worst host's numbers; the report gives each host's.
    expect(seg.mde).toBeCloseTo(a.mde!, 9);
    expect(seg.report).toMatch(/^2 bench hosts, each deciding with its own win threshold: [\d.]+% on bench-b, [\d.]+% on bench-a \(noise floor per pair: bench-b [\d.]+%, bench-a [\d.]+%\); a candidate goes to the quietest free host\. bench-b: Detects changes/u);
    // One candidate at a time: the quiet host takes it, and judges it with its own threshold.
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    const c1 = store.candidateByN(id, 1)!;
    expect(c1.bench_host_id).toBe("host_b");
    expect(c1.verdict).toBe("win");
    const m1 = JSON.parse(c1.metrics_json!) as { mde: number };
    expect(m1.mde).toBeCloseTo(Math.max(0.001, b.mde!), 9);
    expect(m1.mde).toBeLessThan(seg.mde!);
    expect(measurementMde(store, store.study(id)!, store.spec(store.study(id)!), a)).toBeCloseTo(a.mde!, 9);
    // Two at once: both hosts measure, each with its own threshold.
    await Promise.all([submit("thr_w1", "TB", 1300), submit("thr_w2", "TC", 1400)]);
    await engine.settle();
    const later = [store.candidateByN(id, 2)!, store.candidateByN(id, 3)!];
    expect(new Set(later.map((c) => c.bench_host_id))).toEqual(new Set(["host_a", "host_b"]));
    for (const c of later) {
      const host = store.benchHost(id, c.bench_host_id!)!;
      expect((JSON.parse(c.metrics_json!) as { mde: number }).mde).toBeCloseTo(Math.max(0.001, host.mde!), 9);
    }
    // Surfaces: the Overview's threshold line, the Oracle tab, the bench host list, the CLI.
    const s = store.study(id)!;
    const o = overview(engine, s);
    expect(o.calibration.thresholds).toMatch(/^[\d.]+% on bench-b, [\d.]+% on bench-a$/u);
    expect(o.benchHosts.find((h) => h.hostId === "host_b")!.threshold).toBeCloseTo(Math.max(0.001, b.mde!), 9);
    const oracle = oracleView(engine, s);
    expect(oracle.calibration.thresholds).toBe(o.calibration.thresholds);
    expect(oracle.calibration.hosts.map((h) => h.excluded)).toEqual([null, null]);
    expect(oracle.segments[0]!.thresholds).toBe(o.calibration.thresholds);
    expect(oracle.calibration.noiseText).toMatch(/^Run-to-run noise is [\d.]+% to [\d.]+% per pair, depending on the bench host\.$/u);
    const shown = showStudy(engine, SLUG, 0);
    expect(shown).toMatch(/MDE:\s+[\d.]+% on bench-b, [\d.]+% on bench-a \(each host decides with its own\)/u);
    expect(shown).toMatch(/bench-b \[own clone via git bundles\] online · health ok · win threshold [\d.]+%, noise [\d.]+%/u);
  });

  it("a host much noisier than its peers measures nothing until the next calibration, with a notice; the next calibration measures it again", async () => {
    benchA.noise = uniform(3, 0.2);
    benchB.noise = uniform(4, 0.01);
    const id = await running(v1Spec());
    const a = store.benchHost(id, "host_a")!;
    expect(a.excluded_json).not.toBeNull();
    expect(JSON.parse(a.excluded_json!)).toMatchObject({ reason: expect.stringMatching(/^noise floor [\d.]+% per pair, [\d.]+× the [\d.]+% median of the other bench hosts, above max_host_noise_ratio 2$/u), segment: 1 });
    expect(store.benchHost(id, "host_b")!.excluded_json).toBeNull();
    // The segment is the quiet host's: the noisy one's numbers don't count.
    const seg = store.segment(id, 1)!;
    expect(seg.mde).toBeCloseTo(store.benchHost(id, "host_b")!.mde!, 9);
    expect(seg.report).toContain("Not used: bench-a (noise floor");
    const report = JSON.parse(store.study(id)!.calibration_json!) as { warnings: string[]; hosts: Array<{ name: string; excluded?: string }> };
    expect(report.warnings[0]).toMatch(/^bench-a is much noisier than the other bench hosts \(noise floor .*\): it measures nothing until the next calibration\.$/u);
    expect(report.hosts.find((h) => h.name === "bench-a")!.excluded).toBeTruthy();
    expect(store.notices(id).find((n) => n.kind === "calibration.ready")!.text).toContain("Warning: bench-a is much noisier than the other bench hosts");
    expect(store.events(id, { kinds: ["bench.noisy_host"] }).map((e) => JSON.parse(e.data_json))).toEqual([expect.objectContaining({ host: "host_a", action: "excluded", when: "calibration", limit: 2 })]);
    // Two candidates at once: both wait for bench-b; bench-a measures nothing (no drift checks either).
    await Promise.all([submit("thr_w1", "TA", 1300), submit("thr_w2", "TB", 1400)]);
    await engine.settle();
    expect(store.candidates(id).map((c) => c.bench_host_id)).toEqual(["host_b", "host_b"]);
    expect(benchA.commands.filter((c) => c.startsWith("measure")).length).toBe(24); // its calibration only (12 pairs)
    const s = store.study(id)!;
    expect(benchHostsView(engine, s).find((h) => h.hostId === "host_a")).toMatchObject({ excluded: expect.stringContaining("noise floor"), threshold: expect.any(Number) });
    expect(overview(engine, s).calibration.thresholds).toMatch(/^[\d.]+%$/u);
    expect(oracleView(engine, s).calibration.hosts.find((h) => h.name === "bench-a")!.excluded).toContain("median of the other bench hosts");
    expect(showStudy(engine, SLUG, 0)).toContain("NOT USED until the next calibration (noise floor");
    // The next calibration (an oracle change mid-run) measures it again: quiet now, it is back.
    benchA.noise = uniform(5, 0.012);
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 10_000);
    expect(store.study(id)!.calibration_status).toBe("ready");
    expect(store.benchHost(id, "host_a")!.excluded_json).toBeNull();
  });

  it("1.0: `bb study measure` goes to the quietest host with that host's own threshold, and never to a host left out for its noise", async () => {
    benchA.noise = uniform(3, 0.2);
    benchB.noise = uniform(4, 0.01);
    const id = await running(v1Spec());
    await submit("thr_w1", "TA", 800);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    const s = store.study(id)!;
    const spec = store.spec(s);
    expect(store.benchHost(id, "host_a")!.excluded_json).not.toBeNull();
    const row = await engine.requestMeasure(SLUG, { refA: "base", refB: "best" }, "human");
    // The host is chosen when the run starts, not pinned at the request.
    expect(row.host_id).toBeNull();
    await engine.primitives.wait(row.id, 10_000);
    const done = store.adhocRun(row.id)!;
    expect(done.state, done.error ?? "").toBe("done");
    expect(done.host_id).toBe("host_b");
    const result = JSON.parse(done.result_json!) as MeasureResult;
    expect(result.host.id).toBe("host_b");
    expect(result.threshold).toBeCloseTo(measurementMde(store, s, spec, store.benchHost(id, "host_b")!), 9);
    expect(result.threshold).toBeLessThan(measurementMde(store, s, spec, store.benchHost(id, "host_a")!));
    expect(result.classification).toBe("win");
    // The noisy host measured nothing beyond its calibration, and naming it is refused with the reason.
    expect(benchA.commands.filter((c) => c.startsWith("measure")).length).toBe(24);
    await expect(engine.requestMeasure(SLUG, { refA: "base", refB: "best", host: "bench-a" }, "human")).rejects.toThrow(/bench-a is not used until the next calibration \(noise floor/u);
    // The evidence gives each host's own threshold and the exclusion.
    const ev = await studyEvidence(engine.ctx, s, spec);
    expect(ev.benchHosts.find((h) => h.id === "host_a")).toMatchObject({ excluded: expect.stringContaining("median of the other bench hosts") });
    expect(ev.benchHosts.find((h) => h.id === "host_b")!.threshold).toBeCloseTo(result.threshold, 9);
  });

  it("a host above the ratio but within chance keeps measuring, and calibration says why", async () => {
    // About 2.5× noisier, with the default 12 calibration pairs (chance reaches 3.4×).
    benchA.noise = uniform(11, 0.025);
    benchB.noise = uniform(12, 0.01);
    const id = await running(v1Spec());
    const [a, b] = [store.benchHost(id, "host_a")!, store.benchHost(id, "host_b")!];
    const ratio = a.noise_floor! / b.noise_floor!;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(chanceRatio("noisy", 12));
    expect(store.benchHosts(id).map((h) => h.excluded_json)).toEqual([null, null]);
    const report = JSON.parse(store.study(id)!.calibration_json!) as { warnings: string[] };
    expect(report.warnings[0]).toMatch(/^bench-a's noise floor \([\d.]+% per pair\) is [\d.]+× the [\d.]+% median of the other bench hosts, above max_host_noise_ratio 2, but with 12 calibration pairs two equal hosts differ that much by chance \(it would take more than 3\.4×\): it keeps measuring, with its own win threshold\. More calibration pairs would tell them apart$/u);
  });

  it("max_host_noise_ratio = 0 keeps every host, however noisy", async () => {
    benchA.noise = uniform(3, 0.2);
    benchB.noise = uniform(4, 0.01);
    const id = await running(v1Spec({ oracle: "max_host_noise_ratio = 0" }));
    expect(store.benchHosts(id).map((h) => h.excluded_json)).toEqual([null, null]);
    expect(store.events(id, { kinds: ["bench.noisy_host"] })).toHaveLength(0);
  });

  const unhealthy = healthyReport({ loadavg: [40, 40, 40] });

  it("an automatic recalibration whose health check fails tries again after retry_seconds instead of pausing", async () => {
    const id = await running(v1Spec({ benchHosts: ["bench-a"], health: "retry_seconds = 30", drift: "every = 0\nrecalibrate_below = 0.6" }));
    // The win makes best's runs 5× shorter (a recalibration is due); the bench gets busy during its measurement.
    benchA.onMeasure = () => {
      benchA.healthReport = unhealthy;
    };
    await submit("thr_w1", "TA", 200, 1000);
    await engine.settle();
    benchA.onMeasure = null;
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    let s = store.study(id)!;
    expect(s.state).toBe("running");
    expect(s.segment).toBe(1);
    expect(s.recalibrate_due).not.toBeNull();
    expect(JSON.parse(s.recalibrate_due!)).toMatchObject({ health_retries: 1, retry_at: clock.now() + 30_000 });
    expect(store.events(id, { kinds: ["recalibration.deferred"] }).map((e) => JSON.parse(e.data_json))).toEqual([expect.objectContaining({ tries: 1, max: 30, retry_seconds: 30 })]);
    expect(store.events(id, { kinds: ["recalibration.started", "recalibration.failed"] })).toHaveLength(0);
    expect(statusLine(engine, s)).toContain("recalibrating on best waits for a healthy bench (retry 1 of 30, next in 30 s)");
    // Not before retry_seconds.
    benchA.healthReport = healthyReport();
    clock.advance(10_000);
    engine.pipeline.kick();
    await engine.settle();
    expect(store.study(id)!.segment).toBe(1);
    // Then it runs, and the study never paused.
    clock.advance(21_000);
    engine.pipeline.kick();
    await engine.settle();
    s = store.study(id)!;
    expect(s.segment).toBe(2);
    expect(s.recalibrate_due).toBeNull();
    expect(s.state).toBe("running");
    expect(store.events(id, { kinds: ["study.state"] }).some((e) => e.data_json.includes('"paused"'))).toBe(false);
  });

  it("the retries are bounded: after recalibration_retries the study pauses, and resuming recalibrates first", async () => {
    const id = await running(v1Spec({ benchHosts: ["bench-a"], health: "retry_seconds = 30\nrecalibration_retries = 2", drift: "every = 0\nrecalibrate_below = 0.6" }));
    benchA.onMeasure = () => {
      benchA.healthReport = unhealthy;
    };
    await submit("thr_w1", "TA", 200, 1000);
    await engine.settle();
    benchA.onMeasure = null;
    for (let i = 0; i < 2; i++) {
      expect(store.study(id)!.state).toBe("running");
      clock.advance(31_000);
      engine.pipeline.kick();
      await engine.settle();
    }
    let s = store.study(id)!;
    expect(s.state).toBe("paused");
    expect(s.pause_reason).toMatch(/^automatic recalibration failed \(.*\): a bench host stayed unhealthy through 2 retries, 30 s apart: bench-a: health check failed: .*then resume: it recalibrates first$/u);
    expect(store.events(id, { kinds: ["recalibration.deferred"] })).toHaveLength(2);
    expect(JSON.parse(s.recalibrate_due!)).toMatchObject({ health_retries: 0 });
    expect(store.notices(id).some((n) => n.kind === "drift" && n.text.includes("paused itself: automatic recalibration failed"))).toBe(true);
    benchA.healthReport = healthyReport();
    engine.resume(SLUG, "human");
    await engine.settle();
    s = store.study(id)!;
    expect(s.state).toBe("running");
    expect(s.segment).toBe(2);
    expect(s.recalibrate_due).toBeNull();
  });

  it("a recalibration that finds a host much noisier than its peers leaves it out of the new segment", async () => {
    benchA.noise = uniform(6, 0.01);
    benchB.noise = uniform(7, 0.01);
    const id = await running(v1Spec({ drift: "every = 0\nrecalibrate_below = 0.6" }));
    expect(store.benchHosts(id).map((h) => h.excluded_json)).toEqual([null, null]);
    // bench-a gets disturbed; a win with 5× shorter runs triggers the recalibration.
    const loud = uniform(8, 0.3);
    const disturb = () => {
      benchA.noise = loud;
    };
    benchA.onMeasure = disturb;
    benchB.onMeasure = disturb;
    await submit("thr_w1", "TA", 200, 1000);
    await engine.settle();
    benchA.onMeasure = null;
    benchB.onMeasure = null;
    const s = store.study(id)!;
    expect(s.segment).toBe(2);
    expect(s.state).toBe("running");
    expect(store.benchHost(id, "host_a")!.excluded_json).not.toBeNull();
    expect(store.events(id, { kinds: ["bench.noisy_host"] }).map((e) => JSON.parse(e.data_json))).toEqual([expect.objectContaining({ host: "host_a", action: "excluded", when: "recalibration" })]);
    expect(store.notices(id).find((n) => n.kind === "segment.recalibrated")!.text).toContain("bench-a is much noisier than the other bench hosts");
    expect(store.segment(id, 2)!.mde).toBeCloseTo(store.benchHost(id, "host_b")!.mde!, 9);
  });
});
