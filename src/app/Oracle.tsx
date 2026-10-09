// Oracle tab: the active spec (holdout redacted by the server), a pending
// spec with its diff and the CLI command that approves it, version history,
// the calibration report, and segments. Approval is CLI-only by design.
import { cn } from "@/lib/utils";
import type { OracleView } from "../views.ts";
import { useLive } from "./data.ts";
import { ago, duration, frac, shortSha } from "./format.ts";
import { EmptyState, ErrorLine, Mono, Section, StatePill } from "./ui.tsx";

export function OracleTab({ slug }: { slug: string }) {
  const o = useLive((rpc) => rpc.call("study.oracle", { slug }), [slug], 15_000);
  const v = o.data;
  if (!v) return o.error ? <ErrorLine error={o.error} /> : <EmptyState>Loading oracle…</EmptyState>;
  return (
    <div className="space-y-5">
      <ErrorLine error={o.error} />
      {v.pending ? <PendingSpec pending={v.pending} active={v.specVersion} /> : null}
      <Calibration c={v.calibration} />
      <Section title={`Active spec v${v.specVersion}${v.holdoutConfigured ? " · holdout configured (hidden)" : ""}`}>
        {v.activeToml ? <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs" aria-label="Active spec">{v.activeToml}</pre> : <EmptyState>No active spec.</EmptyState>}
      </Section>
      <Section title={`Segments (${v.segments.length})`}>
        {v.segments.length ? (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm" aria-label="Segments">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">k</th>
                  <th className="px-3 py-2 font-medium">Oracle</th>
                  <th className="px-3 py-2 font-medium">Spec</th>
                  <th className="px-3 py-2 font-medium">Baseline</th>
                  <th className="px-3 py-2 text-right font-medium">Noise floor</th>
                  <th className="px-3 py-2 text-right font-medium">MDE</th>
                  <th className="px-3 py-2 text-right font-medium">Eval</th>
                  <th className="px-3 py-2 font-medium">Hosts</th>
                </tr>
              </thead>
              <tbody>
                {v.segments.map((g) => (
                  <tr key={g.k} className={cn("border-b border-border align-top last:border-0", g.active && "bg-state-active")}>
                    <td className="px-3 py-2 tabular-nums">
                      {g.k}
                      {g.active ? <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">active</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Mono>{g.oracleHash}</Mono>
                    </td>
                    <td className="px-3 py-2 tabular-nums">v{g.specVersion}</td>
                    <td className="px-3 py-2">
                      <Mono>{shortSha(g.baselineSha)}</Mono>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{frac(g.noiseFloor)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{frac(g.mde)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{duration(g.evalSeconds)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {g.hosts.length ? g.hosts.map((h) => `${h.name}: noise ${frac(h.noiseFloor)}, MDE ${frac(h.mde)}, ${duration(h.evalSeconds)}`).join("; ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No segments yet: the first one starts when the study is calibrated and started.</EmptyState>
        )}
      </Section>
      <Section title={`Spec versions (${v.versions.length})`}>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm" aria-label="Spec versions">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Oracle</th>
                <th className="px-3 py-2 font-medium">Proposed</th>
                <th className="px-3 py-2 font-medium">Approved</th>
                <th className="px-3 py-2 font-medium">Bench hosts</th>
              </tr>
            </thead>
            <tbody>
              {v.versions.map((s) => (
                <tr key={s.version} className={cn("border-b border-border last:border-0", s.active && "bg-state-active")}>
                  <td className="px-3 py-2 tabular-nums">
                    v{s.version}
                    {s.active ? <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">active</span> : null}
                    {s.pending ? <span className="ml-1 text-xs text-sky-600 dark:text-sky-400">pending</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Mono>{s.oracleHash}</Mono>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{ago(s.createdAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{s.approvedAt ? ago(s.approvedAt) : "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{s.benchHosts.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function PendingSpec({ pending, active }: { pending: NonNullable<OracleView["pending"]>; active: number }) {
  return (
    <Section title={`Pending spec v${pending.version}`}>
      <div role="status" className="space-y-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
        <p>
          Spec v{pending.version} waits for approval; the study keeps running on v{active}.{" "}
          {pending.changesOracle ? `The oracle changed (${pending.oracleHash}): approving recalibrates and starts a new segment.` : "The oracle is unchanged: approving applies it without recalibration."}
        </p>
        <p>
          Approve from a terminal: <Mono className="text-foreground">{pending.command}</Mono>
        </p>
      </div>
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs" aria-label="Pending spec diff">
        {pending.diff.map((l, i) => (
          <div key={i} className={cn(l.op === "add" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", l.op === "del" && "bg-red-500/15 text-red-700 dark:text-red-300")}>
            {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
    </Section>
  );
}

function Calibration({ c }: { c: OracleView["calibration"] }) {
  return (
    <Section title="Calibration">
      <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatePill state={c.status ?? "not run"} />
          {c.ok !== null ? <span className={c.ok ? "text-xs text-emerald-600 dark:text-emerald-400" : "text-xs text-destructive"}>{c.ok ? "passed" : "failed"}</span> : null}
          <span className="text-xs text-muted-foreground">{c.approved ? "approved" : "not approved"}</span>
          {c.baselineSha ? (
            <span className="text-xs text-muted-foreground">
              baseline <Mono>{shortSha(c.baselineSha)}</Mono>
            </span>
          ) : null}
          {c.oracleHash ? (
            <span className="text-xs text-muted-foreground">
              oracle <Mono>{c.oracleHash}</Mono>
            </span>
          ) : null}
          {c.finishedAt ? <span className="text-xs text-muted-foreground">finished {ago(c.finishedAt)}</span> : null}
        </div>
        {c.nextCommand ? (
          <p>
            Next: <Mono className="text-foreground">{c.nextCommand}</Mono>
          </p>
        ) : null}
        {c.problems.length ? (
          <ul className="list-disc pl-5 text-xs text-destructive">
            {c.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        ) : null}
        {c.hosts.length ? (
          <table className="w-full text-xs tabular-nums">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Host</th>
                <th className="py-1 text-right font-medium">Noise floor</th>
                <th className="py-1 text-right font-medium">MDE</th>
                <th className="py-1 text-right font-medium">Eval</th>
              </tr>
            </thead>
            <tbody>
              {c.hosts.map((h) => (
                <tr key={h.name} className="border-t border-border">
                  <td className="py-1">{h.name}</td>
                  <td className="py-1 text-right">{frac(h.noiseFloor)}</td>
                  <td className="py-1 text-right">{frac(h.mde)}</td>
                  <td className="py-1 text-right">{duration(h.evalSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {c.report ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{c.report}</pre> : <p className="text-xs text-muted-foreground">No calibration report yet.</p>}
      </div>
    </Section>
  );
}
