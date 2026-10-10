// Replay: the whole Live view of a study at any moment, rebuilt in the app
// from the `study.replay` bundle (events, CI bands, metadata) by the pure
// ReplayModel. A timeline scrubber shows where things happened (event
// density, wins, best moves, pauses, segment and harvest changes), with
// play/pause, speeds (1×, 10×, 60×, 600×), "next win", and the keyboard.
// The position lives in the URL (the page's subPath), so a moment can be
// reopened. Read only.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { nextMilestone, ReplayModel, type Milestone, type ReplayBundle } from "../../replay.ts";
import { useStudyRpc } from "../data.ts";
import { ErrorLine, FOCUS_RING, Skeleton } from "../ui.tsx";
import { LiveBoard, type LiveLayout } from "./LiveStudy.tsx";
import { clock } from "./useLiveStudy.ts";

export const SPEEDS = [1, 10, 60, 600] as const;
export type Speed = (typeof SPEEDS)[number];

/** Board frames at most this often while playing (the scrubber moves every frame). */
const BOARD_EVERY_MS = 120;
/** The URL follows a playing replay this often. */
const URL_EVERY_MS = 2000;

export interface ReplayStudyProps {
  slug: string;
  layout: LiveLayout;
  /** Position: ms since the study's first event (null: the start, playing). */
  at: number | null;
  onMove?: (at: number) => void;
  onExit?: () => void;
  onOpenCandidate: (n: number) => void;
  onOpenOverview: () => void;
  initialWorker?: number | null;
}

export function ReplayStudy(props: ReplayStudyProps) {
  const rpc = useStudyRpc();
  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    rpc.call("study.replay", { slug: props.slug }).then(
      (b) => live && setBundle(b),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [rpc, props.slug, attempt]);
  const model = useMemo(() => (bundle ? new ReplayModel(bundle) : null), [bundle]);
  if (!model) return error ? <ErrorLine error={`Couldn't load the replay: ${error}`} retry={() => setAttempt((a) => a + 1)} /> : <Skeleton lines={props.layout === "wide" ? 8 : 5} label="Loading the replay…" />;
  if (!model.events.length) return <p className="text-sm text-muted-foreground">Nothing to replay yet: this study has no recorded events.</p>;
  return <ReplayPlayer key={bundle!.now} model={model} {...props} onReload={() => setAttempt((a) => a + 1)} />;
}

