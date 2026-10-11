// Guardrails: secondary metrics that may not regress beyond a limit. Two
// limits apply to every win (docs/design.md, "Guardrails and holdout"):
//
// - per step: the candidate against the current best (`max_regression`);
// - in total: best after the promotion against the segment base
//   (`max_total_regression`), so small regressions can't creep across many
//   kept wins.
//
// Both are judged on a confidence interval, like the primary metric: a
// guardrail breaks only when the whole CI is beyond the limit, is ok when the
// whole CI is within it, and is inconclusive (flagged, not a rejection) in
// between. The total position compounds the per-promotion estimates of the
// chain base → best, with their CI half-widths combined in log space (root
// sum of squares, independent errors), the same way harvest accounts for a gap.
//
// Pure functions (no I/O), shared by the pipeline, views, prompts and report.
import type { Direction, StudySpec } from "./spec.ts";
import { bootstrapMedianCI, calibrateNoisy, improvement, median, sampleSd, type Rng } from "./stats.ts";

/** A guardrail's change against a reference, positive = worse (a regression). */
export interface GuardrailEstimate {
  /** Point estimate; NaN when the metric is missing. */
  regression: number;
  /** CI of the regression (null when the class gives none, e.g. one run without calibrated noise). */
  lo: number | null;
  hi: number | null;
  /** Pairs or runs behind the estimate. */
  n: number;
  /** noisy: per-pair regressions, so a confirmation measurement can pool them. */
  samples?: number[];
}

export type LimitState = "ok" | "inconclusive" | "broken";
export type GuardrailVerdictState = LimitState | "missing";

export interface LimitCheck {
  regression: number;
  lo: number | null;
  hi: number | null;
  limit: number;
  state: LimitState;
}

/** Where best stands against the segment base, compounded over the promotions since it. */
export interface Position {
  regression: number;
  lo: number | null;
  hi: number | null;
  /** Promotions compounded. */
  steps: number;
  /** Promotions on the chain without a recorded estimate for this guardrail (skipped). */
  missing?: number;
}

export interface GuardrailJudgement {
  name: string;
  direction: Direction;
  /** Worst of the two checks; "missing" when the metric wasn't measured. */
  state: GuardrailVerdictState;
  /** The candidate against the current best. */
  step: LimitCheck | null;
  /** Best after this candidate against the segment base. */
  total: LimitCheck | null;
  /** Best's position before this candidate (what the step is compounded onto). */
  prior: Position | null;
  /** One sentence, in words. */
  text: string;
}

