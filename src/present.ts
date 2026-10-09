// One way to express improvement, shared by the study page, the CLI, the
// report, notices, and agent messages (pure: no I/O, safe in the frontend
// bundle).
//
// The convention (docs/design.md, "Implementation notes: human interface"):
// an improvement is a fraction relative to a reference, POSITIVE = BETTER in
// the metric's own direction. It is shown signed ("+74.7%") where space is
// short, and in words where it is the headline ("74.7% fewer ops (3.9×)").
// Raw metric values stay available next to it ("210,802 → 53,300 opcodes").

export type Direction = "lower" | "higher";

export interface MetricInfo {
  name: string;
  unit: string;
  direction: Direction;
}

const COUNT_LIKE = /(count|ops|opcodes|instructions|insns|allocs?|allocations|calls|requests|bytes|lines|files|tokens|items|frames|misses|faults)$/iu;

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** Signed improvement, better is positive: "+74.7%", "−3.0%", "—". */
export function signedPct(f: number | null | undefined, digits = 1): string {
  if (!finite(f)) return "—";
  const r = Number((f * 100).toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)}%`;
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(digits)}%`;
}

/** An unsigned magnitude (noise floor, MDE, limits): "0.96%". */
export function magnitudePct(f: number | null | undefined, digits = 2): string {
  if (!finite(f)) return "—";
  return `${Math.abs(f * 100).toFixed(digits)}%`;
}

/** "fewer"/"more" for counts, "lower"/"higher" otherwise, for a change in the given direction. */
function changeWord(metric: MetricInfo, decreased: boolean): string {
  // "fewer ops" reads well, "fewer size" doesn't: only the name decides.
  if (COUNT_LIKE.test(metric.name)) return decreased ? "fewer" : "more";
  return decreased ? "lower" : "higher";
}

/** The metric changed by this fraction in its own terms: lower-is-better metrics decrease when they improve. */
function decreasedFor(f: number, direction: Direction): boolean {
  return direction === "lower" ? f > 0 : f < 0;
}

/**
 * How many times better: base/best for lower-is-better (f is the reduction),
 * best/base for higher-is-better (f is the gain). Null when it isn't defined.
 */
export function factorOf(f: number | null | undefined, direction: Direction): number | null {
  if (!finite(f)) return null;
  if (direction === "lower") return f < 1 ? 1 / (1 - f) : null;
  return 1 + f > 0 ? 1 + f : null;
}

/** "3.9×" when the change is large enough for a factor to help (≥ 1.5×), else "". */
export function factorText(f: number | null | undefined, direction: Direction): string {
  const x = factorOf(f, direction);
  if (x === null || x < 1.5) return "";
  return x >= 100 ? `${Math.round(x).toLocaleString("en-US")}×` : x >= 10 ? `${x.toFixed(0)}×` : `${x.toFixed(1)}×`;
}

/**
 * The improvement in words: "74.7% fewer ops", "12.0% higher throughput",
 * "3.1% more ops (worse)", "no measurable change". With `factor`, large
 * changes get " (3.9×)".
 */
export function improvementText(f: number | null | undefined, metric: MetricInfo, opts: { digits?: number; factor?: boolean } = {}): string {
  if (!finite(f)) return "—";
  const digits = opts.digits ?? 1;
  const mag = Math.abs(f * 100);
  if (Number(mag.toFixed(digits)) === 0) return "no measurable change";
  const word = changeWord(metric, decreasedFor(f, metric.direction));
  const fx = opts.factor === false || f < 0 ? "" : factorText(f, metric.direction);
  return `${mag.toFixed(digits)}% ${word} ${metric.name}${fx ? ` (${fx})` : ""}${f < 0 ? " (worse)" : ""}`;
}

/** A CI of improvements, both ends signed (better is positive): "CI +73.7% to +75.6%". Empty when unknown. */
export function ciText(lo: number | null | undefined, hi: number | null | undefined, digits = 1): string {
  if (!finite(lo) || !finite(hi)) return "";
  return `CI ${signedPct(Math.min(lo, hi), digits)} to ${signedPct(Math.max(lo, hi), digits)}`;
}

/**
 * Compound promoted improvements (each relative to the best before it) into
 * the improvement of best over base. Lower-is-better: 1 − Π(1 − e) (the
 * reduction); higher-is-better: Π(1 + e) − 1 (the gain).
 */
export function compound(effects: readonly number[], direction: Direction): number {
  if (direction === "lower") return effects.reduce((acc, e) => 1 - (1 - acc) * (1 - e), 0);
  return effects.reduce((acc, e) => (1 + acc) * (1 + e) - 1, 0);
}

/** Where a candidate sat relative to base: the improvement of best-then compounded with its own. */
export function compoundOne(acc: number, e: number, direction: Direction): number {
  return compound([acc, e], direction);
}

/**
 * Harvest measures everything relative to best (ablation: best without S
 * against best), so terms add. Convert a relative-to-best gain `t` of the
 * whole study into the usual relative-to-base improvement.
 * Lower-is-better: t / (1 + t); higher-is-better: t / (1 − t).
 */
export function vsBaseFromVsBest(t: number | null | undefined, direction: Direction): number | null {
  if (!finite(t)) return null;
  const v = direction === "lower" ? t / (1 + t) : t / (1 - t);
  return Number.isFinite(v) ? v : null;
}

