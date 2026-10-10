// The Live panel: the same Live view in the study thread's right split pane,
// so the human can watch while chatting with the strategist. Registered as
// a threadPanelAction; it resolves its study from the thread it was opened
// on (the study thread or a worker thread), or from `params.slug` when the
// study page or the header badge opened it.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
        slug={resolved.slug}
        layout="compact"
        initialWorker={resolved.workerKey}
        onOpenCandidate={(n) => nav.toPluginPanel("studies", { subPath: `${resolved.slug}/candidates/${n}` })}
        onOpenOverview={() => nav.toPluginPanel("studies", { subPath: `${resolved.slug}/overview` })}
      />
    );
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="p-3">{body}</div>
    </div>
  );
}
