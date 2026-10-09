// Noise-class strategies behind one interface. The pipeline hands a strategy
// a Bench (two prepared checkouts on one bench host) and gets back a
// decision with an effect estimate; verdict.ts then applies guardrails.
import type { NoiseClass, StudySpec } from "./spec.ts";
import {
  calibrateNoisy,
  deterministicDecision,
  improvement,
  median,
  sampleSd,
  sequentialDecision,
  tQuantile,
  type Rng,
} from "./stats.ts";

export type Side = "best" | "candidate";

export interface RunResult {
  metrics: Record<string, number>;
  diag: string[];
  durationMs: number;
}

export class BenchError extends Error {
  constructor(
    readonly side: Side,
    message: string,
    readonly output = "",
  ) {
    super(message);
    this.name = "BenchError";
  }
}

export interface Bench {
  /** One `measure` run on a side. Throws BenchError when the run fails or the primary metric is missing. */
  run(side: Side): Promise<RunResult>;
}

export interface Sample {
  pair: number;
  side: Side;
  metrics: Record<string, number>;
}

export interface MeasureContext {
  bench: Bench;
  spec: StudySpec;
  mde: number;
  rng: Rng;
  record: (sample: Sample) => void;
  /** A previous run of the current best, when the class allows reusing it. */
  bestCache?: RunResult | null;
  /** expensive: runs of the current best on this bench host (calibration, or the promoted winner's confirmation runs). */
  baseline?: RunResult[] | null;
  /** Calibrated per-run noise (expensive: σ of one run, relative). */
  noiseFloor?: number | null;
  signal?: AbortSignal;
}

export type Decision = "win" | "lose" | "inconclusive";

export interface MeasureOutcome {
  decision: Decision;
  /** Primary-metric relative improvement, positive = better. */
  effect: number;
  ciLo: number | null;
  ciHi: number | null;
  n: number;
  /** Per guardrail: median relative regression, positive = worse. */
  guardrails: Record<string, number>;
  bestMetrics: Record<string, number>;
  candidateMetrics: Record<string, number>;
  bestDiag: string[];
  candidateDiag: string[];
  /** A best run the caller may cache for the next candidate. */
  bestRun: RunResult | null;
  /** expensive: the baseline runs used (cache them for the next candidate). */
  baselineRuns?: RunResult[];
  /** expensive: the candidate's confirmation runs (the new baseline if it is promoted). */
  confirmRuns?: RunResult[];
}

export interface CalibrationContext {
  /** Both sides are checkouts of the same baseline commit. */
  bench: Bench;
  spec: StudySpec;
  rng: Rng;
  record: (sample: Sample) => void;
  signal?: AbortSignal;
}

export interface CalibrationOutcome {
  ok: boolean;
  problems: string[];
  noiseFloor: number;
  mde: number;
  /** Bench seconds for one typical evaluation. */
  evalSeconds: number;
  report: string;
  details: Record<string, number | string | boolean>;
  bestRun: RunResult | null;
  /** expensive: every baseline run (the bench host's baseline for the segment). */
  baselineRuns?: RunResult[];
}

export interface NoiseStrategy {
  readonly kind: NoiseClass;
  /** Whether measurement needs exclusive use of the bench host. */
  readonly benchLock: boolean;
  calibrate(ctx: CalibrationContext): Promise<CalibrationOutcome>;
  measure(ctx: MeasureContext): Promise<MeasureOutcome>;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("measurement aborted");
}

function guardrailRegressions(spec: StudySpec, pairs: Array<{ best: Record<string, number>; candidate: Record<string, number> }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of spec.guardrail) {
    const values: number[] = [];
    for (const p of pairs) {
      const b = p.best[g.name];
      const c = p.candidate[g.name];
      if (b === undefined || c === undefined) continue;
      values.push(-improvement(b, c, g.direction));
    }
    out[g.name] = values.length ? median(values) : Number.NaN;
  }
  return out;
}

function medianMetrics(runs: Array<Record<string, number>>): Record<string, number> {
  const keys = new Set(runs.flatMap((r) => Object.keys(r)));
  const out: Record<string, number> = {};
  for (const k of keys) {
    const vals = runs.map((r) => r[k]).filter((v): v is number => v !== undefined);
    if (vals.length) out[k] = median(vals);
  }
  return out;
}

