// The live CI band of a measurement: the estimate and its confidence
// interval narrowing pair by pair against the zero line and the win
// threshold, with the sequential test's regions shaded (lose, continue,
// win), the zone before n_min hatched, and the moment it stopped marked
// ("decided after 9 of 20 pairs"). The confirmation is a second phase.
// Deterministic measurements show the run against the tolerance; expensive
// ones the runs against the calibrated σ band. Guardrails sit underneath,
// compactly: the step against its limit and the total against its own.
// Every state is also in words; color is never the only signal.
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { bandGuardrails, expensiveThresholds, pointDecision, runDecision, type BandDecision, type BandGuardrailState, type BandPoint, type BandRun, type DeterministicBand, type ExpensiveBand, type MeasureBand, type NoisyBand } from "../../band.ts";
import { changeWords, rangeWords } from "../../guardrails.ts";
import type { LiveCard } from "../../live-model.ts";
import { magnitudePct, signedPct, type MetricInfo } from "../../present.ts";
import { animateIf, useMotionGate } from "./motion.tsx";

const DECISION_WORD: Record<Exclude<BandDecision, "continue">, { label: string; icon: string; tone: string }> = {
  win: { label: "win", icon: "Check", tone: "text-success" },
  lose: { label: "lose", icon: "X", tone: "text-destructive" },
  inconclusive: { label: "inconclusive", icon: "Minus", tone: "text-muted-foreground" },
};

const pct = (f: number, digits = 1) => signedPct(f, digits);

export interface MeasurementProps {
  band: MeasureBand;
  card: LiveCard | null;
  hostName: string | null;
  metric: MetricInfo;
  compact: boolean;
  onOpenCandidate: (n: number) => void;
}

/** One measurement: its title, chart(s), the decision in words, and the guardrails. */
export function Measurement({ band, card, hostName, metric, compact, onOpenCandidate }: MeasurementProps) {
  const decided = band.final !== null;
  const stage = card?.stage === "confirming" ? "confirming" : card?.stage === "promoting" ? "promoting" : decided ? "measured" : "measuring";
  return (
    <article className={cn("min-w-0 space-y-2 rounded-lg border border-border bg-card p-3", compact && "p-2.5")} aria-label={`CI band of c/${band.n}`} data-band={band.n}>
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <button type="button" className="rounded font-mono font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenCandidate(band.n)}>
          c/{band.n}
        </button>
        {card?.ideaTitle ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{card.ideaTitle}</span> : <span className="flex-1" />}
        <span className="text-xs text-muted-foreground">
          {stage}
          {hostName ? ` on ${hostName}` : ""} · {band.kind}
        </span>
      </header>
      {band.kind === "noisy" ? <NoisyBandView band={band} compact={compact} /> : band.kind === "deterministic" ? <DeterministicView band={band} metric={metric} /> : <ExpensiveView band={band} compact={compact} />}
      <Guardrails states={bandGuardrails(band)} compact={compact} />
    </article>
  );
}

// ------------------------------------------------------------------ noisy

function domainOf(band: NoisyBand): [number, number] {
  let lo = Math.min(0, -band.mde * 0.5);
  let hi = band.mde * 1.8;
  const judged: number[] = [];
  for (const r of band.runs)
    for (const p of r.points) {
      judged.push(p.m);
      // Early preview CIs (2-3 pairs) can be huge: they may stretch the scale only so far.
      if (p.lo !== null && p.hi !== null && p.n >= Math.min(band.nMin, 3)) judged.push(p.lo, p.hi);
    }
  for (const v of judged) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const pad = (hi - lo) * 0.08 || 0.01;
  return [lo - pad, hi + pad];
}

function NoisyBandView({ band, compact }: { band: NoisyBand; compact: boolean }) {
  const domain = useMemo(() => domainOf(band), [band]);
  const measure = band.runs.find((r) => r.run === "measure");
  const confirm = band.runs.find((r) => r.run === "confirm");
  return (
    <div className={cn("grid gap-3", confirm && !compact ? "grid-cols-2" : "grid-cols-1")}>
      {measure ? <RunPanel band={band} run={measure} domain={domain} title={confirm ? "Measurement" : null} compact={compact} /> : null}
      {confirm ? <RunPanel band={band} run={confirm} domain={domain} title="Confirmation · fresh pairs" compact={compact} /> : null}
      {!band.exact ? <p className="text-[11px] text-muted-foreground">Recomputed from the samples (this measurement predates stored bands): the CI can differ slightly from the verdict's.</p> : null}
    </div>
  );
}

const M = { l: 40, r: 10, t: 12, b: 20 };

/** The pixel width of a box (charts draw in pixels, so their text stays crisp); `fallback` until measured. */
function useBoxWidth(fallback: number): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(fallback);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width > 0) setW(Math.round(width));
    if (typeof ResizeObserver === "function") {
      obs.current = new ResizeObserver((entries) => {
        const x = entries[0]?.contentRect.width;
        if (x && x > 0) setW(Math.round(x));
      });
      obs.current.observe(el);
    }
  }, []);
  return [ref, w];
}

