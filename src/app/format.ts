// Display helpers shared by the study page and the header badge.

export type Direction = "lower" | "higher";

/** An improvement (positive = better) as the metric's own change: latency −12.3%, throughput +4.0%. */
export function metricChange(improvement: number | null | undefined, direction: Direction): string {
  if (improvement === null || improvement === undefined || !Number.isFinite(improvement)) return "—";
  const change = direction === "lower" ? -improvement : improvement;
  return `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)}%`;
}

/** An improvement, always "better is positive". */
export function pct(f: number | null | undefined, digits = 1): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return "—";
  return `${f >= 0 ? "+" : "−"}${Math.abs(f * 100).toFixed(digits)}%`;
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

export const VERDICT_TONE: Record<string, string> = {
  win: "text-emerald-600 dark:text-emerald-400",
  lose: "text-destructive",
  inconclusive: "text-muted-foreground",
  gate_failed: "text-amber-600 dark:text-amber-400",
  conflict: "text-amber-600 dark:text-amber-400",
  rejected: "text-muted-foreground",
};

export const STATE_TONE: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  paused: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  calibrating: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  draft: "bg-muted text-muted-foreground",
  harvesting: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  archived: "bg-muted text-muted-foreground",
  // Harvest states.
  ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

/** An unsigned fraction as a percentage (noise floors, MDEs). */
export function frac(f: number | null | undefined, digits = 2): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return "—";
  return `${(f * 100).toFixed(digits)}%`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
