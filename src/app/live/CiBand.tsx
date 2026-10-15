// The live CI band of a measurement: the estimate and its confidence
// interval narrowing pair by pair against the zero line and the win
// threshold, with the sequential test's regions shaded (lose, continue,
// win), the zone before n_min hatched, and the moment it stopped marked
// ("decided after 9 of 20 pairs"). The confirmation is a second phase.
// Deterministic measurements show the run against the tolerance; expensive
// ones the runs against the calibrated σ band. Guardrails sit underneath,
// compactly: the step against its limit and the total against its own.
// Every state is also in words; color is never the only signal.
import { useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { bandGuardrails, expensiveThresholds, pointDecision, runDecision, type BandDecision, type BandGuardrailState, type BandPoint, type BandRun, type DeterministicBand, type ExpensiveBand, type MeasureBand, type NoisyBand } from "../../band.ts";
import { limitCheckWords } from "../../guardrails.ts";
import type { LiveCard } from "../../live-model.ts";
import { layoutLabels } from "../../chart.ts";
import { magnitudePct, signedPct, type MetricInfo } from "../../present.ts";
import { animateIf, useMotionGate } from "./motion.tsx";
import { useBoxWidth } from "../useBoxWidth.ts";

const DECISION_WORD: Record<Exclude<BandDecision, "continue">, { label: string; icon: string; tone: string }> = {
  win: { label: "win", icon: "Check", tone: "text-success" },
  lose: { label: "lose", icon: "X", tone: "text-destructive" },
  inconclusive: { label: "inconclusive", icon: "Minus", tone: "text-muted-foreground" },
};

const pct = (f: number, digits = 1) => signedPct(f, digits);

export interface MeasurementProps {
  band: MeasureBand;
  /** What the band needs of the candidate (the Live view passes its card; the candidate detail its own fields). */
  card: (Pick<LiveCard, "stage" | "verdict" | "cause" | "ideaTitle"> & Partial<Pick<LiveCard, "pairs">>) | null;
  /** Without the "c/N · idea" header (the candidate detail already shows it). */
  bare?: boolean;
  hostName: string | null;
  metric: MetricInfo;
  compact: boolean;
  onOpenCandidate: (n: number) => void;
}

/** One measurement: its title, chart(s), the decision in words, and the guardrails. */
export function Measurement({ band, card, hostName, metric, compact, onOpenCandidate, bare = false }: MeasurementProps) {
  const decided = band.final !== null;
  const stage = card?.stage === "confirming" ? "confirming" : card?.stage === "promoting" ? "promoting" : decided ? "measured" : "measuring";
  return (
    <article className={cn("min-w-0 space-y-2 rounded-lg border border-border bg-card p-3", compact && "p-2.5")} aria-label={`CI band of c/${band.n}`} data-band={band.n}>
      {bare ? (
        <p className="text-xs text-muted-foreground">
          {stage}
          {hostName ? ` on ${hostName}` : ""} · {band.kind === "deterministic" ? "deterministic, single run" : band.kind}
        </p>
      ) : (
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <button type="button" className="rounded font-mono font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenCandidate(band.n)}>
          c/{band.n}
        </button>
        {card?.ideaTitle ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{card.ideaTitle}</span> : <span className="flex-1" />}
        <span className="text-xs text-muted-foreground">
          {stage}
          {hostName ? ` on ${hostName}` : ""} · {band.kind === "deterministic" ? "deterministic, single run" : band.kind}
        </span>
      </header>
      )}
      {band.kind === "noisy" ? <NoisyBandView band={band} compact={compact} confirming={card?.stage === "confirming" && card.pairs?.run === "confirm"} /> : band.kind === "deterministic" ? <DeterministicView band={band} metric={metric} /> : <ExpensiveView band={band} compact={compact} />}
      <Guardrails states={bandGuardrails(band)} compact={compact} />
      {card?.stage === "decided" && card.cause ? (
        // The band shows the primary metric's test; when something else decided the verdict (a guardrail), say so.
        <p className="flex items-start gap-1 text-xs font-medium text-destructive">
          <Icon name="X" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Verdict: {card.verdict === "lose" ? "lose" : (card.verdict ?? "decided").replace("_", " ")} · {card.cause}
          </span>
        </p>
      ) : null}
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

function NoisyBandView({ band, compact, confirming = false }: { band: NoisyBand; compact: boolean; confirming?: boolean }) {
  const domain = useMemo(() => domainOf(band), [band]);
  const measure = band.runs.find((r) => r.run === "measure" && r.points.length);
  const confirm = band.runs.find((r) => r.run === "confirm" && r.points.length);
  // The confirmation started (its progress says so) but its first pair isn't done: keep its panel's place.
  const confirmStarted = band.runs.some((r) => r.run === "confirm") || (confirming && !band.final);
  if (!measure) return <BandPlaceholder text={noisyPlaceholder(band, "measure")} />;
  return (
    <div className={cn("grid gap-3", (confirm || confirmStarted) && !compact ? "grid-cols-2" : "grid-cols-1")}>
      {measure ? <RunPanel band={band} run={measure} domain={domain} title={confirm ? "Measurement" : null} compact={compact} /> : null}
      {confirm ? <RunPanel band={band} run={confirm} domain={domain} title="Confirmation · fresh pairs" compact={compact} /> : confirmStarted ? <BandPlaceholder text={noisyPlaceholder(band, "confirm")} /> : null}
      {!band.exact ? <p className="text-[11px] text-muted-foreground">Recomputed from the samples (this measurement predates stored bands): the CI can differ slightly from the verdict's.</p> : null}
    </div>
  );
}

/** Margins: the region labels (win, continue, lose) sit in the right margin, outside the plot, so they never cover the band or the decision line. */
const M = { l: 40, r: 52, t: 12, b: 20 };

/** What a noisy band shows before its first pair is done (no point to draw yet). */
export function noisyPlaceholder(band: Pick<NoisyBand, "nMax">, run: "measure" | "confirm"): string {
  return run === "confirm"
    ? `Confirmation: running its first fresh pair (best and the candidate, in random order); its band starts once that pair is done.`
    : `Running best and the candidate for the first pair (in random order) of up to ${band.nMax}; the band starts once that pair is done.`;
}

/** A band's space while there is nothing to draw yet: keeps the card's height and says what runs. */
function BandPlaceholder({ text }: { text: string }) {
  return (
    <div className="flex min-h-[6rem] items-center gap-2 rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground" role="status" data-band-placeholder>
      <Icon name="Clock" className="size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
/** Pixel font size of chart text (charts draw in pixels, so text never scales with the width). */
const FONT = 9;
/** Minimum distance between two stacked labels. */
const LABEL_GAP = 11;

export interface BandLabels {
  /** Y-axis tick labels: 0, the win threshold, and the domain's ends when they fit. */
  axis: Array<{ key: string; y: number; text: string }>;
  /** Region labels in the right margin. */
  regions: Array<{ key: "win" | "continue" | "lose"; y: number }>;
}

/**
 * Where a noisy band's text goes, without overlaps (chart.ts layoutLabels):
 * axis ticks on the left (0 and the threshold first; the domain's ends only
 * where they fit) and the region names in the right margin, each near the
 * middle of its region. `y` maps a value to pixels; `top`/`bottom` bound the plot.
 */
export function bandLabels(domain: [number, number], mde: number, y: (v: number) => number, top: number, bottom: number): BandLabels {
  const [yMin, yMax] = domain;
  const axisItems = [
    { key: "zero", at: y(0), priority: 3, maxShift: 0, text: "0" },
    { key: "mde", at: y(mde), priority: 2, maxShift: LABEL_GAP, text: pct(mde) },
    { key: "max", at: top + 4, priority: 1, maxShift: 0, text: pct(yMax, 0) },
    { key: "min", at: bottom - 3, priority: 1, maxShift: 0, text: pct(yMin, 0) },
  ];
  const axis = layoutLabels(axisItems, { gap: LABEL_GAP, min: top + 3, max: bottom - 2 }).map((p) => ({ key: p.key, y: p.at, text: axisItems.find((i) => i.key === p.key)!.text }));
  const mid = (a: number, b: number) => (y(a) + y(b)) / 2;
  const regionItems = [
    { key: "win" as const, at: mid(Math.max(mde, yMin), yMax), priority: 3, maxShift: Math.max(LABEL_GAP, (y(mde) - y(yMax)) / 2) },
    { key: "lose" as const, at: mid(yMin, Math.min(0, yMax)), priority: 2, maxShift: Math.max(LABEL_GAP, (y(yMin) - y(0)) / 2) },
    { key: "continue" as const, at: mid(0, mde), priority: 1, maxShift: Math.max(0, (y(0) - y(mde)) / 2 - 2) },
  ];
  const regions = layoutLabels(regionItems, { gap: LABEL_GAP, min: top + 4, max: bottom - 2 }).map((p) => ({ key: p.key as BandLabels["regions"][number]["key"], y: p.at }));
  return { axis, regions };
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
  // The last CI drawn: an early lose shows the stricter CI it was decided on.
  const whisker = last && stop?.reason === "early" && last.early ? last.early : last && last.lo !== null && last.hi !== null ? { lo: last.lo, hi: last.hi } : null;
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
  const labels = bandLabels(domain, band.mde, y, M.t, H - M.b);
  // Pair numbers: 1, n_min and n_max, minus any that would collide.
  const xTicks = [...new Set([1, band.nMin, band.nMax])].filter((n, i, all) => i === 0 || n === band.nMax || all.every((m) => m === n || Math.abs(x(m) - x(n)) >= 16));
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
          {/* Region names in the right margin, outside the plot (never over the band or the decision line). */}
          <g className="fill-muted-foreground" style={{ fontSize: FONT }} data-region-labels>
            {labels.regions.map((r) => (
              <text key={r.key} data-label={r.key} x={W - M.r + 4} y={r.y + 3} textAnchor="start" className={r.key === "win" ? "fill-success" : r.key === "lose" ? "fill-destructive" : undefined}>
                {r.key}
              </text>
            ))}
          </g>
          {/* Zero and the win threshold. */}
          <line x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} className="text-foreground" stroke="currentColor" strokeOpacity={0.45} strokeWidth={1} />
          <line x1={M.l} x2={W - M.r} y1={y(band.mde)} y2={y(band.mde)} className="text-success" stroke="currentColor" strokeDasharray="4 3" strokeWidth={1} />
          {/* Axes. */}
          <g className="fill-muted-foreground" style={{ fontSize: FONT }} data-axis-labels>
            {labels.axis.map((a) => (
              <text key={a.key} data-label={a.key} x={M.l - 4} y={a.y + 3} textAnchor="end">
                {a.text}
              </text>
            ))}
            {xTicks.map((n) => (
              <text key={n} x={x(n)} y={H - 6} textAnchor="middle">
                {n}
              </text>
            ))}
            <text x={W - M.r + 4} y={H - 6} textAnchor="start" opacity={0.7}>
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
            {whisker ? <line data-whisker={stop?.reason === "early" ? "early" : undefined} x1={x(last!.n)} x2={x(last!.n)} y1={y(whisker.hi)} y2={y(whisker.lo)} stroke="currentColor" strokeWidth={2} strokeLinecap="round" /> : null}
            {last ? <circle data-head cx={x(last.n)} cy={y(last.m)} r={3.2} fill="currentColor" style={{ transformBox: "fill-box", transformOrigin: "center" }} /> : null}
          </g>
          {stop ? (
            <g data-decision className={DECISION_WORD[stop.decision].tone} style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}>
              <line x1={x(stop.n)} x2={x(stop.n)} y1={M.t} y2={H - M.b} stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2" />
              <text x={x(stop.n) > W - M.r - 50 ? x(stop.n) - 3 : x(stop.n) + 3} y={M.t + 8} fill="currentColor" style={{ fontSize: FONT, fontWeight: 600 }} textAnchor={x(stop.n) > W - M.r - 50 ? "end" : "start"}>
                {stop.n} of {band.nMax}
                {STOP_TAG[stop.reason] ? ` · ${STOP_TAG[stop.reason]}` : ""}
              </text>
            </g>
          ) : null}
        </g>
      </svg>
      </div>
      {labels.regions.length < 3 ? (
        // A region name didn't fit next to its region (the threshold sits next to 0): say the regions in words.
        <p className="text-xs leading-relaxed text-muted-foreground" data-region-legend>
          Regions: <span className="text-destructive">lose</span> below 0 · continue from 0 to {pct(band.mde)} · <span className="text-success">win</span> above {pct(band.mde)}
        </p>
      ) : null}
      <RunWords band={band} run={run} />
    </figure>
  );
}

/** A short tag on the decision marker when the stop wasn't the plain rule. */
const STOP_TAG: Record<string, string> = { futility: "can't win", early: "early" };

/** The decision's CI at a point: the stricter early-lose CI for an early stop. */
function stopCi(band: NoisyBand, p: BandPoint, reason: string | null): string {
  if (reason === "early" && p.early) return `CI ${pct(p.early.lo)} to ${pct(p.early.hi)} at ${Math.round((band.earlyLoseConfidence ?? 0.99) * 1000) / 10}%`;
  return p.lo !== null && p.hi !== null ? `CI ${pct(p.lo)} to ${pct(p.hi)}` : "no CI yet";
}

/** The run's state in one sentence (also the chart's accessible name). */
export function runWords(band: NoisyBand, run: BandRun): string {
  const last = run.points.at(-1);
  if (!last) return "No pairs yet.";
  const stop = runDecision(band, run);
  const ci = stopCi(band, last, stop?.reason ?? null);
  if (stop) {
    const what =
      stop.reason === "win"
        ? `the CI cleared the ${pct(band.mde)} threshold`
        : stop.reason === "lose"
          ? "the whole CI is on the worse side"
          : stop.reason === "early"
            ? `the whole CI is on the worse side even at the stricter confidence, so it stopped before pair ${band.nMin}`
            : stop.reason === "futility"
              ? `the CI's high end is below the ${pct(band.mde)} threshold, so more pairs can't make it a win (stopped early)`
              : `the CI still straddles the range at the ${band.nMax}-pair cap`;
    return `Decided after ${stop.n} of ${band.nMax} pairs: ${DECISION_WORD[stop.decision].label}. Estimate ${pct(last.m)}, ${ci}: ${what}.`;
  }
  if (last.n < band.nMin) {
    const head = band.earlyLoseFrom ? `no win before pair ${band.nMin}; only a clear loss (a CI entirely below 0 at ${Math.round((band.earlyLoseConfidence ?? 0.99) * 1000) / 10}%) stops it sooner` : `no decision before pair ${band.nMin}`;
    return `Pair ${last.n} of up to ${band.nMax}: ${head}. Estimate ${pct(last.m)}${last.lo !== null ? `, CI ${pct(last.lo)} to ${pct(last.hi ?? last.lo)} (for orientation)` : ""}.`;
  }
  return `Pair ${last.n} of up to ${band.nMax}: estimate ${pct(last.m)}, ${ci}. A win needs the CI's low end above ${pct(band.mde)}, a loss its high end below 0${band.futility ? `; a high end below ${pct(band.mde)} stops it as inconclusive` : ""}.`;
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
            {stop.reason === "futility" ? <span className="font-normal"> (futility: CI upper bound below the win threshold)</span> : stop.reason === "early" ? <span className="font-normal"> (early: clearly worse)</span> : null}
            {last ? <span className="font-normal text-muted-foreground"> · {stopCi(band, last, stop.reason)}</span> : null}
          </>
        ) : (
          runWords(band, run)
        )}
      </span>
    </p>
  );
}

