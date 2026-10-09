import { experimental_Diff as Diff, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CandidateDetailView, CandidateView } from "../views.ts";
import { useLive } from "./data.ts";
import { ago, duration, metricChange, pct, shortSha, VERDICT_TONE, type Direction } from "./format.ts";
import { EmptyState, ErrorLine, Mono, Section } from "./ui.tsx";

const VERDICTS = ["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"] as const;
const STAGES = ["gating", "queued", "measuring", "confirming", "promoting", "decided"] as const;

export function CandidatesTab({ slug, direction, metric, selected, onSelect }: { slug: string; direction: Direction; metric: string; selected: number | null; onSelect: (n: number | null) => void }) {
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
    return q ? all.filter((c) => `${c.summary} ${c.ideaTitle ?? ""} c/${c.n}`.toLowerCase().includes(q)) : all;
  }, [list.data, query]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className="h-8 rounded-md border border-input bg-transparent px-2" value={verdict} onChange={(e) => setVerdict(e.target.value)} aria-label="Filter by verdict">
          <option value="">All verdicts</option>
          {VERDICTS.map((v) => (
            <option key={v} value={v}>
              {v}
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
      <ErrorLine error={list.error} />
      {selected !== null ? <CandidateDetail slug={slug} n={selected} direction={direction} metric={metric} onClose={() => onSelect(null)} /> : null}
      {list.loading && !list.data ? <EmptyState>Loading candidates…</EmptyState> : rows.length === 0 ? <EmptyState>No candidates match.</EmptyState> : <Table rows={rows} direction={direction} selected={selected} onSelect={onSelect} />}
    </div>
  );
}

function Table({ rows, direction, selected, onSelect }: { rows: CandidateView[]; direction: Direction; selected: number | null; onSelect: (n: number) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Idea</th>
            <th className="px-3 py-2 font-medium">Verdict</th>
            <th className="px-3 py-2 text-right font-medium">Effect</th>
            <th className="px-3 py-2 text-right font-medium">CI</th>
            <th className="px-3 py-2 text-right font-medium">Diff</th>
            <th className="px-3 py-2 text-right font-medium">Bench</th>
            <th className="px-3 py-2 font-medium">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.n} className={cn("cursor-pointer border-b border-border last:border-0 hover:bg-state-hover", selected === c.n && "bg-state-active")} onClick={() => onSelect(c.n)}>
              <td className="px-3 py-2 font-mono text-xs">c/{c.n}</td>
              <td className="max-w-80 px-3 py-2">
                <div className="truncate">{c.ideaTitle ?? `idea #${c.ideaId ?? "?"}`}</div>
                <div className="truncate text-xs text-muted-foreground">{c.summary}</div>
              </td>
              <td className={cn("px-3 py-2", c.verdict ? VERDICT_TONE[c.verdict] : "text-muted-foreground")}>
                {c.verdict ?? c.stage}
                {c.rebases ? <span className="text-xs text-muted-foreground"> · rebased</span> : null}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{metricChange(c.effect, direction)}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{c.ciLo !== null && c.ciHi !== null ? `${pct(c.ciLo)} … ${pct(c.ciHi)}` : "—"}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
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

function CandidateDetail({ slug, n, direction, metric, onClose }: { slug: string; n: number; direction: Direction; metric: string; onClose: () => void }) {
  const nav = useBbNavigate();
  const d = useLive((rpc) => rpc.call("study.candidate", { slug, n }), [slug, n], 15_000);
  const c: CandidateDetailView | null = d.data?.candidate ?? null;
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">
            c/{n} {c ? <span className={cn("ml-1", c.verdict ? VERDICT_TONE[c.verdict] : "text-muted-foreground")}>{c.verdict ?? c.stage}</span> : null}
            {c?.effect !== null && c?.effect !== undefined ? <span className="ml-2 tabular-nums">{metricChange(c.effect, direction)}</span> : null}
          </h3>
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
      <ErrorLine error={d.error} />
      {!c ? (
        d.loading ? <EmptyState>Loading…</EmptyState> : <EmptyState>Candidate not found.</EmptyState>
      ) : (
        <>
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
          <Section title="Summary">
            <p className="whitespace-pre-wrap text-sm">{c.summaryFull}</p>
          </Section>
          <Samples samples={c.samples} metric={metric} direction={direction} />
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

function Samples({ samples, metric, direction }: { samples: CandidateDetailView["samples"]; metric: string; direction: Direction }) {
  const pairs = useMemo(() => {
    const byKey = new Map<string, { run: string; pair: number; best?: number; candidate?: number }>();
    for (const s of samples) {
      if (s.metric !== metric) continue;
      const k = `${s.run}:${s.pair}`;
      const row = byKey.get(k) ?? { run: s.run, pair: s.pair };
      if (s.side === "best") row.best = s.value;
      else row.candidate = s.value;
      byKey.set(k, row);
    }
    return [...byKey.values()];
  }, [samples, metric]);
  if (!pairs.length) return null;
  return (
    <Section title={`Samples (${metric}, ${pairs.length} pairs)`}>
      <div className="max-h-56 overflow-auto rounded-md border border-border">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1 font-medium">run</th>
              <th className="px-2 py-1 font-medium">pair</th>
              <th className="px-2 py-1 text-right font-medium">best</th>
              <th className="px-2 py-1 text-right font-medium">candidate</th>
              <th className="px-2 py-1 text-right font-medium">change</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => {
              const imp = p.best !== undefined && p.candidate !== undefined && p.best !== 0 ? (direction === "lower" ? (p.best - p.candidate) / p.best : (p.candidate - p.best) / p.best) : null;
              return (
                <tr key={`${p.run}:${p.pair}`} className="border-t border-border">
                  <td className="px-2 py-1">{p.run}</td>
                  <td className="px-2 py-1">{p.pair}</td>
                  <td className="px-2 py-1 text-right">{p.best?.toPrecision(5) ?? "—"}</td>
                  <td className="px-2 py-1 text-right">{p.candidate?.toPrecision(5) ?? "—"}</td>
                  <td className="px-2 py-1 text-right">{metricChange(imp, direction)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
