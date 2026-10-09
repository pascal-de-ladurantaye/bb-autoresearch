// Findings tab: what workers learned, searchable and filterable by outcome,
// theme, and the candidate's verdict.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { FindingsView } from "../views.ts";
import { useLive } from "./data.ts";
import { ago, metricChange, VERDICT_TONE, type Direction } from "./format.ts";
import { EmptyState, ErrorLine } from "./ui.tsx";

const VERDICTS = ["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"] as const;
type Verdict = (typeof VERDICTS)[number];

/** `value` after it has been stable for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function FindingsTab({ slug, direction, onOpenCandidate }: { slug: string; direction: Direction; onOpenCandidate: (n: number) => void }) {
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState("");
  const [theme, setTheme] = useState("");
  const [verdict, setVerdict] = useState("");
  const query = useDebounced(input.trim(), 300);
  const list = useLive(
    (rpc) =>
      rpc.call("study.findings", {
        slug,
        ...(query ? { query } : {}),
        ...(outcome ? { outcome } : {}),
        ...(theme ? { theme } : {}),
        ...(verdict ? { verdict: verdict as Verdict } : {}),
        limit: 200,
      }),
    [slug, query, outcome, theme, verdict],
    15_000,
  );
  const d = list.data;
  const filtered = Boolean(query || outcome || theme || verdict);
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-center gap-2 text-sm"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          list.refetch();
        }}
      >
        <input className="h-8 min-w-40 flex-1 rounded-md border border-input bg-transparent px-2" placeholder="Search learned, revisit-if, evidence, idea, summary" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search findings" />
        <select className="h-8 rounded-md border border-input bg-transparent px-2" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filter by outcome">
          <option value="">All outcomes</option>
          {(d?.outcomes ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.value} ({o.count})
            </option>
          ))}
        </select>
        <select className="h-8 rounded-md border border-input bg-transparent px-2" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Filter by theme">
          <option value="">All themes</option>
          {(d?.themes ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.value} ({o.count})
            </option>
          ))}
        </select>
        <select className="h-8 rounded-md border border-input bg-transparent px-2" value={verdict} onChange={(e) => setVerdict(e.target.value)} aria-label="Filter by verdict">
          <option value="">All verdicts</option>
          {VERDICTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {d ? (
          <span className="text-xs text-muted-foreground">
            {d.findings.length} of {d.total}
          </span>
        ) : null}
      </form>
      <ErrorLine error={list.error} />
      {!d ? (
        list.loading ? <EmptyState>Loading findings…</EmptyState> : <EmptyState>Findings unavailable.</EmptyState>
      ) : d.total === 0 ? (
        <EmptyState>No findings yet. Workers record what they learned (study_record_finding) as they finish an idea.</EmptyState>
      ) : d.findings.length === 0 ? (
        <EmptyState>No findings match{filtered ? " these filters" : ""}.</EmptyState>
      ) : (
        <ul className="space-y-2" aria-label="Findings">
          {d.findings.map((f) => (
            <FindingItem key={f.id} f={f} direction={direction} onOpenCandidate={onOpenCandidate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingItem({ f, direction, onOpenCandidate }: { f: FindingsView["findings"][number]; direction: Direction; onOpenCandidate: (n: number) => void }) {
  const nav = useBbNavigate();
  return (
    <li className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{f.outcome}</span>
        <span className="min-w-0 flex-1 truncate">
          {f.ideaId !== null ? `#${f.ideaId} ` : ""}
          {f.ideaTitle ?? (f.ideaId === null ? "no idea" : "")}
          {f.theme ? <span className="ml-1 text-xs text-muted-foreground">· {f.theme}</span> : null}
        </span>
        {f.candidate !== null ? (
          <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => onOpenCandidate(f.candidate!)}>
            c/{f.candidate}
          </button>
        ) : null}
        {f.verdict ? <span className={cn("text-xs", VERDICT_TONE[f.verdict])}>{f.verdict}</span> : null}
        {f.effect !== null ? <span className="text-xs tabular-nums">{metricChange(f.effect, direction)}</span> : null}
        <span className="text-xs text-muted-foreground">#{f.id} · {ago(f.createdAt)}</span>
        {f.threadId ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => nav.toThread(f.threadId!)}>
            <Icon name="MessageSquare" className="size-4" />
            Thread
          </Button>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap">{f.learned}</p>
      {f.revisitIf ? (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Revisit if:</span> {f.revisitIf}
        </p>
      ) : null}
      {f.evidence ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Evidence</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">{f.evidence}</pre>
        </details>
      ) : null}
    </li>
  );
}
