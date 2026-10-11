// Guardrails: per-step and cumulative limits, judged on a CI for every noise
// class, calibrated noise, and the view model. See docs/design.md,
// "Guardrails and holdout" and "Implementation notes: guardrails and
// pre-release fixes".
import { beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import {
  chainPosition,
  checkLimit,
  compose,
  estimateRuns,
  headroomWords,
  invertRegression,
  judgeGuardrail,
  ZERO_POSITION,
  type Position,
} from "../src/guardrails.ts";
import { deterministicStrategy, expensiveStrategy, noisyStrategy, type Bench, type MeasureOutcome } from "../src/noise.ts";
import { parseSpec, type StudySpec } from "../src/spec.ts";
import { median, seededRng, type Rng } from "../src/stats.ts";
import { verdictMessage } from "../src/prompts.ts";
import { studyReport } from "../src/report.ts";
import { applyConfirmation, decideVerdict, outcomeEstimates } from "../src/verdict.ts";
import { candidateDetail, candidatesView, guardrailStatus, oracleView, overview } from "../src/views.ts";
import { DETERMINISTIC_SPEC, FakeHost, fakeHostSpec, makeCtx, type FakePort } from "./helpers.ts";

function spec(over: { guardrail?: string; noise?: string; protocol?: string } = {}): StudySpec {
  let toml = DETERMINISTIC_SPEC.replace('noise = "deterministic"', `noise = "${over.noise ?? "deterministic"}"${over.protocol ? `\n\n[oracle.protocol]\n${over.protocol}` : ""}`);
  if (over.guardrail) toml = toml.replace('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\n', over.guardrail);
  const r = parseSpec(toml);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.spec;
}

/** Box-Muller standard normal. */
function gauss(rng: Rng): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

describe("spec: max_total_regression", () => {
  it("defaults to max_regression, validates, warns when below it, and is part of the oracle hash", async () => {
    const { oracleHash } = await import("../src/spec.ts");
    const plain = spec();
    expect(plain.guardrail[0]).toMatchObject({ max_regression: 0.05, max_total_regression: 0.05 });
    const loose = spec({ guardrail: '[[guardrail]]\nname = "rss"\nmax_regression = "5%"\nmax_total_regression = "20%"\n' });
    expect(loose.guardrail[0]!.max_total_regression).toBe(0.2);
    expect(oracleHash(loose)).not.toBe(oracleHash(plain));
    const bad = parseSpec(DETERMINISTIC_SPEC.replace('max_regression = "5%"', 'max_regression = "5%"\nmax_total_regression = "lots"'));
    expect(bad.ok).toBe(false);
    const tight = parseSpec(DETERMINISTIC_SPEC.replace('max_regression = "5%"', 'max_regression = "5%"\nmax_total_regression = "2%"'));
    expect(tight.ok && tight.warnings.join()).toContain("max_total_regression 2.0% is below max_regression 5.0%");
  });
});

describe("compounding and judging (pure)", () => {
  it("lower is better: steps multiply values by 1 + r; the CI combines in log space", () => {
    const p = chainPosition([{ regression: 0.1, lo: 0.08, hi: 0.12 }, { regression: 0.1, lo: 0.08, hi: 0.12 }], "lower");
    expect(p.regression).toBeCloseTo(0.21, 9);
    expect(p.steps).toBe(2);
    // Each step's log half-width ≈ 0.0180; RSS over two steps ≈ 0.0255.
    expect(p.lo!).toBeGreaterThan(0.17);
    expect(p.lo!).toBeLessThan(0.19);
    expect(p.hi!).toBeGreaterThan(0.23);
    expect(p.hi!).toBeLessThan(0.25);
  });
  it("higher is better: a 10% drop twice is 19% worse, not 20%", () => {
    expect(chainPosition([{ regression: 0.1, lo: null, hi: null }, { regression: 0.1, lo: null, hi: null }], "higher").regression).toBeCloseTo(0.19, 9);
    expect(invertRegression(0.25, "lower")).toBeCloseTo(-0.2, 9); // base 25% worse than best ⇒ best 20% better than base
    expect(invertRegression(0.2, "higher")).toBeCloseTo(-0.25, 9);
  });
  it("a limit check: broken only when the whole CI is beyond, inconclusive when it straddles", () => {
    expect(checkLimit({ regression: 0.06, lo: 0.051, hi: 0.07 }, 0.05).state).toBe("broken");
    expect(checkLimit({ regression: 0.06, lo: 0.01, hi: 0.11 }, 0.05).state).toBe("inconclusive");
    expect(checkLimit({ regression: 0.02, lo: -0.01, hi: 0.049 }, 0.05).state).toBe("ok");
    expect(checkLimit({ regression: 0.06, lo: null, hi: null }, 0.05).state).toBe("broken");
  });
  it("the reason says which limit, in words", () => {
    const g = { name: "rss", direction: "lower" as const, max_regression: 0.05, max_total_regression: 0.05 };
    const prior: Position = { regression: 0.022, lo: 0.022, hi: 0.022, steps: 1 };
    const j = judgeGuardrail(g, { regression: 0.031, lo: 0.031, hi: 0.031, n: 1 }, prior);
    expect(j.state).toBe("broken");
    expect(j.text).toBe("guardrail rss: 3.1% worse than best, within the 5.0% limit; 5.4% worse than the segment base, beyond the 5.0% total limit");
    expect(headroomWords("rss", prior, 0.05)).toBe("rss: 2.8% of the 5.0% total limit left (best: 2.2% worse than the segment base)");
  });
});

describe("cumulative creep across kept wins (deterministic class, end to end)", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;

  beforeEach(() => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port } = made);
    engine = new Engine(made.ctx);
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });

  async function study(guardrail: string) {
    const toml = fakeHostSpec(DETERMINISTIC_SPEC)
      .replace('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\n', guardrail)
      .replace("max_candidates = 3", "max_candidates = 20")
      .replace("max_submissions_per_worker = 2", "max_submissions_per_worker = 20");
    await engine.proposeStudy("thr_study", "proj_1", toml);
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 5_000);
    engine.addIdea("toy-size", { title: "Shrink" }, "human");
    await engine.start("toy-size", "human");
    await engine.settle();
  }

  /** Submit a candidate whose primary metric improves and whose rss is `factor` × best's. */
  async function submitStep(k: number, factor: number) {
    const s = store.study("toy-size")!;
    const bestTree = host.commits.get(s.best_sha!)!.tree;
    const tree = `T${k}`;
    host.metric.set(tree, 1000 - 10 * k);
    host.rss.set(tree, (host.rss.get(bestTree) ?? 100) * factor);
    host.nextSnapshot = { tree };
    await engine.submit("thr_w1", `step ${k}`);
    await engine.settle();
    return store.candidateByN(s.id, k)!;
  }

  it("10 × 4.9%: each passes the 5% per-step limit, but the 20% total limit rejects once best would exceed it", async () => {
    await study('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\nmax_total_regression = "20%"\n');
    const verdicts: string[] = [];
    for (let k = 1; k <= 10; k++) verdicts.push((await submitStep(k, 1.049)).verdict!);
    // 1.049³ = +15.4% is within 20%; 1.049⁴ = +21.1% is not, and best stops moving.
    expect(verdicts).toEqual(["win", "win", "win", "lose", "lose", "lose", "lose", "lose", "lose", "lose"]);
    const c4 = store.candidateByN(store.study("toy-size")!.id, 4)!;
    const reasons = JSON.parse(c4.reasons_json!) as string[];
    expect(reasons[0]).toContain("primary metric improved");
    expect(reasons[1]).toBe("guardrail rss: 4.9% worse than best, within the 5.0% limit; 21.1% worse than the segment base, beyond the 20.0% total limit");
    // Without the cumulative limit (the old rule: per step against best only) every one of them would have been kept: 1.049¹⁰ = +61.3%.
    expect(1.049 ** 10 - 1).toBeCloseTo(0.613, 3);
    // The worker hears the remaining headroom (agent-only detail); the human line stays short.
    const msg = port.sent.filter((m) => m.threadId === "thr_w1" && m.text.includes("Verdict for c/4")).at(-1)!.text;
    expect(msg.split("\n")[0]).toBe("[autoresearch] Verdict for c/4: LOSE, 1.0% lower size than best. Broke guardrail rss.");
    expect(msg).toContain("Guardrail headroom now (best vs the segment base): rss: 4.6% of the 20.0% total limit left (best: 15.4% worse than the segment base)");
    // Views: the Overview shows best's cumulative position against the total limit; the candidate its total check.
    const o = overview(engine, store.study("toy-size")!);
    const g = o.secondary.guardrails[0]!;
    expect(g).toMatchObject({ state: "pass", label: "ok", promotions: 3, used: expect.closeTo(0.772, 3) });
    expect(g.regression).toBeCloseTo(1.049 ** 3 - 1, 6);
    expect(g.text).toBe("15.4% worse than the segment base (total limit 20.0% worse) · 5.0% per step");
    expect(g.headroomText).toBe("rss: 4.6% of the 20.0% total limit left (best: 15.4% worse than the segment base)");
    const detail = (await candidateDetail(engine, store.study("toy-size")!, 4))!;
    const row = detail.metricRows.find((r) => r.name === "rss")!;
    expect(row.guardrail).toMatchObject({ state: "broken", label: "BROKEN (total)" });
    expect(row.text).toBe("4.9% worse than best (limit 5.0% worse) · 21.1% worse than the segment base (total limit 20.0% worse)");
    const list = candidatesView(engine, store.study("toy-size")!, {});
    expect(list.find((r) => r.n === 4)!.guardrails.text).toBe("rss BROKEN (total)");
    // The strategist's digest and the report carry the cumulative position.
    const report = studyReport(engine.ctx, store.study("toy-size")!, store.spec(store.study("toy-size")!), null);
    expect(report).toContain("## Guardrails (segment 1)");
    expect(report).toContain("- Best vs the segment base: 15.4% worse, compounded over 3 promotion(s).");
    expect(report).toMatch(/Wins it rejected: c\/4 \(4\.9% worse than best, within the 5\.0% limit; 21\.1% worse than the segment base, beyond the 20\.0% total limit\)/u);
  });

  it("the per-step limit still applies when the total has room; an improving guardrail wins room back", async () => {
    await study('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\nmax_total_regression = "20%"\n');
    expect((await submitStep(1, 0.9)).verdict).toBe("win"); // rss 10% better: more room
    const c2 = await submitStep(2, 1.06); // 6% worse than best, but 4.6% worse than base
    expect(c2.verdict).toBe("lose");
    expect((JSON.parse(c2.reasons_json!) as string[])[1]).toBe("guardrail rss: 6.0% worse than best, beyond the 5.0% limit; 4.6% better than the segment base, within the 20.0% total limit");
    expect((await submitStep(3, 1.049)).verdict).toBe("win");
  });

  it("the default total limit is the per-step limit", async () => {
    await study('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\n');
    expect((await submitStep(1, 1.03)).verdict).toBe("win");
    const c2 = await submitStep(2, 1.03); // +6.1% in total
    expect(c2.verdict).toBe("lose");
    expect((JSON.parse(c2.reasons_json!) as string[])[1]).toContain("6.1% worse than the segment base, beyond the 5.0% total limit");
  });

  it("higher is better: a throughput guardrail that drops 4.9% per promotion", async () => {
    await study('[[guardrail]]\nname = "rss"\ndirection = "higher"\nmax_regression = "5%"\nmax_total_regression = "12%"\n');
    const v = [];
    for (let k = 1; k <= 4; k++) v.push((await submitStep(k, 0.951)).verdict);
    // 0.951² = −9.6% is within 12%; 0.951³ = −14.0% is not.
    expect(v).toEqual(["win", "win", "lose", "lose"]);
    const c3 = store.candidateByN(store.study("toy-size")!.id, 3)!;
    expect((JSON.parse(c3.reasons_json!) as string[])[1]).toBe("guardrail rss: 4.9% worse than best, within the 5.0% limit; 14.0% worse than the segment base, beyond the 12.0% total limit");
  });
});

