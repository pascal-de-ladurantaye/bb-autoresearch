// The candidate detail's samples table, per noise class (pure, frontend-safe).
// Samples are stored with a 0-based `pair` index whose meaning depends on the
// class: noisy pairs are pairs (shown 1-based), a deterministic measurement is
// one run of each side (pair 0), an expensive one is best's baseline runs
// (pair i) and the candidate's screening run (pair 0) and confirmation runs
// (pair 1..k). Never shows "pair 0".
import { improvementOf, type Direction, type NoiseClass } from "./present.ts";

export interface SampleLikeRow {
  run: string;
  pair: number;
  side: string;
  metric: string;
  value: number;
}

export interface SampleTableRow {
  key: string;
  /** "measurement", "confirmation", "calibration". */
  run: string;
  /** "pair 3", "single run", "baseline run 2", "screening run", "confirmation run 1". */
  label: string;
  best: number | null;
  candidate: number | null;
  /** Improvement of the candidate over best in this row (better is positive); null when the row has one side. */
  change: number | null;
}

const RUN_WORD: Record<string, string> = { measure: "measurement", confirm: "confirmation" };

export function sampleTableRows(samples: readonly SampleLikeRow[], metric: { name: string; direction: Direction }, noise: NoiseClass): SampleTableRow[] {
  const mine = samples.filter((s) => s.metric === metric.name);
  const runWord = (r: string) => RUN_WORD[r] ?? r;
  if (noise === "expensive") {
    const out: SampleTableRow[] = [];
    for (const s of mine) {
      const best = s.side === "best";
      const label = best ? `baseline run ${s.pair + 1}` : s.pair === 0 ? "screening run" : `confirmation run ${s.pair}`;
      out.push({ key: `${s.run}:${s.side}:${s.pair}`, run: runWord(s.run), label, best: best ? s.value : null, candidate: best ? null : s.value, change: null });
    }
    // Baseline runs first, then the screen, then the confirmations, per run.
    const rank = (r: SampleTableRow) => (r.best !== null ? 0 : r.label === "screening run" ? 1 : 2);
    return out.sort((a, b) => a.run.localeCompare(b.run) || rank(a) - rank(b) || a.key.localeCompare(b.key, undefined, { numeric: true }));
  }
  const byKey = new Map<string, SampleTableRow>();
  for (const s of mine) {
    const k = `${s.run}:${s.pair}`;
    const row = byKey.get(k) ?? { key: k, run: runWord(s.run), label: noise === "deterministic" ? "single run" : `pair ${s.pair + 1}`, best: null, candidate: null, change: null };
    if (s.side === "best") row.best = s.value;
    else row.candidate = s.value;
    byKey.set(k, row);
  }
  return [...byKey.values()].map((r) => ({ ...r, change: improvementOf(r.best, r.candidate, metric.direction) }));
}

/** Rows shown before "Show all": enough to see the pattern, without a scroll box. */
export const SAMPLE_ROWS_SHOWN = 12;