function RunPanel({ band, run, domain, title, compact }: { band: NoisyBand; run: BandRun; domain: [number, number]; title: string | null; compact: boolean }) {
  const clip = useId().replace(/:/gu, "");
  const [box, W] = useBoxWidth(320);
  const H = compact ? 128 : 160;
  const motion = useMotionGate();
  const [yMin, yMax] = domain;
  const x = (n: number) => M.l + ((n - 0.5) / band.nMax) * (W - M.l - M.r);
  const y = (v: number) => M.t + ((yMax - Math.max(yMin, Math.min(yMax, v))) / (yMax - yMin)) * (H - M.t - M.b);
  const pts = run.points;
  const last = pts.at(-1) ?? null;
  const stop = runDecision(band, run);
  const ci = pts.filter((p) => p.lo !== null && p.hi !== null);
  const tone = stop ? DECISION_WORD[stop.decision].tone : "text-foreground";
  // Segments of the band between consecutive points, keyed by pair: a new one grows in from the left.
  const segments = ci.slice(1).map((p, i) => {
    const a = ci[i]!;
    return { n: p.n, d: `M${x(a.n)},${y(a.hi!)} L${x(p.n)},${y(p.hi!)} L${x(p.n)},${y(p.lo!)} L${x(a.n)},${y(a.lo!)} Z`, preview: p.n < band.nMin };
  });
  const median = pts.map((p, i) => `${i ? "L" : "M"}${x(p.n)},${y(p.m)}`).join(" ");
  const g = useRef<SVGGElement | null>(null);
  const seen = useRef<number>(pts.length);
  const stopSeen = useRef<boolean>(stop !== null);
  useLayoutEffect(() => {
    const root = g.current;
    if (!root) return;
    const ok = motion();
    if (pts.length > seen.current) {
      const seg = root.querySelector(`[data-seg="${pts.length}"]`);
      animateIf(ok, seg, [{ opacity: 0, transform: "scaleX(0)" }, { opacity: 1, transform: "scaleX(1)" }], { duration: 420 });
      animateIf(ok, root.querySelector("[data-head]"), [{ transform: "scale(2)", opacity: 0.4 }, { transform: "scale(1)", opacity: 1 }], { duration: 420 });
    }
    if (stop && !stopSeen.current) {
      animateIf(ok, root.querySelector("[data-decision]"), [{ opacity: 0, transform: "scaleY(0)" }, { opacity: 1, transform: "scaleY(1)" }], { duration: 600 });
      animateIf(ok, root.querySelector(`[data-region="${stop.decision}"]`), [{ fillOpacity: 0.08 }, { fillOpacity: 0.32 }, { fillOpacity: 0.08 }], { duration: 1400 });
    }
    seen.current = pts.length;
    stopSeen.current = stop !== null;
  }, [pts.length, stop, motion]);
  const yTicks = [0, band.mde];
  const xTicks = [...new Set([1, band.nMin, band.nMax])];
  return (
    <figure className="min-w-0 space-y-1" aria-label={`${title ?? "Measurement"} of c/${band.n}`}>
      {title ? <figcaption className="text-xs font-medium text-muted-foreground">{title}</figcaption> : null}
      <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={runWords(band, run)}>
        <defs>
          <clipPath id={`plot-${clip}`}>
            <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} />
          </clipPath>
          <pattern id={`hatch-${clip}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <g ref={g}>
          {/* Decision regions: lose (CI entirely below 0), continue, win (CI's low end above the threshold). */}
          <rect data-region="win" className="text-success" fill="currentColor" fillOpacity={0.09} x={M.l} width={W - M.l - M.r} y={y(yMax)} height={Math.max(0, y(band.mde) - y(yMax))} />
          <rect data-region="lose" className="text-destructive" fill="currentColor" fillOpacity={0.07} x={M.l} width={W - M.l - M.r} y={y(0)} height={Math.max(0, y(yMin) - y(0))} />
          {band.nMin > 1 ? (
            <g className="text-muted-foreground">
              <rect fill={`url(#hatch-${clip})`} opacity={0.18} x={M.l} width={Math.max(0, x(band.nMin - 0.5) - M.l)} y={M.t} height={H - M.t - M.b} />
            </g>
          ) : null}
          <g className="fill-muted-foreground text-[9px]" style={{ fontSize: 9 }}>
            <text x={W - M.r - 3} y={y(yMax) + 10} textAnchor="end" className="fill-success">
              win
            </text>
            <text x={W - M.r - 3} y={Math.min(H - M.b - 3, y(0) + 10)} textAnchor="end" className="fill-destructive">
              lose
            </text>
            {y(0) - y(band.mde) > 12 ? (
              <text x={W - M.r - 3} y={(y(0) + y(band.mde)) / 2 + 3} textAnchor="end">
                continue
              </text>
            ) : null}
          </g>
          {/* Zero and the win threshold. */}
          <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} className="text-foreground" stroke="currentColor" strokeOpacity={0.45} strokeWidth={1} />
          <line x1={M.l} x2={W - M.r} y1={y(band.mde)} y2={y(band.mde)} className="text-success" stroke="currentColor" strokeDasharray="4 3" strokeWidth={1} />
          {/* Axes. */}
          <g className="fill-muted-foreground" style={{ fontSize: 9 }}>
            {yTicks.map((v) => (
              <text key={v} x={M.l - 4} y={y(v) + 3} textAnchor="end">
                {v === 0 ? "0" : pct(v)}
              </text>
            ))}
            {Math.min(...yTicks.map((v) => Math.abs(y(v) - (M.t + 4)))) > 11 ? (
              <text x={M.l - 4} y={M.t + 7} textAnchor="end">
                {pct(yMax, 0)}
              </text>
            ) : null}
            {Math.min(...yTicks.map((v) => Math.abs(y(v) - (H - M.b - 3)))) > 11 ? (
              <text x={M.l - 4} y={H - M.b} textAnchor="end">
                {pct(yMin, 0)}
              </text>
            ) : null}
            {xTicks.map((n) => (
              <text key={n} x={x(n)} y={H - 6} textAnchor="middle">
                {n}
              </text>
            ))}
            <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" opacity={0.7}>
              pairs
            </text>
          </g>
          <g clipPath={`url(#plot-${clip})`} className={tone}>
            {segments.map((s) => (
              <path key={s.n} data-seg={s.n} d={s.d} fill="currentColor" fillOpacity={s.preview ? 0.08 : 0.2} style={{ transformBox: "fill-box", transformOrigin: "left center" }} />
            ))}
            <path d={median} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
            {pts.map((p) => (
              <circle key={p.n} cx={x(p.n)} cy={y(p.m)} r={1.6} fill="currentColor" opacity={p.n < band.nMin ? 0.5 : 0.9} />
            ))}
            {last && last.lo !== null && last.hi !== null ? <line x1={x(last.n)} x2={x(last.n)} y1={y(last.hi)} y2={y(last.lo)} stroke="currentColor" strokeWidth={2} strokeLinecap="round" /> : null}
            {last ? <circle data-head cx={x(last.n)} cy={y(last.m)} r={3.2} fill="currentColor" style={{ transformBox: "fill-box", transformOrigin: "center" }} /> : null}
          </g>
          {stop ? (
            <g data-decision className={DECISION_WORD[stop.decision].tone} style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}>
              <line x1={x(stop.n)} x2={x(stop.n)} y1={M.t} y2={H - M.b} stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2" />
              <text x={x(stop.n) > W - 80 ? x(stop.n) - 3 : x(stop.n) + 3} y={x(stop.n) > W - 80 ? M.t + 20 : M.t + 8} fill="currentColor" style={{ fontSize: 9, fontWeight: 600 }} textAnchor={x(stop.n) > W - 80 ? "end" : "start"}>
                {stop.n} of {band.nMax}
              </text>
            </g>
          ) : null}
        </g>
      </svg>
      </div>
      <RunWords band={band} run={run} />
    </figure>
  );
}