describe("statistics: a noisy guardrail no longer rejects a real win", () => {
  /** A bench whose primary metric improves by `effect` with little noise, and whose rss changes by `rssEffect` with per-run noise `rssSd`. */
  function bench(rng: Rng, opts: { effect: number; rssEffect: number; rssSd: number }): Bench {
    return {
      async run(side) {
        const cand = side === "candidate";
        const size = 1000 * (cand ? 1 - opts.effect : 1) * (1 + 0.002 * gauss(rng));
        const rss = 100 * (cand ? 1 + opts.rssEffect : 1) * (1 + opts.rssSd * gauss(rng));
        return { metrics: { size, rss }, diag: [], durationMs: 1 };
      },
    };
  }

  /** The old rule: the median of per-pair regressions against the limit, in each measurement. */
  function oldRule(o: MeasureOutcome, limit: number): boolean {
    return (o.guardrails.rss ?? Number.NaN) > limit;
  }

  async function simulate(opts: { rssEffect: number; rssSd: number; trials: number; seed: number }) {
    const s = spec({ noise: "noisy", protocol: "warmup = 0\nn_min = 6\nn_max = 20\nbootstrap = 400\nconfirm = true" });
    const limit = s.guardrail[0]!.max_regression;
    const rng = seededRng(opts.seed);
    let before = 0;
    let after = 0;
    let flagged = 0;
    for (let t = 0; t < opts.trials; t++) {
      const b = bench(rng, { effect: 0.2, rssEffect: opts.rssEffect, rssSd: opts.rssSd });
      const ctx = { bench: b, spec: s, mde: 0.02, rng, record: () => undefined };
      const first = await noisyStrategy.measure(ctx);
      const confirmation = await noisyStrategy.measure(ctx);
      // Before: either measurement's median beyond the limit rejected the win.
      if (oldRule(first, limit) || oldRule(confirmation, limit)) before += 1;
      // After: as the pipeline does it (CI on the first, then the confirmation on both measurements' pairs).
      let v = decideVerdict(first, s);
      if (v.verdict === "win") {
        const pooled = { rss: { ...outcomeEstimates(first).rss!, samples: [...outcomeEstimates(first).rss!.samples!, ...outcomeEstimates(confirmation).rss!.samples!] } };
        const { estimatePaired } = await import("../src/guardrails.ts");
        const est = { rss: estimatePaired(pooled.rss.samples, s.oracle.protocol.confidence, s.oracle.protocol.bootstrap, rng) };
        v = applyConfirmation(v, decideVerdict({ ...confirmation, guardrails: { rss: est.rss.regression }, guardrailEstimates: est }, s));
      }
      if (v.verdict !== "win") after += 1;
      else if (v.guardrails?.rss?.state === "inconclusive") flagged += 1;
    }
    return { before: before / opts.trials, after: after / opts.trials, flagged: flagged / opts.trials };
  }

  it("true guardrail effect 0, per-run noise 5% (per-pair SD ≈ 7%, above half the 5% limit): false rejections drop to near zero", async () => {
    const r = await simulate({ rssEffect: 0, rssSd: 0.05, trials: 400, seed: 11 });
    // Reported in the PR and the design notes.
    console.log(`noisy guardrail, no true effect: false rejections before ${(r.before * 100).toFixed(1)}%, after ${(r.after * 100).toFixed(1)}% (flagged inconclusive ${(r.flagged * 100).toFixed(1)}%)`);
    expect(r.before).toBeGreaterThan(0.08);
    expect(r.after).toBeLessThan(0.03);
    expect(r.flagged).toBeGreaterThan(0.2);
  }, 60_000);

  it("noisy and beyond the limit: power is the price (reported, not a regression)", async () => {
    const r = await simulate({ rssEffect: 0.12, rssSd: 0.05, trials: 200, seed: 13 });
    console.log(`noisy guardrail, true +12% (5% limit, per-run noise 5%): rejected before ${(r.before * 100).toFixed(1)}%, after ${(r.after * 100).toFixed(1)}% (flagged ${(r.flagged * 100).toFixed(1)}%)`);
    expect(r.after + r.flagged).toBeGreaterThan(0.95); // never silently passed
  }, 60_000);

  it("a real guardrail regression beyond the limit is still rejected", async () => {
    const r = await simulate({ rssEffect: 0.15, rssSd: 0.02, trials: 200, seed: 12 });
    console.log(`real +15% guardrail regression (5% limit): rejected before ${(r.before * 100).toFixed(1)}%, after ${(r.after * 100).toFixed(1)}%`);
    expect(r.after).toBeGreaterThan(0.95);
  }, 60_000);
});

