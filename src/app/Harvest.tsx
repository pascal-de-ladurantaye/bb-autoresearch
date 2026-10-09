// Harvest tab: turn the promotions on best into reviewable changesets.
// Every contribution is shown as a share of the base→best gain (plus points
// of the headline and metric units), with its CI; dependencies are spelled
// out in words; publishing is a confirmed step whose dialog lists exactly
// which branches go to which remote and which draft PRs open, and whose
// results (URLs or errors) stay on the page.
import { Markdown } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { HarvestView, OverviewResult } from "../views.ts";
import { ArchiveDialog, HarvestDialog } from "./Actions.tsx";
import { useLive, useStudyRpc, type Rpc } from "./data.ts";
import { ago, duration, sharePct, shortSha } from "./format.ts";
import { Callout, ConfirmDialog, EmptyState, ErrorLine, Help, Mono, Section, Skeleton, Stat, StatePill, TabState } from "./ui.tsx";

type Harvest = NonNullable<HarvestView["harvest"]>;
type Changeset = Harvest["changesets"][number];

const PHASES = ["waiting", "grouping", "ablating", "checking", "drafting", "ready"] as const;

export function HarvestTab({ slug, o, onOpenCandidate, onChanged }: { slug: string; o: OverviewResult; onOpenCandidate: (n: number) => void; onChanged: () => void }) {
  const rpc = useStudyRpc();
  const v = useLive((r) => r.call("study.harvest", { slug }), [slug], 5000);
  const [dialog, setDialog] = useState<null | "start" | "restart" | "archive">(null);
  const d = v.data;
  if (!d) return <TabState loading={v.loading} error={v.error} retry={v.refetch} label="the harvest" />;
  const h = d.harvest;
  const done = () => {
    v.refetch();
    onChanged();
  };
  return (
    <div className="space-y-5">
      {v.error ? <ErrorLine error={`Live updates failed (showing the last data): ${v.error}`} retry={v.refetch} /> : null}
      {!h ? (
        <Section title="Harvest" help="ablation">
          <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-3 text-sm">
            <p>Harvest turns the {d.promotions} promotion{d.promotions === 1 ? "" : "s"} on <Mono>studies/{slug}/best</Mono> into reviewable changesets, one PR each:</p>
            <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
              <li>New work stops; candidates in flight finish so best is final.</li>
              <li>The strategist groups the promotions into changesets (or one per promotion).</li>
              <li>Each changeset is reverted from best and measured: how much worse best gets is its contribution.</li>
              <li>Each is checked alone on its PR base, then drafted as a local branch with a PR body.</li>
            </ol>
            <p className="text-muted-foreground">A dry run: nothing is pushed until you publish.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!d.canStart} aria-describedby={d.cannotStartReason ? "harvest-cannot" : undefined} onClick={() => setDialog("start")}>
                Start harvest…
              </Button>
              {d.cannotStartReason ? (
                <span id="harvest-cannot" className="text-xs text-muted-foreground">
                  {d.cannotStartReason}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                CLI <Mono>{d.startCommand}</Mono>
              </span>
            </div>
          </div>
        </Section>
      ) : (
        <HarvestDetail h={h} slug={slug} o={o} rpc={rpc} onOpenCandidate={onOpenCandidate} onChanged={done} onRestart={d.canStart && ["ready", "failed", "cancelled"].includes(h.state) ? () => setDialog("restart") : null} onArchive={() => setDialog("archive")} />
      )}
      {d.history.length > 1 ? (
        <Section title={`Harvest history (${d.history.length})`}>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {d.history.map((x) => (
              <li key={x.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="font-mono text-xs">h{x.id}</span>
                <StatePill state={x.state} />
                {x.publishState && x.publishState !== "dry-run" ? <span className="text-xs">publish: {x.publishState}</span> : null}
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
      {dialog === "start" || dialog === "restart" ? <HarvestDialog slug={slug} promotions={d.promotions} restart={dialog === "restart"} rpc={rpc} open onOpenChange={(x) => !x && setDialog(null)} onDone={done} /> : null}
      {dialog === "archive" ? <ArchiveDialog slug={slug} rpc={rpc} open onOpenChange={(x) => !x && setDialog(null)} onDone={done} /> : null}
    </div>
  );
}

function Progress({ h }: { h: Harvest }) {
  const at = PHASES.indexOf(h.state as (typeof PHASES)[number]);
  if (at < 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Harvest progress">
      {PHASES.map((p, i) => (
        <li key={p} className={cn("flex items-center gap-1", i < at ? "text-muted-foreground" : i === at ? "font-medium text-foreground" : "text-muted-foreground/70")} aria-current={i === at ? "step" : undefined}>
          <span aria-hidden>{i < at ? "✓" : i === at ? "●" : "○"}</span>
          {p}
          {i < PHASES.length - 1 ? <Icon name="ChevronRight" className="size-3 text-muted-foreground" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

function HarvestDetail({ h, slug, o, rpc, onOpenCandidate, onChanged, onRestart, onArchive }: { h: Harvest; slug: string; o: OverviewResult; rpc: Rpc; onOpenCandidate: (n: number) => void; onChanged: () => void; onRestart: (() => void) | null; onArchive: () => void }) {
  const a = h.accounting;
  const onlyMissing = a.missing.length > 0 && (a.gap === null || a.gapHalfWidth === null || Math.abs(a.gap) <= a.gapHalfWidth);
  const [publishing, setPublishing] = useState(false);
  const resume = async () => {
    try {
      toast.success((await rpc.call("study.resume", { slug })).message);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const running = !["ready", "failed", "cancelled"].includes(h.state);
  return (
    <>
      <Section
        title={`Harvest h${h.id}`}
        actions={
          onRestart ? (
            <Button size="sm" variant="outline" onClick={onRestart}>
              Start a new harvest…
            </Button>
          ) : null
        }
      >
        <div className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={h.state} />
            <Progress h={h} />
          </div>
          {h.detail ? <p className="text-xs text-muted-foreground" aria-live="polite">{h.detail}</p> : null}
          {h.error ? <ErrorLine error={h.error} /> : null}
          <p className="text-xs text-muted-foreground">
            base <Mono>{shortSha(h.baseSha)}</Mono> → best <Mono>{shortSha(h.bestSha)}</Mono> · started {ago(h.startedAt)}
            {h.finishedAt ? ` · finished ${ago(h.finishedAt)}` : ""} · bench {duration(h.benchSeconds)} · standalone {h.measureStandalone ? "gated and measured" : "gated only"} · afterwards the study returns to {h.fromState}
          </p>
          {h.groupingSource ? (
            <p className="text-xs text-muted-foreground">
              Grouping: {h.groupingSource === "strategist" ? "proposed by the strategist" : `one changeset per promotion${h.groupingNotes ? ` (${h.groupingNotes})` : ""}`}
              {h.groupingSource === "strategist" && h.groupingNotes ? ` · ${h.groupingNotes}` : ""}
            </p>
          ) : null}
        </div>
      </Section>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <Stat
          className="col-span-2 md:col-span-1"
          label="Best vs base (measured now)"
          help="improvement"
          value={h.headline?.text ?? "not measured yet"}
          hint={h.headline ? [h.headline.raw, h.headline.ci].filter(Boolean).join(" · ") : running ? "measured during ablation" : undefined}
        />
        <Stat
          label="Explained by the changesets"
          help="ablation"
          value={a.explained === null ? "—" : `${sharePct(a.explained)}${a.explainedHalfWidth !== null ? ` ± ${sharePct(a.explainedHalfWidth)}` : ""}`}
          hint={`${a.items.filter((i) => i.value !== null).length} measured term(s)${a.missing.length ? `, not measured: ${a.missing.join(", ")}` : ""}`}
        />
        <Stat
          label="Unexplained"
          help="unexplained"
          value={a.unexplained === null ? "—" : sharePct(a.unexplained)}
          hint={a.unexplainedHalfWidth !== null ? `noise allows ± ${sharePct(a.unexplainedHalfWidth)}` : undefined}
        />
      </div>
      {a.interaction && a.severity === "slight" ? (
        <Callout tone="info" title={`The contributions add up to ${sharePct(a.explained, 1)} of the gain: slightly more off than the noise allows (± ${sharePct(a.unexplainedHalfWidth, 1)}).`}>
          Small gaps like this are common at this many pairs (the CIs are a little narrow). A large gap would mean the changes interact.
        </Callout>
      ) : a.interaction ? (
        <Callout tone="alert" title={onlyMissing ? "Some contributions could not be measured, so the sum doesn't cover the whole gain." : "The changes interact: their contributions don't add up to the total."}>
          {onlyMissing ? "See the changesets marked “not measured alone” below." : "A PR's contribution depends on which others land with it. Review them as a set."}
        </Callout>
      ) : a.gap !== null ? (
        <p className="text-xs text-muted-foreground">✓ The contributions add up to the measured gain within the noise.</p>
      ) : null}

      <Section title={`Changesets (${h.changesets.length})`} help="dependency">
        {h.changesets.length ? (
          <ul className="space-y-2" aria-label="Changesets">
            {h.changesets.map((c) => (
              <ChangesetItem key={c.id} c={c} h={h} slug={slug} rpc={rpc} onOpenCandidate={onOpenCandidate} onChanged={onChanged} />
            ))}
          </ul>
        ) : running ? (
          <Skeleton lines={3} label={`Harvest is ${h.state}…`} />
        ) : (
          <EmptyState>No changesets.</EmptyState>
        )}
      </Section>

      {h.stacks.length ? (
        <Section title={`Stacks (${h.stacks.length})`} help="stack">
          <ul className="space-y-1 text-sm" aria-label="Stacks">
            {h.stacks.map((s) => (
              <li key={s.stack} className="rounded-md border border-border bg-card px-3 py-1.5">
                <span className="font-medium">Stack {s.stack}:</span> <span className="font-mono">{s.members.map((k) => `#${k}`).join(" → ")}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  PRs stacked in this order{s.contribution ? ` · together ${s.contribution.text}` : s.status === "not_needed" ? " · members measured one by one" : ` · joint measurement ${s.status}`}
                  {s.detail && s.status !== "not_needed" ? ` · ${s.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Publish and next steps">
        <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          {h.published ? <PublishResults prs={h.published} /> : null}
          {h.publishState === "failed" && !h.published && h.error ? <ErrorLine error={h.error} /> : null}
          <p className="text-xs text-muted-foreground">
            {h.publishState === "published" ? "Published as draft PRs on GitHub." : "Dry run so far: local branches only, nothing pushed."}
            {h.exportDir ? (
              <>
                {" "}
                PR bodies and the report: <Mono>{h.exportDir}</Mono>
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {h.canPublish ? (
              <Button size="sm" onClick={() => setPublishing(true)}>
                <Icon name="GitPullRequest" className="size-4" aria-hidden />
                Publish draft PRs…
              </Button>
            ) : null}
            {o.state === "harvesting" && !running ? (
              <Button size="sm" variant="outline" onClick={() => void resume()}>
                Keep exploring (resume)
              </Button>
            ) : null}
            {o.state !== "archived" && !running ? (
              <Button size="sm" variant="ghost" onClick={onArchive}>
                <Icon name="Archive" className="size-4" aria-hidden />
                Archive…
              </Button>
            ) : null}
            {h.publishCommand ? (
              <span className="text-xs text-muted-foreground">
                CLI <Mono>{h.publishCommand}</Mono>
              </span>
            ) : null}
          </div>
        </div>
      </Section>
      {publishing ? <PublishDialog slug={slug} harvestId={h.id} rpc={rpc} onClose={() => setPublishing(false)} onDone={onChanged} /> : null}
    </>
  );
}

function PublishResults({ prs }: { prs: NonNullable<Harvest["published"]> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" aria-label="Publish results">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-medium">#</th>
            <th className="py-1 pr-2 font-medium">Branch → base</th>
            <th className="py-1 pr-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((p) => (
            <tr key={p.changesetId} className="border-t border-border align-top">
              <td className="py-1 pr-2">#{p.k}</td>
              <td className="py-1 pr-2 font-mono">
                {p.branch} → {p.baseBranch}
              </td>
              <td className={cn("py-1 pr-2", p.status === "opened" ? "text-success" : p.status === "failed" || p.status === "pushed" ? "text-destructive" : "text-muted-foreground")}>
                {p.status === "opened" ? "✓ draft PR opened" : p.status === "pushed" ? "⚠ pushed, PR not opened" : p.status === "failed" ? "✗ failed" : "— skipped"}
                {p.url ? (
                  <>
                    {" "}
                    <a className="underline" href={p.url} target="_blank" rel="noreferrer">
                      {p.url}
                    </a>
                  </>
                ) : null}
                {p.detail && p.status !== "opened" ? <div className="text-muted-foreground">{p.detail}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PublishDialog({ slug, harvestId, rpc, onClose, onDone }: { slug: string; harvestId: number; rpc: Rpc; onClose: () => void; onDone: () => void }) {
  const plan = useLive((r) => r.call("study.harvest.plan", { slug, harvestId }), [slug, harvestId], 60_000);
  const p = plan.data;
  const pushing = p?.prs.filter((x) => x.push) ?? [];
  return (
    <ConfirmDialog
      open
      onOpenChange={(x) => !x && onClose()}
      title={`Publish harvest h${harvestId} as draft PRs`}
      description="This pushes branches to GitHub and opens draft PRs. It is a human control, recorded in the audit log, the same as the CLI command."
      confirmLabel={p ? `Push ${pushing.length} branch${pushing.length === 1 ? "" : "es"} and open draft PRs` : "Publish"}
      disabled={!p || !p.ok || !pushing.length}
      onConfirm={async () => {
        try {
          const r = await rpc.call("study.harvest.publish", { slug, harvestId, confirm: true });
          toast.success(r.message.split("\n")[0] ?? r.message);
        } finally {
          onDone();
        }
      }}
    >
      {!p ? (
        plan.error ? <ErrorLine error={plan.error} retry={plan.refetch} /> : <Skeleton lines={3} label="Checking the remote…" />
      ) : (
        <>
          <p>
            Remote <Mono className="text-foreground">{p.remote}</Mono>
            {p.remoteUrl ? (
              <>
                {" "}
                (<Mono>{p.remoteUrl}</Mono>)
              </>
            ) : null}
          </p>
          {p.problem ? (
            <Callout tone="alert" title="Publishing can't run yet">
              {p.problem}
            </Callout>
          ) : null}
          <ul className="space-y-1">
            {p.prs.map((x) => (
              <li key={x.k} className="rounded-md border border-border px-2 py-1 text-xs">
                <div className="font-medium">
                  #{x.k} {x.title}
                </div>
                {x.push ? (
                  <div className="text-muted-foreground">
                    push <Mono>{x.branch}</Mono> → draft PR into <Mono>{x.base}</Mono>
                    {x.stacked ? " (stacked)" : ""}
                  </div>
                ) : (
                  <div className="text-muted-foreground">skipped: {x.skip}</div>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            CLI equivalent: <Mono>bb study harvest {slug} --publish</Mono>
          </p>
        </>
      )}
    </ConfirmDialog>
  );
}

function ChangesetItem({ c, h, slug, rpc, onOpenCandidate, onChanged }: { c: Changeset; h: Harvest; slug: string; rpc: Rpc; onOpenCandidate: (n: number) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const choose = async (choice: "keep" | "drop" | null) => {
    setBusy(true);
    try {
      toast.success((await rpc.call("study.harvest.choice", { slug, harvestId: h.id, k: c.k, choice })).message);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const editable = h.state === "ready" && h.publishState !== "published";
  return (
    <li className={cn("space-y-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm", c.choice === "drop" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">#{c.k}</span>
        <span className="min-w-0 flex-1 font-medium">{c.title}</span>
        {c.stack !== null ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">stack {c.stack}</span> : null}
        {c.droppable ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning-text">
            droppable <Help term="droppable" />
          </span>
        ) : null}
        {c.choice === "drop" ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">you dropped it</span> : c.choice === "keep" ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">you keep it</span> : null}
      </div>
      <p>
        {c.contribution ? (
          <>
            <span className="font-medium">Contributes {c.contribution.text}</span>
            {c.contribution.detail ? <span className="text-muted-foreground"> · {c.contribution.detail}</span> : null}
            {c.ablation.n ? <span className="text-muted-foreground"> · {c.ablation.n} pairs</span> : null}
          </>
        ) : c.ablation.status === "pending" ? (
          <span className="text-muted-foreground">Contribution: measuring…</span>
        ) : (
          <span className="text-muted-foreground">Not measured alone ({c.ablation.status.replace(/_/gu, " ")}); see below.</span>
        )}
      </p>
      {c.explanation.map((line, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          {line}
        </p>
      ))}
      <p className="text-xs">
        <span className="text-muted-foreground">Alone on its PR base ({c.prBaseText}):</span> {c.standalone.summary}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          From{" "}
          {c.candidates.map((n, i) => (
            <span key={n}>
              {i ? ", " : ""}
              <button type="button" className="rounded font-mono underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenCandidate(n)}>
                c/{n}
              </button>
            </span>
          ))}
        </span>
        {c.pr.branch ? (
          <span>
            branch <Mono>{c.pr.branch}</Mono>
          </span>
        ) : null}
        {c.pr.url ? (
          <a className="underline" href={c.pr.url} target="_blank" rel="noreferrer">
            {c.pr.url}
          </a>
        ) : null}
        {c.pr.published && c.pr.published.status !== "opened" ? <span className="text-destructive">publish: {c.pr.published.status}{c.pr.published.detail ? ` (${c.pr.published.detail})` : ""}</span> : null}
      </div>
      {c.rationale ? <p className="whitespace-pre-wrap text-xs">{c.rationale}</p> : null}
      {editable && c.droppable && c.canDrop ? (
        <fieldset className="flex flex-wrap items-center gap-3 text-xs">
          <legend className="sr-only">Publish #{c.k}?</legend>
          <span className="text-muted-foreground">No measurable contribution. Publish it anyway?</span>
          <label className="flex items-center gap-1">
            <input type="radio" name={`choice-${c.id}`} disabled={busy} checked={c.choice !== "drop"} onChange={() => void choose("keep")} /> Keep (publish)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name={`choice-${c.id}`} disabled={busy} checked={c.choice === "drop"} onChange={() => void choose("drop")} /> Drop (skip when publishing)
          </label>
        </fieldset>
      ) : null}
      {c.pr.body ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">PR preview{c.pr.title ? `: ${c.pr.title}` : ""}</summary>
          <div className="mt-1 max-h-96 overflow-auto rounded-md border border-border p-3">
            <Markdown content={c.pr.body} />
          </div>
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
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
          {loading ? "Loading…" : md === null ? "Show report" : "Refresh report"}
        </Button>
      }
    >
      <ErrorLine error={error} retry={() => void load()} />
      {md !== null ? (
        <div className="max-h-[40rem] overflow-auto rounded-md border border-border bg-card p-4 text-sm" aria-label="Study report">
          <Markdown content={md} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Trajectory, wins, notable losses and why, the dossier, calibration, and this harvest, as Markdown (also `bb study report {slug}`).</p>
      )}
    </Section>
  );
}

