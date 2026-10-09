import { describe, expect, it } from "vitest";
import {
  bootstrapMedianCI,
  calibrateNoisy,
  deterministicDecision,
  improvement,
  median,
  pairedImprovements,
  robustSd,
  seededRng,
  sequentialDecision,
} from "../src/stats.ts";

function normal(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe("basics", () => {
  it("median, robust sd, improvement direction", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(robustSd([1, 1, 1, 1])).toBe(0);
    expect(improvement(100, 90, "lower")).toBeCloseTo(0.1);
    expect(improvement(100, 110, "higher")).toBeCloseTo(0.1);
    expect(improvement(100, 110, "lower")).toBeCloseTo(-0.1);
    expect(improvement(0, 0, "lower")).toBe(0);
    expect(pairedImprovements([{ best: 10, candidate: 9 }], "lower")[0]).toBeCloseTo(0.1);
  });
  it("seeded RNG is deterministic", () => {
    const a = seededRng(7);
    const b = seededRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("bootstrapMedianCI", () => {
  it("brackets the sample median and narrows with more data", () => {
    const rng = seededRng(1);
    const small = Array.from({ length: 10 }, () => normal(rng, 0.05, 0.02));
    const big = Array.from({ length: 200 }, () => normal(rng, 0.05, 0.02));
    const ciSmall = bootstrapMedianCI(small, 0.95, 2000, seededRng(2));
    const ciBig = bootstrapMedianCI(big, 0.95, 2000, seededRng(2));
    expect(ciSmall.lo).toBeLessThanOrEqual(ciSmall.median);
    expect(ciSmall.hi).toBeGreaterThanOrEqual(ciSmall.median);
    expect(ciBig.hi - ciBig.lo).toBeLessThan(ciSmall.hi - ciSmall.lo);
    expect(Math.abs(ciBig.median - 0.05)).toBeLessThan(0.01);
  });
  it("covers the true median about as often as promised", () => {
    const rng = seededRng(3);
    let covered = 0;
    const trials = 200;
    for (let t = 0; t < trials; t++) {
      const xs = Array.from({ length: 25 }, () => normal(rng, 0, 1));
      const ci = bootstrapMedianCI(xs, 0.9, 500, rng);
      if (ci.lo <= 0 && ci.hi >= 0) covered++;
    }
    expect(covered / trials).toBeGreaterThan(0.8);
  });
});

describe("sequentialDecision", () => {
  const base = { nMin: 5, nMax: 20, mde: 0.02, confidence: 0.95, iterations: 1000 };
  it("continues before n_min", () => {
    expect(sequentialDecision({ ...base, improvements: [0.5, 0.5, 0.5], rng: seededRng(1) }).decision).toBe("continue");
  });
  it("stops early on a clear win when the lower bound clears the MDE", () => {
    const r = sequentialDecision({ ...base, improvements: [0.1, 0.11, 0.09, 0.1, 0.12], rng: seededRng(1) });
    expect(r.decision).toBe("win");
    expect(r.ci.lo).toBeGreaterThan(0.02);
  });
  it("stops early on a clear loss when the CI is entirely negative", () => {
    expect(sequentialDecision({ ...base, improvements: [-0.1, -0.08, -0.12, -0.09, -0.11], rng: seededRng(1) }).decision).toBe("lose");
  });
  it("does not call a win when the effect is real but below the MDE", () => {
    const r = sequentialDecision({ ...base, improvements: [0.01, 0.011, 0.009, 0.01, 0.012], rng: seededRng(1) });
    expect(r.decision).toBe("continue");
  });
  it("is inconclusive at n_max when ambiguous", () => {
    const rng = seededRng(4);
    const xs = Array.from({ length: 20 }, () => normal(rng, 0, 0.05));
    expect(sequentialDecision({ ...base, improvements: xs, rng: seededRng(5) }).decision).toBe("inconclusive");
  });
  it("has a low false-win rate on A/A data", () => {
    const rng = seededRng(9);
    let wins = 0;
    const trials = 200;
    for (let t = 0; t < trials; t++) {
      const xs: number[] = [];
      let d = "continue";
      for (let i = 0; i < 20 && d === "continue"; i++) {
        xs.push(normal(rng, 0, 0.02));
        d = sequentialDecision({ ...base, mde: 0.01, improvements: xs, iterations: 300, rng }).decision;
      }
      if (d === "win") wins++;
    }
    expect(wins / trials).toBeLessThan(0.05);
  });
});

describe("calibrateNoisy (A/A → MDE)", () => {
  it("floors the MDE at min_effect for a quiet bench", () => {
    const rng = seededRng(11);
    const aa = Array.from({ length: 16 }, () => normal(rng, 0, 0.001));
    const c = calibrateNoisy(aa, { nMax: 20, confidence: 0.95, iterations: 1000, minEffect: 0.01, rng });
    expect(c.mde).toBe(0.01);
    expect(c.biased).toBe(false);
    expect(c.noiseFloor).toBeLessThan(0.005);
  });
  it("scales the MDE with noise and shrinks it with n_max", () => {
    const rng = seededRng(12);
    const aa = Array.from({ length: 40 }, () => normal(rng, 0, 0.05));
    const n10 = calibrateNoisy(aa, { nMax: 10, confidence: 0.95, iterations: 2000, minEffect: 0, rng: seededRng(1) });
    const n80 = calibrateNoisy(aa, { nMax: 80, confidence: 0.95, iterations: 2000, minEffect: 0, rng: seededRng(1) });
    expect(n10.mde).toBeGreaterThan(0.01);
    expect(n80.mde).toBeLessThan(n10.mde);
    expect(n10.detectable).toBeGreaterThan(n10.mde);
  });
  it("flags a biased A/A (constant offset between checkouts)", () => {
    const aa = Array.from({ length: 16 }, (_, i) => 0.05 + (i % 2 ? 0.001 : -0.001));
    expect(calibrateNoisy(aa, { nMax: 20, confidence: 0.95, iterations: 500, minEffect: 0.01, rng: seededRng(1) }).biased).toBe(true);
  });
});

describe("deterministicDecision", () => {
  it("wins only when strictly better beyond the tolerance", () => {
    expect(deterministicDecision(100, 90, "lower", 0).decision).toBe("win");
    expect(deterministicDecision(100, 100, "lower", 0).decision).toBe("inconclusive");
    expect(deterministicDecision(100, 99.5, "lower", 0.01).decision).toBe("inconclusive");
    expect(deterministicDecision(100, 102, "lower", 0.01).decision).toBe("lose");
    expect(deterministicDecision(100, 110, "higher", 0).decision).toBe("win");
  });
});
