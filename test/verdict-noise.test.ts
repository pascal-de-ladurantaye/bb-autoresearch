import { describe, expect, it } from "vitest";
import { BenchError, deterministicStrategy, expensiveStrategy, noisyStrategy, type Bench, type MeasureOutcome, type Sample, type Side } from "../src/noise.ts";
import { parseSpec, type StudySpec } from "../src/spec.ts";
import { seededRng } from "../src/stats.ts";
import { applyConfirmation, decideVerdict } from "../src/verdict.ts";
import { DETERMINISTIC_SPEC } from "./helpers.ts";

function spec(extra = "", noise = "noisy"): StudySpec {
  const r = parseSpec(DETERMINISTIC_SPEC.replace('noise = "deterministic"', `noise = "${noise}"\n${extra}`));
  if (!r.ok) throw new Error(r.errors.join());
  return r.spec;
}

function outcome(p: Partial<MeasureOutcome>): MeasureOutcome {
  return { decision: "win", effect: 0.1, ciLo: 0.05, ciHi: 0.15, n: 6, guardrails: { rss: 0 }, bestMetrics: {}, candidateMetrics: {}, bestDiag: [], candidateDiag: [], bestRun: null, ...p };
}

describe("decideVerdict", () => {
  const s = spec();
  it("keeps a win within guardrails", () => {
    expect(decideVerdict(outcome({}), s).verdict).toBe("win");
  });
  it("turns a win that breaks a guardrail into a lose with the reason", () => {
    const v = decideVerdict(outcome({ guardrails: { rss: 0.08 } }), s);
    expect(v.verdict).toBe("lose");
    expect(v.reasons.join()).toContain("guardrail rss: 8.0% worse than best, beyond the 5.0% limit; 8.0% worse than the segment base, beyond the 5.0% total limit");
  });
  it("treats a missing guardrail metric as broken", () => {
    expect(decideVerdict(outcome({ guardrails: { rss: Number.NaN } }), s).verdict).toBe("lose");
  });
  it("passes lose and inconclusive through", () => {
    expect(decideVerdict(outcome({ decision: "lose", effect: -0.1 }), s).verdict).toBe("lose");
    expect(decideVerdict(outcome({ decision: "inconclusive", effect: 0.001 }), s).verdict).toBe("inconclusive");
  });
  it("requires the confirmation to win too", () => {
    const first = decideVerdict(outcome({}), s);
    expect(applyConfirmation(first, decideVerdict(outcome({}), s)).verdict).toBe("win");
    const failed = applyConfirmation(first, decideVerdict(outcome({ decision: "inconclusive", effect: 0.001 }), s));
    expect(failed.verdict).toBe("inconclusive");
    expect(failed.reasons.join()).toContain("failed confirmation");
  });
});

/** Bench with a multiplicative effect on the candidate and Gaussian-ish noise. */
function fakeBench(opts: { effect: number; noise: number; seed: number; fail?: Side }): Bench & { order: Side[] } {
  const rng = seededRng(opts.seed);
  const order: Side[] = [];
  return {
    order,
    async run(side) {
      order.push(side);
      if (opts.fail === side) throw new BenchError(side, "boom");
      const n = (rng() - 0.5) * 2 * opts.noise;
      const v = 1000 * (side === "candidate" ? 1 - opts.effect : 1) * (1 + n);
      return { metrics: { size: v, rss: 100 }, diag: [`side=${side}`], durationMs: 10 };
    },
  };
}

describe("noisy strategy", () => {
  const s = spec("[oracle.protocol]\nn_min = 5\nn_max = 20\nwarmup = 1\nbootstrap = 500");
  it("stops at n_min on a clear win and records paired, interleaved samples", async () => {
    const samples: Sample[] = [];
    const bench = fakeBench({ effect: 0.1, noise: 0.01, seed: 1 });
    const o = await noisyStrategy.measure({ bench, spec: s, mde: 0.02, rng: seededRng(1), record: (x) => samples.push(x) });
    expect(o.decision).toBe("win");
    expect(o.n).toBe(5);
    expect(o.effect).toBeGreaterThan(0.08);
    expect(samples.filter((x) => x.side === "best")).toHaveLength(5);
    // Random order within pairs: both orders occur.
    const pairsOrder = bench.order.slice(2).reduce<string[]>((acc, side, i, a) => (i % 2 === 0 ? [...acc, `${side}-${a[i + 1]}`] : acc), []);
    expect(new Set(pairsOrder).size).toBe(2);
  });
  it("stops early on a clear loss", async () => {
    const o = await noisyStrategy.measure({ bench: fakeBench({ effect: -0.1, noise: 0.01, seed: 2 }), spec: s, mde: 0.02, rng: seededRng(2), record: () => {} });
    expect(o.decision).toBe("lose");
    expect(o.n).toBe(5);
  });
  it("runs to n_max and is inconclusive on no effect", async () => {
    const o = await noisyStrategy.measure({ bench: fakeBench({ effect: 0, noise: 0.05, seed: 3 }), spec: s, mde: 0.02, rng: seededRng(3), record: () => {} });
    expect(o.decision).toBe("inconclusive");
    expect(o.n).toBe(20);
  });
  it("calibrates A/A: MDE and evaluation cost", async () => {
    const c = await noisyStrategy.calibrate({ bench: fakeBench({ effect: 0, noise: 0.02, seed: 4 }), spec: s, rng: seededRng(4), record: () => {} });
    expect(c.ok).toBe(true);
    expect(c.mde).toBeGreaterThanOrEqual(0.01);
    expect(c.report).toMatch(/Detects changes of .* with 20 pairs/u);
  });
  it("fails calibration when the oracle is too noisy", async () => {
    const noisy = spec("[oracle.protocol]\nmax_mde = \"1%\"\nmin_effect = \"0.5%\"\nbootstrap = 500");
    const c = await noisyStrategy.calibrate({ bench: fakeBench({ effect: 0, noise: 0.5, seed: 5 }), spec: noisy, rng: seededRng(5), record: () => {} });
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toContain("too noisy");
  });
});

describe("deterministic and expensive strategies", () => {
  it("deterministic: one run each side, reuses a cached best", async () => {
    const s = spec("", "deterministic");
    const bench = fakeBench({ effect: 0.05, noise: 0, seed: 1 });
    const cached = { metrics: { size: 1000, rss: 100 }, diag: [], durationMs: 1 };
    const o = await deterministicStrategy.measure({ bench, spec: s, mde: 0, rng: seededRng(1), record: () => {}, bestCache: cached });
    expect(o.decision).toBe("win");
    expect(bench.order).toEqual(["candidate"]);
  });
  it("deterministic calibration catches a non-deterministic metric", async () => {
    const s = spec("", "deterministic");
    const c = await deterministicStrategy.calibrate({ bench: fakeBench({ effect: 0, noise: 0.1, seed: 9 }), spec: s, rng: seededRng(1), record: () => {} });
    expect(c.ok).toBe(false);
  });
  it("expensive: confirms a single-run win with extra runs", async () => {
    const s = spec("[oracle.protocol]\nconfirm_runs = 2", "expensive");
    const bench = fakeBench({ effect: 0.2, noise: 0.001, seed: 1 });
    const o = await expensiveStrategy.measure({ bench, spec: s, mde: 0.05, rng: seededRng(1), record: () => {} });
    expect(o.decision).toBe("win");
    expect(bench.order.filter((x) => x === "candidate")).toHaveLength(3);
  });
});
