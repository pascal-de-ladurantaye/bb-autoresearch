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

/**
 * Why a sequential test stopped: a clear `win` or `lose` after n_min, an
 * `early` lose before n_min (a CI entirely below 0 at the stricter
 * confidence), `futility` (after n_min the CI's upper bound is below the win
 * threshold: it can no longer win), or the `cap` at n_max.
 */
export type StopReason = "win" | "lose" | "early" | "futility" | "cap";

export interface SequentialInput {
  improvements: readonly number[];
  nMin: number;
  nMax: number;
  /** Minimum detectable effect (fraction). A win needs the CI lower bound above it. */
  mde: number;
  confidence: number;
  iterations: number;
  rng: Rng;
  /** Stop as inconclusive after n_min once the CI's upper bound is below the MDE (v0.2.4; default off here, on in the spec). */
  futility?: boolean;
  /** From this many pairs before n_min, a CI entirely below 0 at `earlyLoseConfidence` is a lose (0 or absent: off). */
  earlyLoseFrom?: number;
  earlyLoseConfidence?: number;
}

export interface SequentialResult {
  decision: SequentialDecision;
  ci: Interval;
  /** Set when the test stopped. */
  stop?: StopReason;
  /** Before n_min: the early-lose check's CI (at the stricter confidence), when it ran. */
  early?: Interval;
}

/** Student-t CDF for an integer number of degrees of freedom (the exact finite series). */
export function tCdf(t: number, df: number): number {
  const v = Math.max(1, Math.round(df));
  const theta = Math.atan(t / Math.sqrt(v));
  const c2 = Math.cos(theta) ** 2;
  const sin = Math.sin(theta);
  if (v % 2 === 1) {
    let sum = 0;
    let term = Math.cos(theta);
    for (let k = 3; k <= v; k += 2) {
      sum += term;
      term *= (c2 * (k - 1)) / k;
    }
    return 0.5 + (theta + sin * (v > 1 ? sum : 0)) / Math.PI;
  }
  let sum = 0;
  let term = 1;
  for (let k = 2; k <= v; k += 2) {
    sum += term;
    term *= (c2 * (k - 1)) / k;
  }
  return 0.5 + (sin * sum) / 2;
}

/** One-sided Student-t quantile, exact for integer degrees of freedom (bisection on `tCdf`). */
export function tQuantileExact(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < 0.5) return -tQuantileExact(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The early-lose check's interval: a two-sided Student-t CI of the MEAN of
 * the per-pair improvements. The bootstrap percentile CI of the median the
 * sequential test uses after n_min is badly miscalibrated at 3-5 pairs (a
 * "99%" bootstrap CI of 3 pairs is just [min, max], which covers the true
 * median 75% of the time), so the early check uses the t interval, valid at
 * small n for roughly normal pair noise and conservative with outliers
 * (they inflate the SD). Deterministic: no resampling.
 */
export function earlyLoseCI(values: readonly number[], confidence: number): Interval {
  const n = values.length;
  if (n < 2) return { median: values[0] ?? Number.NaN, lo: Number.NaN, hi: Number.NaN, n };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const half = tQuantileExact(1 - (1 - confidence) / 2, n - 1) * (sampleSd(values) / Math.sqrt(n));
  return { median: median(values), lo: mean - half, hi: mean + half, n };
}

/** Whether the early-lose check runs at `n` pairs. */
export function earlyLoseApplies(n: number, nMin: number, earlyLoseFrom: number | undefined): boolean {
  return Boolean(earlyLoseFrom && earlyLoseFrom > 0 && n >= earlyLoseFrom && n < nMin && n >= 2);
}

/**
 * After n_min: lose when the CI is entirely on the regression side, win when
 * the lower bound clears the MDE, inconclusive once the upper bound can no
 * longer clear it (futility) or at n_max. Before n_min, an early lose needs
 * the CI entirely below 0 at a stricter confidence (`earlyLoseCI`: a t
 * interval of the mean, valid at a few pairs).
 */
export function sequentialDecision(input: SequentialInput): SequentialResult {
  const n = input.improvements.length;
  if (n < input.nMin) {
    const open = { median: median(input.improvements), lo: Number.NaN, hi: Number.NaN, n };
    if (earlyLoseApplies(n, input.nMin, input.earlyLoseFrom)) {
      const early = earlyLoseCI(input.improvements, input.earlyLoseConfidence ?? 0.99);
      if (early.hi < 0) return { decision: "lose", ci: early, stop: "early", early };
      return { decision: "continue", ci: open, early };
    }
    return { decision: "continue", ci: open };
  }
  const ci = bootstrapMedianCI(input.improvements, input.confidence, input.iterations, input.rng);
  if (ci.hi < 0) return { decision: "lose", ci, stop: "lose" };
  if (ci.lo > input.mde) return { decision: "win", ci, stop: "win" };
  if (input.futility && ci.hi < input.mde) return { decision: "inconclusive", ci, stop: "futility" };
  if (n >= input.nMax) return { decision: "inconclusive", ci, stop: "cap" };
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

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Sample standard deviation (n - 1). */
export function sampleSd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * One-sided Student-t quantile, by the Cornish-Fisher expansion around the
 * normal quantile (accurate to ~0.01 for df ≥ 3 at the usual confidences).
 */
export function tQuantile(p: number, df: number): number {
  const z = normalQuantile(p);
  if (!Number.isFinite(df) || df <= 0) return z;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}