describe("confirmation", () => {
  it("a primary metric that confirms but a guardrail that breaks on the pooled pairs is a lose that says so", () => {
    const s = spec({ noise: "noisy" });
    const win = { decision: "win" as const, effect: 0.6, ciLo: 0.59, ciHi: 0.61, n: 6, guardrails: { rss: 0.09 }, guardrailEstimates: { rss: { regression: 0.09, lo: 0.02, hi: 0.16, n: 6 } }, bestMetrics: {}, candidateMetrics: {}, bestDiag: [], candidateDiag: [], bestRun: null };
    const first = decideVerdict(win, s);
    expect(first).toMatchObject({ verdict: "win" });
    const pooled = decideVerdict({ ...win, guardrailEstimates: { rss: { regression: 0.09, lo: 0.08, hi: 0.1, n: 12 } } }, s);
    const v = applyConfirmation(first, pooled);
    expect(v.verdict).toBe("lose");
    expect(v.reasons[0]).toMatch(/^primary metric improved 60\.00%/u);
    expect(v.reasons[1]).toMatch(/^confirmed: primary metric improved/u);
    expect(v.reasons[2]).toContain("beyond the 5.0% limit");
    expect(v.guardrails!.rss!.state).toBe("broken");
  });
});

describe("deterministic and expensive classes", () => {
  const cachedBest = { metrics: { size: 1000, rss: 100 }, diag: [], durationMs: 1 };
  function fixed(candRss: number): Bench {
    return { run: async (side) => ({ metrics: side === "best" ? { size: 1000, rss: 100 } : { size: 900, rss: candRss }, diag: [], durationMs: 1 }) };
  }
  it("deterministic: the tolerance is the band; within the band of the limit is inconclusive (flagged), beyond it broken", async () => {
    const s = spec({ protocol: 'tolerance = "1%"' });
    const run = async (rss: number) => decideVerdict(await deterministicStrategy.measure({ bench: fixed(rss), spec: s, mde: 0, rng: seededRng(1), record: () => undefined, bestCache: cachedBest }), s);
    expect((await run(104)).verdict).toBe("win");
    const edge = await run(105.5);
    expect(edge.verdict).toBe("win");
    expect(edge.guardrails!.rss!.state).toBe("inconclusive");
    expect(edge.reasons[1]).toContain("inconclusive against the 5.0% limit");
    expect((await run(106.5)).verdict).toBe("lose");
    // Tolerance 0: the exact value decides.
    const exact = spec();
    expect(decideVerdict(await deterministicStrategy.measure({ bench: fixed(105.5), spec: exact, mde: 0, rng: seededRng(1), record: () => undefined, bestCache: cachedBest }), exact).verdict).toBe("lose");
  });

  it("expensive: the CI is t·σ·√(1/k + 1/m) from the calibrated guardrail noise", async () => {
    const s = spec({ noise: "expensive", protocol: "confirm_runs = 3\ncalibration_runs = 5" });
    const baseline = [99, 100, 101, 100, 100].map((rss) => ({ metrics: { size: 1000, rss }, diag: [], durationMs: 1 }));
    const measure = async (rss: () => number, sigma: number) => {
      const b: Bench = { run: async () => ({ metrics: { size: 700, rss: rss() }, diag: [], durationMs: 1 }) };
      const o = await expensiveStrategy.measure({ bench: b, spec: s, mde: 0.05, rng: seededRng(1), record: () => undefined, baseline, noiseFloor: 0.01, guardrailNoise: { rss: sigma } });
      return { o, v: decideVerdict(o, s) };
    };
    // A noisy guardrail (σ 6% per run) with no true effect: the CI straddles the limit, so it is flagged, not a rejection.
    const rng = seededRng(5);
    const noisy = await measure(() => 100 * (1 + 0.06 * gauss(rng)), 0.06);
    expect(noisy.o.decision).toBe("win");
    expect(noisy.o.guardrailEstimates!.rss!.hi! - noisy.o.guardrailEstimates!.rss!.lo!).toBeGreaterThan(0.1);
    expect(noisy.v.verdict).toBe("win");
    // A real +15% regression with modest noise is still a lose.
    const bad = await measure(() => 115, 0.01);
    expect(bad.v.verdict).toBe("lose");
    expect(bad.v.reasons.join()).toContain("beyond the 5.0% limit");
    // Without calibrated noise the CI comes from the runs themselves.
    expect(estimateRuns([100, 101, 99], [100, 102, 98], "lower", null, 2).lo).not.toBeNull();
    expect(estimateRuns([100], [104], "lower", null, 2)).toMatchObject({ lo: null, hi: null });
  });
});

