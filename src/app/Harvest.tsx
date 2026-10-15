// Harvest tab. v1: harvest freezes best and closes submissions; an agent
// turns the frozen best into PRs with the study-harvest skill, asking the
// plugin for every number (`bb study measure`) and check (`bb study gate`).
// The tab shows the freeze (base, best, the pinned ref, the promotions with
// their commit messages), the measurements and gates agents asked for, and a
// short guide with the prompt to give an agent. Harvests the plugin drafted
// before 1.0 stay readable: changesets, contributions, stacks, PR previews and
// publish results, without the old publish and keep/drop controls.
import { experimental_NewThreadComposer as NewThreadComposer, Markdown, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { HarvestView, OverviewResult } from "../views.ts";
import { ArchiveDialog, HarvestDialog } from "./Actions.tsx";
import { useLive, useStudyRpc, type Rpc } from "./data.ts";
import { ago, duration, sharePct, shortSha } from "./format.ts";
import { Callout, EmptyState, ErrorLine, Help, Mono, Section, Skeleton, Stat, StatePill, TabState } from "./ui.tsx";

type Harvest = NonNullable<HarvestView["harvest"]>;
type Changeset = Harvest["changesets"][number];
type Run = HarvestView["runs"][number];

export function HarvestTab({ slug, o, onOpenCandidate, onChanged }: { slug: string; o: OverviewResult; onOpenCandidate: (n: number) => void; onChanged: () => void }) {
  const rpc = useStudyRpc();
  const [selected, setSelected] = useState<number | null>(null);
  const v = useLive((r) => r.call("study.harvest", { slug, ...(selected !== null ? { harvestId: selected } : {}) }), [slug, selected], 5000);
  const [dialog, setDialog] = useState<null | "start" | "refreeze" | "archive">(null);
  const d = v.data;
  if (!d) return <TabState loading={v.loading} error={v.error} retry={v.refetch} label="the harvest" />;
  const h = d.harvest;
  const done = () => {
    v.refetch();
    onChanged();
  };
  const latestId = d.history[0]?.id ?? null;
  return (
    <div className="space-y-5">
      {v.error ? <ErrorLine error={`Live updates failed (showing the last data): ${v.error}`} retry={v.refetch} /> : null}
      {!h ? (
        <Section title="Harvest">
          <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-3 text-sm">
            <p>
              Harvest freezes <Mono>studies/{slug}/best</Mono> ({d.promotions} promotion{d.promotions === 1 ? "" : "s"}) so an agent can turn it into pull requests:
            </p>
            <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
              <li>New work stops; candidates in flight finish so best is final, and best is pinned.</li>
              <li>You ask an agent (the study thread works) to harvest it with the study-harvest skill.</li>
              <li>It reads the evidence, groups and splits the changes, builds the branches or stacks, and has the plugin measure and gate each one.</li>
              <li>It writes the PR descriptions in your repository's style and publishes only when you ask, with your repository's own tools.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!d.canStart} aria-describedby={d.cannotStartReason ? "harvest-cannot" : undefined} onClick={() => setDialog("start")}>
                Freeze best for harvest…
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
      ) : h.legacy ? (
        <LegacyHarvest h={h} onOpenCandidate={onOpenCandidate} />
      ) : (
        <FrozenHarvest h={h} o={o} guide={d.guide} onOpenCandidate={onOpenCandidate} />
      )}
      {h && (o.state === "harvesting" || o.state !== "archived") ? <NextSteps h={h} d={d} o={o} slug={slug} rpc={rpc} onChanged={done} onStart={() => setDialog("start")} onRefreeze={() => setDialog("refreeze")} onArchive={() => setDialog("archive")} /> : null}
      <Runs runs={d.runs} slug={slug} />
      {d.history.length > 1 ? (
        <Section title={`Harvest history (${d.history.length})`}>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {d.history.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <button
                  type="button"
                  className={cn("rounded font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", (h?.id ?? latestId) === x.id && "font-semibold")}
                  aria-current={(h?.id ?? latestId) === x.id ? "true" : undefined}
                  onClick={() => setSelected(x.id === latestId ? null : x.id)}
                >
                  h{x.seq}
                </button>
                <StatePill state={x.state} />
                {x.legacy ? <span className="text-xs text-muted-foreground">before 1.0</span> : null}
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
      {dialog === "start" || dialog === "refreeze" ? <HarvestDialog slug={slug} promotions={d.promotions} refreeze={dialog === "refreeze"} rpc={rpc} open onOpenChange={(x) => !x && setDialog(null)} onDone={done} /> : null}
      {dialog === "archive" ? <ArchiveDialog slug={slug} rpc={rpc} open onOpenChange={(x) => !x && setDialog(null)} onDone={done} /> : null}
    </div>
  );
}

/** A v1 harvest: the freeze and the promotions with their commit messages. */
function FrozenHarvest({ h, o, guide, onOpenCandidate }: { h: Harvest; o: OverviewResult; guide: HarvestView["guide"]; onOpenCandidate: (n: number) => void }) {
  return (
    <>
      <Section title={`Harvest h${h.seq}`}>
        <div className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={h.state} />
            <span className="text-xs text-muted-foreground">{h.state === "waiting" ? "in-flight candidates finish, then best freezes" : h.state === "frozen" ? "best is frozen: an agent harvests it" : null}</span>
          </div>
          {h.detail ? <p className="text-xs text-muted-foreground" aria-live="polite">{h.detail}</p> : null}
          {h.error ? <ErrorLine error={h.error} /> : null}
          {h.bestSha ? (
            <p className="text-xs text-muted-foreground">
              base <Mono>{shortSha(h.baseSha)}</Mono> → best <Mono>{shortSha(h.bestSha)}</Mono>
              {h.frozenRef ? (
                <>
                  {" "}
                  pinned as <Mono>{h.frozenRef}</Mono>
                </>
              ) : null}{" "}
              · started {ago(h.startedAt)}
              {h.finishedAt ? ` · frozen ${ago(h.finishedAt)}` : ""}
            </p>
          ) : null}
        </div>
      </Section>
      {h.state === "frozen" && o.state === "harvesting" ? <AgentGuide guide={guide} o={o} /> : null}
      {h.promotions.length ? (
        <Section title={`Promotions on best (${h.promotions.length}, oldest first)`}>
          <ul className="space-y-1.5" aria-label="Promotions">
            {h.promotions.map((p) => (
              <li key={p.sha} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Mono>{shortSha(p.sha)}</Mono>
                  {p.n !== null ? (
                    <button type="button" className="rounded font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenCandidate(p.n!)}>
                      c/{p.n}
                    </button>
                  ) : null}
                  <span className="min-w-0 flex-1 font-medium">{p.title}</span>
                  {p.effectText ? <span className="text-xs text-muted-foreground">{p.effectText} when promoted</span> : null}
                  <span className="text-xs text-muted-foreground">
                    {p.files} file{p.files === 1 ? "" : "s"}
                  </span>
                </div>
                {p.body ? (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Commit message</summary>
                    <pre className="mt-1 whitespace-pre-wrap font-sans">{p.body}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : h.state === "frozen" ? (
        <EmptyState>No promotions on best.</EmptyState>
      ) : null}
    </>
  );
}

/** How to get an agent to do the harvest: the prompt, a new thread with it, or the study thread. */
function AgentGuide({ guide, o }: { guide: HarvestView["guide"]; o: OverviewResult }) {
  const nav = useBbNavigate();
  const [composing, setComposing] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(guide.prompt);
      toast.success("Copied the prompt.");
    } catch {
      toast.error("Couldn't copy; select the text instead.");
    }
  };
  return (
    <Callout
      tone="action"
      title="Ask an agent to harvest it"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setComposing(true)}>
            Ask in a new thread…
          </Button>
          {o.studyThreadId ? (
            <Button size="sm" variant="outline" onClick={() => nav.toThread(o.studyThreadId!)}>
              Open the study thread
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void copy()}>
            Copy prompt
          </Button>
        </div>
      }
    >
      <p className="text-sm">
        Ask an agent to propose a PR plan from the frozen best. You approve the grouping first; the agent then builds branches and uses the plugin to measure and gate them. Publishing needs your separate approval.
      </p>
      <blockquote className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground" data-testid="harvest-prompt">
        {guide.prompt}
      </blockquote>
      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {guide.commands.map((c) => (
          <li key={c.command}>
            <Mono>{c.command}</Mono>: {c.what}
          </li>
        ))}
      </ul>
      {composing ? <HarvestComposer prompt={guide.prompt} projectId={o.projectId} onClose={() => setComposing(false)} /> : null}
    </Callout>
  );
}

function HarvestComposer({ prompt, projectId, onClose }: { prompt: string; projectId: string; onClose: () => void }) {
  const sdk = useSdk();
  const nav = useBbNavigate();
  const [focus, setFocus] = useState(1);
  useEffect(() => setFocus((f) => f + 1), []);
  return (
    <Dialog open onOpenChange={(x) => !x && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Harvest with an agent</DialogTitle>
          <DialogDescription>Starts a thread in this study's project with the prompt below. Edit it first if you like (for example, which review tool to publish with).</DialogDescription>
        </DialogHeader>
        <div className="min-h-40" data-testid="harvest-composer">
          <NewThreadComposer
            defaultProjectId={projectId}
            initialPrompt={prompt}
            focusRequest={focus}
            layout="document"
            draftKey="autoresearch:harvest"
            onSubmit={async (request) => {
              const thread = await sdk.threads.spawn(request);
              onClose();
              nav.toThread(thread.id);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NextSteps({ h, d, o, slug, rpc, onChanged, onStart, onRefreeze, onArchive }: { h: Harvest; d: HarvestView; o: OverviewResult; slug: string; rpc: Rpc; onChanged: () => void; onStart: () => void; onRefreeze: () => void; onArchive: () => void }) {
  const resume = async () => {
    try {
      toast.success((await rpc.call("study.resume", { slug })).message);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const waiting = h.state === "waiting";
  if (o.state === "archived") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {d.canStart ? (
        <Button size="sm" variant="outline" onClick={onStart}>
          Freeze best for a new harvest…
        </Button>
      ) : null}
      {/* Already frozen: freezing again is explicit, and offered only when it pins something new (best moved, or a freeze from before 1.0). */}
      {d.canRefreeze ? (
        <Button size="sm" variant="outline" onClick={onRefreeze}>
          Freeze best again as a new harvest…
        </Button>
      ) : null}
      {o.state === "harvesting" && !waiting ? (
        <Button size="sm" variant="outline" onClick={() => void resume()}>
          Keep exploring (resume)
        </Button>
      ) : null}
      {!waiting ? (
        <Button size="sm" variant="ghost" onClick={onArchive}>
          <Icon name="Archive" className="size-4" aria-hidden />
          Archive…
        </Button>
      ) : null}
    </div>
  );
}

/** `bb study measure` / `bb study gate` runs, newest first. */
function Runs({ runs, slug }: { runs: Run[]; slug: string }) {
  return (
    <Section title={`Measurements and gates agents asked for (${runs.length})`}>
      {runs.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm" aria-label="Measurements and gates">
          {runs.map((r) => (
            <li key={r.id} className="space-y-0.5 px-3 py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">r{r.seq}</span>
                <StatePill state={r.state} />
                <span className="text-xs">{r.kind === "measure" ? <>measure <Mono>{r.refB}</Mono> against <Mono>{r.refA ?? ""}</Mono></> : <>gate <Mono>{r.refB}</Mono></>}</span>
                <span className="text-xs text-muted-foreground">
                  {ago(r.requestedAt)}
                  {r.benchSeconds > 0 ? ` · bench ${duration(r.benchSeconds)}` : ""}
                </span>
              </div>
              <p className={cn("text-xs", r.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {r.state === "done" && r.result ? r.result.text : r.state === "failed" || r.state === "cancelled" ? r.error : (r.progress ?? r.state)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          None yet. An agent asks with <Mono>bb study measure {slug} &lt;A&gt; &lt;B&gt;</Mono> and <Mono>bb study gate {slug} &lt;ref&gt;</Mono>; every number it reports comes from here.
        </p>
      )}
    </Section>
  );
}

/** A harvest the plugin ran before 1.0, read only. */
function LegacyHarvest({ h, onOpenCandidate }: { h: Harvest; onOpenCandidate: (n: number) => void }) {
  const a = h.accounting;
  const onlyMissing = a.missing.length > 0 && (a.gap === null || a.gapHalfWidth === null || Math.abs(a.gap) <= a.gapHalfWidth);
  const running = false;
  return (
    <>
      <Section title={`Harvest h${h.seq} (drafted before 1.0, read only)`}>
        <div className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={h.state} />
            <span className="text-xs text-muted-foreground">The plugin grouped, measured and drafted this harvest itself. Since v1 an agent does that; it can start from these changesets, branches and drafts.</span>
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
              <ChangesetItem key={c.id} c={c} onOpenCandidate={onOpenCandidate} />
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
                <span className="font-medium">Stack {s.stack}:</span> <span className="font-mono">{s.order}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  PRs stacked in this order{s.contribution ? ` · together ${s.contribution.text}` : s.status === "not_needed" ? " · members measured one by one" : ` · joint measurement ${s.status}`}
                  {s.detail && s.status !== "not_needed" ? ` · ${s.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {h.published || h.exportDir ? (
        <Section title="Drafts and publishing (before 1.0)">
          <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            {h.published ? <PublishResults prs={h.published} /> : null}
            <p className="text-xs text-muted-foreground">
              {h.publishState === "published" ? "Published as draft PRs." : "Local branches only; nothing was pushed."}
              {h.exportDir ? (
                <>
                  {" "}
                  PR bodies and the report: <Mono>{h.exportDir}</Mono>
                </>
              ) : null}
            </p>
          </div>
        </Section>
      ) : null}
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

function ChangesetItem({ c, onOpenCandidate }: { c: Changeset; onOpenCandidate: (n: number) => void }) {
  return (
    <li className={cn("space-y-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm", c.choice === "drop" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">#{c.k}</span>
        <span className="min-w-0 flex-1 font-medium">{c.title}</span>
        {c.stack !== null ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">stack {c.stack}</span> : null}
        {c.foldedInto !== null ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">ships inside #{c.foldedInto}'s PR</span> : null}
        {c.ships.length ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">also ships {c.ships.map((k) => `#${k}`).join(", ")}</span> : null}
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
      {c.pr.body ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">PR preview{c.pr.title ? `: ${c.pr.title}` : ""}</summary>
          <PrPreview body={c.pr.body} k={c.k} />
        </details>
      ) : null}
    </li>
  );
}

/** Bodies longer than this start collapsed (a fade and "Show more"); shorter ones show whole. */
const PREVIEW_LINES = 24;
const PREVIEW_CHARS = 1600;

/** A PR body: whole when short; otherwise collapsed with a fade and a Show more / Show less toggle (never a hidden inner scroll). */
export function PrPreview({ body, k }: { body: string; k: number }) {
  const long = body.length > PREVIEW_CHARS || body.split("\n").length > PREVIEW_LINES;
  const [open, setOpen] = useState(false);
  const id = `pr-preview-${k}`;
  return (
    <div className="mt-1">
      <div id={id} data-testid="pr-preview" className={cn("relative rounded-md border border-border p-3", long && !open && "max-h-96 overflow-hidden")}>
        <Markdown content={body} />
        {long && !open ? <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-md bg-gradient-to-t from-card to-transparent" /> : null}
      </div>
      {long ? (
        <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" aria-expanded={open} aria-controls={id} onClick={() => setOpen((x) => !x)}>
          {open ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
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

