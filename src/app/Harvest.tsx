// Harvest tab: turn the promotions on best into reviewable changesets.
// Starting a harvest here is always a DRY RUN (local branches and files);
// publishing draft PRs to GitHub is CLI-only, so the page shows the command.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HarvestView } from "../views.ts";
import { useLive, useStudyRpc } from "./data.ts";
import { ago, duration, metricChange, pct, shortSha, type Direction } from "./format.ts";
import { EmptyState, ErrorLine, Mono, Section, Stat, StatePill } from "./ui.tsx";

type Harvest = NonNullable<HarvestView["harvest"]>;
type Changeset = Harvest["changesets"][number];

const p2 = (v: number | null | undefined) => pct(v, 2);
const ciText = (lo: number | null, hi: number | null) => (lo === null || hi === null ? "" : ` (CI ${p2(lo)} … ${p2(hi)})`);


export function HarvestTab({ slug, direction, onOpenCandidate, onChanged }: { slug: string; direction: Direction; onOpenCandidate: (n: number) => void; onChanged: () => void }) {
  const rpc = useStudyRpc();
  const v = useLive((r) => r.call("study.harvest", { slug }), [slug], 5000);
  const [busy, setBusy] = useState(false);
  const start = async (restart: boolean) => {
    setBusy(true);
    try {
      const r = await rpc.call("study.harvest.start", { slug, ...(restart ? { restart: true } : {}) });
      toast.success(r.message);
      v.refetch();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const d = v.data;
  if (!d) return v.error ? <ErrorLine error={v.error} /> : <EmptyState>Loading harvest…</EmptyState>;
  const h = d.harvest;
  return (
    <div className="space-y-5">
      <ErrorLine error={v.error} />
      {!h ? (
        <Section title="Harvest">
          <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-3 text-sm">
            <p>
              Harvest turns the promotions on <Mono>studies/{slug}/best</Mono> into reviewable changesets: it stops new work, groups the promotions (the strategist proposes, or one per promotion), measures each changeset's contribution by ablating it from best, checks each alone on its PR base, and drafts a local branch and PR body for each. A harvest started here is a dry run: nothing is pushed.
            </p>
            <p className="text-muted-foreground">
              {d.promotions} promotion(s) on best · study is {d.state}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {d.canStart ? (
                <Button size="sm" disabled={busy || d.promotions === 0} onClick={() => void start(false)}>
                  Start harvest (dry run)
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Harvest starts from Running or Paused.</span>
              )}
              <span className="text-xs text-muted-foreground">
                or from a terminal: <Mono>{d.startCommand}</Mono>
              </span>
            </div>
          </div>
        </Section>
      ) : (
        <HarvestDetail h={h} slug={slug} direction={direction} onOpenCandidate={onOpenCandidate} restart={d.canStart && ["ready", "failed", "cancelled"].includes(h.state) ? () => void start(true) : null} busy={busy} />
      )}
      {d.history.length > 1 ? (
        <Section title={`Harvest history (${d.history.length})`}>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {d.history.map((x) => (
              <li key={x.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="font-mono text-xs">h{x.id}</span>
                <StatePill state={x.state} />
                <span className="text-xs text-muted-foreground">
                  started {ago(x.startedAt)}
                  {x.finishedAt ? ` · finished ${ago(x.finishedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Report slug={slug} />
    </div>
  );
}

function HarvestDetail({ h, slug, direction, onOpenCandidate, restart, busy }: { h: Harvest; slug: string; direction: Direction; onOpenCandidate: (n: number) => void; restart: (() => void) | null; busy: boolean }) {
  const a = h.accounting;
  const onlyMissing = a.missing.length > 0 && (a.gap === null || a.gapHalfWidth === null || Math.abs(a.gap) <= a.gapHalfWidth);
  return (
    <>
      <Section
        title={`Harvest h${h.id}`}
        actions={
          restart ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={restart}>
              Start a new harvest (dry run)
            </Button>
          ) : null
        }
      >
        <div className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={h.state} />
            {h.detail ? <span className="text-muted-foreground">{h.detail}</span> : null}
          </div>
          {h.error ? <ErrorLine error={h.error} /> : null}
          <p className="text-xs text-muted-foreground">
            base <Mono>{shortSha(h.baseSha)}</Mono> → best <Mono>{shortSha(h.bestSha)}</Mono> · started {ago(h.startedAt)}
            {h.finishedAt ? ` · finished ${ago(h.finishedAt)}` : ""} · bench {duration(h.benchSeconds)} · returns to {h.fromState} · standalone {h.measureStandalone ? "measured" : "gates only"}
          </p>
          {h.groupingSource ? (
            <p className="text-xs text-muted-foreground">
              Grouping: {h.groupingSource === "strategist" ? "proposed by the strategist" : "one changeset per promotion (fallback)"}
              {h.groupingNotes ? ` · ${h.groupingNotes}` : ""}
            </p>
          ) : null}
        </div>
      </Section>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Total gain (vs best)" value={h.total ? p2(h.total.value) : "not measured"} hint={h.total ? `${ciText(h.total.lo, h.total.hi).trim() || "no CI"}${h.total.n ? ` · n=${h.total.n}` : ""}` : undefined} />
        <Stat label="Best vs base" value={h.total?.vsBase !== null && h.total?.vsBase !== undefined ? metricChange(h.total.vsBase, direction) : "—"} />
        <Stat label="Sum of contributions" value={a.sum === null ? "—" : `${p2(a.sum)}${a.sumHalfWidth !== null ? ` ± ${(a.sumHalfWidth * 100).toFixed(2)}%` : ""}`} hint={`${a.items.filter((i) => i.value !== null).length} term(s)`} />
        <Stat label="Gap (total − sum)" value={a.gap === null ? "—" : p2(a.gap)} hint={a.gapHalfWidth !== null ? `CI half-width ${(a.gapHalfWidth * 100).toFixed(2)}%` : undefined} />
      </div>
      {a.interaction ? (
        <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {onlyMissing
            ? "Warning: some contributions could not be measured, so the sum does not account for the whole gain."
            : "Interaction warning: the gap is larger than its CI. The changesets interact (their effects do not add), so a PR's contribution depends on which others land with it."}
        </div>
      ) : a.gap !== null ? (
        <p className="text-xs text-muted-foreground">The contributions add up to the total gain within the CI.</p>
      ) : null}
      {a.missing.length ? <p className="text-xs text-muted-foreground">Not measured: {a.missing.join(", ")}</p> : null}

      <Section title={`Changesets (${h.changesets.length})`}>
        {h.changesets.length ? (
          <ul className="space-y-2" aria-label="Changesets">
            {h.changesets.map((c) => (
              <ChangesetItem key={c.id} c={c} onOpenCandidate={onOpenCandidate} />
            ))}
          </ul>
        ) : (
          <EmptyState>No changesets yet{h.state === "waiting" || h.state === "grouping" ? `: harvest is ${h.state}` : ""}.</EmptyState>
        )}
      </Section>

      {h.stacks.length ? (
        <Section title={`Stacks (${h.stacks.length})`}>
          <ul className="space-y-1 text-sm" aria-label="Stacks">
            {h.stacks.map((s) => (
              <li key={s.stack} className="rounded-md border border-border bg-card px-3 py-1.5">
                <span className="font-mono">{s.members.map((k) => `#${k}`).join(" → ")}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  stack {s.stack} · {s.status}
                  {s.estimate ? ` · ablated together ${p2(s.estimate.value)}${ciText(s.estimate.lo, s.estimate.hi)}` : ""}
                  {s.detail ? ` · ${s.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Publish">
        <div className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <p>
            Publisher {h.publisher} · {h.publishState ?? "not published"}
          </p>
          {h.exportDir ? (
            <p className="text-xs">
              Dry-run export (report.md, prs/*.md, manifest.json): <Mono>{h.exportDir}</Mono>
            </p>
          ) : null}
          {h.publishCommand ? (
            <p className="text-xs">
              Open DRAFT PRs on GitHub from a terminal: <Mono className="text-foreground">{h.publishCommand}</Mono>
            </p>
          ) : null}
          {h.state === "ready" ? (
            <p className="text-xs text-muted-foreground">
              Or keep exploring with <Mono>bb study resume {slug}</Mono>, or finish with <Mono>bb study archive {slug}</Mono>.
            </p>
          ) : null}
        </div>
      </Section>
    </>
  );
}

function ChangesetItem({ c, onOpenCandidate }: { c: Changeset; onOpenCandidate: (n: number) => void }) {
  const ab = c.ablation;
  return (
    <li className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">#{c.k}</span>
        <span className="min-w-0 flex-1 font-medium">{c.title}</span>
        {c.droppable ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">droppable</span> : null}
        {c.stack !== null ? <span className="text-xs text-muted-foreground">stack {c.stack}</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          {c.candidates.map((n, i) => (
            <span key={n}>
              {i ? ", " : ""}
              <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => onOpenCandidate(n)}>
                c/{n}
              </button>
            </span>
          ))}
        </span>
        <span className={cn(ab.contribution !== null && "text-foreground")}>
          contribution{" "}
          {ab.contribution !== null ? `${p2(ab.contribution)}${ciText(ab.ciLo, ab.ciHi)}${ab.n ? `, n=${ab.n}` : ""}` : `${ab.status}${ab.detail ? `: ${ab.detail}` : ""}`}
        </span>
        {c.dependsOn.length ? <span>depends on {c.dependsOn.map((k) => `#${k}`).join(", ")}</span> : null}
        {c.neededBy.length ? <span>needed by {c.neededBy.map((k) => `#${k}`).join(", ")}</span> : null}
        <span>standalone: {c.standalone.text}</span>
      </div>
      {c.dependencyReason ? <p className="text-xs text-muted-foreground">Dependency: {c.dependencyReason}</p> : null}
      {c.rationale ? <p className="whitespace-pre-wrap text-xs">{c.rationale}</p> : null}
      {c.pr.branch || c.pr.status || c.pr.url ? (
        <p className="text-xs text-muted-foreground">
          PR {c.pr.status ?? "not drafted"}
          {c.pr.branch ? (
            <>
              {" "}
              · branch <Mono>{c.pr.branch}</Mono>
            </>
          ) : null}
          {c.prBase ? ` · base ${c.prBase}` : ""}
          {c.pr.url ? (
            <>
              {" "}
              ·{" "}
              <a className="underline" href={c.pr.url} target="_blank" rel="noreferrer">
                {c.pr.url}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {c.pr.body ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">PR draft{c.pr.title ? `: ${c.pr.title}` : ""}</summary>
          <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">{c.pr.body}</pre>
        </details>
      ) : null}
    </li>
  );
}

function Report({ slug }: { slug: string }) {
  const rpc = useStudyRpc();
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setMd((await rpc.call("study.report", { slug })).markdown);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Section
      title="Study report"
      actions={
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
          {md === null ? "Load report" : "Refresh report"}
        </Button>
      }
    >
      <ErrorLine error={error} />
      {md !== null ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-xs" aria-label="Study report">{md}</pre> : null}
    </Section>
  );
}
