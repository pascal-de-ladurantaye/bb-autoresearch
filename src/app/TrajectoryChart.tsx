// Trajectory: every measured candidate is a mark at its position relative
// to base when it was measured (better is up, as everywhere: "+40%" means
// 40% better in the metric's own direction), best is a step line. Marks
// differ by shape as well as color (win ●, lose ×, other ○). Plain SVG;
// colors come from text tokens through currentColor.
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { improvementText, pct, VERDICT, VERDICT_TONE, type MetricInfo } from "./format.ts";

export interface TrajectoryData {
  points: Array<{ n: number; verdict: string; effect: number; position: number; at: number }>;
  steps: Array<{ n: number; value: number }>;
}

const W = 640;
const H = 220;
const PAD = { l: 52, r: 12, t: 12, b: 26 };

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
  const geo = useMemo(() => {
    const maxN = Math.max(1, lastN, ...data.points.map((p) => p.n));
    const ys = [0, ...data.points.map((p) => p.position), ...data.steps.map((s) => s.value)];
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (hi - lo < 0.02) {
      lo -= 0.01;
      hi += 0.01;
    }
    const padY = (hi - lo) * 0.08;
    lo -= padY;
    // A reduction can't pass 100%: don't draw ticks above it for lower-is-better metrics.
    hi = metric.direction === "lower" ? Math.min(hi + padY, Math.max(hi, 1)) : hi + padY;
    const x = (n: number) => PAD.l + (n / maxN) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    let path = `M ${x(0)} ${y(0)}`;
    let cur = 0;
    for (const s of data.steps.slice(1)) {
      path += ` H ${x(s.n)} V ${y(s.value)}`;
      cur = s.value;
    }
    path += ` H ${x(maxN)}`;
    return { x, y, ticks, path, maxN, cur };
  }, [data, lastN, metric.direction]);
  const hovered = hover !== null ? data.points.find((p) => p.n === hover) : undefined;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Trajectory: ${data.points.length} measured candidates; best is ${improvementText(geo.cur, metric)} than base`}>
        <g className="text-border">
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(t)} y2={geo.y(t)} stroke="currentColor" strokeWidth={1} />
              <text x={PAD.l - 6} y={geo.y(t) + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
                {pct(t)}
              </text>
            </g>
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(0)} y2={geo.y(0)} stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 3" className="text-muted-foreground/60" />
        </g>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
          candidate #
        </text>
        <path d={geo.path} fill="none" stroke="currentColor" strokeWidth={2} className="text-foreground" />
        {data.points.map((p) => (
          <g
            key={p.n}
            role="button"
            tabIndex={0}
            aria-label={`c/${p.n} ${VERDICT[p.verdict]?.label ?? p.verdict}: ${improvementText(p.effect, metric, { factor: false })} than best at the time. Open it.`}
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
            c/{hovered.n} · <span className={VERDICT_TONE[hovered.verdict]}>{VERDICT[hovered.verdict]?.label ?? hovered.verdict}</span> · {improvementText(hovered.effect, metric, { factor: false })} than best then
          </>
        ) : (
          "—"
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Up is better: improvement vs base, in {metric.name} ({metric.direction} is better). Line: best. Marks: ● win · × lose · ○ other verdicts.
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
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y1 - y0 < 1e-12) {
    y0 -= 1;
    y1 += 1;
  }
  const d = points.map((p, i) => `${i ? "L" : "M"} ${(((p.n - x0) / (x1 - x0 || 1)) * (w - 4) + 2).toFixed(1)} ${(h - 2 - ((p.value - y0) / (y1 - y0)) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${points.map((p) => p.value.toPrecision(4)).join(", ")}`} className="text-muted-foreground">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
