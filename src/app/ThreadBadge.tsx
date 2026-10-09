// Thread header badge for study and worker threads; renders nothing elsewhere.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useLive } from "./data.ts";

export function ThreadBadge({ threadId, isCompactViewport }: { threadId: string; projectId: string; isCompactViewport: boolean }) {
  const nav = useBbNavigate();
  const b = useLive((rpc) => rpc.call("thread.badge", { threadId }), [threadId], 15_000);
  const badge = b.data?.badge;
  if (!badge) return null;
  const label = `Autoresearch: ${badge.text}. Open the study page.`;
  return (
    <button
      type="button"
      aria-label={label}
      title={badge.text}
      onClick={() => nav.toPluginPanel("studies", { subPath: badge.slug })}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground",
        badge.tone === "paused" && "border-amber-500/50",
      )}
    >
      <Icon name="autoresearch-flask" className={cn("size-3.5 shrink-0", badge.tone === "running" && "text-emerald-600 dark:text-emerald-400", badge.tone === "paused" && "text-amber-600 dark:text-amber-400")} />
      {isCompactViewport ? null : <span className="truncate tabular-nums">{badge.text}</span>}
    </button>
  );
}
