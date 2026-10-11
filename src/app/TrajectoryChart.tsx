// Trajectory: every measured candidate is a mark at its position relative
// to base when it was measured (better is up, as everywhere: "+40%" means
// 40% better in the metric's own direction), best is a step line. Marks
// differ by shape as well as color (win ●, lose ×, other ○). Plain SVG;
// colors come from text tokens through currentColor.
import { useMemo, useState } from "react";
import { niceTicks, pctTickDigits, trendDomain } from "../chart.ts";
import { useBoxWidth } from "./useBoxWidth.ts";
import { cn } from "@/lib/utils";
import { improvementText, pct, VERDICT, VERDICT_TONE, type MetricInfo } from "./format.ts";

export interface TrajectoryData {
  points: Array<{ n: number; verdict: string; effect: number | null; position: number; at: number }>;
  steps: Array<{ n: number; value: number }>;
}

const H = 220;
const PAD = { l: 52, r: 12, t: 12, b: 30 };
/** Pixel font size of the axis labels: the chart draws at its box's width, so text never scales with it. */
const FONT = 10;

/**
 * The chart's axes: nice y ticks (round percentages, the domain widened to
 * them) and candidate-number ticks on x. Pure, for tests.
 */
export function trajectoryAxes(data: TrajectoryData, lastN: number, direction: MetricInfo["direction"], width: number) {
  const maxN = Math.max(1, lastN, ...data.points.map((p) => p.n));
  const ys = [0, ...data.points.map((p) => p.position), ...data.steps.map((s) => s.value)];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 0.02) {
    lo -= 0.01;
    hi += 0.01;
  }
  // A reduction can't pass 100%: don't draw ticks above it for lower-is-better metrics.
  if (direction === "lower") hi = Math.min(hi, 1);
  const y = niceTicks(lo, hi, 5);
  const plotW = Math.max(40, width - PAD.l - PAD.r);
  const x = niceTicks(0, maxN, Math.max(2, Math.min(10, Math.floor(plotW / 60))), { integer: true });
  const xTicks = x.ticks.filter((n) => n >= 1 && n <= maxN);
  return { maxN, yTicks: y.ticks, yLo: y.lo, yHi: y.hi, yDigits: pctTickDigits(y.step), xTicks };
}

function Mark({ verdict, x, y, big }: { verdict: string; x: number; y: number; big: boolean }) {
  const r = big ? 5 : 3.6;
  if (verdict === "win") return <circle cx={x} cy={y} r={r} fill="currentColor" />;
  if (verdict === "lose")
    return (
      <g stroke="currentColor" strokeWidth={1.8}>
        <line x1={x - r} y1={y - r} x2={x + r} y2={y + r} />
        <line x1={x - r} y1={y + r} x2={x + r} y2={y - r} />
      </g>
    );
  return <circle cx={x} cy={y} r={r} fill="none" stroke="currentColor" strokeWidth={1.5} />;
}