const fmt = (f: number) => `${(f * 100).toFixed(2)}%`;
const duration = (seconds: number) => (seconds < 120 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`);

export const noisyStrategy: NoiseStrategy = {
  kind: "noisy",
  benchLock: true,
  async calibrate(ctx) {
    const p = ctx.spec.oracle.protocol;
    const metric = ctx.spec.metric;
    for (let w = 0; w < p.warmup; w++) {
      await ctx.bench.run("best");
      await ctx.bench.run("candidate");
    }
    const improvements: number[] = [];
    let pairMs = 0;
    let bestRun: RunResult | null = null;
    for (let i = 0; i < p.calibration_pairs; i++) {
      checkAborted(ctx.signal);
      const order: Side[] = ctx.rng() < 0.5 ? ["best", "candidate"] : ["candidate", "best"];
      const runs: Partial<Record<Side, RunResult>> = {};
      for (const side of order) {
        const r = await ctx.bench.run(side);
        runs[side] = r;
        pairMs += r.durationMs;
        ctx.record({ pair: i, side, metrics: r.metrics });
      }
      bestRun = runs.best!;
      improvements.push(improvement(runs.best!.metrics[metric.name]!, runs.candidate!.metrics[metric.name]!, metric.direction));
    }
    const stats = calibrateNoisy(improvements, {
      nMax: p.n_max,
      confidence: p.confidence,
      iterations: p.bootstrap,
      minEffect: p.min_effect,
      rng: ctx.rng,
    });
    const secondsPerPair = pairMs / 1000 / p.calibration_pairs;
    const evalSeconds = secondsPerPair * ((p.n_min + p.n_max) / 2) * (p.confirm ? 1.3 : 1);
    const problems: string[] = [];
    if (stats.mde > p.max_mde) problems.push(`minimum detectable effect ${fmt(stats.mde)} exceeds max_mde ${fmt(p.max_mde)}: the oracle is too noisy`);
    if (stats.biased) problems.push(`A/A median ${fmt(stats.aaCi.median)} (CI ${fmt(stats.aaCi.lo)}..${fmt(stats.aaCi.hi)}) excludes zero: the two bench checkouts are not equivalent`);
    const report =
      `Detects changes of ${fmt(stats.detectable)} or more with ${p.n_max} pairs (win threshold on the CI lower bound: ${fmt(stats.mde)}). ` +
      `Noise floor ${fmt(stats.noiseFloor)} per pair. About ${duration(evalSeconds)} per evaluation, ` +
      `so about ${Math.round(3600 / Math.max(0.1, evalSeconds))} evaluations per hour per bench host.`;
    return {
      ok: problems.length === 0,
      problems,
      noiseFloor: stats.noiseFloor,
      mde: stats.mde,
      evalSeconds,
      report,
      details: {
        pairs: p.calibration_pairs,
        aaMedian: stats.aaCi.median,
        aaLo: stats.aaCi.lo,
        aaHi: stats.aaCi.hi,
        halfWidthAtNMax: stats.halfWidthAtNMax,
        detectable: stats.detectable,
        secondsPerPair,
      },
      bestRun,
    };
  },
  async measure(ctx) {
    const p = ctx.spec.oracle.protocol;
    const metric = ctx.spec.metric;
    for (let w = 0; w < p.warmup; w++) {
      await ctx.bench.run("best");
      await ctx.bench.run("candidate");
    }
    const pairs: Array<{ best: RunResult; candidate: RunResult }> = [];
    const improvements: number[] = [];
    let last: ReturnType<typeof sequentialDecision> | null = null;
    for (let i = 0; i < p.n_max; i++) {
      checkAborted(ctx.signal);
      const order: Side[] = ctx.rng() < 0.5 ? ["best", "candidate"] : ["candidate", "best"];
      const runs: Partial<Record<Side, RunResult>> = {};
      for (const side of order) {
        const r = await ctx.bench.run(side);
        runs[side] = r;
        ctx.record({ pair: i, side, metrics: r.metrics });
      }
      pairs.push({ best: runs.best!, candidate: runs.candidate! });
      improvements.push(improvement(runs.best!.metrics[metric.name]!, runs.candidate!.metrics[metric.name]!, metric.direction));
      last = sequentialDecision({
        improvements,
        nMin: p.n_min,
        nMax: p.n_max,
        mde: ctx.mde,
        confidence: p.confidence,
        iterations: p.bootstrap,
        rng: ctx.rng,
      });
      if (last.decision !== "continue") break;
    }
    const decision = last && last.decision !== "continue" ? last.decision : "inconclusive";
    return {
      decision,
      effect: last?.ci.median ?? Number.NaN,
      ciLo: last && Number.isFinite(last.ci.lo) ? last.ci.lo : null,
      ciHi: last && Number.isFinite(last.ci.hi) ? last.ci.hi : null,
      n: pairs.length,
      guardrails: guardrailRegressions(ctx.spec, pairs.map((x) => ({ best: x.best.metrics, candidate: x.candidate.metrics }))),
      bestMetrics: medianMetrics(pairs.map((x) => x.best.metrics)),
      candidateMetrics: medianMetrics(pairs.map((x) => x.candidate.metrics)),
      bestDiag: pairs.at(-1)?.best.diag ?? [],
      candidateDiag: pairs.at(-1)?.candidate.diag ?? [],
      bestRun: pairs.at(-1)?.best ?? null,
    };
  },
};

export const deterministicStrategy: NoiseStrategy = {
  kind: "deterministic",
  benchLock: false,
  async calibrate(ctx) {
    const metric = ctx.spec.metric;
    const tol = ctx.spec.oracle.protocol.tolerance;
    const a = await ctx.bench.run("best");
    ctx.record({ pair: 0, side: "best", metrics: a.metrics });
    const b = await ctx.bench.run("candidate");
    ctx.record({ pair: 0, side: "candidate", metrics: b.metrics });
    const diff = Math.abs(improvement(a.metrics[metric.name]!, b.metrics[metric.name]!, metric.direction));
    const problems = diff > tol ? [`two runs of the baseline differ by ${fmt(diff)} (> tolerance ${fmt(tol)}): the metric is not deterministic; use noise = "noisy"`] : [];
    const evalSeconds = (a.durationMs + b.durationMs) / 2 / 1000;
    return {
      ok: problems.length === 0,
      problems,
      noiseFloor: diff,
      mde: tol,
      evalSeconds,
      report: `Deterministic: baseline ${metric.name}=${a.metrics[metric.name]}${ctx.spec.metric.unit ? ` ${ctx.spec.metric.unit}` : ""}, repeat differs by ${fmt(diff)}. A candidate wins when it is better by more than ${fmt(tol)}. About ${duration(evalSeconds)} per evaluation.`,
      details: { baseline: a.metrics[metric.name]!, repeatDiff: diff },
      bestRun: a,
    };
  },
  async measure(ctx) {
    const metric = ctx.spec.metric;
    const best = ctx.bestCache ?? (await ctx.bench.run("best"));
    ctx.record({ pair: 0, side: "best", metrics: best.metrics });
    const cand = await ctx.bench.run("candidate");
    ctx.record({ pair: 0, side: "candidate", metrics: cand.metrics });
    const { decision, effect } = deterministicDecision(best.metrics[metric.name]!, cand.metrics[metric.name]!, metric.direction, ctx.spec.oracle.protocol.tolerance);
    return {
      decision,
      effect,
      ciLo: effect,
      ciHi: effect,
      n: 1,
      guardrails: guardrailRegressions(ctx.spec, [{ best: best.metrics, candidate: cand.metrics }]),
      bestMetrics: best.metrics,
      candidateMetrics: cand.metrics,
      bestDiag: best.diag,
      candidateDiag: cand.diag,
      bestRun: best,
    };
  },
};

/**
 * Expensive class: a run costs minutes to hours, so pairs are unaffordable.
 *
 * - Calibration takes `calibration_runs` baseline runs. σ is the per-run
 *   relative noise: the sample SD of the runs around their median. (With so
 *   few runs the robust MAD estimate underestimates σ too often.)
 * - A candidate gets ONE screening run, compared against the median of the
 *   bench host's baseline runs (m of them). It is promising when its
 *   improvement e1 > max(min_effect, z·σ·√(1 + 1/m)), a clear lose below the
 *   negative of that, and inconclusive in between.
 * - A promising run is confirmed with k = `confirm_runs` (default 3) fresh
 *   runs. The screening run is left out of the decision (it was selected
 *   because it looked good, so it is biased). The confirmed effect is the
 *   mean of the k runs; a win needs it above max(min_effect, z·σ·√(1/k + 1/m)).
 * - z is the one-sided Student-t quantile of `confidence` with
 *   calibration_runs - 1 degrees of freedom, because σ is itself estimated
 *   from a handful of runs. k = 3 cuts the confirmation threshold to
 *   √(1/3 + 1/m)/√(1 + 1/m) ≈ 0.6 of the screen. Simulated with σ estimated
 *   from 5 runs (see the M2 implementation notes): about 1% false wins at no
 *   effect, and most 3σ effects found.
 * - The winner's k confirmation runs become the next best's baseline on that
 *   host, so a promotion costs no extra baseline run.
 */
export const expensiveStrategy: NoiseStrategy = {
  kind: "expensive",
  benchLock: true,
  async calibrate(ctx) {
    const metric = ctx.spec.metric;
    const p = ctx.spec.oracle.protocol;
    const runs: RunResult[] = [];
    for (let i = 0; i < p.calibration_runs; i++) {
      checkAborted(ctx.signal);
      const side: Side = i % 2 ? "candidate" : "best";
      const r = await ctx.bench.run(side);
      ctx.record({ pair: i, side, metrics: r.metrics });
      runs.push(r);
    }
    const values = runs.map((r) => r.metrics[metric.name]!);
    const m = median(values);
    const rel = values.map((v) => improvement(m, v, metric.direction));
    const noiseFloor = sampleSd(rel);
    const z = tQuantile(p.confidence, p.calibration_runs - 1);
    const k = p.confirm_runs;
    const mde = Math.max(p.min_effect, z * noiseFloor * Math.sqrt(1 / k + 1 / runs.length));
    const evalSeconds = median(runs.map((r) => r.durationMs)) / 1000;
    const problems = mde > p.max_mde ? [`minimum detectable effect ${fmt(mde)} exceeds max_mde ${fmt(p.max_mde)}: the oracle is too noisy`] : [];
    return {
      ok: problems.length === 0,
      problems,
      noiseFloor,
      mde,
      evalSeconds,
      report:
        `Expensive: ${runs.length} baseline runs, per-run noise ${fmt(noiseFloor)}. One screening run per candidate; a promising run is confirmed with ${k} more, ` +
        `and a win needs the confirmed mean above ${fmt(mde)}. About ${duration(evalSeconds)} per run (${duration(evalSeconds * (1 + k))} for a confirmed win).`,
      details: { baseline: m, runs: runs.length, confirmRuns: k, z },
      bestRun: runs[0]!,
      baselineRuns: runs,
    };
  },
  async measure(ctx) {
    const metric = ctx.spec.metric;
    const p = ctx.spec.oracle.protocol;
    const z = tQuantile(p.confidence, p.calibration_runs - 1);
    const k = p.confirm_runs;
    let baseline = ctx.baseline?.length ? [...ctx.baseline] : [];
    if (!baseline.length) {
      const b = ctx.bestCache ?? (await ctx.bench.run("best"));
      baseline = [b];
    }
    baseline.forEach((b, i) => ctx.record({ pair: i, side: "best", metrics: b.metrics }));
    const m = baseline.length;
    const baseVal = median(baseline.map((b) => b.metrics[metric.name]!));
    // Without a calibrated σ, fall back to the MDE as a two-sigma band.
    const sigma = ctx.noiseFloor ?? ctx.mde / 2;
    const screen = await ctx.bench.run("candidate");
    ctx.record({ pair: 0, side: "candidate", metrics: screen.metrics });
    const e1 = improvement(baseVal, screen.metrics[metric.name]!, metric.direction);
    const thr1 = Math.max(p.min_effect, z * sigma * Math.sqrt(1 + 1 / m));
    const bestMetrics = medianMetrics(baseline.map((b) => b.metrics));
    let decision: Decision = e1 < -thr1 ? "lose" : "inconclusive";
    let effect = e1;
    let half = thr1;
    let confirmRuns: RunResult[] = [];
    if (e1 > thr1) {
      for (let i = 0; i < k; i++) {
        checkAborted(ctx.signal);
        const r = await ctx.bench.run("candidate");
        ctx.record({ pair: i + 1, side: "candidate", metrics: r.metrics });
        confirmRuns.push(r);
      }
      const effects = confirmRuns.map((r) => improvement(baseVal, r.metrics[metric.name]!, metric.direction));
      effect = effects.reduce((a, b) => a + b, 0) / effects.length;
      half = z * sigma * Math.sqrt(1 / k + 1 / m);
      const thr2 = Math.max(p.min_effect, half);
      decision = effect > thr2 ? "win" : effect < -thr2 ? "lose" : "inconclusive";
    }
    const judged = confirmRuns.length ? confirmRuns : [screen];
    const candidateMetrics = medianMetrics(judged.map((r) => r.metrics));
    return {
      decision,
      effect,
      ciLo: effect - half,
      ciHi: effect + half,
      n: 1 + confirmRuns.length,
      guardrails: guardrailRegressions(ctx.spec, [{ best: bestMetrics, candidate: candidateMetrics }]),
      bestMetrics,
      candidateMetrics,
      bestDiag: baseline.at(-1)!.diag,
      candidateDiag: judged.at(-1)!.diag,
      bestRun: baseline[0]!,
      baselineRuns: baseline,
      ...(confirmRuns.length ? { confirmRuns } : {}),
    };
  },
};

export function strategyFor(kind: NoiseClass): NoiseStrategy {
  switch (kind) {
    case "noisy":
      return noisyStrategy;
    case "deterministic":
      return deterministicStrategy;
    case "expensive":
      return expensiveStrategy;
  }
}
