// The Live view: workers picking up ideas, editing, and pushing candidates
// through tests and the bench, with verdicts arriving. Shared by the study
// page's Live tab (wide) and the study thread's Live panel (compact).
// Strictly read only: the only actions open things (a candidate, a worker's
// transcript or thread, the Overview).
import { ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COLUMN_INFO, COLUMNS, PHASE_INFO, PHASE_STEPS, STAGE_LABEL, type Column, type LiveBenchHost, type LiveCard, type LiveFeedItem, type LiveView, type LiveWorker, type Pairs } from "../../live-model.ts";
import { VERDICT } from "../format.ts";
import { EmptyState, ErrorLine, FOCUS_RING, Skeleton, StatePill } from "../ui.tsx";
import { FlipRoot, useFlash, useFlip } from "./motion.tsx";
import { clock, spokenDuration, useLiveStudy, useNow } from "./useLiveStudy.ts";

export type LiveLayout = "wide" | "compact";

export interface LiveStudyProps {
  slug: string;
  layout: LiveLayout;
  /** Open a candidate's detail (Candidates tab). */
  onOpenCandidate: (n: number) => void;
  /** Open the Overview tab (the calm "not running" state points there). */
  onOpenOverview: () => void;
  /** Wide only: open the Live panel beside the study thread. */
  onOpenBeside?: (studyThreadId: string) => void;
  /** Show this worker's transcript first (the panel opened from a worker thread). */
  initialWorker?: number | null;
}

/** Recent verdict cards shown per column. */
const SHOWN = { verdict: 5, promoted: 4 } as const;

export function LiveStudy({ slug, layout, onOpenCandidate, onOpenOverview, onOpenBeside, initialWorker = null }: LiveStudyProps) {
  const live = useLiveStudy(slug);
  const now = useNow(live.offset);
  const [selected, setSelected] = useState<number | null>(initialWorker);
  const v = live.view;
  // The selected worker's thread: kept after the worker leaves, so its transcript stays readable.
  const [selectedThread, setSelectedThread] = useState<{ key: number; threadId: string; title: string } | null>(null);
  useEffect(() => {
    if (selected === null) return setSelectedThread(null);
    const w = v?.workers.find((x) => x.key === selected);
    if (w?.threadId) setSelectedThread({ key: w.key, threadId: w.threadId, title: `#${w.ideaId ?? "?"} ${w.ideaTitle}` });
  }, [selected, v?.workers]);

  if (!v) {
    if (live.error) return <ErrorLine error={live.error.includes("no study named") ? `No study named ${slug}.` : `Couldn't load the live view: ${live.error}`} retry={live.refetch} />;
    return <Skeleton lines={layout === "wide" ? 8 : 5} label="Loading the live view…" />;
  }
  const inFlight = v.cards.some((c) => c.stage !== "decided");
  const quiet = v.state !== "running" && !v.workers.length && !inFlight;
  const compact = layout === "compact";
  const lanes = (
    <WorkerLanes
      workers={v.workers}
      now={now}
      compact={compact}
      selected={selected}
      onSelect={(k) => setSelected((cur) => (cur === k ? null : k))}
      state={v.state}
      transcript={selectedThread ? <Transcript t={selectedThread} gone={!v.workers.some((w) => w.key === selectedThread.key)} onClose={() => setSelected(null)} compact={compact} /> : null}
    />
  );
  return (
    <FlipRoot className={cn("space-y-4", compact && "space-y-3")}>
      <LiveHeader v={v} compact={compact} onOpenBeside={onOpenBeside} />
      {live.error ? <ErrorLine error={`Live updates failed (showing the last data): ${live.error}`} retry={live.refetch} /> : null}
      {quiet ? (
        <CalmState v={v} onOpenOverview={onOpenOverview} onOpenCandidate={onOpenCandidate} now={now} compact={compact} />
      ) : compact ? (
        <div className="space-y-4">
          {lanes}
          <PipelineTrack v={v} now={now} compact onOpenCandidate={onOpenCandidate} />
          <BenchStrip v={v} now={now} compact onOpenCandidate={onOpenCandidate} />
          <IdeaQueue v={v} compact />
          <Feed v={v} compact />
        </div>
      ) : (
        <div className="space-y-5">
          <PipelineTrack v={v} now={now} compact={false} onOpenCandidate={onOpenCandidate} />
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="min-w-0 space-y-4 lg:col-span-2">{lanes}</div>
            <div className="min-w-0 space-y-4">
              <BenchStrip v={v} now={now} compact={false} onOpenCandidate={onOpenCandidate} />
              <IdeaQueue v={v} compact={false} />
              <Feed v={v} compact={false} />
            </div>
          </div>
        </div>
      )}
    </FlipRoot>
  );
}