/** The run's state in one sentence (also the chart's accessible name). */
export function runWords(band: NoisyBand, run: BandRun): string {
  const last = run.points.at(-1);
  if (!last) return "No pairs yet.";
  const stop = runDecision(band, run);
  const ci = last.lo !== null && last.hi !== null ? `CI ${pct(last.lo)} to ${pct(last.hi)}` : "no CI yet";
  if (stop) {
    const what =
      stop.decision === "win"
        ? `the CI cleared the ${pct(band.mde)} threshold`
        : stop.decision === "lose"
          ? "the whole CI is on the worse side"
          : `the CI still straddles the range at the ${band.nMax}-pair cap`;
    return `Decided after ${stop.n} of ${band.nMax} pairs: ${DECISION_WORD[stop.decision].label}. Estimate ${pct(last.m)}, ${ci}: ${what}.`;
  }
  if (last.n < band.nMin) return `Pair ${last.n} of up to ${band.nMax}: no decision before pair ${band.nMin}. Estimate ${pct(last.m)}${last.lo !== null ? `, ${ci} (for orientation)` : ""}.`;
  return `Pair ${last.n} of up to ${band.nMax}: estimate ${pct(last.m)}, ${ci}. A win needs the CI's low end above ${pct(band.mde)}, a loss its high end below 0.`;
}

