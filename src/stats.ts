// Statistics for verdicts. Pure functions with an injected RNG so tests and
// replays are deterministic.
import type { Direction } from "./spec.ts";

export type Rng = () => number;

/** Small, fast, seedable PRNG (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Linear-interpolated quantile of an already sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Robust standard deviation estimate: 1.4826 × MAD. */
export function robustSd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

/**
 * Relative improvement of `candidate` over `best`, positive = better.
 * direction "lower": (best - cand) / |best|; "higher": (cand - best) / |best|.
 */
export function improvement(best: number, candidate: number, direction: Direction): number {
  const raw = direction === "lower" ? best - candidate : candidate - best;
  if (best === 0) return raw === 0 ? 0 : Math.sign(raw);
  return raw / Math.abs(best);
}

export interface Pair {
  best: number;
  candidate: number;
}

export function pairedImprovements(pairs: readonly Pair[], direction: Direction): number[] {
  return pairs.map((p) => improvement(p.best, p.candidate, direction));
}

export interface Interval {
  median: number;
  lo: number;
  hi: number;
  n: number;
}

/** Percentile bootstrap confidence interval of the median. */
export function bootstrapMedianCI(values: readonly number[], confidence: number, iterations: number, rng: Rng): Interval {
  const n = values.length;
  if (n === 0) return { median: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 };
  const medians = new Float64Array(iterations);
  const sample = new Array<number>(n);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < n; j++) sample[j] = values[Math.floor(rng() * n)]!;
    medians[i] = median(sample);
  }
  const sorted = Array.from(medians).sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return { median: median(values), lo: quantileSorted(sorted, alpha), hi: quantileSorted(sorted, 1 - alpha), n };
}

export type SequentialDecision = "continue" | "win" | "lose" | "inconclusive";

export interface SequentialInput {
  improvements: readonly number[];
  nMin: number;
  nMax: number;
  /** Minimum detectable effect (fraction). A win needs the CI lower bound above it. */
  mde: number;
  confidence: number;
  iterations: number;
  rng: Rng;
}

/**
 * After n_min pairs: lose when the CI is entirely on the regression side,
 * win when the lower bound clears the MDE, inconclusive at n_max.
 */
export function sequentialDecision(input: SequentialInput): { decision: SequentialDecision; ci: Interval } {
  const n = input.improvements.length;
  if (n < input.nMin) {
    return { decision: "continue", ci: { median: median(input.improvements), lo: Number.NaN, hi: Number.NaN, n } };
  }
  const ci = bootstrapMedianCI(input.improvements, input.confidence, input.iterations, input.rng);
  if (ci.hi < 0) return { decision: "lose", ci };
  if (ci.lo > input.mde) return { decision: "win", ci };
  if (n >= input.nMax) return { decision: "inconclusive", ci };
  return { decision: "continue", ci };
}

export interface CalibrationStats {
  /** Robust SD of A/A paired relative differences. */
  noiseFloor: number;
  /** Half-width of the null CI at n_max pairs: the effect A/A noise alone can fake. */
  halfWidthAtNMax: number;
  /** Win threshold on the CI lower bound: max(min_effect, halfWidthAtNMax). */
  mde: number;
  /** A true effect of about this size is detected at n_max pairs. */
  detectable: number;
  /** CI of the A/A median over all calibration pairs; should contain 0. */
  aaCi: Interval;
  biased: boolean;
}

export function calibrateNoisy(
  aaImprovements: readonly number[],
  opts: { nMax: number; confidence: number; iterations: number; minEffect: number; rng: Rng },
): CalibrationStats {
  const n = aaImprovements.length;
  const aaCi = bootstrapMedianCI(aaImprovements, opts.confidence, opts.iterations, opts.rng);
  // Center the A/A pool so a constant offset between checkouts doesn't count as noise width.
  const centered = aaImprovements.map((v) => v - aaCi.median);
  const meds = new Float64Array(opts.iterations);
  const sample = new Array<number>(opts.nMax);
  for (let i = 0; i < opts.iterations; i++) {
    for (let j = 0; j < opts.nMax; j++) sample[j] = centered[Math.floor(opts.rng() * n)]!;
    meds[i] = Math.abs(median(sample));
  }
  const sorted = Array.from(meds).sort((a, b) => a - b);
  const halfWidthAtNMax = quantileSorted(sorted, opts.confidence);
  const mde = Math.max(opts.minEffect, halfWidthAtNMax);
  return {
    noiseFloor: robustSd(aaImprovements),
    halfWidthAtNMax,
    mde,
    detectable: mde + halfWidthAtNMax,
    aaCi,
    biased: aaCi.lo > 0 || aaCi.hi < 0,
  };
}

export type DeterministicDecision = "win" | "lose" | "inconclusive";

/** Deterministic class: one run each side; win only when strictly better beyond the tolerance. */
export function deterministicDecision(best: number, candidate: number, direction: Direction, tolerance: number): { decision: DeterministicDecision; effect: number } {
  const effect = improvement(best, candidate, direction);
  if (effect > tolerance) return { decision: "win", effect };
  if (effect < -tolerance) return { decision: "lose", effect };
  return { decision: "inconclusive", effect };
}