// ---------------------------------------------------------------- header

function LiveHeader({ v, compact, onOpenBeside }: { v: LiveView; compact: boolean; onOpenBeside?: (threadId: string) => void }) {
  const flash = useFlash(v.best.n);
  const running = v.state === "running";
  return (
    <div className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3 py-2", compact && "px-2.5")}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="relative inline-flex size-2.5 shrink-0" aria-hidden>
            {running ? <span className="absolute inline-flex size-full rounded-full bg-success/70 motion-safe:animate-ping" /> : null}
            <span className={cn("relative inline-flex size-2.5 rounded-full", running ? "bg-success" : "bg-muted-foreground/50")} />
          </span>
          <span>{running ? "Live" : "Not running"}</span>
          {compact ? <span className="truncate text-muted-foreground">{v.slug}</span> : null}
          <StatePill state={v.state} />
        </div>
        <p className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
          {v.statusLine}
        </p>
      </div>
      <div className={cn("text-right", compact && "text-left")}>
        <div className={cn("rounded px-1 text-sm font-semibold tabular-nums transition-colors duration-700", flash && "bg-success/15 text-success")} aria-live="polite">
          {v.best.text ? (
            <>
              <span className="mr-1 text-xs font-normal text-muted-foreground">best vs base</span>
              {v.best.text}
              {flash ? <span className="ml-1 text-xs font-medium">best moved</span> : null}
            </>
          ) : (
            <span className="text-xs font-normal text-muted-foreground">no win yet</span>
          )}
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {v.counts.candidates} of {v.counts.maxCandidates} candidates · {v.counts.workers} worker{v.counts.workers === 1 ? "" : "s"} (up to {v.counts.targetWorkers})
        </div>
      </div>
      {onOpenBeside && v.studyThreadId ? (
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => onOpenBeside(v.studyThreadId!)}>
          <Icon name="PanelRight" className="size-4" aria-hidden />
          Open beside the study thread
        </Button>
      ) : null}
    </div>
  );
}

function SectionTitle({ icon, children, count }: { icon: string; children: ReactNode; count?: number | string }) {
  return (
    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon name={icon} className="size-3.5" aria-hidden />
      {children}
      {count !== undefined ? <span className="font-normal normal-case tracking-normal">({count})</span> : null}
    </h3>
  );
}

// ---------------------------------------------------------- worker lanes