export function ReplayPlayer({ model, layout, at, onMove, onExit, onOpenCandidate, onOpenOverview, initialWorker = null, onReload }: ReplayStudyProps & { model: ReplayModel; onReload?: () => void }) {
  const span = Math.max(1, model.end - model.start);
  const clampT = useCallback((t: number) => Math.max(model.start, Math.min(model.end, t)), [model]);
  const [t, setT] = useState(() => clampT(model.start + (at ?? 0)));
  const [playing, setPlaying] = useState(at === null);
  const [speed, setSpeed] = useState<Speed>(60);
  const milestones = useMemo(() => model.milestones(), [model]);
  const tRef = useRef(t);
  tRef.current = t;

  // The board follows t at most every BOARD_EVERY_MS while playing (immediately when the event index changes or on a seek).
  const [boardT, setBoardT] = useState(t);
  const boardAt = useRef(0);
  useEffect(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!playing || model.indexAt(t) !== model.indexAt(boardT) || now - boardAt.current >= BOARD_EVERY_MS || t >= model.end) {
      boardAt.current = now;
      setBoardT(t);
    }
  }, [t, playing, model, boardT]);
  const view = useMemo(() => model.viewAt(boardT), [model, boardT]);

  // Playback: time-based, from animation frames, with a slow timer as a fallback for pages that draw no frames.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setT((prev) => {
        const next = Math.min(model.end, prev + dt * speed);
        if (next >= model.end) setPlaying(false);
        return next;
      });
    };
    const loop = () => {
      step();
      raf = requestAnimationFrame(loop);
    };
    if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(loop);
    const timer = setInterval(step, 250);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [playing, speed, model]);

  // The URL follows: on pause and seeks right away, every URL_EVERY_MS while playing.
  const lastUrl = useRef(0);
  const reported = useRef<number | null>(null);
  const report = useCallback(
    (time: number, force = false) => {
      if (!onMove) return;
      const now = Date.now();
      const pos = Math.round(time - model.start);
      if (reported.current === pos || (!force && now - lastUrl.current < URL_EVERY_MS)) return;
      lastUrl.current = now;
      reported.current = pos;
      onMove(pos);
    },
    [onMove, model],
  );
  useEffect(() => {
    report(t, !playing);
  }, [t, playing, report]);

  const seek = useCallback((time: number) => setT(clampT(time)), [clampT]);
  const nextWin = useCallback(() => {
    const at = nextMilestone(milestones, tRef.current + 1, "win");
    if (at !== null) seek(at - Math.min(3000, span / 50));
  }, [milestones, seek, span]);
  const prevWin = useCallback(() => {
    const before = milestones.filter((m) => m.kind === "win" && m.at < tRef.current - 3500);
    if (before.length) seek(before.at(-1)!.at - Math.min(3000, span / 50));
    else seek(model.start);
  }, [milestones, seek, span, model]);

  const togglePlay = () => {
    if (!playing && tRef.current >= model.end) seek(model.start);
    setPlaying(!playing);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const big = e.shiftKey ? span / 10 : span / 100;
    switch (e.key) {
      case " ":
      case "k":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowRight":
        e.preventDefault();
        seek(t + big);
        break;
      case "ArrowLeft":
        e.preventDefault();
        seek(t - big);
        break;
      case "Home":
        e.preventDefault();
        seek(model.start);
        break;
      case "End":
        e.preventDefault();
        seek(model.end);
        break;
      case "n":
        e.preventDefault();
        nextWin();
        break;
      case "p":
        e.preventDefault();
        prevWin();
        break;
      case "1":
      case "2":
      case "3":
      case "4":
        e.preventDefault();
        setSpeed(SPEEDS[Number(e.key) - 1]!);
        break;
      case "Escape":
        if (onExit) {
          e.preventDefault();
          onExit();
        }
        break;
    }
  };

  const wins = milestones.filter((m) => m.kind === "win" && m.at <= t).length;
  const toolbar = (
    <section aria-label="Replay controls" className="space-y-2 rounded-lg border border-border bg-card px-3 py-2" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={togglePlay} aria-label={playing ? "Pause the replay" : "Play the replay"} data-replay-play>
          <Icon name={playing ? "Pause" : "Play"} className="size-4" aria-hidden />
          {playing ? "Pause" : t >= model.end ? "Replay again" : "Play"}
        </Button>
        <div role="radiogroup" aria-label="Replay speed" className="inline-flex overflow-hidden rounded-md border border-border">
          {SPEEDS.map((s, i) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={speed === s}
              aria-label={`${s} times real time (key ${i + 1})`}
              onClick={() => setSpeed(s)}
              className={cn("px-2 py-1 text-xs tabular-nums", FOCUS_RING, speed === s ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-state-hover")}
            >
              {s}×
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={nextWin} disabled={nextMilestone(milestones, t + 1, "win") === null} aria-label="Jump to the next win (key N)">
          <Icon name="Star" className="size-4" aria-hidden />
          Next win
        </Button>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground" aria-live="off">
          <span className="font-medium text-foreground">{clock(t - model.start)}</span> of {clock(span)} · {wallClock(t)} · {wins} win{wins === 1 ? "" : "s"} so far
        </span>
        {model.bundle.state === "running" && onReload ? (
          <Button size="sm" variant="ghost" onClick={onReload} aria-label="Load what happened since this replay was opened">
            <Icon name="Repeat" className="size-4" aria-hidden />
            Update
          </Button>
        ) : null}
        {onExit ? (
          <Button size="sm" variant="outline" onClick={onExit}>
            {model.bundle.state === "running" ? "Back to live" : "Exit replay"}
          </Button>
        ) : null}
      </div>
      <Scrubber model={model} t={t} milestones={milestones} onSeek={seek} onCommit={(x) => report(x, true)} />
      <p className="text-[11px] text-muted-foreground">
        Space play/pause · ←/→ step (Shift: bigger) · Home/End · N/P next/previous win · 1-4 speed. Rebuilt from the study's recorded events; transcripts show their current state.
      </p>
    </section>
  );
  return (
    <LiveBoard
      v={view}
      now={boardT}
      layout={layout}
      mode="replay"
      onOpenCandidate={onOpenCandidate}
      onOpenOverview={onOpenOverview}
      initialWorker={initialWorker}
      toolbar={toolbar}
      flowing={playing && speed <= 60}
    />
  );
}

function wallClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const MARK: Record<Milestone["kind"], { icon: string; tone: string; label: string }> = {
  win: { icon: "Check", tone: "text-success", label: "win" },
  best: { icon: "Star", tone: "text-success", label: "best moved" },
  pause: { icon: "Pause", tone: "text-warning-text", label: "paused" },
  resume: { icon: "Play", tone: "text-muted-foreground", label: "running" },
  harvest: { icon: "GitPullRequest", tone: "text-muted-foreground", label: "harvest" },
  segment: { icon: "Layers", tone: "text-muted-foreground", label: "segment" },
};

const BINS = 120;

/** The timeline: event density, milestone markers, the position; drag, click or keys to move. */
export function Scrubber({ model, t, milestones, onSeek, onCommit }: { model: ReplayModel; t: number; milestones: readonly Milestone[]; onSeek: (t: number) => void; onCommit: (t: number) => void }) {
  const span = Math.max(1, model.end - model.start);
  const density = useMemo(() => model.density(BINS), [model]);
  const peak = Math.max(1, ...density);
  const track = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return t;
    return model.start + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };
  const pos = ((t - model.start) / span) * 100;
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(at(e.clientX));
  };
  const onMoveP = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) onSeek(at(e.clientX));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit(at(e.clientX));
  };
  // Milestones that would overlap are thinned (wins and best moves first).
  const marks = useMemo(() => {
    const order: Milestone["kind"][] = ["pause", "segment", "harvest", "win", "best", "resume"];
    const out: Milestone[] = [];
    const taken: number[] = [];
    for (const kind of order)
      for (const m of milestones.filter((x) => x.kind === kind)) {
        const p = ((m.at - model.start) / span) * 100;
        if (taken.some((q) => Math.abs(q - p) < 1.2)) continue;
        taken.push(p);
        out.push(m);
      }
    return out.sort((a, b) => a.at - b.at);
  }, [milestones, model, span]);
  const winsSoFar = milestones.filter((m) => m.kind === "win" && m.at <= t).length;
  return (
    <div className="relative select-none pt-4">
      {/* Milestone markers above the track. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-4">
        {marks.map((m, i) => (
          <button
            key={`${m.kind}-${m.at}-${i}`}
            type="button"
            tabIndex={-1}
            title={`${m.label} at ${clock(m.at - model.start)}`}
            aria-label={`${m.label} at ${clock(m.at - model.start)}: jump there`}
            onClick={() => {
              onSeek(m.at);
              onCommit(m.at);
            }}
            className={cn("pointer-events-auto absolute top-0 -translate-x-1/2 rounded-sm", MARK[m.kind].tone)}
            style={{ left: `${((m.at - model.start) / span) * 100}%` }}
            data-milestone={m.kind}
          >
            <Icon name={MARK[m.kind].icon} className="size-3" aria-hidden />
          </button>
        ))}
      </div>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(span / 1000)}
        aria-valuenow={Math.round((t - model.start) / 1000)}
        aria-valuetext={`${clock(t - model.start)} of ${clock(span)}, ${winsSoFar} win${winsSoFar === 1 ? "" : "s"} so far`}
        onPointerDown={onDown}
        onPointerMove={onMoveP}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className={cn("relative h-9 cursor-pointer rounded-md bg-muted/50", FOCUS_RING)}
        data-scrubber
      >
        {/* Event density. */}
        <svg viewBox={`0 0 ${BINS} 20`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-7 w-full" aria-hidden>
          {density.map((c, i) =>
            c ? <rect key={i} x={i + 0.1} width={0.8} y={20 - Math.max(1.2, Math.sqrt(c / peak) * 19)} height={Math.max(1.2, Math.sqrt(c / peak) * 19)} className={i / BINS <= pos / 100 ? "text-foreground/45" : "text-foreground/20"} fill="currentColor" /> : null,
          )}
        </svg>
        {milestones
          .filter((m) => m.kind === "win")
          .map((m, i) => (
            <span key={i} className="absolute inset-y-0 w-px bg-success/60" style={{ left: `${((m.at - model.start) / span) * 100}%` }} aria-hidden />
          ))}
        <span className="absolute inset-y-0 left-0 rounded-l-md bg-foreground/5" style={{ width: `${pos}%` }} aria-hidden />
        <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${pos}%` }} aria-hidden />
        <span className="absolute -top-1 size-3 -translate-x-1/2 rounded-full border-2 border-background bg-foreground shadow" style={{ left: `${pos}%` }} aria-hidden />
      </div>
    </div>
  );
}