describe("calibration: guardrail noise", () => {
  function aaBench(rng: Rng, rssSd: number): Bench {
    return { run: async () => ({ metrics: { size: 1000 * (1 + 0.005 * gauss(rng)), rss: 100 * (1 + rssSd * gauss(rng)) }, diag: [], durationMs: 1 }) };
  }
  it("noisy: measures each guardrail's A/A noise and CI half-width; judgeable when it is below the limit", async () => {
    const s = spec({ noise: "noisy", protocol: "warmup = 0\nn_max = 20\ncalibration_pairs = 16\nbootstrap = 400" });
    const quiet = await noisyStrategy.calibrate({ bench: aaBench(seededRng(1), 0.005), spec: s, rng: seededRng(1), record: () => undefined });
    expect(quiet.guardrails![0]).toMatchObject({ name: "rss", limit: 0.05, totalLimit: 0.05, judgeable: true });
    expect(quiet.guardrails![0]!.text).toMatch(/^rss: noise 0\.\d\d% per pair \(A\/A\), CI half-width 0\.\d\d%: rejected beyond about 5\.\d% worse/u);
    const loud = await noisyStrategy.calibrate({ bench: aaBench(seededRng(2), 0.15), spec: s, rng: seededRng(2), record: () => undefined });
    expect(loud.guardrails![0]!.judgeable).toBe(false);
    expect(loud.ok).toBe(true); // a warning, not a failure
  });
  it("deterministic and expensive: the repeat difference and the per-run σ", async () => {
    const det = await deterministicStrategy.calibrate({ bench: { run: async (side) => ({ metrics: { size: 1000, rss: side === "best" ? 100 : 108 }, diag: [], durationMs: 1 }) }, spec: spec(), rng: seededRng(1), record: () => undefined });
    expect(det.guardrails![0]).toMatchObject({ noise: expect.closeTo(0.08, 9), judgeable: false });
    const exp = await expensiveStrategy.calibrate({ bench: aaBench(seededRng(3), 0.01), spec: spec({ noise: "expensive" }), rng: seededRng(3), record: () => undefined });
    expect(exp.guardrails![0]!.noise).toBeGreaterThan(0);
    expect(exp.guardrails![0]!.judgeable).toBe(true);
  });

  it("end to end: the report, the warning, the Oracle tab, and the noise used by the next verdict", async () => {
    const host = new FakeHost();
    const made = makeCtx(host);
    const engine = new Engine(made.ctx);
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    made.port.addThread("thr_study");
    const rng = seededRng(9);
    host.rssNoise = () => 0.2 * gauss(rng);
    const toml = fakeHostSpec(DETERMINISTIC_SPEC).replace('noise = "deterministic"', 'noise = "noisy"\n\n[oracle.protocol]\nwarmup = 0\nn_min = 3\nn_max = 8\ncalibration_pairs = 8\nbootstrap = 300');
    await engine.proposeStudy("thr_study", "proj_1", toml);
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 5_000);
    const s = made.store.study("toy-size")!;
    const report = JSON.parse(s.calibration_json!) as { report: string; warnings: string[]; guardrails: Array<{ name: string; judgeable: boolean }> };
    expect(report.report).toMatch(/Guardrails: rss: noise \d+\.\d\d% per pair/u);
    expect(report.guardrails[0]).toMatchObject({ name: "rss", judgeable: false });
    expect(report.warnings[0]).toMatch(/^guardrail rss: noise .* more than its 5\.0% limit: it can never be shown within the limit/u);
    const notice = made.store.notices(s.id)[0]!.text;
    expect(notice).toContain("Warning: guardrail rss");
    const oracle = oracleView(engine, s);
    expect(oracle.calibration.warnings).toHaveLength(1);
    expect(oracle.calibration.guardrails[0]).toMatchObject({ name: "rss", judgeable: false });
    expect(oracle.segments[0]!.guardrails[0]!.name).toBe("rss");
  });
});

