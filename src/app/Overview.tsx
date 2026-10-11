// Overview: what needs you, best vs base, what's running now, then the
// trajectory, secondary metrics and guardrails, controls, bench hosts,
// notices (each with the action it asks for) and the raw event log.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { OverviewResult, UsageView } from "../views.ts";
import { ArchiveDialog, HarvestDialog, NeedsYou } from "./Actions.tsx";
import type { Rpc } from "./data.ts";
import { ago, duration, formatValue, frac, nowHint, ratio, shortSha } from "./format.ts";
import { BenchHostList } from "./BenchHosts.tsx";
import { Sparkline, TrajectoryChart } from "./TrajectoryChart.tsx";
import { ordinal } from "../live-model.ts";
import { EmptyState, GuardrailBadge, Mono, Section, Stat } from "./ui.tsx";
import type { Tab } from "./StudiesPage.tsx";

export function OverviewTab({ o, rpc, onChanged, onOpenCandidate, go }: { o: OverviewResult; rpc: Rpc; onChanged: () => void; onOpenCandidate: (n: number) => void; go: (t: Tab) => void }) {
  const nav = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [workers, setWorkers] = useState<string>("");
  const [dialog, setDialog] = useState<null | "harvest" | "archive">(null);
  const act = async (fn: () => Promise<{ message: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      toast.success(r.message);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const u = o.utilization;
  const running = ["running", "paused", "harvesting"].includes(o.state);
  const promotions = o.trajectory.steps.length - 1;
  const harvestNeeded = o.needs.some((n) => n.action?.kind === "harvest");
  return (
    <div className="space-y-5">
      <NeedsYou o={o} rpc={rpc} onChanged={onChanged} go={go} />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat
          className="col-span-2"
          label={`Best vs base (${o.metric.name}, ${o.metric.direction} is better)`}
          help="improvement"
          value={o.best.text ?? (o.state === "draft" || o.state === "calibrating" ? "not started" : "no win yet")}
          hint={
            o.best.text ? (
              <>
                {o.best.raw ? <span className="text-foreground">{o.best.raw}</span> : null}
                {o.best.raw && o.best.ciText ? " · " : null}
                {o.best.ciText}
              </>
            ) : o.best.base !== null ? (
              `base ${formatValue(o.best.base)}${o.metric.unit ? ` ${o.metric.unit}` : ""}`
            ) : (
              `best ${shortSha(o.bestSha)}`
            )
          }
        />
        <Stat
          label="Now"
          value={running ? `${o.workers} worker${o.workers === 1 ? "" : "s"} · queue ${o.benchDepth}` : o.state}
          hint={nowHint(o)}
        />
        <Stat label="Budget" value={`${o.candidates} of ${o.maxCandidates} candidates`} hint={`bench ${duration(o.benchSeconds)} of ${o.maxBenchHours} h${o.usage.tokens !== null ? ` · ${o.usage.tokens.toLocaleString("en-US")} tokens` : ""}`} />
      </div>

      <Section title="Trajectory" help="improvement">
        {o.trajectory.points.length ? (
          <div className="rounded-lg border border-border bg-card p-3">
            <TrajectoryChart data={o.trajectory} metric={o.metric} lastN={o.candidates} onSelect={onOpenCandidate} />
          </div>
        ) : (
          <EmptyState className="min-h-[9rem] content-center">{running ? "No measured candidates yet: the first verdict usually arrives a few think-times after start." : "The trajectory appears once candidates are measured."}</EmptyState>
        )}
      </Section>

      {o.state === "running" || o.state === "paused" || o.workerList.length || o.queue.length ? (
        <div className="grid gap-5 md:grid-cols-2">
          <Section title={`Workers (${o.workerList.length})`}>
            {o.workerList.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {o.workerList.map((w) => (
                  <li key={w.threadId ?? w.spawnedAt} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        #{w.ideaId} {w.ideaTitle}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {w.phase === "thinking" ? "editing" : w.phase}
                        {w.queuePosition !== null ? ` (${ordinal(w.queuePosition)} in line for the bench)` : ""} · submission {w.submissions} of {w.maxSubmissions}
                        {w.candidate !== null ? ` · c/${w.candidate}` : ""} · started {ago(w.spawnedAt)}
                      </div>
                    </div>
                    {w.threadId ? (
                      <Button size="sm" variant="ghost" aria-label={`Open the worker thread for idea ${w.ideaId}`} onClick={() => nav.toThread(w.threadId!)}>
                        Thread
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>{o.state === "running" ? "No live workers: the next one starts when the bench queue has room." : "No live workers."}</EmptyState>
            )}
          </Section>
          <Section title={`Bench queue (${o.queue.length})`}>
            {o.queue.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {o.queue.map((q) => (
                  <li key={q.n} className="flex items-center justify-between px-3 py-2 text-sm">
                    <button type="button" className="rounded text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenCandidate(q.n)}>
                      c/{q.n} · idea #{q.ideaId ?? "?"}
                    </button>
                    <span className="text-xs text-muted-foreground">
                      {q.stage}
                      {q.rebases ? ` · rebased ${q.rebases}×` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>Bench queue is empty.</EmptyState>
            )}
          </Section>
        </div>
      ) : null}

      <SecondaryMetrics o={o} />

      <Section title="Controls">
        <div className="flex flex-wrap items-center gap-2">
          {o.state === "running" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => rpc.call("study.pause", { slug: o.slug }))}>
              <Icon name="Pause" className="size-4" aria-hidden />
              Pause
            </Button>
          ) : null}
          {o.state === "paused" && !harvestNeeded ? (
            <Button size="sm" disabled={busy} onClick={() => void act(() => rpc.call("study.resume", { slug: o.slug }))}>
              <Icon name="Play" className="size-4" aria-hidden />
              Resume
            </Button>
          ) : null}
          {o.state === "harvesting" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => rpc.call("study.resume", { slug: o.slug }))}>
              Keep exploring (resume)
            </Button>
          ) : null}
          {["running", "paused"].includes(o.state) && !harvestNeeded ? (
            <>
              <Button size="sm" variant="outline" disabled={busy || promotions === 0} aria-describedby={promotions === 0 ? "harvest-why" : undefined} onClick={() => setDialog("harvest")}>
                Harvest…
              </Button>
              {promotions === 0 ? (
                <span id="harvest-why" className="text-xs text-muted-foreground">
                  Nothing to harvest yet: no promotion.
                </span>
              ) : null}
            </>
          ) : null}
          {running ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = workers.trim();
                const n = v === "" || v === "auto" ? null : Number(v);
                if (n !== null && (!Number.isInteger(n) || n < 1 || n > 64)) {
                  toast.error("Concurrency is 1-64, or empty for the spec's value");
                  return;
                }
                void act(() => rpc.call("study.concurrency", { slug: o.slug, maxWorkers: n }));
                setWorkers("");
              }}
            >
              <label className="sr-only" htmlFor="max-workers">
                Max concurrent workers (empty: back to the spec's {o.maxWorkers})
              </label>
              <Input id="max-workers" className="h-8 w-28" inputMode="numeric" placeholder={`max ${o.maxWorkers}`} value={workers} onChange={(e) => setWorkers(e.target.value)} />
              <Button size="sm" variant="outline" type="submit" disabled={busy}>
                Set max workers
              </Button>
            </form>
          ) : null}
          {o.state !== "draft" ? (
            <Button size="sm" variant="outline" onClick={() => nav.toPluginPanel("studies", { subPath: `${o.slug}/live/replay` })} aria-label="Replay this study in the Live view">
              <Icon name="RotateCcw" className="size-4" aria-hidden />
              Replay
            </Button>
          ) : null}
          {o.state !== "archived" ? (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" disabled={busy} onClick={() => setDialog("archive")}>
              <Icon name="Archive" className="size-4" aria-hidden />
              Archive…
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {o.noise} oracle · {o.noise === "deterministic" ? `single runs, tolerance ${frac(o.calibration.mde)}` : `win threshold (MDE) ${frac(o.calibration.mde)}`} · think ≈ {duration(o.tThink)} · eval ≈ {duration(o.tEval)}
          {o.evalTimes?.serialized ? ` (tests ${duration(o.evalTimes.gate)} + measurement ${duration(o.evalTimes.measure)})` : ""} · bench busy {ratio(u.ratio)} of running time{o.evalTimes?.serialized && u.gateSeconds > 0 ? ` (${duration(u.gateSeconds)} of it testing)` : ""} · best <Mono>{shortSha(o.bestSha)}</Mono> on <Mono>studies/{o.slug}/best</Mono>
        </p>
        {o.singleMachine?.serialized ? <p className="text-xs text-muted-foreground">{o.singleMachine.text}</p> : null}
        <Usage u={o.usage} />
      </Section>

      {o.harvest ? (
        <p className="text-sm">
          Harvest h{o.harvest.id}: {o.harvest.state}
          {o.harvest.detail ? ` (${o.harvest.detail})` : ""} · {o.harvest.changesets} changeset(s) · started {ago(o.harvest.startedAt)}{" "}
          <button type="button" className="rounded underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => go("harvest")}>
            Open Harvest
          </button>
        </p>
      ) : null}

      <Section title={`Bench hosts (${o.benchHosts.length}) · segment ${o.segment.k}`} help="segment">
        {o.benchHosts.length ? <BenchHostList hosts={o.benchHosts} queueDepth={o.benchDepth} /> : <EmptyState>Bench hosts are set when the spec is approved for calibration.</EmptyState>}
      </Section>

      <Notices o={o} go={go} />

      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Event log (last {o.events.length})</summary>
        <ul className="max-h-64 overflow-y-auto border-t border-border font-mono text-xs">
          {o.events.map((e) => (
            <li key={e.id} className="flex gap-2 border-b border-border px-3 py-1 last:border-0">
              <span className="shrink-0 text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="shrink-0">{e.kind}</span>
              <span className="truncate text-muted-foreground">{e.data}</span>
            </li>
          ))}
        </ul>
      </details>

      {dialog === "harvest" ? <HarvestDialog slug={o.slug} promotions={promotions} restart={false} rpc={rpc} open onOpenChange={(v) => !v && setDialog(null)} onDone={onChanged} /> : null}
      {dialog === "archive" ? <ArchiveDialog slug={o.slug} rpc={rpc} open onOpenChange={(v) => !v && setDialog(null)} onDone={onChanged} /> : null}
    </div>
  );
}

/** Guardrails (position against their limit) and informational metrics of best vs the segment base. */
export function SecondaryMetrics({ o }: { o: OverviewResult }) {
  const s = o.secondary;
  if (!s.guardrails.length && !s.info.length) return null;
  return (
    <Section title="Secondary metrics (best vs the segment base)" help="guardrail">
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm" aria-label="Secondary metrics">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 font-medium">Metric</th>
              <th className="px-3 py-2 text-right font-medium">Base → best</th>
              <th className="px-3 py-2 font-medium">Change vs base</th>
              <th className="px-3 py-2 font-medium">Against the total limit</th>
              <th className="px-3 py-2 font-medium">Trend</th>
            </tr>
          </thead>
          <tbody>
            {s.guardrails.map((g) => (
              <tr key={g.name} className="border-b border-border align-top last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{g.name}</div>
                  <div className="text-xs text-muted-foreground">guardrail · {g.direction} is better</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{g.raw || "—"}</td>
                <td className="px-3 py-2 text-xs">{g.text}</td>
                <td className="px-3 py-2">
                  <LimitBar used={g.used} state={g.state} />
                  <div className="mt-1">
                    <GuardrailBadge state={g.state} text={g.label} />
                    {g.worstStep !== null ? <span className="ml-2 text-xs text-muted-foreground">worst single promotion {frac(Math.max(0, g.worstStep), 1)} worse</span> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">{g.headroomText}</div>
                  {g.promotions ? (
                    <div className="text-xs text-muted-foreground">
                      compounded over {g.promotions} promotion{g.promotions === 1 ? "" : "s"}
                      {g.missingSteps ? ` (${g.missingSteps} without a measurement)` : ""}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <Sparkline points={g.trend} label={`${g.name} of best after each promotion`} />
                </td>
              </tr>
            ))}
            {s.info.map((m) => (
              <tr key={m.name} className="border-b border-border align-top last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{m.name}</div>
                  <div className="text-xs text-muted-foreground">informational (no direction)</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{m.raw || "—"}</td>
                <td className="px-3 py-2 text-xs">{m.change === null ? "—" : `${m.change >= 0 ? "+" : "−"}${Math.abs(m.change * 100).toFixed(1)}% (raw change)`}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">no limit</td>
                <td className="px-3 py-2">
                  <Sparkline points={m.trend} label={`${m.name} of best after each promotion`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!s.measured ? <p className="text-xs text-muted-foreground">Values appear after the first measurement.</p> : null}
    </Section>
  );
}

/** How much of a guardrail's limit is used: a bar with a marker at the warn share; the label next to it carries the state. */
function LimitBar({ used, state }: { used: number | null; state: string }) {
  const pct = used === null ? 0 : Math.min(1, used) * 100;
  return (
    <div className="relative h-1.5 w-32 rounded-full bg-muted" role="img" aria-label={used === null ? "not measured" : `${Math.round((used ?? 0) * 100)}% of the limit used`}>
      <div className={cn("h-1.5 rounded-full", state === "broken" ? "bg-destructive" : state === "warn" || state === "inconclusive" ? "bg-warning" : "bg-success")} style={{ width: `${pct}%` }} />
      <div className="absolute top-[-2px] h-2.5 w-px bg-foreground/50" style={{ left: "80%" }} aria-hidden />
    </div>
  );
}

function Notices({ o, go }: { o: OverviewResult; go: (t: Tab) => void }) {
  const [all, setAll] = useState(false);
  const every = o.notices.filter((n) => !n.audit);
  const notices = all ? every : every.slice(0, 6);
  const audit = o.notices.filter((n) => n.audit);
  if (!notices.length && !audit.length) return null;
  return (
    <Section title="Notices">
      {notices.length ? (
        <ul className="space-y-1 text-sm" aria-label="Notices">
          {notices.map((n) => (
            <li key={n.id} className="flex flex-wrap items-start gap-2 rounded-md border border-border bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">
                  {ago(n.at)} · {n.kind}
                  {n.unseen ? <span className="ml-1 font-medium text-foreground">· new</span> : null}
                </div>
                <div>{n.summary}</div>
                {n.detail ? (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Details</summary>
                    <div className="whitespace-pre-wrap">{n.detail}</div>
                  </details>
                ) : null}
              </div>
              {n.action ? (
                <Button size="sm" variant="ghost" onClick={() => go(n.action!.tab)}>
                  {n.action.label}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {every.length > notices.length ? (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
          Show {every.length - notices.length} older notice{every.length - notices.length === 1 ? "" : "s"}
        </Button>
      ) : null}
      {audit.length ? (
        <details className="rounded-md border border-border bg-card text-sm">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">Audit trail: {audit.length} human control{audit.length === 1 ? "" : "s"}</summary>
          <ul className="border-t border-border text-xs">
            {audit.map((n) => (
              <li key={n.id} className="border-b border-border px-3 py-1.5 last:border-0">
                <span className="text-muted-foreground">{ago(n.at)} · </span>
                {n.summary}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

function Usage({ u }: { u: UsageView }) {
  const parts = [
    u.rateLimited ? `rate limited until ${u.rateLimitedUntil ? new Date(u.rateLimitedUntil).toLocaleTimeString() : "?"} (no new workers)` : null,
    u.tight ? `usage tight (≥ ${u.tightPercent}%): half the workers` : null,
    u.maxPercent !== null ? `busiest provider window ${u.maxPercent.toFixed(0)}%` : "providers report no usage window",
    u.tokens !== null ? `${u.tokens.toLocaleString("en-US")} tokens${u.maxTokens ? ` of ${u.maxTokens.toLocaleString("en-US")}` : ""}` : null,
    u.tokensPerWin !== null ? `${u.tokensPerWin.toLocaleString("en-US")} per win` : null,
    u.projectedBenchSeconds !== null ? `remaining candidate budget ≈ ${duration(u.projectedBenchSeconds)} of bench` : null,
  ].filter(Boolean);
  return (
    <p className={u.rateLimited || u.tight ? "text-xs text-warning-text" : "text-xs text-muted-foreground"} aria-label="Provider usage">
      Provider usage: {parts.join(" · ")}
      {u.checkedAt ? ` · checked ${ago(u.checkedAt)}` : ""}
    </p>
  );
}
