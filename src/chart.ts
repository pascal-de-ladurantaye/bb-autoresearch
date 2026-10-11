// Small layout helpers for the page's charts (pure: no DOM, safe in the
// frontend bundle, tested on their own): nice axis ticks, label placement
// that never overlaps, and a trend line's value range.

/** A "nice" step (1, 2, 2.5 or 5 × 10^k) close to span / target. */
export function niceStep(span: number, target = 5): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  // The nearest nice step (not the next one up), so ranges get about `target` ticks.
  const nice = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return nice * mag;
}

/**
 * Nice axis ticks covering [lo, hi]: round multiples of a nice step, the
 * domain widened to the outer ticks. `integer` forces whole-number steps
 * (candidate numbers). Ticks are rounded to the step's precision, so they
 * print as "+5%" and "−10%", never "−7.9%".
 */
export function niceTicks(lo: number, hi: number, target = 5, opts: { integer?: boolean } = {}): { ticks: number[]; lo: number; hi: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [0], lo: 0, hi: 1, step: 1 };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-12) {
    const pad = Math.abs(lo) * 0.1 || (opts.integer ? 1 : 0.01);
    lo -= pad;
    hi += pad;
  }
  let step = niceStep(hi - lo, target);
  if (opts.integer) step = Math.max(1, Math.round(step));
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  const ticks: number[] = [];
  for (let i = first; i <= last && ticks.length < 50; i++) ticks.push(Number((i * step).toFixed(decimals)) + 0);
  return { ticks, lo: ticks[0]!, hi: ticks.at(-1)!, step };
}

/** Digits a percentage tick label needs for this step (a fraction): 0.05 → 0 ("+5%"), 0.025 → 1 ("+2.5%"). */
export function pctTickDigits(step: number): number {
  const p = step * 100;
  for (let d = 0; d <= 3; d++) if (Math.abs(p * 10 ** d - Math.round(p * 10 ** d)) < 1e-6) return d;
  return 3;
}

export interface LabelItem {
  key: string;
  /** Wanted position (pixels along the axis the labels stack on). */
  at: number;
  /** Higher wins when two labels can't both fit. */
  priority: number;
  /** How far the label may move from `at` (default: one gap). */
  maxShift?: number;
}

export interface PlacedLabel {
  key: string;
  at: number;
}

/**
 * Place labels along one axis so that no two are closer than `gap` pixels,
 * within [min, max]. Labels are placed by priority; one that can't be placed
 * within its `maxShift` of where it wants to be is dropped (an axis tick
 * dropped beats two overlapping ones). Returns the placed labels by position.
 */
export function layoutLabels(items: readonly LabelItem[], opts: { gap: number; min: number; max: number }): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const free = (at: number) => at >= opts.min - 1e-9 && at <= opts.max + 1e-9 && placed.every((p) => Math.abs(p.at - at) >= opts.gap - 1e-9);
  const order = [...items].sort((a, b) => b.priority - a.priority);
  for (const it of order) {
    const want = Math.min(opts.max, Math.max(opts.min, it.at));
    const shift = it.maxShift ?? opts.gap;
    let best: number | null = free(want) ? want : null;
    if (best === null) {
      // The nearest free spot: just past a placed label's gap, on either side.
      const spots = placed.flatMap((p) => [p.at - opts.gap, p.at + opts.gap]).filter((s) => Math.abs(s - want) <= shift && free(s));
      spots.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
      best = spots[0] ?? null;
    }
    if (best !== null) placed.push({ key: it.key, at: best });
  }
  return placed.sort((a, b) => a.at - b.at);
}

/**
 * The value range a small trend line draws over: at least `minRelSpan` of
 * the values' magnitude, centered, so a change of a fraction of a percent
 * stays a flat line instead of filling the whole height.
 */
export function trendDomain(values: readonly number[], minRelSpan = 0.05): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return [0, 1];
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const mag = Math.max(...finite.map((v) => Math.abs(v)));
  const minSpan = Math.max(mag * minRelSpan, 1e-9);
  if (hi - lo >= minSpan) return [lo, hi];
  const mid = (lo + hi) / 2;
  return [mid - minSpan / 2, mid + minSpan / 2];
}