function RunWords({ band, run }: { band: NoisyBand; run: BandRun }) {
  const stop = runDecision(band, run);
  const last = run.points.at(-1);
  return (
    <p className="flex items-start gap-1 text-xs" aria-live="polite">
      {stop ? <Icon name={DECISION_WORD[stop.decision].icon} className={cn("mt-0.5 size-3.5 shrink-0", DECISION_WORD[stop.decision].tone)} aria-hidden /> : null}
      <span className={cn(stop ? "font-medium" : "text-muted-foreground")}>
        {stop ? (
          <>
            Decided after {stop.n} of {band.nMax} pairs: <span className={DECISION_WORD[stop.decision].tone}>{DECISION_WORD[stop.decision].label}</span>
            {last && last.lo !== null && last.hi !== null ? <span className="font-normal text-muted-foreground"> · CI {pct(last.lo)} to {pct(last.hi)}</span> : null}
          </>
        ) : (
          runWords(band, run)
        )}
      </span>
    </p>
  );
}

// ---------------------------------------------------------- deterministic

function DeterministicView({ band, metric }: { band: DeterministicBand; metric: MetricInfo }) {
  const tol = band.tolerance;
  const e = band.effect;
  const span = Math.max(Math.abs(e ?? 0) * 1.3, tol * 3, 0.01);
  const x = (v: number) => 10 + ((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * 300;
  const decision: BandDecision = e === null ? "continue" : e > tol ? "win" : e < -tol ? "lose" : "inconclusive";
  const words =
    e === null
      ? band.best
        ? "One run of best done; running the candidate."
        : "Running best, then the candidate (one run each)."
      : `${pct(e, 2)} ${decision === "win" ? `is better than the ${magnitudePct(tol)} tolerance: win` : decision === "lose" ? `is worse than the ${magnitudePct(tol)} tolerance: lose` : `is within the ${magnitudePct(tol)} tolerance: inconclusive`}.`;
  return (
    <figure className="space-y-1">
      <svg viewBox="0 0 320 54" className="h-14 w-full" role="img" aria-label={words} preserveAspectRatio="none">
        <rect className="text-destructive" fill="currentColor" fillOpacity={0.08} x={10} y={8} width={x(-tol) - 10} height={24} />
        <rect className="text-muted-foreground" fill="currentColor" fillOpacity={0.12} x={x(-tol)} y={8} width={Math.max(1, x(tol) - x(-tol))} height={24} />
        <rect className="text-success" fill="currentColor" fillOpacity={0.1} x={x(tol)} y={8} width={310 - x(tol)} height={24} />
        <line x1={x(0)} x2={x(0)} y1={4} y2={36} className="text-foreground" stroke="currentColor" strokeOpacity={0.5} />
        {e !== null ? <path d={`M${x(e)},11 l7,9 l-7,9 l-7,-9 Z`} className={decision === "win" ? "text-success" : decision === "lose" ? "text-destructive" : "text-foreground"} fill="currentColor" /> : null}
        <g className="fill-muted-foreground" style={{ fontSize: 9 }}>
          <text x={12} y={46}>
            lose
          </text>
          <text x={x(0)} y={46} textAnchor="middle">
            ±{magnitudePct(tol)}
          </text>
          <text x={308} y={46} textAnchor="end">
            win
          </text>
        </g>
      </svg>
      <p className="text-xs text-muted-foreground">
        {words}
        {band.best && band.value ? ` ${band.best.v.toLocaleString("en-US")} → ${band.value.v.toLocaleString("en-US")}${metric.unit ? ` ${metric.unit}` : ""}.` : ""}
      </p>
    </figure>
  );
}

// -------------------------------------------------------------- expensive

function ExpensiveView({ band, compact }: { band: ExpensiveBand; compact: boolean }) {
  const thr = expensiveThresholds(band);
  const vals = [...band.baseline, band.screen?.m ?? 0, ...band.confirm.map((p) => p.m), thr.screen * 1.4, -thr.screen * 1.4];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 0.01;
  const y = (v: number) => 10 + ((hi + pad - v) / (hi - lo + 2 * pad)) * 110;
  const cols = 2 + band.k;
  const x = (i: number) => 46 + (i + 0.5) * ((310 - 46) / cols);
  const mean = band.confirm.at(-1) ?? null;
  const screenWords = !band.screen
    ? `Screening run pending (baseline: ${band.baseline.length} runs, σ ${magnitudePct(band.sigma)} per run).`
    : band.screen.m > thr.screen
      ? `Screen ${pct(band.screen.m)}: beyond the ±${magnitudePct(thr.screen)} noise band, so ${band.k} confirmation runs.`
      : band.screen.m < -thr.screen
        ? `Screen ${pct(band.screen.m)}: below the noise band: lose.`
        : `Screen ${pct(band.screen.m)}: within the ±${magnitudePct(thr.screen)} noise band: inconclusive.`;
  const confirmWords = mean
    ? `Confirmed mean ${pct(mean.m)} over ${band.confirm.length} of ${band.k} runs${band.confirm.length === band.k ? `: ${mean.m > thr.confirm ? "win" : mean.m < -thr.confirm ? "lose" : "inconclusive"} against ±${magnitudePct(thr.confirm)}` : ""}.`
    : null;
  return (
    <figure className="space-y-1">
      <svg viewBox="0 0 320 140" className={cn("w-full", compact ? "h-28" : "h-36")} role="img" aria-label={`${screenWords} ${confirmWords ?? ""}`} preserveAspectRatio="none">
        {/* The screen's noise band (baseline and screen columns) and the confirmation's tighter one. */}
        <rect className="text-muted-foreground" fill="currentColor" fillOpacity={0.12} x={x(0) - 18} width={x(1) - x(0) + 36} y={y(thr.screen)} height={y(-thr.screen) - y(thr.screen)} />
        <rect className="text-muted-foreground" fill="currentColor" fillOpacity={0.12} x={x(2) - 14} width={x(cols - 1) - x(2) + 28} y={y(thr.confirm)} height={y(-thr.confirm) - y(thr.confirm)} />
        <line x1={40} x2={312} y1={y(0)} y2={y(0)} className="text-foreground" stroke="currentColor" strokeOpacity={0.45} />
        {band.baseline.map((v, i) => (
          <circle key={i} cx={x(0) + ((i % 5) - 2) * 4} cy={y(v)} r={2.2} className="text-muted-foreground" fill="currentColor" />
        ))}
        {band.screen ? <circle cx={x(1)} cy={y(band.screen.m)} r={3.5} className={band.screen.m > thr.screen ? "text-success" : band.screen.m < -thr.screen ? "text-destructive" : "text-foreground"} fill="currentColor" /> : null}
        {band.confirm.map((p, i) => (
          <g key={p.n} className="text-success">
            <circle cx={x(2 + i)} cy={y(p.m)} r={3} fill="currentColor" />
            {p.lo !== null && p.hi !== null ? <line x1={x(2 + i)} x2={x(2 + i)} y1={y(p.hi)} y2={y(p.lo)} stroke="currentColor" strokeWidth={1.5} /> : null}
          </g>
        ))}
        <g className="fill-muted-foreground" style={{ fontSize: 9 }}>
          <text x={x(0)} y={134} textAnchor="middle">
            baseline
          </text>
          <text x={x(1)} y={134} textAnchor="middle">
            screen
          </text>
          {Array.from({ length: band.k }, (_, i) => (
            <text key={i} x={x(2 + i)} y={134} textAnchor="middle">
              mean {i + 1}
            </text>
          ))}
          <text x={38} y={y(0) + 3} textAnchor="end">
            0
          </text>
          <text x={38} y={y(thr.screen) + 3} textAnchor="end">
            {pct(thr.screen)}
          </text>
        </g>
      </svg>
      <p className="text-xs text-muted-foreground">{screenWords}</p>
      {confirmWords ? <p className="text-xs text-muted-foreground">{confirmWords}</p> : null}
    </figure>
  );
}

// ------------------------------------------------------------- guardrails

const GUARD_WORD: Record<string, { label: string; icon: string; tone: string }> = {
  ok: { label: "ok", icon: "Check", tone: "text-success" },
  inconclusive: { label: "inconclusive", icon: "AlertTriangle", tone: "text-warning-text" },
  broken: { label: "BROKEN", icon: "X", tone: "text-destructive" },
  missing: { label: "not measured", icon: "Minus", tone: "text-muted-foreground" },
};

function Guardrails({ states, compact }: { states: BandGuardrailState[]; compact: boolean }) {
  if (!states.length) return null;
  return (
    <ul className="space-y-1 border-t border-border pt-2" aria-label="Guardrails">
      {states.map((g) => (
        <GuardrailRow key={g.name} g={g} compact={compact} />
      ))}
    </ul>
  );
}

function GuardrailRow({ g, compact }: { g: BandGuardrailState; compact: boolean }) {
  const w = GUARD_WORD[g.state] ?? GUARD_WORD.missing!;
  const step = g.step;
  const total = g.total;
  const text = step
    ? `${changeWords(step.regression)} than best${rangeWords(step.lo, step.hi) ? ` (${rangeWords(step.lo, step.hi)})` : ""} vs the ${magnitudePct(step.limit, 1)} limit${total ? ` · total ${changeWords(total.regression)} vs ${magnitudePct(total.limit, 1)}` : ""}`
    : "not measured";
  return (
    <li className="grid grid-cols-[minmax(0,6rem)_1fr] items-center gap-x-2 text-xs" aria-label={`Guardrail ${g.name}: ${w.label}${g.final ? "" : " so far"}. ${text}.`}>
      <span className="flex min-w-0 items-center gap-1">
        <Icon name={w.icon} className={cn("size-3 shrink-0", w.tone)} aria-hidden />
        <span className="truncate font-mono">{g.name}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {step ? <LimitBar check={step} label="step" /> : null}
        {total && !compact ? <LimitBar check={total} label="total" /> : null}
        <span className={cn("shrink-0", w.tone)}>
          {w.label}
          {g.final ? "" : " so far"}
        </span>
      </span>
      <span className="col-span-2 truncate text-[11px] text-muted-foreground" title={text}>
        {text}
      </span>
    </li>
  );
}

/** The regression's CI as a bar against its limit (positive = worse, the limit marked). */
function LimitBar({ check, label }: { check: NonNullable<BandGuardrailState["step"]>; label: ReactNode }) {
  const lo = check.lo ?? check.regression;
  const hi = check.hi ?? check.regression;
  const max = Math.max(check.limit * 1.5, hi * 1.1, 0.01);
  const min = Math.min(0, lo * 1.1, -check.limit * 0.25);
  const x = (v: number) => ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100;
  const tone = check.state === "broken" ? "bg-destructive" : check.state === "inconclusive" ? "bg-warning" : "bg-success";
  return (
    <span className="relative inline-flex h-3 w-24 shrink-0 items-center" aria-hidden title={`${label}: CI ${pct(lo)} to ${pct(hi)} (worse is positive) vs the ${magnitudePct(check.limit, 1)} limit`}>
      <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <span className="absolute top-0 h-3 w-px bg-foreground/40" style={{ left: `${x(0)}%` }} />
      <span className="absolute top-0 h-3 w-0.5 bg-destructive" style={{ left: `${x(check.limit)}%` }} />
      <span className={cn("absolute top-1 h-1 rounded-full", tone)} style={{ left: `${x(lo)}%`, width: `${Math.max(2, x(hi) - x(lo))}%` }} />
      <span className="absolute top-0.5 size-2 rounded-full border border-background bg-foreground" style={{ left: `calc(${x(check.regression)}% - 4px)` }} />
    </span>
  );
}

/** Points of a run as text (tests and screen readers). */
export function pointsText(band: NoisyBand, run: BandRun): string[] {
  return run.points.map((p: BandPoint) => `${p.n}:${pointDecision(band, p)}`);
}
