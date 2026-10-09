// Trajectory: every measured candidate is a dot (its position relative to
// base when it was measured), best is a step line. Plain SVG; colors come
// from text tokens through currentColor.
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { pct, VERDICT_TONE } from "./format.ts";

export interface TrajectoryData {
  points: Array<{ n: number; verdict: string; effect: number; position: number; at: number }>;
  steps: Array<{ n: number; value: number }>;
}

const W = 640;
const H = 220;
const PAD = { l: 48, r: 12, t: 12, b: 26 };

export function TrajectoryChart({ data, lastN, onSelect }: { data: TrajectoryData; lastN: number; onSelect?: (n: number) => void }) {
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
    // Improvement vs base can't pass 100% for a metric that only decreases.
    hi = Math.min(hi + padY, Math.max(hi, 1));
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
  }, [data, lastN]);
  const hovered = hover !== null ? data.points.find((p) => p.n === hover) : undefined;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Trajectory: ${data.points.length} measured candidates, best ${pct(geo.cur)} vs base`}>
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
          <circle
            key={p.n}
            cx={geo.x(p.n)}
            cy={geo.y(p.position)}
            r={hover === p.n ? 5 : 3.5}
            fill="currentColor"
            className={cn("cursor-pointer", VERDICT_TONE[p.verdict] ?? "text-muted-foreground", p.verdict !== "win" && "opacity-70")}
            onMouseEnter={() => setHover(p.n)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(p.n)}
          >
            <title>{`c/${p.n} ${p.verdict} ${pct(p.effect)} vs best at the time`}</title>
          </circle>
        ))}
      </svg>
      {hovered ? (
        <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-sm">
          c/{hovered.n} · <span className={VERDICT_TONE[hovered.verdict]}>{hovered.verdict}</span> · {pct(hovered.effect)} vs best then
        </div>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">Y: improvement vs base (up is better). Dots: measured candidates. Line: best.</p>
    </div>
  );
}
