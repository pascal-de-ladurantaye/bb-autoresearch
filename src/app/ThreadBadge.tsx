// Thread header badge for study and worker threads; renders nothing elsewhere.
// On the study thread it leads with what needs the human, if anything.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useLive } from "./data.ts";
import { openLivePanel, openLivePanelSoon, takeOpenBeside } from "./live/openBeside.ts";

export function ThreadBadge({ threadId, isCompactViewport }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const nav = useBbNavigate();
  const b = useLive((rpc) => rpc.call("thread.badge", { threadId }), [threadId], 15_000);
  // The Live tab's "Open beside the study thread" navigated here: open the Live panel on this thread surface.
  useEffect(() => {
    const slug = takeOpenBeside(threadId);
    return slug ? openLivePanelSoon(nav, slug) : undefined;
  }, [threadId, nav]);
  const badge = b.data?.badge;
  if (!badge) return null;
  const label = `Autoresearch: ${badge.label}. Open the study page.`;
  const live = badge.kind === "study" && ["running", "paused", "harvesting"].includes(badge.state);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
    <button
      type="button"
      aria-label={label}
      title={badge.text}
      onClick={() => nav.toPluginPanel("studies", { subPath: badge.slug })}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-[18rem] items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        badge.tone === "paused" && "border-warning/60",
        badge.tone === "attention" && "border-foreground/60 text-foreground",
      )}
    >
      <Icon name="autoresearch-flask" className={cn("size-3.5 shrink-0", badge.tone === "running" && "text-success", badge.tone === "paused" && "text-warning-text")} />
      {badge.needsYou ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-foreground px-1 text-[10px] font-medium text-background">
          <Icon name="AlertCircle" className="size-3" aria-hidden />
          {badge.needsYou}
        </span>
      ) : null}
      {isCompactViewport ? null : <span className="truncate tabular-nums">{badge.text}</span>}
    </button>
    {live ? (
      <button
        type="button"
        aria-label={`Open the live view of ${badge.slug} beside this thread`}
        title="Live view beside this thread"
        onClick={() => openLivePanel(nav, badge.slug)}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("inline-flex size-1.5 rounded-full", badge.state === "running" ? "bg-success" : "bg-muted-foreground/60")} aria-hidden />
        Live
      </button>
    ) : null}
    </span>
  );
}