/** The share of the base→best gain a relative-to-best term `c` accounts for: c / t. */
export function shareOfGain(c: number | null | undefined, total: number | null | undefined): number | null {
  if (!finite(c) || !finite(total) || total === 0) return null;
  return c / total;
}

/** A share as "81%" (or "0.4%" when small); `digits` forces decimals (CIs). */
export function sharePct(f: number | null | undefined, digits?: number): string {
  if (!finite(f)) return "—";
  const p = f * 100;
  const sign = p < 0 && Number((Math.abs(p)).toFixed(digits ?? (Math.abs(p) < 1 ? 1 : 0))) !== 0 ? "−" : "";
  if (digits !== undefined) return `${sign}${Math.abs(p).toFixed(digits)}%`;
  return `${sign}${Math.abs(p) < 1 && p !== 0 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p))}%`;
}

/** A raw metric value: "210,802", "1.37", "0.000412". */
export function formatValue(v: number | null | undefined): string {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (a >= 100) return v.toFixed(1).replace(/\.0$/u, "");
  if (a >= 1) return Number(v.toPrecision(4)).toString();
  if (a === 0) return "0";
  return Number(v.toPrecision(3)).toString();
}

/** A raw value with its unit: "210,802 opcodes". */
export function valueWithUnit(v: number | null | undefined, unit: string): string {
  const s = formatValue(v);
  return s === "—" || !unit ? s : `${s} ${unit}`;
}

/** "210,802 → 53,300 opcodes" (base → best), or "" when either is missing. */
export function rawChange(from: number | null | undefined, to: number | null | undefined, unit: string): string {
  if (!finite(from) || !finite(to)) return "";
  return `${formatValue(from)} → ${valueWithUnit(to, unit)}`;
}

/**
 * An amount of the metric saved or gained, better is positive:
 * "≈ 171,000 fewer opcodes", "≈ 12 ms less", "≈ 40 rps more".
 */
export function amountText(delta: number | null | undefined, metric: MetricInfo): string {
  if (!finite(delta)) return "";
  const decreased = metric.direction === "lower" ? delta > 0 : delta < 0;
  const unit = metric.unit || metric.name;
  const count = COUNT_LIKE.test(metric.name) || COUNT_LIKE.test(metric.unit);
  const v = formatValue(Math.abs(delta));
  return count ? `≈ ${v} ${decreased ? "fewer" : "more"} ${unit}` : `≈ ${v} ${unit} ${decreased ? "less" : "more"}`;
}

/** Improvement of `candidate` over `reference` (positive = better), as the stats module computes it. */
export function improvementOf(reference: number | null | undefined, candidate: number | null | undefined, direction: Direction): number | null {
  if (!finite(reference) || !finite(candidate)) return null;
  const raw = direction === "lower" ? reference - candidate : candidate - reference;
  if (reference === 0) return raw === 0 ? 0 : Math.sign(raw);
  return raw / Math.abs(reference);
}

/** Plain-language help for the statistical terms the page uses (one or two sentences each). */
export const GLOSSARY = {
  improvement: "Every number is “better is positive”: +10% means 10% better in the metric's own direction (10% lower for lower-is-better metrics). Raw values are shown next to it.",
  ci: "Confidence interval: the range the true change very likely lies in, given the noise in the measurements. A narrow CI that excludes zero means the change is real.",
  mde: "Minimum detectable effect: the smallest improvement a candidate must clear (with confidence) to win. Smaller changes are indistinguishable from noise on this bench.",
  noiseFloor: "Noise floor: how much the metric moves between two runs of the same code (A/A), measured at calibration. The MDE is derived from it.",
  calibration: "Calibration runs the gates on the base commit, then measures the base against itself many times to learn the noise floor, the MDE and the cost of one evaluation.",
  ablation: "Ablation: best with this changeset reverted, measured against best. How much worse that gets is what the changeset contributes.",
  dependency: "Dependency edge: reverting one changeset from best only works if another one is reverted too (a git conflict or failing gates), so they ship as a stack of PRs.",
  stack: "Stack: dependent changesets become PRs stacked on each other, in the order they landed on best. Their contribution is measured together when a member can't be reverted alone.",
  standalone: "Standalone check: the changeset applied alone on its PR base (the study base, or the PR below it in a stack), gated and measured.",
  droppable: "Droppable: the contribution's CI reaches zero, so there's no evidence it helps. You decide whether to keep it (for example as a simplification).",
  unexplained: "Unexplained: the measured total gain minus the sum of the contributions. Within its CI the changes add up; beyond it they interact.",
  guardrail: "Guardrail: a secondary metric that may not regress beyond its limit. Today each promotion is checked against the best before it.",
  drift: "Drift check: an A/A run on best while the study runs. Noise above the limit pauses the study, because verdicts would be random.",
  holdout: "Holdout: a hidden workload on the bench host. Wins must not regress on it; agents only learn pass or fail.",
  segment: "Segment: a period with one fixed oracle version. Changing the oracle starts a new segment with a new calibration.",
  utilization: "Bench utilization: the share of Running time the bench spent measuring. Low values mean workers think longer than the bench measures.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