/** Per guardrail, from calibration (worst bench host). */
export interface GuardrailCalibration {
  name: string;
  /**
   * noisy: robust SD of the A/A paired differences (per pair); expensive: SD
   * of one run around the baseline median; deterministic: the difference
   * between two runs of the baseline.
   */
  noise: number;
  /** CI half-width a typical evaluation gets: at n_max pairs (noisy), k confirmation runs (expensive), the tolerance band (deterministic). */
  halfWidth: number;
  limit: number;
  totalLimit: number;
  /** False when the noise alone exceeds the limit: a candidate can never be shown within it. */
  judgeable: boolean;
  /** One line for the calibration report. */
  text: string;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const pct = (f: number, digits = 1) => `${(Math.abs(f) * 100).toFixed(digits)}%`;

// ---------------------------------------------------------------- estimation

/** noisy: the median of per-pair regressions with a bootstrap CI, as for the primary metric. */
export function estimatePaired(samples: readonly number[], confidence: number, iterations: number, rng: Rng): GuardrailEstimate {
  const values = samples.filter((v) => Number.isFinite(v));
  if (!values.length) return { regression: Number.NaN, lo: null, hi: null, n: 0, samples: [] };
  if (values.length < 2) return { regression: values[0]!, lo: null, hi: null, n: 1, samples: values };
  const ci = bootstrapMedianCI(values, confidence, iterations, rng);
  return { regression: ci.median, lo: ci.lo, hi: ci.hi, n: values.length, samples: values };
}

/** deterministic: one run per side; the CI is the tolerance band (or the calibrated repeat difference, if larger). */
export function estimateBand(regression: number, band: number): GuardrailEstimate {
  if (!Number.isFinite(regression)) return { regression: Number.NaN, lo: null, hi: null, n: 0 };
  return { regression, lo: regression - band, hi: regression + band, n: 1 };
}

/**
 * expensive: the candidate's runs against the bench host's baseline runs.
 * The CI is t·σ·√(1/k + 1/m), with σ the guardrail's calibrated per-run
 * noise; without calibration it is estimated from the runs at hand (pooled
 * deviations around each side's median) when there are enough of them.
 */
export function estimateRuns(baseline: readonly number[], candidate: readonly number[], direction: Direction, sigma: number | null, t: number): GuardrailEstimate {
  const b = baseline.filter(Number.isFinite);
  const c = candidate.filter(Number.isFinite);
  if (!b.length || !c.length) return { regression: Number.NaN, lo: null, hi: null, n: 0 };
  const bm = median(b);
  const regression = -improvement(bm, median(c), direction);
  let s = sigma;
  if (!finite(s)) {
    const cm = median(c);
    const devs = [...b.map((v) => (v - bm) / Math.abs(bm || 1)), ...c.map((v) => (v - cm) / Math.abs(bm || 1))];
    s = b.length + c.length - 2 >= 2 ? sampleSd(devs) : null;
  }
  if (!finite(s)) return { regression, lo: null, hi: null, n: c.length };
  const half = t * s * Math.sqrt(1 / c.length + 1 / b.length);
  return { regression, lo: regression - half, hi: regression + half, n: c.length };
}

/** A confirmation measurement pools its pairs with the first measurement's (guardrails aren't what selected the candidate). */
export function poolPaired(a: GuardrailEstimate | undefined, b: GuardrailEstimate | undefined, confidence: number, iterations: number, rng: Rng): GuardrailEstimate | undefined {
  if (!a?.samples || !b?.samples) return b ?? a;
  return estimatePaired([...a.samples, ...b.samples], confidence, iterations, rng);
}

// ---------------------------------------------------------------- compounding

/**
 * A monotone transform of a regression under which consecutive steps add:
 * lower-is-better ln(1 + r) (values multiply by 1 + r), higher-is-better
 * −ln(1 − r) (values multiply by 1 − r).
 */
function g(r: number, direction: Direction): number {
  if (direction === "lower") return Math.log(Math.max(1e-9, 1 + r));
  return -Math.log(Math.max(1e-9, 1 - r));
}
function gInverse(x: number, direction: Direction): number {
  return direction === "lower" ? Math.exp(x) - 1 : 1 - Math.exp(-x);
}

export const ZERO_POSITION: Position = { regression: 0, lo: 0, hi: 0, steps: 0 };

/** Best's position after one more step: point estimates compound, CI half-widths combine as a root sum of squares in log space. */
export function compose(prior: Position, step: Pick<GuardrailEstimate, "regression" | "lo" | "hi">, direction: Direction): Position {
  if (!Number.isFinite(prior.regression) || !Number.isFinite(step.regression)) return { regression: Number.NaN, lo: null, hi: null, steps: prior.steps + 1 };
  const gp = g(prior.regression, direction);
  const gs = g(step.regression, direction);
  const down = (pos: number, lo: number | null) => (finite(lo) ? Math.max(0, pos - g(lo, direction)) : 0);
  const up = (pos: number, hi: number | null) => (finite(hi) ? Math.max(0, g(hi, direction) - pos) : 0);
  const hasCi = (finite(prior.lo) && finite(prior.hi)) || (finite(step.lo) && finite(step.hi));
  const center = gp + gs;
  const dLo = Math.hypot(down(gp, prior.lo), down(gs, step.lo));
  const dHi = Math.hypot(up(gp, prior.hi), up(gs, step.hi));
  return {
    regression: gInverse(center, direction),
    lo: hasCi ? gInverse(center - dLo, direction) : null,
    hi: hasCi ? gInverse(center + dHi, direction) : null,
    steps: prior.steps + 1,
  };
}

/** Compound a chain of per-promotion estimates (oldest first) into best's position against the segment base. */
export function chainPosition(steps: ReadonlyArray<Pick<GuardrailEstimate, "regression" | "lo" | "hi">>, direction: Direction): Position {
  return steps.reduce<Position>((acc, s) => compose(acc, s, direction), ZERO_POSITION);
}

/**
 * Turn a regression measured relative to best (harvest: base or best-without-S
 * as the candidate, best as the reference) into the regression of best
 * relative to that other side. Lower: 1/(1 + r) − 1; higher: 1 − 1/(1 − r).
 */
export function invertRegression(r: number, direction: Direction): number {
  return gInverse(-g(r, direction), direction);
}

// ---------------------------------------------------------------- judging

export function checkLimit(e: Pick<GuardrailEstimate, "regression" | "lo" | "hi">, limit: number): LimitCheck {
  const { regression } = e;
  const lo = finite(e.lo) ? Math.min(e.lo, regression) : null;
  const hi = finite(e.hi) ? Math.max(e.hi, regression) : null;
  let state: LimitState;
  if (lo === null || hi === null) state = regression > limit ? "broken" : "ok";
  else state = lo > limit ? "broken" : hi > limit ? "inconclusive" : "ok";
  return { regression, lo, hi, limit, state };
}

/** "3.1% worse", "0.4% better", "no change". */
export function changeWords(r: number): string {
  if (!Number.isFinite(r)) return "not measured";
  if (Math.abs(r) < 0.0005) return "no change";
  return `${pct(r)} ${r > 0 ? "worse" : "better"}`;
}

/** "3.1% worse than best", "no change against best". */
export function relativeWords(r: number, against: string): string {
  const w = changeWords(r);
  return w === "no change" || w === "not measured" ? `${w} against ${against}` : `${w} than ${against}`;
}

/** A change against a reference, as a sentence fragment: "3.1% worse than best", "0.4% better than best", "no change from best". */
export function changeFrom(r: number, against: string): string {
  const w = changeWords(r);
  if (w === "not measured") return `not measured against ${against}`;
  return w === "no change" ? `no change from ${against}` : `${w} than ${against}`;
}

/**
 * A guardrail check in plain words, for compact rows: "no change from best
 * (CI 0.3% better to 0.4% worse), within the 10.0% limit", "12.1% worse than
 * the segment base, beyond the 10.0% total limit". `limitWord` names the
 * limit ("limit", "total limit"); `soFar` for an estimate while measuring.
 */
export function limitCheckWords(c: LimitCheck, against: string, limitWord = "limit", soFar = false): string {
  const ci = rangeWords(c.lo, c.hi);
  const limit = `${pct(c.limit)} ${limitWord}`;
  const where = c.state === "broken" ? `beyond the ${limit}` : c.state === "inconclusive" ? `straddling the ${limit}` : `within the ${limit}`;
  return `${changeFrom(c.regression, against)}${ci ? ` (${ci})` : ""}, ${where}${soFar ? " so far" : ""}`;
}

/** A CI of a regression in words: "CI 2.0% to 4.2% worse", "CI 1.0% better to 4.0% worse". Empty when unknown or degenerate. */
export function rangeWords(lo: number | null | undefined, hi: number | null | undefined): string {
  if (!finite(lo) || !finite(hi) || Math.abs(hi - lo) < 1e-12) return "";
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  if (a >= 0) return `CI ${pct(a)} to ${pct(b)} worse`;
  if (b <= 0) return `CI ${pct(b)} to ${pct(a)} better`;
  return `CI ${pct(a)} better to ${pct(b)} worse`;
}

const STATE_WORDS: Record<LimitState, (limit: string) => string> = {
  ok: (l) => `within the ${l} limit`,
  inconclusive: (l) => `inconclusive against the ${l} limit (the CI straddles it; flagged, not a rejection)`,
  broken: (l) => `beyond the ${l} limit`,
};

function checkWords(c: LimitCheck, against: string, total: boolean): string {
  const ci = rangeWords(c.lo, c.hi);
  return `${relativeWords(c.regression, against)}${ci ? ` (${ci})` : ""}, ${STATE_WORDS[c.state](`${pct(c.limit)}${total ? " total" : ""}`)}`;
}

const RANK: Record<GuardrailVerdictState, number> = { ok: 0, inconclusive: 1, missing: 2, broken: 3 };

/** Judge one guardrail: the step against best and the total against the segment base. */
export function judgeGuardrail(
  g: { name: string; direction: Direction; max_regression: number; max_total_regression?: number },
  estimate: GuardrailEstimate | undefined,
  prior: Position | null,
): GuardrailJudgement {
  const totalLimit = g.max_total_regression ?? g.max_regression;
  if (!estimate || !Number.isFinite(estimate.regression)) {
    return { name: g.name, direction: g.direction, state: "missing", step: null, total: null, prior, text: `guardrail ${g.name}: metric missing from measure output` };
  }
  const step = checkLimit(estimate, g.max_regression);
  const position = compose(prior ?? ZERO_POSITION, estimate, g.direction);
  const total = checkLimit(position, totalLimit);
  const state: GuardrailVerdictState = RANK[step.state] >= RANK[total.state] ? step.state : total.state;
  const text = `guardrail ${g.name}: ${checkWords(step, "best", false)}; ${checkWords(total, "the segment base", true)}`;
  return { name: g.name, direction: g.direction, state, step, total, prior, text };
}

export function judgeGuardrails(spec: StudySpec, estimates: Record<string, GuardrailEstimate>, prior: Record<string, Position> = {}): Record<string, GuardrailJudgement> {
  const out: Record<string, GuardrailJudgement> = {};
  for (const g of spec.guardrail) out[g.name] = judgeGuardrail(g, estimates[g.name], prior[g.name] ?? null);
  return out;
}

/** Remaining room under the total limit: the point estimate's, and the conservative one (the CI's upper end). */
export function headroom(position: Position | null, totalLimit: number): { point: number; conservative: number | null } {
  const p = position ?? ZERO_POSITION;
  return { point: totalLimit - p.regression, conservative: finite(p.hi) ? totalLimit - p.hi : null };
}

/** "rss: 3.2% of the 10.0% total limit left (best is 6.8% worse than the segment base, CI 5.9% to 7.7% worse)". */
export function headroomWords(name: string, position: Position | null, totalLimit: number): string {
  const p = position ?? ZERO_POSITION;
  const h = headroom(p, totalLimit);
  const ci = rangeWords(p.lo, p.hi);
  const where = p.steps === 0 ? "best is the segment base" : `best: ${relativeWords(p.regression, "the segment base")}${ci ? `, ${ci}` : ""}`;
  const left =
    h.point <= 0 ? `no room left under the ${pct(totalLimit)} total limit` : h.point >= totalLimit - 1e-9 ? `all of the ${pct(totalLimit)} total limit left` : `${pct(h.point)} of the ${pct(totalLimit)} total limit left`;
  return `${name}: ${left} (${where})`;
}

// ---------------------------------------------------------------- chain of promotions

interface ChainRow {
  verdict: string | null;
  promoted_sha: string | null;
  against_sha: string | null;
  metrics_json: string | null;
}

/** The promoted candidates from the segment base to best, oldest first (stops where the chain can't be followed). */
export function promotionChain<T extends ChainRow>(candidates: readonly T[], baselineSha: string | null, bestSha: string | null): T[] {
  if (!baselineSha || !bestSha || baselineSha === bestSha) return [];
  const byPromoted = new Map<string, T>();
  for (const c of candidates) if (c.verdict === "win" && c.promoted_sha) byPromoted.set(c.promoted_sha, c);
  const out: T[] = [];
  let sha: string | null = bestSha;
  const seen = new Set<string>();
  while (sha && sha !== baselineSha && !seen.has(sha)) {
    seen.add(sha);
    const c = byPromoted.get(sha);
    if (!c) break;
    out.push(c);
    sha = c.against_sha;
  }
  return out.reverse();
}

/** What a decided candidate's metrics_json records about guardrails. */
export interface StoredGuardrails {
  guardrails?: Record<string, number | null>;
  guardrailCi?: Record<string, { lo: number | null; hi: number | null; n: number }>;
  guardrailJudgement?: Record<string, GuardrailJudgement>;
}

/** One promotion's estimate for a guardrail (older candidates have a point estimate only). */
export function storedEstimate(m: StoredGuardrails | null, name: string): Pick<GuardrailEstimate, "regression" | "lo" | "hi"> | null {
  const r = m?.guardrails?.[name];
  if (!finite(r)) return null;
  const ci = m?.guardrailCi?.[name];
  return { regression: r, lo: finite(ci?.lo) ? ci!.lo : null, hi: finite(ci?.hi) ? ci!.hi : null };
}

/** Best's position per guardrail against the segment base, from the promotion chain's stored estimates. */
export function positionsFromChain(spec: StudySpec, chain: ReadonlyArray<{ metrics_json: string | null }>, parse: (s: string | null) => StoredGuardrails | null): Record<string, Position> {
  const out: Record<string, Position> = {};
  const parsed = chain.map((c) => parse(c.metrics_json));
  for (const gr of spec.guardrail) {
    // A promotion without a recorded estimate (measure output lacked the metric) contributes nothing.
    const steps = parsed.map((m) => storedEstimate(m, gr.name)).filter((x): x is NonNullable<typeof x> => x !== null);
    out[gr.name] = { ...chainPosition(steps, gr.direction), ...(steps.length < chain.length ? { missing: chain.length - steps.length } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------- calibration

function calibrationText(c: Omit<GuardrailCalibration, "text">, how: string): string {
  const base = `${c.name}: noise ${pct(c.noise, 2)} ${how}, CI half-width ${pct(c.halfWidth, 2)}`;
  if (!c.judgeable) {
    return `${base}, more than its ${pct(c.limit)} limit: it can never be shown within the limit (every win is flagged inconclusive on it), and only regressions beyond about ${pct(c.limit + c.halfWidth)} are rejected`;
  }
  return `${base}: rejected beyond about ${pct(c.limit + c.halfWidth)} worse, ok below about ${pct(c.limit - c.halfWidth)} worse, inconclusive in between (limit ${pct(c.limit)} per step, ${pct(c.totalLimit)} total)`;
}

function finish(c: Omit<GuardrailCalibration, "text" | "judgeable">, how: string): GuardrailCalibration {
  const judgeable = c.halfWidth < c.limit || c.halfWidth === 0;
  return { ...c, judgeable, text: calibrationText({ ...c, judgeable }, how) };
}

/** noisy: per-pair A/A regressions → robust SD and the CI half-width at n_max pairs. */
export function calibratePairedGuardrail(
  g: { name: string; max_regression: number; max_total_regression?: number },
  aa: readonly number[],
  opts: { nMax: number; confidence: number; iterations: number; rng: Rng },
): GuardrailCalibration | null {
  const values = aa.filter(Number.isFinite);
  if (values.length < 2) return null;
  const s = calibrateNoisy(values, { ...opts, minEffect: 0 });
  return finish({ name: g.name, noise: s.noiseFloor, halfWidth: s.halfWidthAtNMax, limit: g.max_regression, totalLimit: g.max_total_regression ?? g.max_regression }, `per pair (A/A)`);
}

/** expensive: per-run σ of the baseline runs → the CI half-width of k confirmation runs against m baseline runs. */
export function calibrateRunsGuardrail(
  g: { name: string; direction: Direction; max_regression: number; max_total_regression?: number },
  runs: readonly number[],
  opts: { k: number; t: number },
): GuardrailCalibration | null {
  const values = runs.filter(Number.isFinite);
  if (values.length < 2) return null;
  const m = median(values);
  const sigma = sampleSd(values.map((v) => improvement(m, v, g.direction)));
  const halfWidth = opts.t * sigma * Math.sqrt(1 / opts.k + 1 / values.length);
  return finish({ name: g.name, noise: sigma, halfWidth, limit: g.max_regression, totalLimit: g.max_total_regression ?? g.max_regression }, `per run`);
}

/** deterministic: two runs of the baseline; the band is the tolerance or the repeat difference, whichever is larger. */
export function calibrateRepeatGuardrail(
  g: { name: string; direction: Direction; max_regression: number; max_total_regression?: number },
  a: number | undefined,
  b: number | undefined,
  tolerance: number,
): GuardrailCalibration | null {
  if (!finite(a) || !finite(b)) return null;
  const diff = Math.abs(improvement(a, b, g.direction));
  return finish({ name: g.name, noise: diff, halfWidth: Math.max(tolerance, diff), limit: g.max_regression, totalLimit: g.max_total_regression ?? g.max_regression }, `between two runs`);
}

/** Calibration warnings: a guardrail whose noise exceeds its limit can never be judged. */
export function guardrailWarnings(list: readonly GuardrailCalibration[]): string[] {
  return list.filter((c) => !c.judgeable).map((c) => `guardrail ${c.text}. Loosen its limit, make its measurement less noisy, or raise n_max.`);
}

/** Combine per-host guardrail calibrations: the worst host decides (as for the MDE). */
export function worstGuardrailCalibration(perHost: ReadonlyArray<readonly GuardrailCalibration[]>): GuardrailCalibration[] {
  const byName = new Map<string, GuardrailCalibration>();
  for (const list of perHost) {
    for (const c of list) {
      const cur = byName.get(c.name);
      if (!cur || c.halfWidth > cur.halfWidth) byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}
