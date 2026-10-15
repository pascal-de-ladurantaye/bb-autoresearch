// Findings tab: what workers learned, searchable and filterable by outcome,
// theme, and the candidate's verdict (every facet with counts), paged.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { FindingsView } from "../views.ts";
import { useLive } from "./data.ts";
import { ago, pct, VERDICT } from "./format.ts";
import { EmptyState, ErrorLine, Skeleton, VerdictBadge } from "./ui.tsx";

const PAGE = 50;

/** `value` after it has been stable for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type VerdictFilter = "win" | "lose" | "inconclusive" | "gate_failed" | "conflict" | "rejected" | "none";

export function FindingsTab({ slug, onOpenCandidate }: { slug: string; onOpenCandidate: (n: number) => void }) {
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState("");
  const [theme, setTheme] = useState("");
  const [verdict, setVerdict] = useState("");
  const [pages, setPages] = useState(1);
  const query = useDebounced(input.trim(), 300);
  useEffect(() => setPages(1), [query, outcome, theme, verdict]);
  const list = useLive(
    (rpc) =>
      rpc.call("study.findings", {
        slug,
        ...(query ? { query } : {}),
        ...(outcome ? { outcome } : {}),
        ...(theme ? { theme } : {}),
        ...(verdict ? { verdict: verdict as VerdictFilter } : {}),
        limit: Math.min(500, PAGE * pages),
      }),
    [slug, query, outcome, theme, verdict, pages],
    15_000,
  );
  const d = list.data;
  const filtered = Boolean(query || outcome || theme || verdict);
  const select = "h-8 rounded-md border border-input bg-transparent px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
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
        <input className={`${select} min-w-40 flex-1`} placeholder="Search what was learned, revisit-if, evidence, idea, summary" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search findings" />
        <select className={select} value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filter by outcome">
          <option value="">All outcomes{d ? ` (${d.total})` : ""}</option>
          {(d?.outcomes ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.value} ({o.count})
            </option>
          ))}
        </select>
        <select className={select} value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Filter by theme">
          <option value="">All themes</option>
          {(d?.themes ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} ({o.count})
            </option>
          ))}
        </select>
        <select className={select} value={verdict} onChange={(e) => setVerdict(e.target.value)} aria-label="Filter by verdict">
          <option value="">All verdicts</option>
          {(d?.verdicts ?? []).map((v) => (
            <option key={v.value} value={v.value}>
              {VERDICT[v.value]?.label ?? v.label} ({v.count})
            </option>
          ))}
        </select>
        {d ? (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {d.findings.length} of {filtered ? `${d.matching} matching (${d.total} total)` : d.total}
          </span>
        ) : null}
      </form>
      <ErrorLine error={list.error} retry={list.refetch} />
      {!d ? (
        list.loading ? <Skeleton lines={5} label="Loading findings…" /> : <EmptyState>Findings unavailable.</EmptyState>
      ) : d.total === 0 ? (
        <EmptyState>No findings yet. Each worker records what it learned (why it won or lost, and when the idea is worth revisiting) before it finishes.</EmptyState>
      ) : d.findings.length === 0 ? (
        <EmptyState>No findings match{filtered ? " these filters" : ""}.</EmptyState>
      ) : (
        <>
          <ul className="space-y-2" aria-label="Findings">
            {d.findings.map((f) => (
              <FindingItem key={f.id} f={f} onOpenCandidate={onOpenCandidate} />
            ))}
          </ul>
          {d.findings.length < d.matching ? (
            <Button variant="outline" size="sm" disabled={list.loading} onClick={() => setPages((p) => p + 1)}>
              Show {Math.min(PAGE, d.matching - d.findings.length)} more
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function FindingItem({ f, onOpenCandidate }: { f: FindingsView["findings"][number]; onOpenCandidate: (n: number) => void }) {
  const nav = useBbNavigate();
  return (
    <li className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">Worker finding: {f.outcome.replace(/_/gu, " ")}</span>
        <span className="min-w-0 flex-1 truncate">
          {f.ideaId !== null ? `#${f.ideaId} ${f.ideaTitle ?? ""}` : <span className="text-muted-foreground">not tied to an idea</span>}
          <span className="ml-1 text-xs text-muted-foreground">· {f.theme ?? "no theme"}</span>
        </span>
        {f.candidate !== null ? (
          <button type="button" className="rounded font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenCandidate(f.candidate!)}>
            c/{f.candidate}
          </button>
        ) : null}
        {f.verdict ? <span className="inline-flex flex-wrap items-center gap-1 text-xs">Plugin verdict: <VerdictBadge verdict={f.verdict} /></span> : null}
        {f.effect !== null ? (
          <span className="text-xs tabular-nums" title={f.effectText ?? undefined}>
            {pct(f.effect)}
          </span>
        ) : null}
        {f.cause ? <span className="text-xs text-muted-foreground">{f.cause}</span> : null}
        <span className="text-xs text-muted-foreground">
          #{f.id} · {ago(f.createdAt)}
        </span>
        {f.threadId ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => nav.toThread(f.threadId!)}>
            <Icon name="MessageSquare" className="size-4" aria-hidden />
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
