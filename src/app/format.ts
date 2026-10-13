// Display helpers shared by the study page and the header badge. The
// improvement convention itself lives in ../present.ts (shared with the
// server, CLI and report): better is positive, in the metric's own terms.
export {
  ciRangeText,
  ciText,
  factorText,
  formatValue,
  GLOSSARY,
  improvementText,
  magnitudePct,
  rawChange,
  sharePct,
  signedPct,
  valueWithUnit,
  type Direction,
  type GlossaryKey,
  type MetricInfo,
} from "../present.ts";
import { signedPct } from "../present.ts";

/** An improvement, always "better is positive". */
export function pct(f: number | null | undefined, digits = 1): string {
  return signedPct(f, digits);
}

export function ratio(f: number | null | undefined): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return "—";
  return `${(f * 100).toFixed(0)}%`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 120) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "—";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : "—";
}

/** Verdicts: a word and a glyph always travel with the color, so color never carries the meaning alone. */
export const VERDICT: Record<string, { label: string; icon: string; tone: string }> = {
  win: { label: "win", icon: "Check", tone: "text-success" },
  lose: { label: "lose", icon: "X", tone: "text-destructive" },
  inconclusive: { label: "inconclusive", icon: "Minus", tone: "text-muted-foreground" },
  gate_failed: { label: "gate failed", icon: "AlertTriangle", tone: "text-warning-text" },
  conflict: { label: "conflict", icon: "GitMerge", tone: "text-warning-text" },
  rejected: { label: "rejected (scope)", icon: "CircleX", tone: "text-muted-foreground" },
};

export const VERDICT_TONE: Record<string, string> = Object.fromEntries(Object.entries(VERDICT).map(([k, v]) => [k, v.tone]));

export const STATE_TONE: Record<string, string> = {
  running: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning-text",
  calibrating: "bg-muted text-foreground",
  draft: "bg-muted text-muted-foreground",
  harvesting: "bg-muted text-foreground",
  archived: "bg-muted text-muted-foreground",
  // Harvest states (ready: harvests before v1).
  waiting: "bg-muted text-foreground",
  frozen: "bg-success/15 text-success",
  ready: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  // Requested measurements and gates.
  queued: "bg-muted text-muted-foreground",
  done: "bg-success/15 text-success",
};

/** Guardrail states: word + glyph + tone. */
export const GUARDRAIL: Record<string, { icon: string; tone: string }> = {
  pass: { icon: "Check", tone: "text-success" },
  warn: { icon: "AlertTriangle", tone: "text-warning-text" },
  // A CI straddles a limit: flagged (warn tone, its own glyph and word), not a rejection.
  inconclusive: { icon: "AlertCircle", tone: "text-warning-text" },
  broken: { icon: "CircleX", tone: "text-destructive" },
  missing: { icon: "CircleQuestion", tone: "text-muted-foreground" },
};

/** An unsigned fraction as a percentage (noise floors, MDEs). */
export function frac(f: number | null | undefined, digits = 2): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return "—";
  return `${Math.abs(f * 100).toFixed(digits)}%`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** The Overview's "Now" hint, by state: only a running study spawns workers. */
export function nowHint(o: { state: string; workers: number; targetWorkers: number; maxWorkers: number; maxWorkersOverride: number | null }): string {
  switch (o.state) {
    case "running":
      // Live workers include finishing ones, so there can be more than W for a while (W adapts down; nobody is stopped).
      return `target ${o.targetWorkers} now (W), max ${o.maxWorkers}${o.maxWorkersOverride !== null ? " (your override)" : ""}${o.workers > o.targetWorkers ? `; no new worker until fewer than ${o.targetWorkers} are live` : ""}`;
    case "paused":
      return o.workers ? `paused: ${o.workers} finishing, no new workers until you resume` : "paused: no new workers until you resume";
    case "harvesting":
      return o.workers ? `harvesting: ${o.workers} finishing, no new workers` : "harvesting: no new workers";
    case "archived":
      return "workers stopped for good";
    default:
      return "no workers before the study starts";
  }
}
