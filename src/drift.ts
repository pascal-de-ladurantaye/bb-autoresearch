// Drift checks: while Running, an A/A run on best every `oracle.drift.every`
// evaluations per bench host. If the noise has grown past `max_ratio` (2×)
// the calibrated level, the study pauses and the human is notified: a
// disturbed bench machine would otherwise hand out random verdicts.
import { perRunSeconds, type Bench, type RunResult, type Side } from "./noise.ts";
import type { StudySpec } from "./spec.ts";
import { improvement, median, robustSd, sampleSd, type Rng } from "./stats.ts";

export interface DriftResult {
  pairs: number;
  /** Same statistic as the calibrated noise floor (noisy: robust SD of A/A paired differences; expensive: RMS deviation of best runs from the baseline). */
  noise: number;
  calibrated: number | null;
  ratio: number;
  median: number;
  ok: boolean;
  /** Median seconds of one run of the measure command on best during the check (the auto-recalibration trigger). */
  runSeconds?: number | null;
}

/** Below this the calibrated floor is treated as this (avoids dividing by ~0). */
const FLOOR = 1e-4;

export function assessDrift(noise: number, med: number, calibrated: number | null, maxRatio: number, pairs: number): DriftResult {
  const base = Math.max(calibrated ?? 0, FLOOR);
  const ratio = noise / base;
  return { pairs, noise, calibrated, ratio, median: med, ok: calibrated === null ? true : ratio <= maxRatio };
}

/** noisy: `pairs` A/A pairs of best against a second checkout of best, in random order. */
export async function driftNoisy(bench: Bench, spec: StudySpec, rng: Rng, calibrated: number | null, signal?: AbortSignal): Promise<DriftResult> {
  const { pairs, max_ratio } = spec.oracle.drift;
  const metric = spec.metric;
  const diffs: number[] = [];
  const secs: number[] = [];
  for (let i = 0; i < pairs; i++) {
    if (signal?.aborted) throw new Error("drift check aborted");
    const order: Side[] = rng() < 0.5 ? ["best", "candidate"] : ["candidate", "best"];
    const runs: Partial<Record<Side, RunResult>> = {};
    for (const side of order) {
      runs[side] = await bench.run(side);
      secs.push(perRunSeconds(runs[side]!));
    }
    diffs.push(improvement(runs.best!.metrics[metric.name]!, runs.candidate!.metrics[metric.name]!, metric.direction));
  }
  const noise = robustSd(diffs) || sampleSd(diffs);
  return { ...assessDrift(noise, median(diffs), calibrated, max_ratio, pairs), runSeconds: secs.length ? median(secs) : null };
}

/** expensive: `pairs` runs of best compared with the bench host's baseline median. */
export async function driftExpensive(bench: Bench, spec: StudySpec, baseline: RunResult[], calibrated: number | null, signal?: AbortSignal): Promise<DriftResult> {
  const { pairs, max_ratio } = spec.oracle.drift;
  const metric = spec.metric;
  const runs: number[] = [];
  for (let i = 0; i < pairs; i++) {
    if (signal?.aborted) throw new Error("drift check aborted");
    runs.push((await bench.run("best")).metrics[metric.name]!);
  }
  const base = baseline.length ? median(baseline.map((b) => b.metrics[metric.name]!)) : median(runs);
  const dev = runs.map((v) => improvement(base, v, metric.direction));
  const noise = Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / dev.length);
  return assessDrift(noise, median(dev), calibrated, max_ratio, pairs);
}