describe("views: guardrailStatus with the cumulative position and CI", () => {
  const base = { name: "rss", direction: "lower" as const, limit: 0.05, totalLimit: 0.1, reference: null, value: null, against: "best" as const };
  it("a candidate: step and total checks, the worse decides", () => {
    const ok = guardrailStatus({ ...base, regression: 0.01, ci: { lo: 0, hi: 0.02 }, cumulative: { regression: 0.03, lo: 0.02, hi: 0.04, limit: 0.1 } });
    expect(ok).toMatchObject({ state: "pass", label: "ok" });
    expect(ok.text).toBe("1.0% worse than best (CI 0.0% to 2.0% worse; limit 5.0% worse) · 3.0% worse than the segment base (CI 2.0% to 4.0% worse; total limit 10.0% worse)");
    expect(ok.cumulative).toMatchObject({ state: "ok", headroom: expect.closeTo(0.07, 9) });
    const inconclusive = guardrailStatus({ ...base, regression: 0.03, ci: { lo: -0.02, hi: 0.08 }, cumulative: { regression: 0.03, lo: -0.02, hi: 0.08, limit: 0.1 } });
    expect(inconclusive).toMatchObject({ state: "inconclusive", label: "inconclusive" });
    const total = guardrailStatus({ ...base, regression: 0.03, ci: { lo: 0.02, hi: 0.04 }, cumulative: { regression: 0.12, lo: 0.11, hi: 0.13, limit: 0.1 } });
    expect(total).toMatchObject({ state: "broken", label: "BROKEN (total)" });
    const near = guardrailStatus({ ...base, regression: 0.01, cumulative: { regression: 0.09, limit: 0.1 } });
    expect(near).toMatchObject({ state: "warn", label: "near limit", used: expect.closeTo(0.9, 9) });
  });
  it("the Overview: best against the segment base on the total limit, with headroom", () => {
    const s = guardrailStatus({ ...base, against: "base", regression: 0.06, ci: { lo: 0.04, hi: 0.08 } });
    expect(s).toMatchObject({ state: "pass", cumulative: { headroom: expect.closeTo(0.04, 9), limit: 0.1 } });
    const straddles = guardrailStatus({ ...base, against: "base", regression: 0.09, ci: { lo: 0.07, hi: 0.11 } });
    expect(straddles.state).toBe("inconclusive");
  });
  it("compose keeps a point estimate exact when there is no CI", () => {
    expect(compose(ZERO_POSITION, { regression: 0.05, lo: null, hi: null }, "lower")).toMatchObject({ regression: expect.closeTo(0.05, 12), lo: expect.closeTo(0.05, 12), hi: expect.closeTo(0.05, 12) });
    expect(median([1, 2, 3])).toBe(2);
  });
});

