// Calibration: gates on the baseline, then repeated A/A measurement on every
// bench host. Produces the noise floor, the minimum detectable effect, and
// the cost of one evaluation per host, recorded as a segment (the segment
// takes the worst host). Changing the oracle mid-run calibrates again on the
// current best and starts a new segment.
import { createHash } from "node:crypto";
import { BenchTransferError } from "./bench.ts";
import type { Ctx } from "./context.ts";
import type { BenchHostRow, StudyRow } from "./db/store.ts";
import { guardrailWarnings, worstGuardrailCalibration, type GuardrailCalibration } from "./guardrails.ts";
import { checkHealth } from "./health.ts";
import { parseMeasureOutput } from "./metrics.ts";
import { strategyFor, BenchError, type CalibrationOutcome } from "./noise.ts";
import { studySingleMachine, withBench, withGateLock, type Pipeline } from "./pipeline.ts";
import { singleMachineText } from "./single-machine.ts";
import { clip } from "./prompts.ts";
import { ignoreIncludePathspecs } from "./scope.ts";
import type { HostRunner } from "./host/runner.ts";
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
  /** Per bench host results (noise floor, MDE, eval cost). */
  hosts: Array<{ hostId: string; name: string; mode: string; noiseFloor: number; mde: number; evalSeconds: number; report: string; guardrails?: GuardrailCalibration[] }>;
  /** Per guardrail: A/A noise and CI half-width (worst host). */
  guardrails: GuardrailCalibration[];
  /** Things the human should know that don't fail calibration (a guardrail too noisy to be judged). */
  warnings: string[];
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
    hosts: [],
    guardrails: [],
    warnings: [],
    finishedAt: ctx.now(),
    ...partial,
  });

  // 1. Baseline: the existing best (re-calibration) or the spec's base ref.
  const existingBest = await runner.resolveRef(repo, `refs/heads/${bestBranch(study.slug)}`);
  // Before any promotion the baseline follows the spec's base ref; after one, re-calibration measures best.
  // Mid-run (an oracle change) it always measures the current best.
  const hasPromotions = Boolean(study.best_sha && study.base_sha && study.best_sha !== study.base_sha);
  const useBest = Boolean(study.best_sha) && (hasPromotions || store.hasRun(study.id));
  const baseSha = useBest ? study.best_sha : await runner.resolveRef(repo, spec.study.base);
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
  const scopeWarnings = await trackedIgnoredWarning(runner, repo, baseSha, spec.scope.ignore ?? []);

  // 3. Gates on the baseline (single-machine mode: holding the edit host's bench lock, like every gate).
  const gateStarted = ctx.now();
  if (spec.oracle.gate.length) {
    const red = await withGateLock(ctx, study, null, async () => {
      const dir = await runner.checkout(repo, `${study.slug}-gate`, baseSha);
      for (const command of spec.oracle.gate) {
        const r = await runner.exec({ cwd: dir, command, timeoutMs });
        if (r.exitCode !== 0) return `gate is red on the baseline: ${clip(command, 200)} exited ${r.exitCode}${r.timedOut ? " (timeout)" : ""}: ${clip(`${r.stdout}\n${r.stderr}`.trim(), 600)}`;
      }
      return null;
    });
    if (red) {
      problems.push(red);
      return finish({ baselineSha: baseSha, oracleHash: hash, gateSeconds: (ctx.now() - gateStarted) / 1000 });
    }
  }
  const gateSeconds = (ctx.now() - gateStarted) / 1000;
  const single = studySingleMachine(store, study, spec);

  // 4. A/A measurement on two checkouts of the baseline on every bench host, each holding its own lock.
  const strategy = strategyFor(spec.oracle.noise);
  store.deleteCalibrationSamples(study.id);
  const hosts = pipeline.benchHosts(study);
  if (!hosts.length) {
    problems.push("the study has no bench host");
    return finish({ baselineSha: baseSha, oracleHash: hash, gateSeconds });
  }
  const perHost = await Promise.all(
    hosts.map(async (h) => {
      try {
        return { h, outcome: await calibrateHost(ctx, pipeline, study, h, baseSha, timeoutMs), problem: null as string | null };
      } catch (e) {
        if (e instanceof BenchError) return { h, outcome: null, problem: `${h.name}: ${e.message}: ${clip(e.output.trim(), 600)}` };
        if (e instanceof BenchTransferError || e instanceof HealthError) return { h, outcome: null, problem: `${h.name}: ${e.message}` };
        throw e;
      }
    }),
  );
  for (const r of perHost) if (r.problem) problems.push(r.problem);
  const ok = perHost.filter((r): r is { h: BenchHostRow; outcome: CalibrationOutcome; problem: null } => r.outcome !== null);
  if (ok.length !== perHost.length) return finish({ baselineSha: baseSha, oracleHash: hash, gateSeconds });
  for (const r of ok) problems.push(...r.outcome.problems.map((p) => (ok.length > 1 ? `${r.h.name}: ${p}` : p)));
  const first = ok[0]!.outcome;
  if (first.bestRun) {
    store.updateStudy(study.id, { best_run_json: JSON.stringify(first.bestRun), best_run_sha: baseSha });
  }
  // The segment takes the worst host: a win must clear every host's noise.
  const noiseFloor = Math.max(...ok.map((r) => r.outcome.noiseFloor));
  const mde = Math.max(...ok.map((r) => r.outcome.mde));
  const evalSeconds = Math.max(...ok.map((r) => r.outcome.evalSeconds));
  const serialized = single.on && spec.oracle.gate.length > 0;
  const gateLine = spec.oracle.gate.length
    ? serialized
      ? ` Gates take ${gateSeconds.toFixed(1)} s on the edit host, holding the bench, so each candidate occupies the bench about ${(evalSeconds + gateSeconds).toFixed(1)} s.`
      : ` Gates take ${gateSeconds.toFixed(1)} s on the edit host.`
    : "";
  const singleLine = single.on || spec.oracle.quiet_bench ? ` ${singleMachineText(single, spec, hosts.find((h) => h.host_id === study.host_id)?.name ?? null)}` : "";
  const hostLines = ok.length > 1 ? ` Per host: ${ok.map((r) => `${r.h.name} MDE ${(r.outcome.mde * 100).toFixed(2)}%`).join(", ")}.` : "";
  const holdoutLine = spec.oracle.holdout ? " Holdout runs on every bench host." : "";
  const guardrails = worstGuardrailCalibration(ok.map((r) => r.outcome.guardrails ?? []));
  const guardrailLine = guardrails.length ? ` Guardrails: ${guardrails.map((g) => g.text).join("; ")}.` : "";
  return finish({
    baselineSha: baseSha,
    oracleHash: hash,
    gateSeconds,
    noiseFloor,
    mde,
    evalSeconds,
    report: (ok.length > 1 ? `${ok.length} bench hosts. ` : "") + first.report + hostLines + holdoutLine + gateLine + guardrailLine + singleLine,
    details: { ...first.details, existingBest: existingBest ?? "", benchHosts: ok.length, singleMachine: single.on, quietBench: spec.oracle.quiet_bench },
    hosts: ok.map((r) => ({ hostId: r.h.host_id, name: r.h.name, mode: r.h.mode, noiseFloor: r.outcome.noiseFloor, mde: r.outcome.mde, evalSeconds: r.outcome.evalSeconds, report: r.outcome.report, guardrails: r.outcome.guardrails ?? [] })),
    guardrails,
    warnings: [...guardrailWarnings(guardrails), ...scopeWarnings],
  });
}