function WorkerLanes({ workers, now, compact, selected, onSelect, state, transcript }: { workers: LiveWorker[]; now: number; compact: boolean; selected: number | null; onSelect: (key: number) => void; state: string; transcript: ReactNode }) {
  return (
    <section className="space-y-2" aria-label="Workers">
      <SectionTitle icon="Bot" count={workers.length}>
        Workers
      </SectionTitle>
      {workers.length ? (
        <ul className="space-y-1.5">
          {workers.map((w) => (
            <li key={w.key}>
              <Lane w={w} now={now} compact={compact} selected={selected === w.key} onSelect={() => onSelect(w.key)} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState className="py-4">{state === "running" ? "No live workers: the next one starts when the bench queue has room." : "No live workers."}</EmptyState>
      )}
      {transcript}
      {workers.length ? <p className="text-xs text-muted-foreground">Select a worker to follow its transcript.</p> : null}
    </section>
  );
}

function Lane({ w, now, compact, selected, onSelect }: { w: LiveWorker; now: number; compact: boolean; selected: boolean; onSelect: () => void }) {
  const info = PHASE_INFO[w.phase];
  const inPhase = now - w.phaseAt;
  const total = now - w.spawnedAt;
  const titleRef = useFlip<HTMLSpanElement>(`idea-${w.ideaId ?? `w${w.key}`}`);
  const flash = useFlash(w.phase, 1200);
  const waitingOn =
    w.candidate !== null && w.candidateStage && w.candidateStage !== "decided"
      ? `c/${w.candidate} ${w.candidateStage === "queued" && w.queuePosition ? `queued, ${ordinal(w.queuePosition)} for the bench` : STAGE_LABEL[w.candidateStage]}`
      : w.candidate !== null
        ? `last: c/${w.candidate}`
        : null;
  const label = `Worker on idea #${w.ideaId ?? "?"}, ${w.ideaTitle}: ${info.label} for ${spokenDuration(inPhase)}, submission ${w.submissions} of ${w.maxSubmissions}${waitingOn ? `, ${waitingOn}` : ""}. ${selected ? "Hide" : "Show"} its transcript.`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-state-hover",
        FOCUS_RING,
        selected ? "border-foreground/60" : "border-border",
        flash && "motion-safe:bg-muted/60",
        compact && "px-2.5 py-1.5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted", w.phase === "measuring" && "bg-success/15 text-success", w.phase === "verdict" && "bg-foreground text-background")} aria-hidden>
          <Icon name={info.icon} className="size-3.5" />
        </span>
        <span ref={titleRef} className="min-w-0 flex-1 truncate text-sm font-medium">
          #{w.ideaId ?? "?"} {w.ideaTitle}
        </span>
        {w.theme && !compact ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{w.theme}</span> : null}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="Time since the worker started">
          {clock(total)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{info.label}</span>
        <span className="tabular-nums">{clock(inPhase)}</span>
        <span aria-hidden>·</span>
        <span>
          submission {w.submissions} of {w.maxSubmissions}
        </span>
        {waitingOn ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{waitingOn}</span>
          </>
        ) : null}
      </div>
      <PhaseSteps phase={w.phase} />
    </button>
  );
}

/** Where the worker is in its loop: a row of segments, the current one marked (and pulsing when motion is allowed). */
function PhaseSteps({ phase }: { phase: LiveWorker["phase"] }) {
  const step = PHASE_INFO[phase].step;
  return (
    <div className="mt-1.5 flex gap-1" aria-hidden>
      {PHASE_STEPS.map((p) => {
        const s = PHASE_INFO[p].step;
        const current = s === step && phase !== "finishing";
        return <span key={p} className={cn("h-1 flex-1 rounded-full", s < step || phase === "finishing" ? "bg-foreground/40" : current ? "bg-foreground motion-safe:animate-pulse" : "bg-muted")} />;
      })}
    </div>
  );
}

function Transcript({ t, gone, onClose, compact }: { t: { key: number; threadId: string; title: string }; gone: boolean; onClose: () => void; compact: boolean }) {
  const nav = useBbNavigate();
  return (
    <section
      aria-label={`Transcript of the worker on idea ${t.title}`}
      className="space-y-1.5 rounded-lg border border-border bg-card p-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Icon name="MessageSquare" className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Transcript · {t.title}</span>
        {gone ? <span className="text-xs text-muted-foreground">worker finished</span> : null}
        <Button size="sm" variant="ghost" onClick={() => nav.toThread(t.threadId)}>
          Open thread
        </Button>
        <Button size="sm" variant="ghost" aria-label="Close the transcript" onClick={onClose}>
          <Icon name="X" className="size-4" aria-hidden />
        </Button>
      </div>
      <div className={cn("min-h-0 overflow-hidden rounded-md border border-border", compact ? "h-[22rem]" : "h-[28rem]")}>
        <ThreadChat key={t.threadId} threadId={t.threadId} variant="timeline" />
      </div>
    </section>
  );
}

