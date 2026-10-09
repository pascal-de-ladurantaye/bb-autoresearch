// `measure` prints `METRIC name=value` lines plus optional `DIAG ...` lines.

export interface MeasureOutput {
  metrics: Record<string, number>;
  diag: string[];
}

const METRIC_RE = /^\s*METRIC\s+([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*=\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*$/u;
const DIAG_RE = /^\s*DIAG\s+(.*)$/u;

export function parseMeasureOutput(stdout: string, limits = { diagLines: 40, diagChars: 4000 }): MeasureOutput {
  const metrics: Record<string, number> = {};
  const diag: string[] = [];
  let diagChars = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    const m = METRIC_RE.exec(line);
    if (m) {
      const value = Number(m[2]);
      if (Number.isFinite(value)) metrics[m[1]!] = value;
      continue;
    }
    const d = DIAG_RE.exec(line);
    if (d && diag.length < limits.diagLines && diagChars < limits.diagChars) {
      const text = d[1]!.slice(0, 400);
      diag.push(text);
      diagChars += text.length;
    }
  }
  return { metrics, diag };
}