class HealthError extends Error {}

/**
 * A repo that tracks files under an ignore pattern (a `build/` directory of
 * sources, say) would have new files there left out of every candidate: warn
 * so the human can narrow `[scope] ignore`.
 */
export async function trackedIgnoredWarning(runner: { exec: HostRunner["exec"] }, repo: string, sha: string, ignore: readonly string[]): Promise<string[]> {
  if (!ignore.length) return [];
  const specs = ignoreIncludePathspecs(ignore).map((p) => `'${p}'`).join(" ");
  const r = await runner.exec({ cwd: repo, command: `git diff --name-only --no-renames $(git hash-object -t tree /dev/null) ${sha} -- ${specs} | head -n 20`, timeoutMs: 60_000 }).catch(() => null);
  const paths = r && r.exitCode === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  if (!paths.length) return [];
  return [
    `the baseline tracks file(s) matching [scope] ignore (${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}): changes to them are submitted, but new files next to them are left out of candidates. If they are sources, set [scope] ignore without the pattern that matches them.`,
  ];
}

/** Calibrate one bench host: health, transfer, two baseline checkouts, build, A/A, a holdout smoke run. */
async function calibrateHost(ctx: Ctx, pipeline: Pipeline, study: StudyRow, h: BenchHostRow, baseSha: string, timeoutMs: number): Promise<CalibrationOutcome> {
  const { store } = ctx;
  const spec = store.spec(study);
  const strategy = strategyFor(spec.oracle.noise);
  return await withBench(ctx, study, h.host_id, "calibration", null, async () => {
    const health = await checkHealth(ctx, study, h, spec, "calibration", async () => undefined);
    if (!health.ok) throw new HealthError(`health check failed: ${health.problems.join("; ")}`);
    const site = pipeline.site(study, h);
    site.invalidateBest();
    const a = await site.checkout("best", baseSha, "best", "baseline");
    const b = await site.checkout("cand", baseSha, "best", "baseline");
    if (spec.oracle.build) {
      for (const dir of [a, b]) {
        const r = await site.build(dir, spec, "baseline");
        if (!r.ok) throw new BenchError("best", "build failed on the baseline", r.output);
      }
    }
    if (spec.oracle.holdout) {
      // The holdout must work on this host; its output is discarded (agents never see it).
      const r = await site.runner.run({ cwd: a, command: spec.oracle.holdout.measure, timeoutMs, label: "holdout" });
      const metric = spec.oracle.holdout.metric ?? spec.metric.name;
      if (r.exitCode !== 0 || parseMeasureOutput(r.stdout).metrics[metric] === undefined) {
        throw new BenchError("best", `the holdout command does not work on this host (exit ${r.exitCode}, or no METRIC ${metric} line)`, "");
      }
    }
    site.markBestBuilt(baseSha, a);
    const bench = site.bench(spec, { best: a, candidate: b }, { label: "calibration" });
    const outcome = await strategy.calibrate({
      bench,
      spec,
      rng: ctx.rng,
      record: (s) => {
        for (const [metric, value] of Object.entries(s.metrics)) {
          store.addSample({ study_id: study.id, candidate_id: null, run: "calibration", pair: s.pair, side: s.side, metric, value, host_id: h.host_id });
        }
      },
    });
    store.updateBenchHost(study.id, h.host_id, {
      noise_floor: outcome.noiseFloor,
      mde: outcome.mde,
      eval_seconds: outcome.evalSeconds,
      evals_since_drift: 0,
      drift_status: null,
      baseline_json: outcome.baselineRuns ? JSON.stringify({ sha: baseSha, runs: outcome.baselineRuns.slice(0, 20) }) : null,
    });
    return outcome;
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
      spec_version: study.spec_version,
      details_json: JSON.stringify({ hosts: report.hosts, guardrails: report.guardrails ?? [], warnings: report.warnings ?? [] }),
    });
    store.updateStudy(study.id, {
      calibration_status: "ready",
      calibration_json: JSON.stringify(report),
      base_sha: store.candidateCount(study.id) > 0 ? study.base_sha : report.baselineSha,
      best_sha: report.baselineSha,
      segment: k,
    });
    store.event(study.id, "calibration.ready", "plugin", { segment: k, mde: report.mde, noise_floor: report.noiseFloor, eval_seconds: report.evalSeconds, oracle: report.oracleHash, hosts: report.hosts.length, warnings: (report.warnings ?? []).length });
    if (k > Math.max(1, study.segment)) store.event(study.id, "segment.started", "plugin", { segment: k, baseline: report.baselineSha, oracle: report.oracleHash, spec_version: study.spec_version });
  });
}
