import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Rpc } from "./data.ts";
import { ago, duration, metricChange, pct, ratio, shortSha } from "./format.ts";
import { TrajectoryChart } from "./TrajectoryChart.tsx";
import { EmptyState, Mono, Section, Stat } from "./ui.tsx";
import type { OverviewResult } from "../views.ts";

export function OverviewTab({
  o,
  rpc,
  onChanged,
  onOpenCandidate,
}: {
  o: OverviewResult;
  rpc: Rpc;
  onChanged: () => void;
  onOpenCandidate: (n: number) => void;
}) {
  const nav = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [workers, setWorkers] = useState<string>("");
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
  const dir = o.metric.direction;
  const u = o.utilization;
  const ci = o.bestCi;
  return (
    <div className="space-y-5">
      {o.pauseReason ? (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
          Paused: {o.pauseReason}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat
          label={`Best vs base (${o.metric.name})`}
          value={o.bestVsBase === null ? "no win yet" : metricChange(o.bestVsBase, dir)}
          hint={ci ? `CI ≈ ${metricChange(dir === "lower" ? ci.hi : ci.lo, dir)} … ${metricChange(dir === "lower" ? ci.lo : ci.hi, dir)}` : `best ${shortSha(o.bestSha)}`}
        />
        <Stat label="Candidates" value={`${o.candidates} / ${o.maxCandidates}`} hint={`bench ${duration(o.benchSeconds)} of ${o.maxBenchHours} h`} />
        <Stat label="Workers" value={`${o.workers} · W ${o.targetWorkers}`} hint={`max ${o.maxWorkers}${o.maxWorkersOverride !== null ? " (override)" : ""} · queue ${o.benchDepth}`} />
        <Stat label="Bench utilization" value={ratio(u.ratio)} hint={`${ratio(u.steadyRatio)} since first submission · ${duration(u.busySeconds)} busy`} />
      </div>

      <Section title="Trajectory">
        {o.trajectory.points.length ? (
          <div className="rounded-lg border border-border bg-card p-3">
            <TrajectoryChart data={o.trajectory} lastN={o.candidates} onSelect={onOpenCandidate} />
          </div>
        ) : (
          <EmptyState>No measured candidates yet.</EmptyState>
        )}
      </Section>

      <Section title="Controls">
        <div className="flex flex-wrap items-center gap-2">
          {o.state === "running" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => rpc.call("study.pause", { slug: o.slug }))}>
              Pause
            </Button>
          ) : null}
          {o.state === "paused" ? (
            <Button size="sm" disabled={busy} onClick={() => void act(() => rpc.call("study.resume", { slug: o.slug }))}>
              Resume
            </Button>
          ) : null}
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
            <Input className="h-8 w-28" inputMode="numeric" placeholder={`max ${o.maxWorkers}`} value={workers} onChange={(e) => setWorkers(e.target.value)} aria-label="Max concurrent workers" />
            <Button size="sm" variant="outline" type="submit" disabled={busy}>
              Set concurrency
            </Button>
          </form>
          {o.studyThreadId ? (
            <Button size="sm" variant="ghost" onClick={() => nav.toThread(o.studyThreadId!)}>
              Open study thread
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {o.noise} oracle · MDE {pct(o.calibration.mde, 2)} · think ≈ {duration(o.tThink)} · eval ≈ {duration(o.tEval)} · best <Mono>{shortSha(o.bestSha)}</Mono> on <Mono>studies/{o.slug}/best</Mono>
        </p>
      </Section>

      {o.segment.pendingSpecVersion !== null ? (
        <div role="status" className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-foreground">
          Spec v{o.segment.pendingSpecVersion} waits for approval:{" "}
          {o.segment.pendingChangesOracle ? (
            <>
              the oracle changed, so <Mono>bb study calibrate {o.slug}</Mono> starts segment {o.segment.k + 1} with recalibration.
            </>
          ) : (
            <>
              no oracle change; <Mono>bb study approve {o.slug}</Mono> applies it.
            </>
          )}
        </div>
      ) : null}

      <Section title={`Bench hosts (${o.benchHosts.length}) · segment ${o.segment.k}${o.segment.oracleHash ? ` · oracle ${o.segment.oracleHash}` : ""}`}>
        {o.benchHosts.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Bench hosts">
            {o.benchHosts.map((h) => (
              <li key={h.hostId} className="space-y-0.5 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{h.name}</span>
                  <span className="text-xs text-muted-foreground">{h.mode === "clone" ? "own clone · git bundles" : "local checkouts"}</span>
                  <span className={h.status === "offline" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{h.status}</span>
                  <span className={h.healthOk === false ? "text-xs text-amber-600 dark:text-amber-400" : "text-xs text-emerald-600 dark:text-emerald-400"}>
                    {h.healthOk === null ? "health not checked" : h.healthOk ? "healthy" : "unhealthy"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    drift {h.driftStatus ?? "not run"} ({h.evalsSinceDrift}/{h.driftEvery || "off"})
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.measuring !== null ? `measuring c/${h.measuring}` : "idle"}
                  {h.progress ? ` · ${h.progress}` : ""} · queue {o.benchDepth} · best build {h.bestBuildSha ? shortSha(h.bestBuildSha) : "not cached"}
                  {h.mode === "clone" ? ` · ${h.bundles} bundle(s), ${Math.round(h.bundleBytes / 1024)} KiB` : ""}
                  {h.deferredUntil ? ` · deferred until ${new Date(h.deferredUntil).toLocaleTimeString()}` : ""}
                </div>
                {h.problems.length ? <div className="text-xs text-amber-700 dark:text-amber-300">{h.problems.join("; ")}</div> : null}
                {h.healthSummary ? <div className="truncate text-xs text-muted-foreground">{h.healthSummary}</div> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>Bench hosts are set when the study is calibrated.</EmptyState>
        )}
      </Section>

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
                      {w.phase}
                      {w.queuePosition !== null ? ` (#${w.queuePosition})` : ""} · submission {w.submissions}/{w.maxSubmissions}
                      {w.candidate !== null ? ` · c/${w.candidate}` : ""} · started {ago(w.spawnedAt)}
                    </div>
                  </div>
                  {w.threadId ? (
                    <Button size="sm" variant="ghost" onClick={() => nav.toThread(w.threadId!)}>
                      Thread
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No live workers.</EmptyState>
          )}
        </Section>
        <Section title={`Bench queue (${o.queue.length})`}>
          {o.queue.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {o.queue.map((q) => (
                <li key={q.n} className="flex items-center justify-between px-3 py-2 text-sm">
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpenCandidate(q.n)}>
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

      {o.notices.length ? (
        <Section title="Notices">
          <ul className="space-y-1 text-sm">
            {o.notices.map((n) => (
              <li key={n.id} className="rounded-md border border-border bg-card px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {ago(n.at)} · {n.kind}
                  {n.delivered ? "" : " · new"}
                </span>
                <div className="whitespace-pre-wrap">{n.text}</div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Recent events">
        <ul className="max-h-64 overflow-y-auto rounded-lg border border-border bg-card font-mono text-xs">
          {o.events.map((e) => (
            <li key={e.id} className="flex gap-2 border-b border-border px-3 py-1 last:border-0">
              <span className="shrink-0 text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="shrink-0">{e.kind}</span>
              <span className="truncate text-muted-foreground">{e.data}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
