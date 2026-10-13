import { experimental_Diff as Diff, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CandidateDetailView, CandidateView } from "../views.ts";
import { useLive } from "./data.ts";
import { ago, ciRangeText, ciText, duration, formatValue, improvementText, pct, shortSha, valueWithUnit, VERDICT, type MetricInfo } from "./format.ts";
import { EmptyState, ErrorLine, GuardrailBadge, Help, Mono, Section, Skeleton, VerdictBadge } from "./ui.tsx";
import type { NoiseClass } from "../present.ts";
import { sampleTableRows, SAMPLE_ROWS_SHOWN } from "../sample-rows.ts";
import { Measurement } from "./live/CiBand.tsx";

const VERDICTS = ["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"] as const;
const STAGES = ["gating", "queued", "measuring", "confirming", "promoting", "decided"] as const;

export function CandidatesTab({ slug, metric, selected, onSelect }: { slug: string; metric: MetricInfo; selected: number | null; onSelect: (n: number | null) => void }) {
  const [verdict, setVerdict] = useState<string>("");
  const [stage, setStage] = useState<string>("");
  const [query, setQuery] = useState("");
  const list = useLive(
    (rpc) =>
      rpc.call("study.candidates", {
        slug,
        ...(verdict ? { verdict: verdict as (typeof VERDICTS)[number] } : {}),
        ...(stage ? { stage: stage as (typeof STAGES)[number] } : {}),
        limit: 500,
      }),
    [slug, verdict, stage],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list.data?.candidates ?? [];
    return q ? all.filter((c) => `${c.title} ${c.summary} ${c.ideaTitle ?? ""} c/${c.n}`.toLowerCase().includes(q)) : all;
  }, [list.data, query]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className="h-8 rounded-md border border-input bg-transparent px-2" value={verdict} onChange={(e) => setVerdict(e.target.value)} aria-label="Filter by verdict">
          <option value="">All verdicts</option>
          {VERDICTS.map((v) => (
            <option key={v} value={v}>
              {VERDICT[v]?.label ?? v}
            </option>
          ))}
        </select>
        <select className="h-8 rounded-md border border-input bg-transparent px-2" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="">All stages</option>
          {STAGES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <input className="h-8 min-w-40 flex-1 rounded-md border border-input bg-transparent px-2" placeholder="Search summaries" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search candidates" />
        <span className="text-xs text-muted-foreground">{rows.length} shown</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Improvement is against the best at the time each candidate was measured; better is positive ({metric.name}, {metric.direction} is better). <Help term="ci" />
      </p>
      <ErrorLine error={list.error} retry={list.refetch} />
      {selected !== null ? <CandidateDetail slug={slug} n={selected} metric={metric} onClose={() => onSelect(null)} /> : null}
      {list.loading && !list.data ? (
        <Skeleton lines={5} label="Loading candidates…" />
      ) : rows.length === 0 ? (
        <EmptyState>{list.data?.candidates.length ? "No candidates match these filters." : "No candidates yet: workers submit them once the study is running."}</EmptyState>
      ) : (
        <Table rows={rows} metric={metric} selected={selected} onSelect={onSelect} />
      )}
    </div>
  );
}

