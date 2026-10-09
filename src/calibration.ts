// Calibration: gates on the baseline, then repeated A/A measurement. Produces
// the noise floor, the minimum detectable effect, and the cost of one
// evaluation, recorded as a segment.
import { createHash } from "node:crypto";
import type { Ctx } from "./context.ts";
import type { StudyRow } from "./db/store.ts";
import { strategyFor, BenchError, type CalibrationOutcome } from "./noise.ts";
import { withBench, type Pipeline } from "./pipeline.ts";
import { clip } from "./prompts.ts";
import { bestBranch, oracleHash, segmentRef } from "./spec.ts";

export interface CalibrationReport {
  ok: boolean;
  problems: string[];
  report: string;
  baselineSha: string;
  gateSeconds: number;
  noiseFloor: number | null;
  mde: number | null;
  evalSeconds: number | null;
  oracleHash: string;
  details: Record<string, number | string | boolean>;
  finishedAt: number;
}

function quoteGlob(g: string): string {
  return `':(glob)${g.replace(/'/gu, "")}'`;
}

export async function runCalibration(ctx: Ctx, pipeline: Pipeline, studyId: string): Promise<CalibrationReport> {
  const { store } = ctx;
  const study = store.study(studyId)!;
  const spec = store.spec(study);
  const runner = ctx.bb.hostRunner(study.host_id!);
  const repo = study.repo_path!;
  const timeoutMs = spec.oracle.timeout_minutes * 60_000;
  const problems: string[] = [];

  const finish = (partial: Partial<CalibrationReport> & { baselineSha: string; oracleHash: string }): CalibrationReport => ({
    ok: problems.length === 0,
    problems,
    report: "",
    gateSeconds: 0,
    noiseFloor: null,
    mde: null,
    evalSeconds: null,
    details: {},
    finishedAt: ctx.now(),
    ...partial,
  });

  // 1. Baseline: the existing best (re-calibration) or the spec's base ref.
  const existingBest = await runner.resolveRef(repo, `refs/heads/${bestBranch(study.slug)}`);
  // Before any promotion the baseline follows the spec's base ref; after one, re-calibration measures best.
  const hasPromotions = Boolean(study.best_sha && study.base_sha && study.best_sha !== study.base_sha);
  const baseSha = hasPromotions ? study.best_sha : await runner.resolveRef(repo, spec.study.base);
  if (!baseSha) {
    problems.push(`base ref ${JSON.stringify(spec.study.base)} not found in ${repo}`);
    return finish({ baselineSha: "", oracleHash: oracleHash(spec) });
  }

  // 2. Oracle hash includes the content of protected paths at the baseline.
  let protectedHash = "";
  if (spec.scope.protected.length) {
    const ls = await runner.exec({ cwd: repo, command: `git ls-tree -r ${baseSha} -- ${spec.scope.protected.map(quoteGlob).join(" ")}`, timeoutMs: 60_000 });
    protectedHash = createHash("sha256").update(ls.stdout).digest("hex").slice(0, 16);
  }
  const hash = oracleHash(spec, protectedHash);

  // 3. Gates on the baseline.
  const gateStarted = ctx.now();
  if (spec.oracle.gate.length) {
    const dir = await runner.checkout(repo, `${study.slug}-gate`, baseSha);
    for (const command of spec.oracle.gate) {
      const r = await runner.exec({ cwd: dir, command, timeoutMs });
      if (r.exitCode !== 0) {
        problems.push(`gate is red on the baseline: ${clip(command, 200)} exited ${r.exitCode}${r.timedOut ? " (timeout)" : ""}: ${clip(`${r.stdout}\n${r.stderr}`.trim(), 600)}`);
        return finish({ baselineSha: baseSha, oracleHash: hash, gateSeconds: (ctx.now() - gateStarted) / 1000 });
      }
    }
  }
  const gateSeconds = (ctx.now() - gateStarted) / 1000;

  // 4. A/A measurement on two checkouts of the baseline, holding the bench lock.
  const strategy = strategyFor(spec.oracle.noise);
  let outcome: CalibrationOutcome;
  try {
    outcome = await withBench(ctx, study, "calibration", null, async () => {
      const a = await runner.checkout(repo, `${study.slug}-best`, baseSha);
      const b = await runner.checkout(repo, `${study.slug}-cand`, baseSha);
      if (spec.oracle.build) {
        for (const dir of [a, b]) {
          const r = await runner.exec({ cwd: dir, command: spec.oracle.build, timeoutMs });
          if (r.exitCode !== 0) throw new BenchError("best", `build failed on the baseline (exit ${r.exitCode})`, `${r.stdout}\n${r.stderr}`);
        }
      }
      store.deleteCalibrationSamples(study.id);
      const bench = pipeline.makeBench(runner, spec, { best: a, candidate: b });
      return await strategy.calibrate({
        bench,
        spec,
        rng: ctx.rng,
        record: (s) => {
          for (const [metric, value] of Object.entries(s.metrics)) {
            store.addSample({ study_id: study.id, candidate_id: null, run: "calibration", pair: s.pair, side: s.side, metric, value, host_id: runner.hostId });
          }
        },
      });
    });
  } catch (e) {
    if (!(e instanceof BenchError)) throw e;
    problems.push(`${e.message}: ${clip(e.output.trim(), 600)}`);
    return finish({ baselineSha: baseSha, oracleHash: hash, gateSeconds });
  }
  problems.push(...outcome.problems);
  if (outcome.bestRun) {
    store.updateStudy(study.id, { best_run_json: JSON.stringify(outcome.bestRun), best_run_sha: baseSha });
  }
  const gateLine = spec.oracle.gate.length ? ` Gates take ${gateSeconds.toFixed(1)} s on the edit host.` : "";
  return finish({
    baselineSha: baseSha,
    oracleHash: hash,
    gateSeconds,
    noiseFloor: outcome.noiseFloor,
    mde: outcome.mde,
    evalSeconds: outcome.evalSeconds,
    report: outcome.report + gateLine,
    details: { ...outcome.details, existingBest: existingBest ?? "" },
  });
}

