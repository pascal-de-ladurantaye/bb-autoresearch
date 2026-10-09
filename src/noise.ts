// Noise-class strategies behind one interface. The pipeline hands a strategy
// a Bench (two prepared checkouts on one bench host) and gets back a
// decision with an effect estimate; verdict.ts then applies guardrails.
import type { NoiseClass, StudySpec } from "./spec.ts";
import {
  calibrateNoisy,
  deterministicDecision,
  improvement,
  median,
  robustSd,
  sequentialDecision,
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
 * Expensive class: one run per candidate against the calibrated noise floor;
 * a run that clears the MDE is confirmed with `confirm_runs` more runs.
 * Minimal in M0 (open question 8 tracks the right confirmation count).
 */
export const expensiveStrategy: NoiseStrategy = {
  kind: "expensive",
  benchLock: true,
  async calibrate(ctx) {
    const metric = ctx.spec.metric;
    const runs: RunResult[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ctx.bench.run(i % 2 ? "candidate" : "best");
      ctx.record({ pair: i, side: i % 2 ? "candidate" : "best", metrics: r.metrics });
      runs.push(r);
    }
    const values = runs.map((r) => r.metrics[metric.name]!);
    const m = median(values);
    const rel = values.map((v) => improvement(m, v, metric.direction));
    const noiseFloor = robustSd(rel) || Math.max(...rel.map(Math.abs));
    const mde = Math.max(ctx.spec.oracle.protocol.min_effect, 2 * noiseFloor);
    const evalSeconds = median(runs.map((r) => r.durationMs)) / 1000;
    const problems = mde > ctx.spec.oracle.protocol.max_mde ? [`minimum detectable effect ${fmt(mde)} exceeds max_mde`] : [];
    return {
      ok: problems.length === 0,
      problems,
      noiseFloor,
      mde,
      evalSeconds,
      report: `Expensive: 3 baseline runs, noise floor ${fmt(noiseFloor)}, win threshold ${fmt(mde)}, about ${duration(evalSeconds)} per run.`,
      details: { baseline: m },
      bestRun: runs[0]!,
    };
  },
  async measure(ctx) {
    const metric = ctx.spec.metric;
    const best = ctx.bestCache ?? (await ctx.bench.run("best"));
    ctx.record({ pair: 0, side: "best", metrics: best.metrics });
    const runs: RunResult[] = [await ctx.bench.run("candidate")];
    ctx.record({ pair: 0, side: "candidate", metrics: runs[0]!.metrics });
    let effect = improvement(best.metrics[metric.name]!, runs[0]!.metrics[metric.name]!, metric.direction);
    let decision: Decision = effect < -ctx.mde ? "lose" : "inconclusive";
    if (effect > ctx.mde) {
      for (let k = 0; k < ctx.spec.oracle.protocol.confirm_runs; k++) {
        checkAborted(ctx.signal);
        const r = await ctx.bench.run("candidate");
        ctx.record({ pair: k + 1, side: "candidate", metrics: r.metrics });
        runs.push(r);
      }
      effect = median(runs.map((r) => improvement(best.metrics[metric.name]!, r.metrics[metric.name]!, metric.direction)));
      decision = effect > ctx.mde ? "win" : "inconclusive";
    }
    const candidateMetrics = medianMetrics(runs.map((r) => r.metrics));
    return {
      decision,
      effect,
      ciLo: null,
      ciHi: null,
      n: runs.length,
      guardrails: guardrailRegressions(ctx.spec, [{ best: best.metrics, candidate: candidateMetrics }]),
      bestMetrics: best.metrics,
      candidateMetrics,
      bestDiag: best.diag,
      candidateDiag: runs.at(-1)!.diag,
      bestRun: best,
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
