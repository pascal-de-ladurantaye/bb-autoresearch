// The live CI band of one measurement: how the estimate and its confidence
// interval evolve pair by pair (noisy), the single run against the
// tolerance (deterministic), or the runs against the calibrated σ band
// (expensive). Built from the `samples` rows alone, so the live view and
// replay show the same thing. Pure and frontend-safe.
//
// Consistency with the real decision (noisy): the sequential test's
// bootstrap at pair n uses a generator seeded from (candidate, run, n)
// (`ciSeed`, passed to the strategy as `ciRng`), so recomputing the CI from
// the stored samples with the same seed and the same number of iterations
// gives exactly the CI the decision saw, at every judged pair. Before n_min
// the decision computes no CI; the band shows one for orientation, with at
// most PREVIEW_ITERATIONS resamples. See docs/design.md, "Implementation
// notes: live view (part 2)".
import { estimatePaired, judgeGuardrail, type GuardrailJudgement, type LimitCheck, type Position } from "./guardrails.ts";
import type { Direction } from "./present.ts";
import { bootstrapMedianCI, improvement, median, seededRng, tQuantile, type Rng } from "./stats.ts";

/** Resamples for CIs the decision doesn't use (before n_min, running guardrail estimates). */
export const PREVIEW_ITERATIONS = 400;

