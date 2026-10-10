// The "Studies" nav panel: a list of studies at the root, and a study page
// at /plugins/bb-autoresearch/studies/<slug>[/<tab>[/<candidate>]].
//
// Information hierarchy: the header says the state and what the study is
// doing now; "Needs you" comes first on the Overview; then best vs base,
// what's running, and the details. The study page is the primary surface;
// the study thread is the conversation with the strategist.
import { experimental_NewThreadComposer as NewThreadComposer, useBbContext, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BenchTab } from "./Bench.tsx";
import { CandidatesTab } from "./Candidates.tsx";
import { useLive, useStudyRpc } from "./data.ts";
import { FindingsTab } from "./Findings.tsx";
import { ago, duration } from "./format.ts";
import { HarvestTab } from "./Harvest.tsx";
import { IdeasTab } from "./Ideas.tsx";
import { LiveStudy } from "./live/LiveStudy.tsx";
import { requestOpenBeside } from "./live/openBeside.ts";
import { replayPath } from "./live/routes.ts";

export { replayPath } from "./live/routes.ts";
import { OracleTab } from "./Oracle.tsx";
import { OverviewTab } from "./Overview.tsx";
import { EmptyState, ErrorLine, FOCUS_RING, Skeleton, StatePill, Tabs } from "./ui.tsx";

const TABS = ["live", "overview", "ideas", "candidates", "findings", "oracle", "bench", "harvest"] as const;
export type Tab = (typeof TABS)[number];

/** The tab a route names explicitly, or null (the page picks: Live while Running, Overview otherwise). */
export function explicitTab(subPath: string): Tab | null {
  const tab = subPath.split("/").filter(Boolean)[1];
  return (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : null;
}

/** The default tab for a study in this state. */
export function defaultTab(state: string): Tab {
  return state === "running" ? "live" : "overview";
}

export function parseSubPath(subPath: string): { slug: string | null; tab: Tab; candidate: number | null; replay: { at: number | null } | null } {
  const [slug, tab, n, at] = subPath.split("/").filter(Boolean);
  const okSlug = slug && /^[a-z0-9][a-z0-9-]{1,47}$/u.test(slug) ? slug : null;
  const t = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "overview";
  const num = n && /^\d+$/u.test(n) ? Number(n) : null;
  // The Live tab's replay: <slug>/live/replay[/<ms since the study's first event>].
  const replay = t === "live" && n === "replay" ? { at: at && /^\d{1,13}$/u.test(at) ? Number(at) : null } : null;
  return { slug: okSlug, tab: t, candidate: num, replay };
}


export function StudiesPanel({ subPath }: { subPath: string }) {
  const route = parseSubPath(subPath);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-6 pt-3 md:px-5 md:pt-4">{route.slug ? <StudyPage key={route.slug} slug={route.slug} tab={explicitTab(subPath)} candidate={route.candidate} replay={route.replay} /> : <StudyList />}</div>
    </div>
  );
}

/**
 * The project a new study starts in: the one BB's route selects, else the
 * project of the most recently updated active study (the Studies panel isn't
 * a project route), else none (the human picks it). With `known`, a project
 * that no longer exists is never preselected.
 */
