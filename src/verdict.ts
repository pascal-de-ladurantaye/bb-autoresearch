// Verdict rules: the decision from the noise strategy, then guardrails.
import type { MeasureOutcome } from "./noise.ts";
import type { StudySpec } from "./spec.ts";

export const VERDICTS = ["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
}

const pct = (f: number) => `${(f * 100).toFixed(2)}%`;

/** Guardrails are relative to best: a primary-metric win that breaks one is a `lose`. */
export function decideVerdict(outcome: MeasureOutcome, spec: StudySpec): VerdictResult {
  const reasons: string[] = [];
  const broken: string[] = [];
  for (const g of spec.guardrail) {
    const regression = outcome.guardrails[g.name];
    if (regression === undefined || Number.isNaN(regression)) {
      broken.push(`guardrail ${g.name}: metric missing from measure output`);
    } else if (regression > g.max_regression) {
      broken.push(`guardrail ${g.name} regressed ${pct(regression)} (limit ${pct(g.max_regression)})`);
    }
  }
  const ci = outcome.ciLo !== null && outcome.ciHi !== null ? ` (CI ${pct(outcome.ciLo)}..${pct(outcome.ciHi)}, n=${outcome.n})` : ` (n=${outcome.n})`;
  switch (outcome.decision) {
    case "win":
      if (broken.length) return { verdict: "lose", reasons: [`primary metric improved ${pct(outcome.effect)}${ci}`, ...broken] };
      reasons.push(`primary metric improved ${pct(outcome.effect)}${ci}`);
      return { verdict: "win", reasons };
    case "lose":
      return { verdict: "lose", reasons: [`primary metric regressed ${pct(-outcome.effect)}${ci}`, ...broken] };
    case "inconclusive":
      return { verdict: "inconclusive", reasons: [`effect ${pct(outcome.effect)}${ci} did not clear the minimum detectable effect`, ...broken] };
  }
}

/** A win must survive a fresh confirmation measurement before promotion. */
export function applyConfirmation(first: VerdictResult, confirmation: VerdictResult): VerdictResult {
  if (first.verdict !== "win") return first;
  if (confirmation.verdict === "win") {
    return { verdict: "win", reasons: [...first.reasons, `confirmed: ${confirmation.reasons[0] ?? "win"}`] };
  }
  return {
    verdict: confirmation.verdict === "lose" ? "lose" : "inconclusive",
    reasons: [`initial ${first.reasons[0] ?? "win"}`, `failed confirmation: ${confirmation.reasons.join("; ")}`],
  };
}