/** The seed of the sequential test's bootstrap at pair `n` of a run (FNV-1a). */
export function ciSeed(candidateId: number, run: string, n: number, salt = ""): number {
  const key = `${candidateId}:${run}:${n}:${salt}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function ciRngFor(candidateId: number, run: string): (n: number, salt?: string) => Rng {
  return (n, salt = "") => seededRng(ciSeed(candidateId, run, n, salt));
}

export type BandDecision = "continue" | "win" | "lose" | "inconclusive";

export interface BandPoint {
  /** Pairs (noisy) or runs (expensive) so far. */
  n: number;
  /** When the pair's (or run's) last sample landed. */
  at: number;
  /** Estimate: median improvement (noisy), the run's improvement (expensive, deterministic). Better is positive. */
  m: number;
  lo: number | null;
  hi: number | null;
}

export interface BandRun {
  run: "measure" | "confirm";
  points: BandPoint[];
  /** noisy: per guardrail, the per-pair regressions (positive = worse), aligned with the points. */
  gr: Record<string, number[]>;
}

export interface BandGuardrail {
  name: string;
  direction: Direction;
  limit: number;
  totalLimit: number;
  /** Best's position against the segment base before this candidate. */
  prior: Position | null;
}

/** A guardrail's checks at one moment: the step against best and the total against the segment base. */
export interface BandGuardrailState {
  name: string;
  state: GuardrailJudgement["state"];
  step: LimitCheck | null;
  total: LimitCheck | null;
  /** True once the measurement ended (the verdict's own numbers); false while running (an estimate). */
  final: boolean;
}

interface BandBase {
  /** candidates.id and n. */
  candidate: number;
  n: number;
  /** When the first sample landed. */
  startedAt: number | null;
  guardrails: BandGuardrail[];
  /** The verdict's guardrail checks, once the measurement ended (from the candidate's metrics). */
  final: { at: number; guardrails: BandGuardrailState[] } | null;
}

export interface NoisyBand extends BandBase {
  kind: "noisy";
  nMin: number;
  nMax: number;
  /** Win threshold on the CI's lower bound. */
  mde: number;
  confidence: number;
  bootstrap: number;
  /** False for measurements decided before the seeded bootstrap existed (recomputed; can differ slightly from the verdict's CI). */
  exact: boolean;
  runs: BandRun[];
}

export interface DeterministicBand extends BandBase {
  kind: "deterministic";
  tolerance: number;
  best: { v: number; at: number } | null;
  value: { v: number; at: number } | null;
  /** Improvement, better is positive, once both runs are in. */
  effect: number | null;
}

export interface ExpensiveBand extends BandBase {
  kind: "expensive";
  /** Calibrated per-run σ (relative). */
  sigma: number;
  z: number;
  minEffect: number;
  /** Confirmation runs a promising screen gets. */
  k: number;
  /** Baseline runs relative to their median (better is positive), and when they were recorded. */
  baseline: number[];
  baselineAt: number | null;
  /** The screening run (n = 1) and the confirmation runs (n = 1..k). */
  screen: BandPoint | null;
  confirm: BandPoint[];
}

export type MeasureBand = NoisyBand | DeterministicBand | ExpensiveBand;

export interface SampleLike {
  run: string;
  pair: number;
  side: string;
  metric: string;
  value: number;
  at: number;
}

export interface BandInput {
  kind: "noisy" | "deterministic" | "expensive";
  candidate: number;
  n: number;
  metric: { name: string; direction: Direction };
  protocol: { n_min: number; n_max: number; confidence: number; bootstrap: number; tolerance: number; min_effect: number; confirm_runs: number; calibration_runs: number };
  guardrails: BandGuardrail[];
  mde: number;
  /** expensive: calibrated per-run σ (null: mde / 2, as the strategy does). */
  noiseFloor: number | null;
  exact?: boolean;
  final?: BandBase["final"];
}

interface PairRow {
  best?: Record<string, number>;
  candidate?: Record<string, number>;
  at: number;
}

function groupPairs(samples: readonly SampleLike[], run: string): PairRow[] {
  const byPair = new Map<number, PairRow>();
  for (const s of samples) {
    if (s.run !== run) continue;
    const p = byPair.get(s.pair) ?? { at: 0 };
    const side = s.side === "best" ? "best" : "candidate";
    p[side] = { ...(p[side] ?? {}), [s.metric]: s.value };
    p.at = Math.max(p.at, s.at);
    byPair.set(s.pair, p);
  }
  const out: PairRow[] = [];
  for (let i = 0; byPair.has(i); i++) out.push(byPair.get(i)!);
  return out;
}

/** One noisy run's points from its pairs, reusing points already computed (`prev`) for the same prefix. */
function noisyRun(candidate: number, run: "measure" | "confirm", pairs: readonly PairRow[], input: BandInput, prev?: BandRun): BandRun {
  const { metric, protocol: p } = input;
  const imps: number[] = [];
  const points: BandPoint[] = [];
  const gr: Record<string, number[]> = Object.fromEntries(input.guardrails.map((g) => [g.name, [] as number[]]));
  const rngFor = ciRngFor(candidate, run);
  for (const pair of pairs) {
    if (!pair.best || !pair.candidate) break;
    const b = pair.best[metric.name];
    const c = pair.candidate[metric.name];
    if (b === undefined || c === undefined) break;
    imps.push(improvement(b, c, metric.direction));
    for (const g of input.guardrails) {
      const gb = pair.best[g.name];
      const gc = pair.candidate[g.name];
      gr[g.name]!.push(gb === undefined || gc === undefined ? Number.NaN : -improvement(gb, gc, g.direction));
    }
    const n = imps.length;
    const cached = prev?.points[n - 1];
    if (cached && cached.n === n && cached.at === pair.at) {
      points.push(cached);
      continue;
    }
    if (n === 1) {
      points.push({ n, at: pair.at, m: imps[0]!, lo: null, hi: null });
      continue;
    }
    const judged = n >= p.n_min;
    const ci = bootstrapMedianCI(imps, p.confidence, judged ? p.bootstrap : Math.min(p.bootstrap, PREVIEW_ITERATIONS), judged ? rngFor(n) : rngFor(n, "preview"));
    points.push({ n, at: pair.at, m: ci.median, lo: ci.lo, hi: ci.hi });
  }
  return { run, points, gr };
}

/**
 * The band of one measurement from its samples. `prev` (the band built
 * from fewer samples of the same measurement) lets the live view extend it
 * incrementally: points already computed are reused.
 */
export function buildBand(samples: readonly SampleLike[], input: BandInput, prev?: MeasureBand | null): MeasureBand {
  const base: BandBase = { candidate: input.candidate, n: input.n, startedAt: samples.length ? samples.reduce((a, s) => Math.min(a, s.at), Number.POSITIVE_INFINITY) : null, guardrails: input.guardrails, final: input.final ?? null };
  const p = input.protocol;
  if (input.kind === "noisy") {
    const old = prev?.kind === "noisy" ? prev : undefined;
    const runs: BandRun[] = [];
    for (const run of ["measure", "confirm"] as const) {
      const pairs = groupPairs(samples, run);
      if (!pairs.length) continue;
      const r = noisyRun(input.candidate, run, pairs, input, old?.runs.find((x) => x.run === run));
      if (r.points.length) runs.push(r);
    }
    return { ...base, kind: "noisy", nMin: p.n_min, nMax: p.n_max, mde: input.mde, confidence: p.confidence, bootstrap: p.bootstrap, exact: input.exact ?? true, runs };
  }
  const pairs = groupPairs(samples, "measure");
  if (input.kind === "deterministic") {
    const pr = pairs[0];
    const bv = pr?.best?.[input.metric.name];
    const cv = pr?.candidate?.[input.metric.name];
    const at = (side: string) => samples.filter((s) => s.run === "measure" && s.pair === 0 && s.side === side).reduce((a, s) => Math.max(a, s.at), 0) || null;
    const bestAt = at("best");
    const candAt = at("candidate");
    return {
      ...base,
      kind: "deterministic",
      tolerance: p.tolerance,
      best: bv !== undefined && bestAt !== null ? { v: bv, at: bestAt } : null,
      value: cv !== undefined && candAt !== null ? { v: cv, at: candAt } : null,
      effect: bv !== undefined && cv !== undefined ? improvement(bv, cv, input.metric.direction) : null,
    };
  }
  // expensive: best-side samples are the baseline runs; candidate pair 0 is the screen, pairs 1..k the confirmation.
  const bestRuns: Array<{ v: number; at: number }> = [];
  const candRuns: Array<{ pair: number; v: number; at: number }> = [];
  for (const s of samples) {
    if (s.run !== "measure" || s.metric !== input.metric.name) continue;
    if (s.side === "best") bestRuns[s.pair] = { v: s.value, at: s.at };
    else candRuns.push({ pair: s.pair, v: s.value, at: s.at });
  }
  const baseVals = bestRuns.filter(Boolean).map((b) => b.v);
  const baseVal = baseVals.length ? median(baseVals) : Number.NaN;
  const sigma = input.noiseFloor ?? input.mde / 2;
  const z = tQuantile(p.confidence, p.calibration_runs - 1);
  const m = Math.max(1, baseVals.length);
  const rel = (v: number) => improvement(baseVal, v, input.metric.direction);
  const thr1 = Math.max(p.min_effect, z * sigma * Math.sqrt(1 + 1 / m));
  const half2 = z * sigma * Math.sqrt(1 / p.confirm_runs + 1 / m);
  const screenRow = candRuns.find((r) => r.pair === 0);
  const confirmRows = candRuns.filter((r) => r.pair > 0).sort((a, b) => a.pair - b.pair);
  return {
    ...base,
    kind: "expensive",
    sigma,
    z,
    minEffect: p.min_effect,
    k: p.confirm_runs,
    baseline: Number.isFinite(baseVal) ? baseVals.map(rel) : [],
    baselineAt: bestRuns.filter(Boolean).reduce<number | null>((a, b) => (a === null ? b.at : Math.max(a, b.at)), null),
    screen: screenRow && Number.isFinite(baseVal) ? { n: 1, at: screenRow.at, m: rel(screenRow.v), lo: -thr1, hi: thr1 } : null,
    confirm: Number.isFinite(baseVal)
      ? confirmRows.map((r, i) => {
          const mean = confirmRows.slice(0, i + 1).reduce((a, x) => a + rel(x.v), 0) / (i + 1);
          return { n: i + 1, at: r.at, m: mean, lo: mean - half2, hi: mean + half2 };
        })
      : [],
  };
}

// ------------------------------------------------------------ reading

/** The sequential decision at one point of a noisy run (the same rule as stats.sequentialDecision). */
export function pointDecision(band: Pick<NoisyBand, "nMin" | "nMax" | "mde">, p: BandPoint): BandDecision {
  if (p.n < band.nMin || p.lo === null || p.hi === null) return "continue";
  if (p.hi < 0) return "lose";
  if (p.lo > band.mde) return "win";
  if (p.n >= band.nMax) return "inconclusive";
  return "continue";
}

/** Where a noisy run stopped: the first point with a decision, if any. */
export function runDecision(band: Pick<NoisyBand, "nMin" | "nMax" | "mde">, run: BandRun): { n: number; at: number; decision: Exclude<BandDecision, "continue"> } | null {
  for (const p of run.points) {
    const d = pointDecision(band, p);
    if (d !== "continue") return { n: p.n, at: p.at, decision: d };
  }
  return null;
}

/** The expensive class's thresholds: the screen's and the confirmation's (better is positive). */
export function expensiveThresholds(b: ExpensiveBand): { screen: number; confirm: number } {
  const m = Math.max(1, b.baseline.length);
  return { screen: Math.max(b.minEffect, b.z * b.sigma * Math.sqrt(1 + 1 / m)), confirm: Math.max(b.minEffect, b.z * b.sigma * Math.sqrt(1 / b.k + 1 / m)) };
}

/** The band as it was at time t (replay): later points, runs and the verdict's guardrails are dropped. */
export function bandAt(b: MeasureBand, t: number): MeasureBand | null {
  if (b.startedAt === null || b.startedAt > t) return null;
  const final = b.final && b.final.at <= t ? b.final : null;
  switch (b.kind) {
    case "noisy": {
      const runs = b.runs.map((r) => {
        const k = r.points.findIndex((p) => p.at > t);
        if (k < 0) return r;
        return { run: r.run, points: r.points.slice(0, k), gr: Object.fromEntries(Object.entries(r.gr).map(([g, v]) => [g, v.slice(0, k)])) };
      }).filter((r) => r.points.length);
      return { ...b, runs, final };
    }
    case "deterministic":
      return { ...b, best: b.best && b.best.at <= t ? b.best : null, value: b.value && b.value.at <= t ? b.value : null, effect: b.best && b.value && b.best.at <= t && b.value.at <= t ? b.effect : null, final };
    case "expensive":
      return { ...b, screen: b.screen && b.screen.at <= t ? b.screen : null, confirm: b.confirm.filter((p) => p.at <= t), final };
  }
}

/** The last time anything in the band changed (sample or verdict). */
export function bandEnd(b: MeasureBand): number | null {
  let end = b.final?.at ?? null;
  const at = (x: number | null | undefined) => {
    if (typeof x === "number") end = end === null ? x : Math.max(end, x);
  };
  if (b.kind === "noisy") for (const r of b.runs) at(r.points.at(-1)?.at);
  else if (b.kind === "deterministic") {
    at(b.best?.at);
    at(b.value?.at);
  } else {
    at(b.screen?.at);
    at(b.confirm.at(-1)?.at);
  }
  return end;
}

/** Pairs (noisy) or candidate runs measured so far in the band's current run (what "pair i of n" counts). */
export function bandProgress(b: MeasureBand): { run: "measure" | "confirm"; done: number } | null {
  if (b.kind === "noisy") {
    const r = b.runs.at(-1);
    return r ? { run: r.run, done: r.points.length } : null;
  }
  if (b.kind === "deterministic") return b.value ? { run: "measure", done: 1 } : null;
  if (!b.screen) return null;
  return { run: "measure", done: 1 + b.confirm.length };
}

/**
 * Guardrails at the band's latest point: the verdict's checks once the
 * measurement ended, else (noisy) a running estimate from the per-pair
 * regressions so far (pooled over both runs during the confirmation, as the
 * verdict does), judged by the same rule as the verdict.
 */
export function bandGuardrails(b: MeasureBand): BandGuardrailState[] {
  if (b.final) return b.final.guardrails;
  if (b.kind !== "noisy" || !b.runs.length) return [];
  const out: BandGuardrailState[] = [];
  for (const g of b.guardrails) {
    const values = b.runs.flatMap((r) => r.gr[g.name] ?? []).filter((v) => Number.isFinite(v));
    if (values.length < 2) continue;
    const n = b.runs.reduce((a, r) => a + r.points.length, 0);
    const est = estimatePaired(values, b.confidence, PREVIEW_ITERATIONS, seededRng(ciSeed(b.candidate, "guardrail", n, g.name)));
    const j = judgeGuardrail({ name: g.name, direction: g.direction, max_regression: g.limit, max_total_regression: g.totalLimit }, est, g.prior);
    out.push({ name: g.name, state: j.state, step: j.step, total: j.total, final: false });
  }
  return out;
}