export function defaultProjectFor(contextProjectId: string | null, studies: ReadonlyArray<{ projectId: string; state: string; updatedAt: number }>, known?: ReadonlySet<string> | null): string | null {
  const exists = (id: string | null | undefined): id is string => Boolean(id) && (!known || known.has(id!));
  if (exists(contextProjectId)) return contextProjectId;
  const latest = studies.filter((s) => s.state !== "archived" && exists(s.projectId)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest?.projectId ?? null;
}

/**
 * New study: bb's own new-thread composer, seeded with the study-create
 * prompt and the current project (see defaultProjectFor). The thread it
 * creates is an ordinary visible thread; the study-create skill takes it from
 * there, and it becomes the study thread.
 */
function NewStudyDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (v: boolean) => void; projectId: string | null }) {
  const sdk = useSdk();
  const nav = useBbNavigate();
  const [focus, setFocus] = useState(1);
  useEffect(() => {
    if (open) setFocus((f) => f + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New study</DialogTitle>
          <DialogDescription>
            Starts a thread where the <code>study-create</code> skill interviews you, reads the code, drafts the spec and submits it. The study then shows up here for your approval.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-40" data-testid="new-study-composer" data-project={projectId ?? ""}>
          <NewThreadComposer
            {...(projectId ? { defaultProjectId: projectId } : {})}
            initialPrompt={NEW_STUDY_PROMPT}
            focusRequest={focus}
            layout="document"
            draftKey="autoresearch:new-study"
            onSubmit={async (request) => {
              const thread = await sdk.threads.spawn(request);
              onOpenChange(false);
              nav.toThread(thread.id);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const NEW_STUDY_PROMPT =
  "Use the study-create skill to set up an autoresearch study for this project.\n\nGoal: <what number should move, and which way>\nScope: <directories workers may edit>\nBudget: <candidates, bench hours>";

/** The nav panel's sidebar accessory: how many things need the human, across studies. */
export function StudiesAccessory() {
  const a = useLive((rpc) => rpc.call("studies.attention"), [], 15_000);
  const total = a.data?.total ?? 0;
  if (!total) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-medium tabular-nums text-background" aria-label={`${total} item${total === 1 ? "" : "s"} need you`}>
      {total}
    </span>
  );
}

function StudyList() {
  const nav = useBbNavigate();
  const context = useBbContext();
  const list = useLive((rpc) => rpc.call("studies.list"), []);
  const [showArchived, setShowArchived] = useState(false);
  const [composing, setComposing] = useState(false);
  const sdk = useSdk();
  // Projects that exist now (a study's project may have been deleted); null until known or when listing fails.
  const [projects, setProjects] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!composing) return;
    let live = true;
    sdk.projects
      .list()
      .then((list) => live && setProjects(new Set(list.map((p) => p.id))))
      .catch(() => live && setProjects(null));
    return () => {
      live = false;
    };
  }, [composing, sdk]);
  const studies = list.data?.studies ?? [];
  const active = studies.filter((s) => s.state !== "archived");
  const archived = studies.filter((s) => s.state === "archived");
  const row = (s: (typeof studies)[number]) => (
    <li key={s.slug}>
      <button type="button" className={cn("flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-state-hover", FOCUS_RING)} onClick={() => nav.toPluginPanel("studies", { subPath: s.slug })}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{s.slug}</span>
            <StatePill state={s.state} />
            {s.needsYou ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-xs font-medium text-background">
                <Icon name="AlertCircle" className="size-3" aria-hidden /> needs you{s.needsYou > 1 ? ` (${s.needsYou})` : ""}
              </span>
            ) : null}
            {s.unreadNotices ? <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{s.unreadNotices} new</span> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {s.metric.name} ({s.metric.direction} is better) · {s.workers} worker{s.workers === 1 ? "" : "s"} · updated {ago(s.updatedAt)}
          </div>
        </div>
        <div className="text-right text-sm tabular-nums">
          <div className={cn(s.bestVsBase !== null ? "font-semibold" : "text-muted-foreground")}>{s.headline}</div>
          <div className="text-xs text-muted-foreground">
            {s.candidates} of {s.maxCandidates} candidates · bench {duration(s.benchSeconds)} of {s.maxBenchHours} h
          </div>
        </div>
      </button>
    </li>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Measured optimization studies: agent workers propose changes, the plugin benchmarks each one and keeps only real wins.</p>
        <Button size="sm" onClick={() => setComposing(true)}>
          <Icon name="Plus" className="size-4" aria-hidden />
          New study
        </Button>
      </div>
      {composing ? <NewStudyDialog open onOpenChange={setComposing} projectId={defaultProjectFor(context.projectId, studies, projects)} /> : null}
      <ErrorLine error={list.error} retry={list.refetch} />
      {list.loading && !list.data ? (
        <Skeleton lines={4} label="Loading studies…" />
      ) : !active.length ? (
        <EmptyState>
          No active studies. <span className="text-foreground">New study</span> opens a thread where the <code>study-create</code> skill interviews you, drafts the spec and submits it; the study then shows up here for your approval.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card" aria-label="Active studies">
          {active.map(row)}
        </ul>
      )}
      {archived.length ? (
        <div className="space-y-2">
          <button type="button" aria-expanded={showArchived} className={cn("flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground", FOCUS_RING)} onClick={() => setShowArchived((v) => !v)}>
            <Icon name={showArchived ? "ChevronDown" : "ChevronRight"} className="size-4" aria-hidden />
            Archived ({archived.length})
          </button>
          {showArchived ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card" aria-label="Archived studies">
              {archived.map(row)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StudyPage({ slug, tab: routeTab, candidate, replay }: { slug: string; tab: Tab | null; candidate: number | null; replay: { at: number | null } | null }) {
  const nav = useBbNavigate();
  const rpc = useStudyRpc();
  const o = useLive((r) => r.call("study.overview", { slug }), [slug]);
  // Without a tab in the route: Live while Running, Overview otherwise. Decided once per visit,
  // so a study that pauses doesn't pull the page away from what the human is looking at.
  const firstState = useRef<string | null>(null);
  if (firstState.current === null && o.data) firstState.current = o.data.state;
  const tab: Tab = routeTab ?? defaultTab(firstState.current ?? "draft");
  const ideas = useLive((r) => r.call("study.ideas", { slug }), [slug], 10_000);
  // Only the total, for the tab count.
  const findings = useLive((r) => r.call("study.findings", { slug, limit: 1 }), [slug], 30_000);
  const go = useCallback((t: Tab, n: number | null = null) => nav.toPluginPanel("studies", { subPath: `${slug}/${t}${n !== null ? `/${n}` : ""}` }), [nav, slug]);
  const refetch = useCallback(() => {
    o.refetch();
    ideas.refetch();
    findings.refetch();
  }, [o.refetch, ideas.refetch, findings.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = o.data;
  // Notices count as seen once the human has had the Overview open for a moment.
  const seenFor = useRef<string | null>(null);
  const unseen = data?.notices.some((n) => n.unseen && !n.audit) ?? false;
  useEffect(() => {
    if (tab !== "overview" || !unseen || seenFor.current === slug) return;
    const t = setTimeout(() => {
      seenFor.current = slug;
      void rpc.call("study.notices.seen", { slug }).catch(() => undefined);
    }, 3000);
    return () => clearTimeout(t);
  }, [tab, unseen, slug, rpc]);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={cn("rounded text-sm text-muted-foreground hover:text-foreground", FOCUS_RING)} onClick={() => nav.toPluginPanel("studies")}>
            Studies
          </button>
          <span className="text-muted-foreground" aria-hidden>
            /
          </span>
          <h1 className="text-lg font-semibold">{slug}</h1>
          {data ? <StatePill state={data.state} /> : null}
          {data?.needs.length ? (
            <button type="button" className={cn("inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-xs font-medium text-background", FOCUS_RING)} onClick={() => go("overview")}>
              <Icon name="AlertCircle" className="size-3" aria-hidden /> needs you ({data.needs.length})
            </button>
          ) : null}
          {data?.studyThreadId ? (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => nav.toThread(data.studyThreadId!)}>
              <Icon name="MessageSquare" className="size-4" aria-hidden />
              Study thread
            </Button>
          ) : null}
        </div>
        {/* Reserve the lines so live updates don't shift the layout. */}
        <p className="min-h-5 text-sm text-foreground" aria-live="polite">
          {data?.status ?? ""}
        </p>
        {data?.objective ? <p className="text-sm text-muted-foreground">{data.objective}</p> : null}
      </div>
      <Tabs
        tabs={TABS}
        current={tab}
        onSelect={(t) => go(t)}
        label="Study sections"
        badge={(t) =>
          t === "live" && data?.state === "running" ? (
            <span className="ml-1.5 inline-flex size-1.5 rounded-full bg-success align-middle" aria-label="running" />
          ) : t === "ideas" && ideas.data ? (
            <span className="ml-1 text-xs text-muted-foreground">{ideas.data.ideas.filter((i) => i.status === "queued").length}</span>
          ) : t === "candidates" && data ? (
            <span className="ml-1 text-xs text-muted-foreground">{data.candidates}</span>
          ) : t === "findings" && findings.data ? (
            <span className="ml-1 text-xs text-muted-foreground">{findings.data.total}</span>
          ) : t === "oracle" && data?.needs.some((n) => n.tab === "oracle") ? (
            <span className="ml-1 text-xs font-medium text-foreground">needs you</span>
          ) : t === "harvest" && data?.harvest ? (
            <span className="ml-1 text-xs text-muted-foreground">{data.harvest.state}</span>
          ) : null
        }
      />
      <div id="study-tabpanel" role="tabpanel" aria-labelledby={`study-tab-${tab}`} className="space-y-4">
        {!data ? (
          o.error ? <ErrorLine error={o.error.includes("no study named") ? `No study named ${slug}.` : `Couldn't load the study: ${o.error}`} retry={o.refetch} /> : <Skeleton lines={6} label="Loading study…" />
        ) : (
          <>
            {o.error ? <ErrorLine error={`Live updates failed (showing the last data): ${o.error}`} retry={o.refetch} /> : null}
            {tab === "live" ? (
              <LiveStudy
                slug={slug}
                layout="wide"
                replay={replay}
                onReplay={() => nav.toPluginPanel("studies", { subPath: replayPath(slug) })}
                onReplayMove={(at) => nav.toPluginPanel("studies", { subPath: replayPath(slug, at), replace: true })}
                onExitReplay={() => go("live")}
                onOpenCandidate={(n) => go("candidates", n)}
                onOpenOverview={() => go("overview")}
                onOpenBeside={(threadId) => {
                  requestOpenBeside(threadId, slug);
                  nav.toThread(threadId);
                }}
              />
            ) : tab === "overview" ? (
              <OverviewTab o={data} rpc={rpc} onChanged={refetch} onOpenCandidate={(n) => go("candidates", n)} go={go} />
            ) : tab === "ideas" ? (
              ideas.data ? (
                <IdeasTab slug={slug} state={data.state} ideas={ideas.data.ideas} rpc={rpc} onChanged={refetch} onOpenCandidate={(n) => go("candidates", n)} />
              ) : (
                <Skeleton lines={4} label="Loading ideas…" />
              )
            ) : tab === "findings" ? (
              <FindingsTab slug={slug} onOpenCandidate={(n) => go("candidates", n)} />
            ) : tab === "oracle" ? (
              <OracleTab slug={slug} o={data} rpc={rpc} onChanged={refetch} />
            ) : tab === "bench" ? (
              <BenchTab slug={slug} onOpenCandidate={(n) => go("candidates", n)} />
            ) : tab === "harvest" ? (
              <HarvestTab slug={slug} o={data} onOpenCandidate={(n) => go("candidates", n)} onChanged={refetch} />
            ) : (
              <CandidatesTab slug={slug} metric={data.metric} selected={candidate} onSelect={(n) => (n === null ? go("candidates") : go("candidates", n))} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