// ---------------------------------------------------------- deterministic

/**
 * A deterministic measurement in one sentence: one run of best and one of
 * the candidate, no spread, so no CI; the single value against the tolerance.
 */
export function deterministicWords(band: Pick<DeterministicBand, "tolerance" | "effect" | "best">): string {
  const tol = band.tolerance;
  const e = band.effect;
  if (e === null) return band.best ? "Single run: best done, running the candidate." : "Single run: running best, then the candidate (one run each, no spread).";
  const decision = e > tol ? "win" : e < -tol ? "lose" : "inconclusive";
  const value = `Single run: ${pct(e, 2)} vs best`;
  if (tol <= 0) return `${value}: ${decision === "win" ? "better, so a win" : decision === "lose" ? "worse, so a loss" : "no change, inconclusive"} (no tolerance).`;
  return `${value}, ${decision === "win" ? `better by more than the ${magnitudePct(tol)} tolerance: win` : decision === "lose" ? `worse by more than the ${magnitudePct(tol)} tolerance: lose` : `within the ±${magnitudePct(tol)} tolerance: inconclusive`}.`;
}

function DeterministicView({ band, metric }: { band: DeterministicBand; metric: MetricInfo }) {
  const tol = band.tolerance;
  const e = band.effect;
  const span = Math.max(Math.abs(e ?? 0) * 1.3, tol * 3, 0.01);
  const x = (v: number) => 10 + ((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * 300;
  const decision: BandDecision = e === null ? "continue" : e > tol ? "win" : e < -tol ? "lose" : "inconclusive";
  const words = deterministicWords(band);
  return (
    <figure className="space-y-1">
      <svg viewBox="0 0 320 40" className="h-10 w-full" role="img" aria-label={words} preserveAspectRatio="none">
        <rect className="text-destructive" fill="currentColor" fillOpacity={0.08} x={10} y={8} width={x(-tol) - 10} height={24} />
        <rect className="text-muted-foreground" fill="currentColor" fillOpacity={0.12} x={x(-tol)} y={8} width={Math.max(1, x(tol) - x(-tol))} height={24} />
        <rect className="text-success" fill="currentColor" fillOpacity={0.1} x={x(tol)} y={8} width={310 - x(tol)} height={24} />
        <line x1={x(0)} x2={x(0)} y1={4} y2={36} className="text-foreground" stroke="currentColor" strokeOpacity={0.5} />
        {e !== null ? <path d={`M${x(e)},11 l7,9 l-7,9 l-7,-9 Z`} className={decision === "win" ? "text-success" : decision === "lose" ? "text-destructive" : "text-foreground"} fill="currentColor" /> : null}
      </svg>
      {/* Labels in HTML: the chart stretches to the card's width, which would stretch SVG text. */}
      <div className="-mt-1 flex justify-between px-[3%] text-[9px] text-muted-foreground" aria-hidden>
        <span>lose</span>
        <span>{tol > 0 ? `±${magnitudePct(tol)}` : "0"}</span>
        <span>win</span>
      </div>
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
  // Drawn in pixels at the box's width (no stretched viewBox), so labels keep their size and shape.
  const [box, W] = useBoxWidth(320);
  const H = compact ? 112 : 144;
  const B = { l: 46, r: 8, t: 10, b: 18 };
  const vals = [...band.baseline, band.screen?.m ?? 0, ...band.confirm.map((p) => p.m), thr.screen * 1.4, -thr.screen * 1.4];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 0.01;
  const y = (v: number) => B.t + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - B.t - B.b);
  const cols = 2 + band.k;
  const colW = (W - B.l - B.r) / cols;
  const x = (i: number) => B.l + (i + 0.5) * colW;
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
  // Column labels shorten when columns get narrow ("mean 3" → "3"); y labels never overlap (0 wins).
  const narrow = colW < 44;
  const yLabels = layoutLabels(
    [
      { key: "zero", at: y(0), priority: 2, maxShift: 0 },
      { key: "screen", at: y(thr.screen), priority: 1, maxShift: 0 },
    ],
    { gap: LABEL_GAP, min: B.t, max: H - B.b },
  );
  const half = Math.min(18, colW / 2 - 2);
  return (
    <figure className="space-y-1">
      <div ref={box} className="w-full">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${screenWords} ${confirmWords ?? ""}`}>
          {/* The screen's noise band (baseline and screen columns) and the confirmation's tighter one. */}
          <rect className="text-muted-foreground" fill="currentColor" fillOpacity={0.12} x={x(0) - half} width={x(1) - x(0) + 2 * half} y={y(thr.screen)} height={y(-thr.screen) - y(thr.screen)} />
          <rect className="text-muted-foreground" fill="currentColor" fillOpacity={0.12} x={x(2) - half} width={x(cols - 1) - x(2) + 2 * half} y={y(thr.confirm)} height={y(-thr.confirm) - y(thr.confirm)} />
          <line x1={B.l - 6} x2={W - B.r} y1={y(0)} y2={y(0)} className="text-foreground" stroke="currentColor" strokeOpacity={0.45} />
          {band.baseline.map((v, i) => (
            <circle key={i} cx={x(0) + ((i % 5) - 2) * Math.min(4, half / 3)} cy={y(v)} r={2.2} className="text-muted-foreground" fill="currentColor" />
          ))}
          {band.screen ? <circle cx={x(1)} cy={y(band.screen.m)} r={3.5} className={band.screen.m > thr.screen ? "text-success" : band.screen.m < -thr.screen ? "text-destructive" : "text-foreground"} fill="currentColor" /> : null}
          {band.confirm.map((p, i) => (
            <g key={p.n} className="text-success">
              <circle cx={x(2 + i)} cy={y(p.m)} r={3} fill="currentColor" />
              {p.lo !== null && p.hi !== null ? <line x1={x(2 + i)} x2={x(2 + i)} y1={y(p.hi)} y2={y(p.lo)} stroke="currentColor" strokeWidth={1.5} /> : null}
            </g>
          ))}
          <g className="fill-muted-foreground" style={{ fontSize: FONT }}>
            <text x={x(0)} y={H - 5} textAnchor="middle">
              baseline
            </text>
            <text x={x(1)} y={H - 5} textAnchor="middle">
              screen
            </text>
            {Array.from({ length: band.k }, (_, i) => (
              <text key={i} x={x(2 + i)} y={H - 5} textAnchor="middle">
                {narrow ? i + 1 : `mean ${i + 1}`}
              </text>
            ))}
            {yLabels.map((l) => (
              <text key={l.key} x={B.l - 8} y={l.at + 3} textAnchor="end">
                {l.key === "zero" ? "0" : pct(thr.screen)}
              </text>
            ))}
          </g>
        </svg>
      </div>
      <p className="text-xs text-muted-foreground">{screenWords}</p>
      {confirmWords ? <p className="text-xs text-muted-foreground">{confirmWords}</p> : null}
    </figure>
  );
}

// ------------------------------------------------------------- guardrails

const GUARD_WORD: Record<string, { label: string; icon: string; tone: string }> = {
  ok: { label: "ok", icon: "Check", tone: "text-success" },
  inconclusive: { label: "inconclusive", icon: "AlertTriangle", tone: "text-warning-text" },
  broken: { label: "broken", icon: "X", tone: "text-destructive" },
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
  // Plain words (guardrails.ts limitCheckWords): "no change from best (CI …), within the 10.0% limit · in total 2.1% worse than the segment base, within the 15.0% total limit".
  const text = step ? `${limitCheckWords(step, "best")}${total ? ` · in total ${limitCheckWords(total, "the segment base", "total limit")}` : ""}` : "not measured";
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
      {/* Wraps instead of truncating: two bands side by side leave little room, and the limit is the point of the sentence. */}
      <span className="col-span-2 break-words text-sm leading-relaxed text-muted-foreground" data-guardrail-text>
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
    <span className="relative inline-flex h-3 w-24 shrink-0 items-center" aria-hidden title={`${label}: ${Math.abs(hi - lo) < 1e-12 ? `${pct(lo)}, single run` : `CI ${pct(lo)} to ${pct(hi)}`} (worse is positive) vs the ${magnitudePct(check.limit, 1)} limit`}>
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
