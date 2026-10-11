// Bench tab: machines, queue, utilization, health history, drift checks,
// bundle transfers, recent bench intervals, and gate flakiness.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BenchHostList } from "./BenchHosts.tsx";
import { RemoteBench } from "./RemoteBench.tsx";
import { useLive } from "./data.ts";
import { ago, bytes, duration, frac, ratio, shortSha } from "./format.ts";
import { EmptyState, Mono, Section, Stat, TabState } from "./ui.tsx";

export function BenchTab({ slug, onOpenCandidate }: { slug: string; onOpenCandidate: (n: number) => void }) {
  const b = useLive((rpc) => rpc.call("study.bench", { slug }), [slug], 10_000);
  const v = b.data;
  if (!v) return <TabState loading={b.loading} error={b.error} retry={b.refetch} label="the bench" />;
  const u = v.utilization;
  const cand = (n: number | null) =>
    n === null ? (
      "—"
    ) : (
      <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => onOpenCandidate(n)}>
        c/{n}
      </button>
    );
  return (
    <div className="space-y-5">
      {b.error ? <TabState loading={false} error={b.error} retry={b.refetch} label="the bench" /> : null}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Bench utilization" help="utilization" value={ratio(u.ratio)} hint={`${ratio(u.steadyRatio)} since the first submission`} />
        <Stat label="Busy" value={duration(u.busySeconds)} hint={`of ${duration(u.runningSeconds)} running${u.gateSeconds > 0 ? `, ${duration(u.gateSeconds)} testing` : ""}`} />
        <Stat label="Queue" value={v.queue.length} hint={u.overlaps ? `${u.overlaps} overlapping interval(s)` : "no overlaps"} />
        <Stat label="Gate runs" value={`${v.gates.flaky} flaky · ${v.gates.failed} failed`} hint="last 200 gate events" />
      </div>

      {v.singleMachine && (v.singleMachine.on || v.singleMachine.quietBench) ? <p className="text-xs text-muted-foreground">{v.singleMachine.text}</p> : null}

      {v.remote.entries.length || v.remote.machines.length ? (
        <Section title={`Remote bench hosts (${v.remote.live} running)`}>
          <RemoteBench v={v.remote} onOpenCandidate={onOpenCandidate} />
        </Section>
      ) : null}

      <Section title={`Bench hosts (${v.hosts.length})`}>{v.hosts.length ? <BenchHostList hosts={v.hosts} queueDepth={v.queue.length} /> : <EmptyState>Bench hosts are set when the study is calibrated.</EmptyState>}</Section>

      <Section title={`Bench queue (${v.queue.length})`}>
        {v.queue.length ? (
          <Table head={["Candidate", "Idea", "Stage", "Host", "Queued"]} label="Bench queue">
            {v.queue.map((q) => (
              <tr key={q.n} className="border-b border-border last:border-0">
                <Td>{cand(q.n)}</Td>
                <Td className="max-w-80 truncate">{q.ideaTitle ?? "—"}</Td>
                <Td>
                  {q.stage}
                  {q.rebases ? <span className="text-xs text-muted-foreground"> · rebased {q.rebases}×</span> : null}
                </Td>
                <Td className="text-xs text-muted-foreground">{q.benchHostName ?? "—"}</Td>
                <Td className="text-xs text-muted-foreground">{ago(q.queuedAt)}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>Bench queue is empty.</EmptyState>
        )}
      </Section>

      <Section title={`Health checks (${v.health.length})`}>
        {v.health.length ? (
          <Table head={["When", "Host", "Context", "Result", "Summary"]} label="Health checks">
            {v.health.map((h) => (
              <tr key={h.id} className={cn("border-b border-border align-top last:border-0", h.latest && "bg-state-active")}>
                <Td className="text-xs text-muted-foreground">
                  {ago(h.at)}
                  {h.latest ? <span className="ml-1 rounded bg-foreground px-1 text-[10px] font-medium text-background">latest</span> : null}
                </Td>
                <Td>{h.hostName}</Td>
                <Td className="text-xs">{h.context}</Td>
                <Td className={cn("text-xs", h.ok ? "text-success" : "text-warning-text")}>
                  {h.ok ? "✓ ok" : "⚠ problems"}
                  {h.problems.length ? <div className="text-warning-text">{h.problems.join("; ")}</div> : null}
                </Td>
                <Td className="text-xs text-muted-foreground">{h.summary || "—"}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>No health checks recorded.</EmptyState>
        )}
      </Section>

      <Section title={`Drift checks (${v.drift.length})`} help="drift">
        {v.drift.length ? (
          <Table head={["Started", "Host", "Segment", "Best", "Status", "Pairs", "Noise", "Calibrated", "Ratio"]} label="Drift checks">
            {v.drift.map((d) => (
              <tr key={d.id} className="border-b border-border last:border-0">
                <Td className="text-xs text-muted-foreground">{ago(d.startedAt)}</Td>
                <Td>{d.hostName}</Td>
                <Td className="tabular-nums">{d.segment}</Td>
                <Td>
                  <Mono>{shortSha(d.bestSha)}</Mono>
                </Td>
                <Td className={cn("text-xs", d.status === "drift" || d.status === "error" ? "text-warning-text" : "")}>{d.status}</Td>
                <Td className="tabular-nums">{d.pairs ?? "—"}</Td>
                <Td className="tabular-nums">{frac(d.noise)}</Td>
                <Td className="tabular-nums">{frac(d.calibrated)}</Td>
                <Td className="tabular-nums">{d.ratio === null ? "—" : `${d.ratio.toFixed(2)}×`}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>No drift checks yet.</EmptyState>
        )}
      </Section>

      <Section title={`Bundle transfers (${v.transfers.length})`}>
        {v.transfers.length ? (
          <Table head={["When", "Host", "Commit", "Purpose", "Size", "Chunks", "Time", "Result"]} label="Bundle transfers">
            {v.transfers.map((t) => (
              <tr key={t.id} className="border-b border-border align-top last:border-0">
                <Td className="text-xs text-muted-foreground">{ago(t.at)}</Td>
                <Td>{t.hostName}</Td>
                <Td>
                  <Mono>{shortSha(t.sha)}</Mono>
                </Td>
                <Td className="text-xs">{t.purpose}</Td>
                <Td className="tabular-nums">{bytes(t.bytes)}</Td>
                <Td className="tabular-nums">{t.chunks}</Td>
                <Td className="tabular-nums">{t.ms} ms</Td>
                <Td className={cn("text-xs", t.ok ? "text-success" : "text-destructive")}>{t.ok ? "✓ ok" : `✗ failed${t.error ? `: ${t.error}` : ""}`}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>No bundle transfers (local-checkout hosts don't need them).</EmptyState>
        )}
      </Section>

      <Section title={`Recent bench intervals (${v.intervals.length})`}>
        {v.intervals.length ? (
          <Table head={["Started", "Host", "Kind", "Candidate", "Seconds"]} label="Bench intervals">
            {v.intervals.map((i) => (
              <tr key={i.id} className="border-b border-border last:border-0">
                <Td className="text-xs text-muted-foreground">{ago(i.startedAt)}</Td>
                <Td>{i.hostName}</Td>
                <Td className="text-xs">{i.kind}</Td>
                <Td>{cand(i.candidate)}</Td>
                <Td className="tabular-nums">
                  {duration(i.seconds)}
                  {i.open ? <span className="text-xs text-muted-foreground"> · running</span> : null}
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>No bench time used yet.</EmptyState>
        )}
      </Section>
    </div>
  );
}

function Table({ head, label, children }: { head: string[]; label: string; children: ReactNode }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm" aria-label={label}>
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-3 py-1.5", className)}>{children}</td>;
}
