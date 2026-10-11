// Raw metric values of a study's segment baseline and of its current best,
// as measured (medians of each side). Shared by the views and the report.
import type { Store, StudyRow } from "./db/store.ts";
import type { StoredGuardrails } from "./guardrails.ts";
import { safeJson } from "./prompts.ts";

type Metrics = Record<string, number>;
interface CandidateMetrics extends StoredGuardrails {
  best?: Metrics;
  candidate?: Metrics;
}

export interface MetricSnapshot {
  baselineSha: string | null;
  bestSha: string | null;
  baseline: Metrics | null;
  best: Metrics | null;
}

/** Raw metric values of the active segment's baseline and of the current best (medians as measured). */
export function metricSnapshotOf(store: Store, s: StudyRow): MetricSnapshot {
  const seg = store.segment(s.id, s.segment);
  const baselineSha = seg?.baseline_sha ?? s.base_sha;
  const decided = store.candidates(s.id, { stages: ["decided"] });
  const runOf = (sha: string | null): Metrics | null => {
    if (!sha || s.best_run_sha !== sha) return null;
    return safeJson<{ metrics?: Metrics }>(s.best_run_json)?.metrics ?? null;
  };
  const measuredAgainst = decided.find((c) => c.against_sha === baselineSha && safeJson<CandidateMetrics>(c.metrics_json)?.best);
  const baseline = measuredAgainst ? (safeJson<CandidateMetrics>(measuredAgainst.metrics_json)!.best ?? null) : runOf(baselineSha);
  let best: Metrics | null = null;
  if (s.best_sha && s.best_sha === baselineSha) best = baseline;
  else {
    const promoted = decided.find((c) => c.promoted_sha === s.best_sha);
    best = (promoted ? safeJson<CandidateMetrics>(promoted.metrics_json)?.candidate : null) ?? runOf(s.best_sha);
    if (!best) {
      // Measured against the current best (a later candidate's "best" side).
      const later = [...decided].reverse().find((c) => c.against_sha === s.best_sha && safeJson<CandidateMetrics>(c.metrics_json)?.best);
      best = later ? (safeJson<CandidateMetrics>(later.metrics_json)!.best ?? null) : null;
    }
  }
  return { baselineSha, bestSha: s.best_sha, baseline, best };
}

