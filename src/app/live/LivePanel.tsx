// The Live panel: the same Live view in the study thread's right split pane,
// so the human can watch while chatting with the strategist. Registered as
// a threadPanelAction; it resolves its study from the thread it was opened
// on (the study thread or a worker thread), or from `params.slug` when the
// study page or the header badge opened it.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { replayPath } from "./routes.ts";
import { useStudyRpc } from "../data.ts";
import { EmptyState, ErrorLine, Skeleton } from "../ui.tsx";
import { LiveStudy } from "./LiveStudy.tsx";

const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/u;

/** A slug from untrusted panel params, or null. */
export function slugFromParams(params: unknown): string | null {
  const slug = params && typeof params === "object" && !Array.isArray(params) ? (params as { slug?: unknown }).slug : null;
  return typeof slug === "string" && SLUG.test(slug) ? slug : null;
}

export function LivePanel({ threadId, params }: { threadId: string; params: unknown }) {
  const rpc = useStudyRpc();
  const nav = useBbNavigate();
  const fromParams = slugFromParams(params);
  const [resolved, setResolved] = useState<{ slug: string; workerKey: number | null } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The panel's own replay (the page keeps the position in its URL; the panel keeps it here).
  const [replay, setReplay] = useState<{ at: number | null } | null>(null);
  const position = useRef<number | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    rpc.call("thread.study", { threadId }).then(
      (r) => {
        if (!live) return;
        const s = r.study;
        // Params win when they name a study (opened for it explicitly); the thread decides otherwise.
        if (fromParams) setResolved({ slug: fromParams, workerKey: s && s.slug === fromParams ? s.workerKey : null });
        else setResolved(s ? { slug: s.slug, workerKey: s.workerKey } : null);
      },
      (e: unknown) => {
        if (!live) return;
        if (fromParams) setResolved({ slug: fromParams, workerKey: null });
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, fromParams, attempt]);

  const body =
    error !== null ? (
      <ErrorLine error={`Couldn't find this thread's study: ${error}`} retry={() => setAttempt((a) => a + 1)} />
    ) : resolved === undefined ? (
      <Skeleton lines={5} label="Finding this thread's study…" />
    ) : resolved === null ? (
      <EmptyState className="space-y-2">
        <p>This thread isn't part of an autoresearch study. Open the Live panel from a study thread, or pick a study on the Studies page.</p>
        <Button size="sm" variant="outline" onClick={() => nav.toPluginPanel("studies")}>
          Open Studies
        </Button>
      </EmptyState>
    ) : (
      <LiveStudy
        key={replay ? "replay" : "live"}
        slug={resolved.slug}
        layout="compact"
        replay={replay}
        onReplay={() => {
          position.current = null;
          setReplay({ at: null });
        }}
        onReplayMove={(at) => {
          position.current = at;
        }}
        onExitReplay={() => setReplay(null)}
        initialWorker={resolved.workerKey}
        onOpenCandidate={(n) => nav.toPluginPanel("studies", { subPath: `${resolved.slug}/candidates/${n}` })}
        onOpenOverview={() => nav.toPluginPanel("studies", { subPath: `${resolved.slug}/overview` })}
      />
    );
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {resolved ? (
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          <div role="tablist" aria-label="Live or replay" className="inline-flex overflow-hidden rounded-md border border-border text-xs">
            {(["live", "replay"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={(replay !== null) === (m === "replay")}
                onClick={() => (m === "replay" ? (replay ? undefined : setReplay({ at: null })) : setReplay(null))}
                className={cn("px-2 py-0.5", (replay !== null) === (m === "replay") ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-state-hover")}
              >
                {m === "live" ? "Live" : "Replay"}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => nav.toPluginPanel("studies", { subPath: replay ? replayPath(resolved.slug, position.current) : `${resolved.slug}/live` })}>
            Open in the study page
          </Button>
        </div>
      ) : null}
      <div className="p-3">{body}</div>
    </div>
  );
}