export function TrajectoryChart({ data, metric, lastN, onSelect }: { data: TrajectoryData; metric: MetricInfo; lastN: number; onSelect?: (n: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useBoxWidth(640);
  const geo = useMemo(() => {
    const a = trajectoryAxes(data, lastN, metric.direction, W);
    const { maxN, yLo: lo, yHi: hi } = a;
    const x = (n: number) => PAD.l + (n / maxN) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    let path = `M ${x(0)} ${y(0)}`;
    let cur = 0;
    for (const s of data.steps.slice(1)) {
      path += ` H ${x(s.n)} V ${y(s.value)}`;
      cur = s.value;
    }
    path += ` H ${x(maxN)}`;
    return { x, y, ticks: a.yTicks, digits: a.yDigits, xTicks: a.xTicks, path, maxN, cur };
  }, [data, lastN, metric.direction, W]);
  const hovered = hover !== null ? data.points.find((p) => p.n === hover) : undefined;
  return (
    <div className="relative" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Trajectory: ${data.points.filter((p) => p.effect !== null).length} measured candidates${data.points.some((p) => p.effect === null) ? `, ${data.points.filter((p) => p.effect === null).length} without a measurement` : ""}; best is ${improvementText(geo.cur, metric)} than base`}>
        <g className="text-border">
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(t)} y2={geo.y(t)} stroke="currentColor" strokeWidth={1} />
              <text x={PAD.l - 6} y={geo.y(t) + 3} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: FONT }}>
                {t === 0 ? "0%" : pct(t, geo.digits)}
              </text>
            </g>
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(0)} y2={geo.y(0)} stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 3" className="text-muted-foreground/60" />
        </g>
        <g className="fill-muted-foreground" style={{ fontSize: FONT }} data-x-axis>
          {geo.xTicks.map((n) => (
            <g key={n}>
              <line x1={geo.x(n)} x2={geo.x(n)} y1={H - PAD.b} y2={H - PAD.b + 3} stroke="currentColor" className="text-border" />
              <text x={geo.x(n)} y={H - PAD.b + 13} textAnchor="middle">
                {n}
              </text>
            </g>
          ))}
          <text x={(PAD.l + W - PAD.r) / 2} y={H - 3} textAnchor="middle">
            candidate (c/N)
          </text>
        </g>
        <path d={geo.path} fill="none" stroke="currentColor" strokeWidth={2} className="text-foreground" />
        {data.points.map((p) => (
          <g
            key={p.n}
            role="button"
            tabIndex={0}
            aria-label={`c/${p.n} ${VERDICT[p.verdict]?.label ?? p.verdict}: ${p.effect === null ? "not measured (shown on the best line at the time)" : `${improvementText(p.effect, metric, { factor: false })} than best at the time`}. Open it.`}
            className={cn("cursor-pointer outline-none focus-visible:[&>*]:stroke-[3]", VERDICT_TONE[p.verdict] ?? "text-muted-foreground", p.verdict !== "win" && "opacity-80")}
            onMouseEnter={() => setHover(p.n)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(p.n)}
            onBlur={() => setHover(null)}
            onClick={() => onSelect?.(p.n)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.(p.n);
              }
            }}
          >
            <Mark verdict={p.verdict} x={geo.x(p.n)} y={geo.y(p.position)} big={hover === p.n} />
          </g>
        ))}
      </svg>
      {/* Fixed position: the hover card never moves the layout. */}
      <div className={cn("pointer-events-none absolute right-2 top-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-sm", !hovered && "invisible")} aria-hidden>
        {hovered ? (
          <>
            c/{hovered.n} · <span className={VERDICT_TONE[hovered.verdict]}>{VERDICT[hovered.verdict]?.label ?? hovered.verdict}</span> · {hovered.effect === null ? "not measured" : `${improvementText(hovered.effect, metric, { factor: false })} than best then`}
          </>
        ) : (
          "—"
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Up is better: improvement vs base, in {metric.name} ({metric.direction} is better). Line: best. Marks: ● win · × lose · ○ other verdicts (unmeasured ones on the best line).
      </p>
    </div>
  );
}

/** A tiny trend line (values of best after each promotion); text alternative in the label. */
export function Sparkline({ points, label }: { points: Array<{ n: number; value: number }>; label: string }) {
  if (points.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
  const w = 96;
  const h = 24;
  const xs = points.map((p) => p.n);
  const ys = points.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) || 1];
  // At least 5% of the values' size: a change of a fraction of a percent stays flat instead of filling the height.
  const [y0, y1] = trendDomain(ys);
  const d = points.map((p, i) => `${i ? "L" : "M"} ${(((p.n - x0) / (x1 - x0 || 1)) * (w - 4) + 2).toFixed(1)} ${(h - 2 - ((p.value - y0) / (y1 - y0)) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${points.map((p) => p.value.toPrecision(4)).join(", ")}`} className="text-muted-foreground">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