describe("prompts carry headroom", () => {
  it("the verdict message keeps the human line short and puts the checks in the detail", () => {
    const s = spec({ guardrail: '[[guardrail]]\nname = "rss"\nmax_regression = "5%"\nmax_total_regression = "10%"\n' });
    const prior: Position = { regression: 0.06, lo: 0.05, hi: 0.07, steps: 2 };
    const j = judgeGuardrail(s.guardrail[0]!, { regression: 0.035, lo: -0.01, hi: 0.08, n: 6 }, prior);
    const c = {
      n: 7,
      verdict: "win",
      effect: 0.1,
      ci_lo: 0.08,
      ci_hi: 0.12,
      reasons_json: JSON.stringify(["primary metric improved 10.00%", j.text]),
      metrics_json: JSON.stringify({ best: { size: 1000, rss: 100 }, candidate: { size: 900, rss: 103.5 }, guardrails: { rss: 0.035 }, guardrailJudgement: { rss: j } }),
      diag_json: null,
      gate_output: null,
    } as never;
    const m = verdictMessage(c, { submissionsLeft: 1, spec: s, guardrailPositions: { rss: prior } });
    expect(m.summary).toBe("[autoresearch] Verdict for c/7: WIN: promoted to best, 10.0% lower size than best (CI +8.0% to +12.0%). Guardrail rss inconclusive (flagged).");
    expect(m.detail).toContain("rss 3.5% worse than best, CI 1.0% better to 8.0% worse (limit 5.0%) INCONCLUSIVE; 9.7% worse than the segment base, CI 4.8% to 14.6% worse (total limit 10.0%) INCONCLUSIVE");
    expect(m.detail).toContain("Guardrail headroom now (best vs the segment base): rss: 4.0% of the 10.0% total limit left (best: 6.0% worse than the segment base, CI 5.0% to 7.0% worse)");
  });
});