// ------------------------------------------------------------- pipeline

function PipelineTrack({ v, now, compact, onOpenCandidate }: { v: LiveView; now: number; compact: boolean; onOpenCandidate: (n: number) => void }) {
  const byColumn = useMemo(() => {
    const m = new Map<Column, LiveCard[]>(COLUMNS.map((c) => [c, []]));
    for (const c of v.cards) m.get(c.column)!.push(c);
    m.set("queue", [...m.get("queue")!].sort((a, b) => v.queue.indexOf(a.n) - v.queue.indexOf(b.n)));
    m.set("verdict", m.get("verdict")!.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, SHOWN.verdict));
    m.set("promoted", m.get("promoted")!.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, SHOWN.promoted));
    return m;
  }, [v.cards, v.queue]);
  return (
    <section className="space-y-2" aria-label="Candidates in the pipeline">
      <SectionTitle icon="Workflow">Pipeline</SectionTitle>
      {compact ? (
        <ol className="space-y-1.5">
          {COLUMNS.map((col) => (
            <li key={col} className="flex items-start gap-2 rounded-md border border-border bg-card px-2 py-1.5" aria-label={`${COLUMN_INFO[col].label}: ${byColumn.get(col)!.length}`}>
              <span className="flex w-20 shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground">
                <Icon name={COLUMN_INFO[col].icon} className="size-3.5" aria-hidden />
                {COLUMN_INFO[col].label}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {byColumn.get(col)!.length ? byColumn.get(col)!.map((c) => <CandidateCard key={c.n} c={c} v={v} now={now} compact onOpen={() => onOpenCandidate(c.n)} />) : <span className="py-0.5 text-xs text-muted-foreground/70">—</span>}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {COLUMNS.map((col, i) => (
            <li key={col} className="flex min-h-[8.5rem] min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card/60 p-2" aria-label={`${COLUMN_INFO[col].label}: ${byColumn.get(col)!.length}`}>
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Icon name={COLUMN_INFO[col].icon} className="size-3.5" aria-hidden />
                {COLUMN_INFO[col].label}
                <span className="ml-auto tabular-nums">{byColumn.get(col)!.length || ""}</span>
                {i < COLUMNS.length - 1 ? <Icon name="ChevronRight" className="size-3 text-muted-foreground/50" aria-hidden /> : null}
              </div>
              {byColumn.get(col)!.map((c) => (
                <CandidateCard key={c.n} c={c} v={v} now={now} compact={false} onOpen={() => onOpenCandidate(c.n)} />
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CandidateCard({ c, v, now, compact, onOpen }: { c: LiveCard; v: LiveView; now: number; compact: boolean; onOpen: () => void }) {
  const ref = useFlip<HTMLButtonElement>(`card-${c.n}`);
  const flash = useFlash(c.verdict, 2200);
  const vd = c.verdict ? (VERDICT[c.verdict] ?? { label: c.verdict, icon: "Circle", tone: "text-muted-foreground" }) : null;
  const elapsed = clock(now - c.stageAt);
  const qpos = c.stage === "queued" ? v.queue.indexOf(c.n) + 1 : 0;
  const detail =
    c.stage === "decided"
      ? c.effectText ?? (c.verdict === "gate_failed" ? "tests failed" : c.verdict === "conflict" ? "conflicts with best" : c.verdict === "rejected" ? "outside the scope" : "")
      : c.stage === "queued"
        ? `${qpos ? `${ordinal(qpos)} in line` : "queued"} · ${elapsed}`
        : c.stage === "measuring" || c.stage === "confirming"
          ? `${c.stage === "confirming" ? "confirming" : "measuring"}${c.pairs ? ` · ${pairsText(c.pairs)}` : ""}`
          : c.stage === "promoting"
            ? "promoting onto best"
            : `${STAGE_LABEL[c.stage]} · ${elapsed}`;
  const label = `c/${c.n}${c.ideaTitle ? `, ${c.ideaTitle}` : ""}: ${vd ? vd.label : STAGE_LABEL[c.stage]}${detail ? `, ${detail}` : ""}. Open the candidate.`;
  if (compact) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={c.ideaTitle}
        className={cn("inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs", FOCUS_RING, flash && "ring-2 ring-foreground/40", c.verdict === "win" && "border-success/60")}
      >
        {vd ? <Icon name={vd.icon} className={cn("size-3", vd.tone)} aria-hidden /> : null}
        <span className="font-mono">c/{c.n}</span>
        <span className="truncate text-muted-foreground">{c.stage === "measuring" || c.stage === "confirming" ? (c.pairs ? pairsText(c.pairs, true) : "") : c.stage === "decided" ? (vd?.label ?? "") : c.stage === "queued" && qpos ? ordinal(qpos) : ""}</span>
        {(c.stage === "measuring" || c.stage === "confirming") && c.pairs ? <PairBar pairs={c.pairs} className="w-10" /> : null}
      </button>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={cn(
        "w-full min-w-0 rounded-md border bg-background px-2 py-1.5 text-left text-xs shadow-sm transition-shadow hover:bg-state-hover",
        FOCUS_RING,
        c.verdict === "win" ? "border-success/60" : "border-border",
        flash && "ring-2 ring-foreground/40",
      )}
    >
      <div className="flex items-center gap-1">
        <span className="font-mono font-medium">c/{c.n}</span>
        {vd ? (
          <span className={cn("ml-auto inline-flex items-center gap-0.5 font-medium", vd.tone)}>
            <Icon name={vd.icon} className="size-3" aria-hidden />
            {vd.label}
          </span>
        ) : c.rebases ? (
          <span className="ml-auto text-muted-foreground">rebased</span>
        ) : null}
      </div>
      <div className="truncate text-muted-foreground" title={c.ideaTitle}>
        {c.ideaTitle || "—"}
      </div>
      {(c.stage === "measuring" || c.stage === "confirming") && c.pairs ? <PairBar pairs={c.pairs} className="mt-1" /> : null}
      <div className={cn("mt-0.5 truncate tabular-nums", c.verdict === "win" ? "text-success" : "text-muted-foreground")}>{detail}</div>
    </button>
  );
}

function pairsText(p: Pairs, short = false): string {
  const of = p.of > 1 ? (short ? `/${p.of}` : ` of up to ${p.of}`) : "";
  return short ? `${p.done}${of}` : `${p.run === "confirm" ? "confirmation " : ""}pair ${p.done}${of}`;
}

function PairBar({ pairs, className }: { pairs: Pairs; className?: string }) {
  const pct = pairs.of > 0 ? Math.min(100, (pairs.done / pairs.of) * 100) : 0;
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", pairs.run === "confirm" ? "bg-success" : "bg-foreground/70")} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- bench

function BenchStrip({ v, now, compact, onOpenCandidate }: { v: LiveView; now: number; compact: boolean; onOpenCandidate: (n: number) => void }) {
  return (
    <section className="space-y-2" aria-label="Bench">
      <SectionTitle icon="ChartColumn" count={v.bench.length}>
        Bench
      </SectionTitle>
      {v.bench.length ? (
        <ul className="space-y-1.5">
          {v.bench.map((h) => (
            <li key={h.hostId}>
              <BenchHost h={h} now={now} compact={compact} onOpenCandidate={onOpenCandidate} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState className="py-4">Bench hosts appear once the spec is approved.</EmptyState>
      )}
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span>Queue{v.bench.length > 1 ? " (shared)" : ""}:</span>
        {v.queue.length ? (
          v.queue.map((n, i) => (
            <button key={n} type="button" className={cn("rounded border border-border bg-background px-1 font-mono text-foreground", FOCUS_RING)} onClick={() => onOpenCandidate(n)} aria-label={`c/${n}, ${ordinal(i + 1)} in the bench queue. Open the candidate.`}>
              c/{n}
            </button>
          ))
        ) : (
          <span>empty</span>
        )}
      </div>
    </section>
  );
}

function BenchHost({ h, now, compact, onOpenCandidate }: { h: LiveBenchHost; now: number; compact: boolean; onOpenCandidate: (n: number) => void }) {
  const cur = h.current;
  const health = h.status === "offline" ? "offline" : h.deferredUntil ? "waiting for the machine to calm down" : h.healthOk === false ? "unhealthy" : h.healthOk ? "healthy" : "not checked yet";
  return (
    <div className={cn("rounded-lg border border-border bg-card px-3 py-2", compact && "px-2.5")}>
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
        <span className={cn("text-xs", h.status === "offline" || h.healthOk === false ? "text-warning-text" : "text-muted-foreground")}>{health}</span>
      </div>
      {cur?.kind === "measure" ? (
        <div className="mt-1 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <button type="button" className={cn("rounded font-mono font-medium underline-offset-2 hover:underline", FOCUS_RING)} onClick={() => onOpenCandidate(cur.n)}>
              c/{cur.n}
            </button>
            <span className="text-muted-foreground">{cur.stage === "confirming" ? "confirming" : cur.stage === "promoting" ? "promoting" : "measuring"}</span>
            {cur.pairs ? <span className="tabular-nums text-muted-foreground">{pairsText(cur.pairs)}</span> : null}
            <span className="ml-auto tabular-nums text-muted-foreground">{clock(now - cur.startedAt)}</span>
          </div>
          {cur.pairs ? <PairBar pairs={cur.pairs} /> : null}
        </div>
      ) : cur?.kind === "drift" ? (
        <div className="mt-1 text-xs text-muted-foreground">Drift check (A/A on best){cur.startedAt ? ` · ${clock(now - cur.startedAt)}` : ""}</div>
      ) : (
        <div className="mt-1 text-xs text-muted-foreground">Idle</div>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-foreground/40 transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${Math.round((h.utilization ?? 0) * 100)}%` }} />
        </div>
        <span className="tabular-nums">{h.utilization === null ? "busy —" : `busy ${Math.round(h.utilization * 100)}% of the last ${Math.max(1, Math.round(h.windowSeconds / 60))} min`}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ idea queue

function IdeaQueue({ v, compact }: { v: LiveView; compact: boolean }) {
  return (
    <section className="space-y-2" aria-label="Up next">
      <SectionTitle icon="ListTodo" count={v.ideas.total}>
        Up next
      </SectionTitle>
      {v.ideas.next.length ? (
        <ol className="space-y-1">
          {v.ideas.next.map((i) => (
            <IdeaChip key={i.id} idea={i} compact={compact} />
          ))}
          {v.ideas.total > v.ideas.next.length ? <li className="px-1 text-xs text-muted-foreground">and {v.ideas.total - v.ideas.next.length} more</li> : null}
        </ol>
      ) : (
        <EmptyState className="py-3 text-xs">No queued ideas: the strategist adds more when the queue runs low.</EmptyState>
      )}
    </section>
  );
}

function IdeaChip({ idea, compact }: { idea: LiveView["ideas"]["next"][number]; compact: boolean }) {
  const ref = useFlip<HTMLLIElement>(`idea-${idea.id}`);
  return (
    <li ref={ref} className={cn("flex min-w-0 items-center gap-2 rounded-md border border-dashed border-border bg-card px-2 py-1 text-xs", compact && "py-0.5")}>
      {idea.pinned ? <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" aria-label="pinned" /> : null}
      <span className="min-w-0 flex-1 truncate">
        #{idea.id} {idea.title}
      </span>
      {idea.theme ? <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{idea.theme}</span> : null}
    </li>
  );
}

// ------------------------------------------------------------------ feed

interface FeedGroup {
  key: string;
  candidate: number | null;
  items: LiveFeedItem[];
  last: number;
}

/** Group feed lines by candidate; groups ordered by their latest line, so the newest activity is at the bottom. */
export function groupFeed(feed: readonly LiveFeedItem[]): FeedGroup[] {
  const groups = new Map<string, FeedGroup>();
  for (const f of feed) {
    const key = f.candidate !== null ? `c${f.candidate}` : `e${f.id}`;
    const g = groups.get(key) ?? { key, candidate: f.candidate, items: [], last: 0 };
    g.items.push(f);
    g.last = Math.max(g.last, f.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.last - b.last);
}

const TONE: Record<LiveFeedItem["tone"], { icon: string; className: string }> = {
  win: { icon: "Check", className: "text-success" },
  best: { icon: "Star", className: "text-success" },
  lose: { icon: "X", className: "text-destructive" },
  warn: { icon: "AlertTriangle", className: "text-warning-text" },
  info: { icon: "Circle", className: "text-muted-foreground" },
};

function Feed({ v, compact }: { v: LiveView; compact: boolean }) {
  const groups = useMemo(() => groupFeed(v.feed).slice(-14), [v.feed]);
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const titles = useMemo(() => new Map(v.cards.map((c) => [c.n, c.ideaTitle] as const)), [v.cards]);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [v.feed]);
  return (
    <section className="space-y-2" aria-label="What just happened">
      <SectionTitle icon="Activity">What just happened</SectionTitle>
      <div
        ref={box}
        role="log"
        aria-live="off"
        aria-label="Event feed, grouped by candidate"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={cn("space-y-1.5 overflow-y-auto rounded-lg border border-border bg-card p-2", FOCUS_RING, compact ? "max-h-64" : "max-h-80")}
      >
        {groups.length ? (
          groups.map((g) => (
            <div key={g.key} className="text-xs">
              {g.candidate !== null ? (
                <div className="truncate font-medium">
                  <span className="font-mono">c/{g.candidate}</span>
                  {titles.get(g.candidate) ? <span className="font-normal text-muted-foreground"> · {titles.get(g.candidate)}</span> : null}
                </div>
              ) : null}
              <ul className={cn(g.candidate !== null && "ml-2 border-l border-border pl-2")}>
                {g.items.map((f) => (
                  <li key={f.id} className="flex items-start gap-1.5">
                    <time className="shrink-0 tabular-nums text-muted-foreground" dateTime={new Date(f.at).toISOString()}>
                      {hhmm(f.at)}
                    </time>
                    <Icon name={TONE[f.tone].icon} className={cn("mt-0.5 size-3 shrink-0", TONE[f.tone].className)} aria-hidden />
                    <span className="min-w-0">{g.candidate !== null ? f.text.replace(new RegExp(`^c/${g.candidate}:? `, "u"), "") : f.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="py-2 text-center text-muted-foreground">Nothing yet: submissions, test results and verdicts show up here.</p>
        )}
      </div>
    </section>
  );
}

// ----------------------------------------------------------- calm state

function CalmState({ v, onOpenOverview, onOpenCandidate, now, compact }: { v: LiveView; onOpenOverview: () => void; onOpenCandidate: (n: number) => void; now: number; compact: boolean }) {
  const recent = [...v.cards].filter((c) => c.stage === "decided").sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, compact ? 4 : 6);
  const why =
    v.state === "paused"
      ? "The study is paused: no worker is running and nothing is on the bench."
      : v.state === "draft" || v.state === "calibrating"
        ? "The study hasn't started yet. Workers, candidates and the bench show up here once it runs."
        : v.state === "harvesting"
          ? "The study is harvesting its wins into PRs; no worker is running."
          : v.state === "archived"
            ? "The study is archived."
            : "Nothing is running right now.";
  return (
    <div className="space-y-3">
      <EmptyState className="space-y-2 py-6">
        <p>{why}</p>
        <Button size="sm" variant="outline" onClick={onOpenOverview}>
          Open the Overview
        </Button>
      </EmptyState>
      {recent.length ? (
        <section className="space-y-2" aria-label="Last verdicts">
          <SectionTitle icon="Target">Last verdicts</SectionTitle>
          <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-2 md:grid-cols-3")}>
            {recent.map((c) => (
              <CandidateCard key={c.n} c={c} v={v} now={now} compact={false} onOpen={() => onOpenCandidate(c.n)} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- helpers

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
