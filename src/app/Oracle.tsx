// Oracle tab: the active spec (holdout redacted by the server), a pending
// spec with its diff and the button that approves it, version history, the
// calibration report with its approval, and segments. In-app and CLI
// approval are equivalent and audited the same way (threat model).
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OracleView, OverviewResult } from "../views.ts";
import { ApproveSpecDialog, StartDialog } from "./Actions.tsx";
import { useLive, type Rpc } from "./data.ts";
import { ago, duration, frac, shortSha } from "./format.ts";
import { Callout, EmptyState, GuardrailBadge, Help, Mono, Section, StatePill, TabState } from "./ui.tsx";

export function OracleTab({ slug, o: overview, rpc, onChanged }: { slug: string; o: OverviewResult; rpc: Rpc; onChanged: () => void }) {
  const o = useLive((r) => r.call("study.oracle", { slug }), [slug], 15_000);
  const [dialog, setDialog] = useState<null | { kind: "approve"; version: number; changesOracle: boolean } | { kind: "start" }>(null);
  const v = o.data;
  if (!v) return <TabState loading={o.loading} error={o.error} retry={o.refetch} label="the oracle" />;
  const done = () => {
    o.refetch();
    onChanged();
  };
  return (
    <div className="space-y-5">
      {o.error ? <TabState loading={false} error={o.error} retry={o.refetch} label="the oracle" /> : null}
      {v.pending ? <PendingSpec pending={v.pending} active={v.specVersion} onApprove={() => setDialog({ kind: "approve", version: v.pending!.version, changesOracle: v.pending!.changesOracle })} /> : null}
      <Calibration c={v.calibration} specVersion={v.specVersion} onAction={(a) => setDialog(a.kind === "start" ? { kind: "start" } : { kind: "approve", version: a.version, changesOracle: a.changesOracle })} />
      {dialog?.kind === "approve" ? <ApproveSpecDialog o={overview} version={dialog.version} changesOracle={dialog.changesOracle} rpc={rpc} open onOpenChange={(x) => !x && setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "start" ? <StartDialog o={overview} rpc={rpc} open onOpenChange={(x) => !x && setDialog(null)} onDone={done} /> : null}
      {v.singleMachine ? (
        <Section title={`Single-machine mode: ${v.singleMachine.on ? "on" : "off"}${v.singleMachine.quietBench ? " · quiet bench" : ""}`}>
          <p className="text-sm text-muted-foreground" aria-label="Single-machine mode">
            {v.singleMachine.text} Set with <Mono>[oracle] single_machine</Mono> ({v.singleMachine.setting}) and <Mono>quiet_bench</Mono>; neither is part of the oracle hash, so changing them applies without recalibration.
          </p>
        </Section>
      ) : null}
      <Section title={`Active spec v${v.specVersion}${v.holdoutConfigured ? " · holdout configured (hidden)" : ""}`}>
        {v.activeToml ? <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs" aria-label="Active spec">{v.activeToml}</pre> : <EmptyState>No active spec.</EmptyState>}
      </Section>
      <Section title={`Segments (${v.segments.length})`} help="segment">
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
                  <th className="px-3 py-2 text-right font-medium">Win threshold (MDE)</th>
                  <th className="px-3 py-2 text-right font-medium">Per evaluation</th>
                  <th className="px-3 py-2 font-medium">Hosts</th>
                </tr>
              </thead>
              <tbody>
                {v.segments.map((g) => (
                  <tr key={g.k} className={cn("border-b border-border align-top last:border-0", g.active && "bg-state-active")}>
                    <td className="px-3 py-2 tabular-nums">
                      {g.k}
                      {g.active ? <span className="ml-1 text-xs text-success">active</span> : null}
                      {g.awaitingApproval ? <span className="ml-1 text-xs text-foreground">awaiting your approval</span> : null}
                      {g.auto ? (
                        <div className="text-xs text-muted-foreground" title={g.autoReason ?? undefined}>
                          recalibrated automatically (same oracle){g.autoReason ? `: ${g.autoReason}` : ""}
                        </div>
                      ) : null}
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
                      {g.hosts.length ? g.hosts.map((h) => `${h.name}: noise ${frac(h.noiseFloor)}, MDE ${frac(h.mde)}, ${duration(h.evalSeconds)}${h.sideRuns && h.sideRuns > 1 ? `, ${h.sideRuns} runs a side` : ""}${h.runSeconds !== null ? `, one run ${duration(h.runSeconds)}` : ""}`).join("; ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No segments yet: the first one is created by calibration and starts when you approve it.</EmptyState>
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
                    {s.active ? <span className="ml-1 text-xs text-success">active</span> : null}
                    {s.pending ? <span className="ml-1 text-xs text-foreground">pending your approval</span> : null}
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

function PendingSpec({ pending, active, onApprove }: { pending: NonNullable<OracleView["pending"]>; active: number; onApprove: () => void }) {
  return (
    <Section title={`Pending spec v${pending.version}`}>
      <Callout
        tone="action"
        title={`Spec v${pending.version} waits for your approval; the study keeps running on v${active}.`}
        actions={<Button size="sm" onClick={onApprove}>{pending.changesOracle ? "Approve and recalibrate…" : "Apply spec…"}</Button>}
      >
        {pending.changesOracle ? `The oracle changed (${pending.oracleHash}): approving recalibrates on the current best and starts a new segment.` : "The oracle is unchanged: approving applies it without recalibration."} CLI <Mono>{pending.command}</Mono>. The diff below is
        against v{active}.
      </Callout>
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs" aria-label="Pending spec diff">
        {pending.diff.map((l, i) => (
          <div key={i} className={cn(l.op === "add" && "bg-success/15 text-success", l.op === "del" && "bg-destructive/15 text-destructive")}>
            {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
    </Section>
  );
}

function Calibration({ c, specVersion, onAction }: { c: OracleView["calibration"]; specVersion: number; onAction: (a: NonNullable<OracleView["calibration"]["action"]>) => void }) {
  return (
    <Section title="Calibration" help="calibration">
      {c.action ? (
        <Callout
          tone="action"
          title={c.action.kind === "start" ? "Calibration is ready: review it, then approve and start." : c.status === "failed" ? `The last calibration failed. Approve spec v${specVersion} to calibrate again.` : `Spec v${specVersion} waits for your approval.`}
          actions={<Button size="sm" onClick={() => onAction(c.action!)}>{c.action.kind === "start" ? "Approve and start…" : "Approve and calibrate…"}</Button>}
        >
          {c.action.kind === "start" ? "Starting spawns workers and spends tokens and bench time." : "Approving runs the gates on the base commit, then A/A measurements to learn the noise."} CLI <Mono>{c.nextCommand}</Mono>
        </Callout>
      ) : null}
      <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatePill state={c.status ?? "not run"} />
          {c.ok !== null ? <span className={c.ok ? "text-xs text-success" : "text-xs text-destructive"}>{c.ok ? "passed" : "failed"}</span> : null}
          <span className="text-xs text-muted-foreground">{c.approved ? "approved" : "not approved yet"}</span>
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
        {c.hosts.length ? (
          <p className="text-sm">
            {c.noise === "deterministic" ? null : (
              <>
                A win must improve by more than <strong>{frac(Math.max(...c.hosts.map((h) => h.mde)))}</strong> with confidence <Help term="mde" />
                {c.detectable !== null ? <> (in practice, changes of about {frac(c.detectable)} or more are detected)</> : null}.{" "}
              </>
            )}
            {c.noiseText} <Help term="noiseFloor" />
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
                <th className="py-1 text-right font-medium">Win threshold (MDE)</th>
                <th className="py-1 text-right font-medium">Per evaluation</th>
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
        {c.warnings.length ? (
          <ul className="list-disc pl-5 text-xs text-warning-text" aria-label="Calibration warnings">
            {c.warnings.map((w, i) => (
              <li key={i}>Warning: {w}</li>
            ))}
          </ul>
        ) : null}
        {c.guardrails.length ? (
          <table className="w-full text-xs tabular-nums" aria-label="Guardrail noise">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">
                  Guardrail <Help term="guardrail" />
                </th>
                <th className="px-2 py-1 text-right font-medium">A/A noise</th>
                <th className="px-2 py-1 text-right font-medium">CI half-width</th>
                <th className="px-2 py-1 text-right font-medium">Limit (step / total)</th>
                <th className="px-2 py-1 font-medium">Judged</th>
              </tr>
            </thead>
            <tbody>
              {c.guardrails.map((g) => (
                <tr key={g.name} className="border-t border-border align-top">
                  <td className="py-1 pr-2">{g.name}</td>
                  <td className="px-2 py-1 text-right">{frac(g.noise)}</td>
                  <td className="px-2 py-1 text-right">{frac(g.halfWidth)}</td>
                  <td className="px-2 py-1 text-right">
                    {frac(g.limit, 1)} / {frac(g.totalLimit, 1)}
                  </td>
                  <td className="py-1">
                    <GuardrailBadge state={g.judgeable ? "pass" : "inconclusive"} text={g.judgeable ? `rejected beyond about ${frac(g.limit + g.halfWidth, 1)} worse` : "too noisy to show within its limit"} title={g.text} />
                  </td>
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
