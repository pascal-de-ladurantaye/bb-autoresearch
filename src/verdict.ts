// Verdict rules: the decision from the noise strategy, then guardrails (per
// step against best and in total against the segment base; see guardrails.ts).
import { judgeGuardrails, type GuardrailEstimate, type GuardrailJudgement, type Position } from "./guardrails.ts";
import type { MeasureOutcome } from "./noise.ts";
import { magnitudePct, measuredCiText, signedPct } from "./present.ts";
import type { StudySpec } from "./spec.ts";

export const VERDICTS = ["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  /** Per guardrail: the step and total checks behind the verdict (measured verdicts only). */
  guardrails?: Record<string, GuardrailJudgement>;
}

export interface VerdictOptions {
  /** Best's position per guardrail against the segment base (the promotion chain so far). */
  prior?: Record<string, Position>;
  /** The win threshold the measurement used (named in futility reasons). */
  mde?: number;
}

const pct = (f: number) => `${Math.abs(f * 100).toFixed(1)}%`;

/** The outcome's guardrail estimates; hand-built outcomes without them fall back to their point regressions (no CI). */
export function outcomeEstimates(outcome: MeasureOutcome): Record<string, GuardrailEstimate> {
  if (outcome.guardrailEstimates) return outcome.guardrailEstimates;
  return Object.fromEntries(Object.entries(outcome.guardrails).map(([k, r]) => [k, { regression: r, lo: null, hi: null, n: outcome.n }]));
}

/**
 * A primary-metric win that breaks a guardrail (its CI entirely beyond the
 * per-step or the total limit, or the metric missing) is a `lose`. A guardrail
 * whose CI straddles a limit is inconclusive: flagged in the reasons, not a
 * rejection.
 */
export function decideVerdict(outcome: MeasureOutcome, spec: StudySpec, opts: VerdictOptions = {}): VerdictResult {
  const guardrails = judgeGuardrails(spec, outcomeEstimates(outcome), opts.prior ?? {});
  const broken = Object.values(guardrails).filter((g) => g.state === "broken" || g.state === "missing").map((g) => g.text);
  const flagged = Object.values(guardrails).filter((g) => g.state === "inconclusive").map((g) => g.text);
  const noise = spec.oracle.noise;
  const p = spec.oracle.protocol;
  const early = outcome.stop === "early";
  const ciWords = measuredCiText(outcome.ciLo, outcome.ciHi, outcome.n, noise, early ? { confidence: p.early_lose_confidence } : {});
  const ci = ciWords ? ` (${ciWords})` : "";
  const threshold = opts.mde !== undefined ? `the ${magnitudePct(opts.mde, 1)} win threshold` : "the win threshold";
  switch (outcome.decision) {
    case "win":
      if (broken.length) return { verdict: "lose", reasons: [`primary metric improved ${pct(outcome.effect)}${ci}`, ...broken, ...flagged], guardrails };
      return { verdict: "win", reasons: [`primary metric improved ${pct(outcome.effect)}${ci}`, ...flagged], guardrails };
    case "lose":
      return {
        verdict: "lose",
        reasons: [
          `primary metric regressed ${pct(-outcome.effect)}${ci}${early ? `: stopped early, the whole CI is below 0 before pair ${p.n_min}` : ""}`,
          ...broken,
          ...flagged,
        ],
        guardrails,
      };
    case "inconclusive":
      if (outcome.stop === "futility") {
        return {
          verdict: "inconclusive",
          reasons: [`effect ${signedPct(outcome.effect)}${ci} can no longer clear ${threshold}: stopped early (futility: the CI's high end is below it)`, ...broken, ...flagged],
          guardrails,
        };
      }
      return { verdict: "inconclusive", reasons: [`effect ${signedPct(outcome.effect)}${ci} did not clear ${threshold}`, ...broken, ...flagged], guardrails };
  }
}

/**
 * A win must survive a fresh confirmation measurement before promotion. The
 * confirmation's guardrail judgement (the pipeline pools both measurements'
 * pairs for it) replaces the first one's.
 */
export function applyConfirmation(first: VerdictResult, confirmation: VerdictResult): VerdictResult {
  if (first.verdict !== "win") return first;
  const guardrails = confirmation.guardrails ?? first.guardrails;
  if (confirmation.verdict === "win") {
    return { verdict: "win", reasons: [first.reasons[0] ?? "win", `confirmed: ${confirmation.reasons[0] ?? "win"}`, ...confirmation.reasons.slice(1)], ...(guardrails ? { guardrails } : {}) };
  }
  if (/^primary metric improved/u.test(confirmation.reasons[0] ?? "")) {
    // The primary metric confirmed; a guardrail, judged on both measurements' pairs, broke.
    return { verdict: "lose", reasons: [first.reasons[0] ?? "win", `confirmed: ${confirmation.reasons[0]}`, ...confirmation.reasons.slice(1)], ...(guardrails ? { guardrails } : {}) };
  }
  return {
    verdict: confirmation.verdict === "lose" ? "lose" : "inconclusive",
    reasons: [`initial ${first.reasons[0] ?? "win"}`, `failed confirmation: ${confirmation.reasons.join("; ")}`],
    ...(guardrails ? { guardrails } : {}),
  };
}
