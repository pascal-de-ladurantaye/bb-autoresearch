import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { IdeaView } from "../views.ts";
import type { Rpc } from "./data.ts";
import { pct } from "./format.ts";
import { EmptyState } from "./ui.tsx";

const COLUMNS = [
  { key: "queued", title: "Queued" },
  { key: "running", title: "Running" },
  { key: "won", title: "Won" },
  { key: "lost", title: "Lost" },
  { key: "abandoned", title: "Abandoned / vetoed" },
] as const;

export function IdeasTab({ slug, ideas, rpc, onChanged, onOpenCandidate }: { slug: string; ideas: IdeaView[]; rpc: Rpc; onChanged: () => void; onOpenCandidate: (n: number) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<{ message: string }>, quiet = false) => {
    setBusy(true);
    try {
      const r = await fn();
      if (!quiet) toast.success(r.message);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const queued = ideas.filter((i) => i.status === "queued").sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority || a.id - b.id);
  const move = (id: number, delta: -1 | 1) => {
    const order = queued.map((i) => i.id);
    const at = order.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    void act(() => rpc.call("ideas.reorder", { slug, ids: order }), true);
  };
  const byStatus = (key: string) => (key === "queued" ? queued : ideas.filter((i) => (key === "abandoned" ? i.status === "abandoned" || i.status === "retired" : i.status === key)));
  return (
    <div className="space-y-4">
      <AddIdea slug={slug} rpc={rpc} onChanged={onChanged} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const list = byStatus(col.key);
          return (
            <div key={col.key} className="min-w-0 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {col.title} · {list.length}
              </h3>
              {list.length === 0 ? <EmptyState>None</EmptyState> : null}
              {list.slice(0, 100).map((i, idx) => (
                <article key={i.id} className="space-y-1 rounded-lg border border-border bg-card p-2 text-sm">
                  <div className="flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium">
                        <span className="text-muted-foreground">#{i.id}</span> {i.title}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[i.theme && `theme ${i.theme}`, i.source, col.key === "queued" ? `p ${i.priority}` : null, i.startRef && `from ${i.startRef}`, i.variationOf && `varies #${i.variationOf}`].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {i.pinned ? <Icon name="Pin" className="size-3.5 shrink-0 text-foreground" aria-label="Pinned" /> : null}
                  </div>
                  {i.rationale ? <p className="line-clamp-3 text-xs text-muted-foreground">{i.rationale}</p> : null}
                  {i.candidates.length ? (
                    <div className="flex flex-wrap gap-1 text-xs">
                      {i.candidates.map((n) => (
                        <button key={n} type="button" className="rounded bg-muted px-1.5 py-0.5 hover:bg-state-hover" onClick={() => onOpenCandidate(n)}>
                          c/{n}
                        </button>
                      ))}
                      {i.bestEffect !== null ? <span className="text-muted-foreground">best {pct(i.bestEffect)}</span> : null}
                    </div>
                  ) : null}
                  {i.statusReason && col.key !== "queued" ? <p className="text-xs text-muted-foreground">{i.statusReason}</p> : null}
                  {col.key === "queued" ? (
                    <div className="flex gap-1 pt-1">
                      <IconButton label={i.pinned ? "Unpin" : "Pin"} icon="Pin" disabled={busy} onClick={() => void act(() => rpc.call("ideas.update", { slug, id: i.id, pinned: !i.pinned }), true)} />
                      <IconButton label="Move up" icon="ArrowUp" disabled={busy || idx === 0} onClick={() => move(i.id, -1)} />
                      <IconButton label="Move down" icon="ArrowDown" disabled={busy || idx === list.length - 1} onClick={() => move(i.id, 1)} />
                      <IconButton
                        label="Veto"
                        icon="X"
                        className="ml-auto hover:text-destructive"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt(`Veto idea #${i.id}? Optional reason:`, "");
                          if (reason === null) return;
                          void act(() => rpc.call("ideas.veto", { slug, id: i.id, reason }));
                        }}
                      />
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconButton({ label, icon, onClick, disabled, className }: { label: string; icon: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <Button type="button" variant="ghost" size="icon" className={cn("size-7 text-muted-foreground hover:text-foreground", className)} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}

function AddIdea({ slug, rpc, onChanged }: { slug: string; rpc: Rpc; onChanged: () => void }) {
  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState("");
  const [rationale, setRationale] = useState("");
  const [startRef, setStartRef] = useState("");
  const [pinned, setPinned] = useState(true);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3 || pending) return;
    setPending(true);
    try {
      const r = await rpc.call("ideas.add", {
        slug,
        title: title.trim(),
        ...(theme.trim() ? { theme: theme.trim() } : {}),
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        ...(startRef.trim() ? { startRef: startRef.trim() } : {}),
        pinned,
      });
      toast.success(r.message);
      setTitle("");
      setRationale("");
      setStartRef("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-2 rounded-lg border border-border bg-card p-3 md:grid-cols-[2fr_1fr_1fr_auto]">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New idea, e.g. Precompile header matchers into a trie" aria-label="Idea title" />
      <Input value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="Theme" aria-label="Theme" />
      <Input value={startRef} onChange={(e) => setStartRef(e.target.value)} placeholder="Start from (c/12)" aria-label="Start from candidate" />
      <Button type="submit" disabled={pending || title.trim().length < 3}>
        <Icon name="Plus" className="size-4" />
        Add
      </Button>
      <Input className="md:col-span-3" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale (optional)" aria-label="Rationale" />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin
      </label>
    </form>
  );
}
