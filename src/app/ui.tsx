// Small presentational pieces for the study page. Host tokens only (bg-card,
// text-foreground, border-border, …) so they follow BB's light and dark
// themes; every state carries a word or glyph, never color alone.
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { GLOSSARY, GUARDRAIL, STATE_TONE, VERDICT, type GlossaryKey } from "./format.ts";

export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function StatePill({ state, className }: { state: string; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", STATE_TONE[state] ?? "bg-muted text-muted-foreground", className)}>{state.replace(/_/gu, " ")}</span>;
}

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" className={cn("rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/** A loading placeholder that keeps the layout (no jump when the data arrives). */
export function Skeleton({ lines = 3, label = "Loading…", className }: { lines?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn("space-y-2 rounded-lg border border-border bg-card p-3", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={cn("h-3 animate-pulse rounded bg-muted", i === 0 ? "w-1/3" : i % 2 ? "w-5/6" : "w-2/3")} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorLine({ error, retry }: { error: string | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
      <Icon name="AlertCircle" className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1">{error}</span>
      {retry ? (
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Loading, error and empty states for a tab, in one place so every tab behaves the same. */
export function TabState({ loading, error, retry, label }: { loading: boolean; error: string | null; retry: () => void; label: string }) {
  if (error) return <ErrorLine error={`Couldn't load ${label}: ${error}`} retry={retry} />;
  if (loading) return <Skeleton lines={4} label={`Loading ${label}…`} />;
  return <EmptyState>{label} unavailable.</EmptyState>;
}

export function Stat({ label, value, hint, help, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; help?: GlossaryKey; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-card px-3 py-2", className)}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {help ? <Help term={help} /> : null}
      </div>
      <div className="break-words text-base font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Section({ title, actions, children, className, help, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; help?: GlossaryKey; id?: string }) {
  return (
    <section className={cn("space-y-2", className)} aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="flex items-center gap-1 text-sm font-semibold text-foreground">
          {title}
          {help ? <Help term={help} /> : null}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("font-mono text-xs text-muted-foreground", className)}>{children}</code>;
}

/** Short inline help for a statistical term: a "?" button that opens one or two sentences. */
export function Help({ term, label }: { term: GlossaryKey; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`What is ${label ?? term}?`} className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:size-11", FOCUS_RING)}>
          <Icon name="CircleQuestion" className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-xs text-sm leading-relaxed" align="start">
        {GLOSSARY[term]}
      </PopoverContent>
    </Popover>
  );
}

/** A callout: alert (something broke), action (a decision waits), info. Glyph + title always. */
export function Callout({ tone, title, children, actions, className }: { tone: "alert" | "action" | "info"; title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  const styles = {
    alert: { box: "border-warning/60 bg-warning/10", icon: "AlertTriangle", iconTone: "text-warning-text" },
    action: { box: "border-border bg-muted/50", icon: "CircleCheck", iconTone: "text-foreground" },
    info: { box: "border-border bg-card", icon: "Info", iconTone: "text-muted-foreground" },
  }[tone];
  return (
    <div role={tone === "alert" ? "alert" : "status"} className={cn("flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2 text-sm text-foreground", styles.box, className)}>
      <Icon name={styles.icon} className={cn("mt-0.5 size-4 shrink-0", styles.iconTone)} aria-hidden />
      <div className="min-w-0 flex-1 basis-48 space-y-0.5">
        <div className="font-medium">{title}</div>
        {children ? <div className="text-xs text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div> : null}
    </div>
  );
}

export function VerdictBadge({ verdict, stage }: { verdict: string | null; stage?: string }) {
  if (!verdict) return <span className="text-xs text-muted-foreground">{(stage ?? "pending").replace(/_/gu, " ")}</span>;
  const v = VERDICT[verdict] ?? { label: verdict, icon: "Circle", tone: "text-muted-foreground" };
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium", v.tone)}>
      <Icon name={v.icon} className="size-3.5" aria-hidden />
      {v.label}
    </span>
  );
}

export function GuardrailBadge({ state, text, title }: { state: string | null; text: string; title?: string }) {
  if (state === null) return <span className="text-xs text-muted-foreground">{text}</span>;
  const g = GUARDRAIL[state] ?? GUARDRAIL.missing!;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", g.tone)} title={title}>
      <Icon name={g.icon} className="size-3.5 shrink-0" aria-hidden />
      {text}
    </span>
  );
}

/**
 * A deliberate step: the dialog states exactly what will happen, and the
 * action runs only from its confirm button. Errors stay in the dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  confirmVariant = "default",
  onConfirm,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive";
  onConfirm: () => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) {
          setError(null);
          onOpenChange(o);
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <div className="max-h-[50vh] space-y-2 overflow-y-auto text-sm">{children}</div> : null}
        {error ? <ErrorLine error={error} /> : null}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={confirmVariant} disabled={busy || disabled} onClick={() => void run()}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Keyboard-navigable tabs (roving focus with arrow keys, Home and End), as a WAI-ARIA tablist. */
export function Tabs<T extends string>({ tabs, current, onSelect, label, badge }: { tabs: readonly T[]; current: T; onSelect: (t: T) => void; label: string; badge?: (t: T) => ReactNode }) {
  const focusTab = (i: number) => {
    const t = tabs[(i + tabs.length) % tabs.length]!;
    onSelect(t);
    requestAnimationFrame(() => document.getElementById(`study-tab-${t}`)?.focus());
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t, i) => (
        <button
          key={t}
          id={`study-tab-${t}`}
          type="button"
          role="tab"
          aria-selected={t === current}
          aria-controls="study-tabpanel"
          tabIndex={t === current ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              focusTab(i + 1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              focusTab(i - 1);
            } else if (e.key === "Home") {
              e.preventDefault();
              focusTab(0);
            } else if (e.key === "End") {
              e.preventDefault();
              focusTab(tabs.length - 1);
            }
          }}
          className={cn(
            "-mb-px shrink-0 rounded-t-md border-b-2 px-3 py-1.5 text-sm",
            FOCUS_RING,
            t === current ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onSelect(t)}
        >
          <span className="capitalize">{t}</span>
          {badge ? badge(t) : null}
        </button>
      ))}
    </div>
  );
}