function Table({ rows, metric, selected, onSelect }: { rows: CandidateView[]; metric: MetricInfo; selected: number | null; onSelect: (n: number) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm" aria-label="Candidates">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Idea</th>
            <th className="px-3 py-2 font-medium">Verdict</th>
            <th className="px-3 py-2 text-right font-medium">Improvement</th>
            <th className="px-3 py-2 text-right font-medium">CI</th>
            <th className="px-3 py-2 font-medium">Guardrails</th>
            <th className="px-3 py-2 text-right font-medium">Diff</th>
            <th className="px-3 py-2 text-right font-medium">Bench</th>
            <th className="px-3 py-2 font-medium">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.n} className={cn("cursor-pointer border-b border-border last:border-0 hover:bg-state-hover", selected === c.n && "bg-state-active")} onClick={() => onSelect(c.n)}>
              <td className="px-3 py-2 font-mono text-xs">
                <button type="button" className="rounded underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open c/${c.n}`} onClick={(e) => (e.stopPropagation(), onSelect(c.n))}>
                  c/{c.n}
                </button>
              </td>
              <td className="max-w-80 px-3 py-2">
                <div className="truncate">{c.ideaTitle ?? `idea #${c.ideaId ?? "?"}`}</div>
                <div className="truncate text-xs text-muted-foreground">{c.title}</div>
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <VerdictBadge verdict={c.verdict} stage={c.stage} />
                {c.rebases ? <span className="text-xs text-muted-foreground"> · rebased</span> : null}
                {c.cause ? <div className="max-w-56 truncate text-xs text-muted-foreground" title={c.cause}>{c.cause}</div> : null}
              </td>
              <td className="px-3 py-2 text-right tabular-nums" title={c.effectText ?? undefined}>
                {pct(c.effect)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{ciRangeText(c.ciLo, c.ciHi)}</td>
              <td className="px-3 py-2">
                <GuardrailBadge state={c.guardrails.state} text={c.guardrails.text} title={c.guardrails.list.map((g) => `${g.name}: ${g.text}`).join("\n") || undefined} />
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                {c.files}f +{c.linesAdded}/−{c.linesDeleted}
              </td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{c.benchSeconds ? duration(c.benchSeconds) : "—"}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{ago(c.submittedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function splitPatch(patch: string): Array<{ path: string; patch: string }> {
  const parts = patch.split(/^(?=diff --git )/mu).filter((p) => p.startsWith("diff --git "));
  return parts.map((p) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(p);
    return { path: m?.[2] ?? "file", patch: p };
  });
}

function CandidateDetail({ slug, n, metric, onClose }: { slug: string; n: number; metric: MetricInfo; onClose: () => void }) {
  const nav = useBbNavigate();
  const d = useLive((rpc) => rpc.call("study.candidate", { slug, n }), [slug, n], 15_000);
  const c: CandidateDetailView | null = d.data?.candidate ?? null;
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">
            c/{n}{" "}
            {c ? (
              <span className="ml-1">
                <VerdictBadge verdict={c.verdict} stage={c.stage} />
              </span>
            ) : null}
          </h3>
          {c?.effect !== null && c?.effect !== undefined ? (
            <p className="text-sm tabular-nums">
              {improvementText(c.effect, metric, { digits: 2 })} than the best it was measured against
              {c.ciLo !== null && c.ciHi !== null ? <span className="text-muted-foreground"> ({ciText(c.ciLo, c.ciHi, 2)})</span> : null}
              <span className="text-muted-foreground"> · {c.effectStatistic}</span>
              {c.cause ? <span className="font-medium">, but {c.cause}</span> : null}
            </p>
          ) : c?.cause ? (
            <p className="text-sm">{c.cause}</p>
          ) : null}
          {c ? <p className="text-sm text-muted-foreground">{c.ideaTitle ?? `idea #${c.ideaId ?? "?"}`}</p> : null}
        </div>
        {c?.threadId ? (
          <Button size="sm" variant="outline" onClick={() => nav.toThread(c.threadId!)}>
            <Icon name="MessageSquare" className="size-4" />
            Worker thread
          </Button>
        ) : null}
        <Button size="icon" variant="ghost" className="size-8" aria-label="Close" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </Button>
      </div>
      <ErrorLine error={d.error} retry={d.refetch} />
      {!c ? (
        d.loading ? <Skeleton lines={4} label={`Loading c/${n}…`} /> : <EmptyState>Candidate c/{n} not found.</EmptyState>
      ) : (
        <>
          {c.band ? (
            <Section title="How the verdict formed">
              <Measurement band={c.band} card={{ stage: c.stage, verdict: c.verdict, cause: c.cause, ideaTitle: c.ideaTitle ?? "" }} hostName={c.hostName} metric={metric} compact={false} onOpenCandidate={() => undefined} bare />
            </Section>
          ) : null}
          <MetricsTable rows={c.metricRows} metric={metric} headline={c.effect} statistic={c.effectStatistic} />
          <Section title="Verdict">
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {c.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              measured against <Mono>{shortSha(c.againstSha)}</Mono> · prepared <Mono>{shortSha(c.preparedSha)}</Mono>
              {c.promotedSha ? (
                <>
                  {" "}
                  · promoted <Mono>{shortSha(c.promotedSha)}</Mono>
                </>
              ) : null}{" "}
              · ref <Mono>{c.ref}</Mono>
            </p>
          </Section>
          <Section title={c.commit.fromWorker ? "Commit message (the worker's)" : "Summary"}>
            {c.commit.fromWorker ? (
              <div className="space-y-1 rounded-md border border-border bg-card px-3 py-2" aria-label="Commit message">
                <p className="text-sm font-medium">{c.commit.title}</p>
                {c.commit.body ? <p className="whitespace-pre-wrap text-sm">{c.commit.body}</p> : null}
                <p className="text-xs text-muted-foreground">
                  Used verbatim for this candidate's commit{c.promotedSha ? " and its commit on best" : ""}; the plugin only adds its <Mono>Autoresearch-Study</Mono> and <Mono>Autoresearch-Candidate</Mono> trailers.
                </p>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-sm">{c.summaryFull}</p>
            )}
          </Section>
          <Samples samples={c.samples} metric={metric} noise={c.noise} />
          {c.gateOutput ? (
            <Section title="Gate / build output (tail)">
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">{c.gateOutput}</pre>
            </Section>
          ) : null}
          {c.diag.length ? (
            <Section title="Diagnostics">
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">{c.diag.join("\n")}</pre>
            </Section>
          ) : null}
          <Section title={`Diff${c.diff ? ` · ${c.diff.files.length} file(s)` : ""}`}>
            {c.diffError ? <ErrorLine error={c.diffError} /> : null}
            {c.diff ? (
              <div className="space-y-2">
                <ul className="text-xs">
                  {c.diff.files.map((f) => (
                    <li key={f.path} className="flex justify-between gap-2 font-mono">
                      <span className="truncate">{f.path}</span>
                      <span className="shrink-0 text-muted-foreground">
                        +{f.added} −{f.deleted}
                      </span>
                    </li>
                  ))}
                </ul>
                {splitPatch(c.diff.patch).map((p) => (
                  <details key={p.path} className="rounded-md border border-border">
                    <summary className="cursor-pointer px-2 py-1 font-mono text-xs">{p.path}</summary>
                    <Diff patch={p.patch} path={p.path} />
                  </details>
                ))}
                {c.diff.truncated ? <p className="text-xs text-muted-foreground">Patch truncated; see the ref in git.</p> : null}
              </div>
            ) : null}
          </Section>
        </>
      )}
    </div>
  );
}

/** Every recorded metric of the measurement: primary, guardrails (limit and status), informational. */
function MetricsTable({ rows, metric, headline, statistic }: { rows: CandidateDetailView["metricRows"]; metric: MetricInfo; headline: number | null; statistic: string }) {
  if (!rows.length) return null;
  const primary = rows.find((r) => r.kind === "primary");
  // The table compares the two sides' medians; the headline is the verdict's estimate. Say so when they differ.
  const differs = primary?.improvement != null && headline !== null && pct(primary.improvement, 2) !== pct(headline, 2);
  return (
    <Section title="Metrics (median of each side, best vs candidate)" help="guardrail">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs tabular-nums" aria-label="Metrics">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1 font-medium">Metric</th>
              <th className="px-2 py-1 text-right font-medium">Best</th>
              <th className="px-2 py-1 text-right font-medium">Candidate</th>
              <th className="px-2 py-1 font-medium">Change between the medians (better is +)</th>
              <th className="px-2 py-1 font-medium">Guardrail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-border align-top">
                <td className="px-2 py-1">
                  <span className="font-medium">{r.name}</span>
                  <span className="ml-1 text-muted-foreground">{r.kind === "primary" ? `primary · ${metric.direction} is better` : r.kind === "guardrail" ? `guardrail · ${r.direction} is better` : "informational"}</span>
                </td>
                <td className="px-2 py-1 text-right">{r.kind === "primary" ? valueWithUnit(r.best, r.unit) : formatValue(r.best)}</td>
                <td className="px-2 py-1 text-right">{r.kind === "primary" ? valueWithUnit(r.candidate, r.unit) : formatValue(r.candidate)}</td>
                <td className="px-2 py-1">{r.improvement !== null ? `${pct(r.improvement, 2)} · ${r.text}` : r.text}</td>
                <td className="px-2 py-1">{r.guardrail ? <GuardrailBadge state={r.guardrail.state} text={r.guardrail.label} /> : <span className="text-muted-foreground">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {differs ? (
        <p className="text-xs text-muted-foreground" data-statistic-note>
          The headline {pct(headline, 2)} is the {statistic}; this table compares the median of each side ({pct(primary!.improvement, 2)}). Both describe the same samples; the verdict uses the first.
        </p>
      ) : null}
    </Section>
  );
}

function Samples({ samples, metric, noise }: { samples: CandidateDetailView["samples"]; metric: MetricInfo; noise: NoiseClass }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => sampleTableRows(samples, metric, noise), [samples, metric, noise]);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, SAMPLE_ROWS_SHOWN);
  const unit = noise === "noisy" ? (rows.length === 1 ? "pair" : "pairs") : rows.length === 1 ? "row" : "rows";
  return (
    <Section title={`Samples (${metric.name}, ${rows.length} ${unit})`}>
      {/* No inner scroll box: the rows are all on the page, the long tail behind "Show all". */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs tabular-nums" aria-label="Samples">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1 font-medium">run</th>
              <th className="px-2 py-1 font-medium">{noise === "noisy" ? "pair" : "sample"}</th>
              <th className="px-2 py-1 text-right font-medium">best</th>
              <th className="px-2 py-1 text-right font-medium">candidate</th>
              <th className="px-2 py-1 text-right font-medium">change (better is +)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.key} className="border-t border-border">
                <td className="px-2 py-1">{p.run}</td>
                <td className="px-2 py-1">{p.label}</td>
                <td className="px-2 py-1 text-right">{p.best?.toPrecision(5) ?? "—"}</td>
                <td className="px-2 py-1 text-right">{p.candidate?.toPrecision(5) ?? "—"}</td>
                <td className="px-2 py-1 text-right">{p.change === null ? "—" : pct(p.change, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > SAMPLE_ROWS_SHOWN ? (
        <Button size="sm" variant="ghost" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? `Show the first ${SAMPLE_ROWS_SHOWN}` : `Show all ${rows.length} ${unit}`}
        </Button>
      ) : null}
    </Section>
  );
}
