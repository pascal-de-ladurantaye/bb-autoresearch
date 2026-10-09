// Thread header badge for study and worker threads; renders nothing elsewhere.
// On the study thread it leads with what needs the human, if anything.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useLive } from "./data.ts";

export function ThreadBadge({ threadId, isCompactViewport }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const nav = useBbNavigate();
  const b = useLive((rpc) => rpc.call("thread.badge", { threadId }), [threadId], 15_000);
  const badge = b.data?.badge;
  if (!badge) return null;
  const label = `Autoresearch: ${badge.label}. Open the study page.`;
  return (
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
  );
}
