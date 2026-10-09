// The "Studies" nav panel: a list of studies at the root, and a study page
// at /plugins/autoresearch/studies/<slug>[/<tab>[/<candidate>]].
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { CandidatesTab } from "./Candidates.tsx";
import { useLive, useStudyRpc } from "./data.ts";
import { ago, duration, metricChange } from "./format.ts";
import { IdeasTab } from "./Ideas.tsx";
import { OverviewTab } from "./Overview.tsx";
import { EmptyState, ErrorLine, StatePill } from "./ui.tsx";

const TABS = ["overview", "ideas", "candidates"] as const;
type Tab = (typeof TABS)[number];

export function parseSubPath(subPath: string): { slug: string | null; tab: Tab; candidate: number | null } {
  const [slug, tab, n] = subPath.split("/").filter(Boolean);
  const okSlug = slug && /^[a-z0-9][a-z0-9-]{1,47}$/u.test(slug) ? slug : null;
  const t = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "overview";
  const num = n && /^\d+$/u.test(n) ? Number(n) : null;
  return { slug: okSlug, tab: t, candidate: num };
}

export function StudiesPanel({ subPath }: { subPath: string }) {
  const route = parseSubPath(subPath);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-6 pt-3 md:px-5 md:pt-4">{route.slug ? <StudyPage slug={route.slug} tab={route.tab} candidate={route.candidate} /> : <StudyList />}</div>
    </div>
  );
}

function StudyList() {
  const nav = useBbNavigate();
  const list = useLive((rpc) => rpc.call("studies.list"), []);
  const studies = list.data?.studies ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Measured optimization studies. Start one by asking an agent to use the <code>study-create</code> skill; steer it here or with <code>bb study</code>.
      </p>
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? (
        <EmptyState>Loading studies…</EmptyState>
      ) : studies.length === 0 ? (
        <EmptyState>No studies yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {studies.map((s) => (
            <li key={s.slug}>
              <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-state-hover" onClick={() => nav.toPluginPanel("studies", { subPath: s.slug })}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.slug}</span>
                    <StatePill state={s.state} />
                    {s.unreadNotices ? <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{s.unreadNotices} new</span> : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.metric.name} · {s.workers} worker(s) · queue {s.benchDepth} · updated {ago(s.updatedAt)}
                  </div>
                </div>
                <div className="text-right text-sm tabular-nums">
                  <div className={cn(s.bestVsBase ? "font-semibold" : "text-muted-foreground")}>{s.bestVsBase === null ? "no win yet" : metricChange(s.bestVsBase, s.metric.direction)}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.candidates}/{s.maxCandidates} · {duration(s.benchSeconds)} of {s.maxBenchHours} h
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StudyPage({ slug, tab, candidate }: { slug: string; tab: Tab; candidate: number | null }) {
  const nav = useBbNavigate();
  const rpc = useStudyRpc();
  const o = useLive((r) => r.call("study.overview", { slug }), [slug]);
  const ideas = useLive((r) => r.call("study.ideas", { slug }), [slug], 10_000);
  const go = useCallback((t: Tab, n: number | null = null) => nav.toPluginPanel("studies", { subPath: `${slug}/${t}${n !== null ? `/${n}` : ""}` }), [nav, slug]);
  const refetch = () => {
    o.refetch();
    ideas.refetch();
  };
  const data = o.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => nav.toPluginPanel("studies")}>
          Studies
        </button>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-lg font-semibold">{slug}</h1>
        {data ? <StatePill state={data.state} /> : null}
      </div>
      {data?.objective ? <p className="text-sm text-muted-foreground">{data.objective}</p> : null}
      <nav className="flex gap-1 border-b border-border" aria-label="Study sections">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-current={t === tab ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm capitalize", t === tab ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            onClick={() => go(t)}
          >
            {t}
            {t === "ideas" && ideas.data ? <span className="ml-1 text-xs text-muted-foreground">{ideas.data.ideas.filter((i) => i.status === "queued").length}</span> : null}
            {t === "candidates" && data ? <span className="ml-1 text-xs text-muted-foreground">{data.candidates}</span> : null}
          </button>
        ))}
      </nav>
      <ErrorLine error={o.error} />
      {!data ? (
        <EmptyState>{o.loading ? "Loading study…" : "Study not found."}</EmptyState>
      ) : tab === "overview" ? (
        <OverviewTab o={data} rpc={rpc} onChanged={refetch} onOpenCandidate={(n) => go("candidates", n)} />
      ) : tab === "ideas" ? (
        ideas.data ? (
          <IdeasTab slug={slug} ideas={ideas.data.ideas} rpc={rpc} onChanged={refetch} onOpenCandidate={(n) => go("candidates", n)} />
        ) : (
          <EmptyState>Loading ideas…</EmptyState>
        )
      ) : (
        <CandidatesTab slug={slug} direction={data.metric.direction} metric={data.metric.name} selected={candidate} onSelect={(n) => go("candidates", n)} />
      )}
    </div>
  );
}
