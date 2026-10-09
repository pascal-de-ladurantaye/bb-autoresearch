// Holdout: a workload that lives on the bench host, run only on candidates
// about to be promoted. It catches changes that special-case the benchmark
// input. Agents only ever learn pass or fail: the numbers go to the private
// holdout_results table, never into samples, events, notices, verdicts,
// views, or diagnostics, and the command's output is discarded.
import type { Ctx } from "./context.ts";
import type { CandidateRow, StudyRow } from "./db/store.ts";
import type { HostRunner } from "./host/runner.ts";
import { parseMeasureOutput } from "./metrics.ts";
import type { Side } from "./noise.ts";
import type { StudySpec } from "./spec.ts";
import { improvement, median } from "./stats.ts";

export interface HoldoutOutcome {
  pass: boolean;
  /** Safe for agents: no numbers, no command, no output. */
  reason: string;
  /** The holdout failed on best itself: the oracle is broken, not the candidate. */
  broken: boolean;
}

export const HOLDOUT_PASS = "passed the holdout check (a hidden workload on the bench host; agents see pass/fail only)";
export const HOLDOUT_FAIL = "failed the holdout check (a hidden workload on the bench host; agents see pass/fail only)";

export async function runHoldout(
  ctx: Ctx,
  study: StudyRow,
  c: CandidateRow,
  spec: StudySpec,
  runner: HostRunner,
  dirs: Record<Side, string>,
  signal?: AbortSignal,
): Promise<HoldoutOutcome> {
  const h = spec.oracle.holdout!;
  const metric = h.metric ?? spec.metric.name;
  const improvements: number[] = [];
  const raw: Array<{ best: number; candidate: number }> = [];
  for (let i = 0; i < h.runs; i++) {
    const order: Side[] = ctx.rng() < 0.5 ? ["best", "candidate"] : ["candidate", "best"];
    const got: Partial<Record<Side, number>> = {};
    for (const side of order) {
      // No onProgress: holdout output never leaves the host call.
      const r = await runner.run({ cwd: dirs[side], command: h.measure, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: "holdout" }, signal ? { signal } : {});
      const v = r.exitCode === 0 ? parseMeasureOutput(r.stdout).metrics[metric] : undefined;
      if (v === undefined) {
        ctx.store.recordHoldout({ candidate_id: c.id, study_id: study.id, pass: false, runs: i, effect: null, details: { failedSide: side, exitCode: r.exitCode } });
        return side === "best"
          ? { pass: false, broken: true, reason: "the holdout check failed on best itself" }
          : { pass: false, broken: false, reason: HOLDOUT_FAIL };
      }
      got[side] = v;
    }
    raw.push({ best: got.best!, candidate: got.candidate! });
    improvements.push(improvement(got.best!, got.candidate!, spec.metric.direction));
  }
  const effect = median(improvements);
  const pass = effect >= -h.max_regression;
  ctx.store.recordHoldout({ candidate_id: c.id, study_id: study.id, pass, runs: h.runs, effect, details: { metric, raw, maxRegression: h.max_regression } });
  return { pass, broken: false, reason: pass ? HOLDOUT_PASS : HOLDOUT_FAIL };
}