/** Persist a finished calibration: the segment, refs, and the study's calibration status. */
export async function recordCalibration(ctx: Ctx, study: StudyRow, report: CalibrationReport): Promise<void> {
  const { store } = ctx;
  if (!report.ok) {
    store.tx(() => {
      store.updateStudy(study.id, { calibration_status: "failed", calibration_json: JSON.stringify(report) });
      store.setStudyState(study.id, "draft", "plugin", { reason: "calibration failed", problems: report.problems });
    });
    return;
  }
  const runner = ctx.bb.hostRunner(study.host_id!);
  const repo = study.repo_path!;
  // A new segment starts only once candidates were judged under the previous oracle.
  const k = store.candidateCount(study.id) > 0 ? study.segment + 1 : Math.max(1, study.segment);
  // Create (or keep) studies/<slug>/best at the baseline and pin the segment base.
  const branch = `refs/heads/${bestBranch(study.slug)}`;
  const current = await runner.resolveRef(repo, branch);
  if (current !== report.baselineSha) {
    const r = await runner.updateRef(repo, branch, report.baselineSha, current);
    if (!r.ok) throw new Error(`could not set ${bestBranch(study.slug)} to the baseline`);
  }
  const segRef = segmentRef(study.slug, k);
  const seg = await runner.resolveRef(repo, segRef);
  if (seg !== report.baselineSha) await runner.updateRef(repo, segRef, report.baselineSha, seg);
  store.tx(() => {
    store.upsertSegment({
      study_id: study.id,
      k,
      baseline_sha: report.baselineSha,
      oracle_hash: report.oracleHash,
      noise_floor: report.noiseFloor,
      mde: report.mde,
      eval_seconds: report.evalSeconds,
      gate_seconds: report.gateSeconds,
      report: report.report,
    });
    store.updateStudy(study.id, {
      calibration_status: "ready",
      calibration_json: JSON.stringify(report),
      base_sha: store.candidateCount(study.id) > 0 ? study.base_sha : report.baselineSha,
      best_sha: report.baselineSha,
      segment: k,
    });
    store.event(study.id, "calibration.ready", "plugin", { segment: k, mde: report.mde, noise_floor: report.noiseFloor, eval_seconds: report.evalSeconds });
  });
}
