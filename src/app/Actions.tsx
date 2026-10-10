// The study's deliberate steps (approve a spec, approve the calibration and
// start, start a harvest, archive), each behind a dialog that says exactly
// what will happen, plus the "Needs you" list that offers them. In-app and
// CLI approval are equivalent and audited the same way (threat model).
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NeedsYouItem, OverviewResult } from "../views.ts";
import type { Rpc } from "./data.ts";
import { ago, duration, frac } from "./format.ts";
import { Callout, ConfirmDialog, FOCUS_RING, Mono } from "./ui.tsx";

type Tab = "overview" | "ideas" | "candidates" | "findings" | "oracle" | "bench" | "harvest";

export function ApproveSpecDialog({ o, version, changesOracle, rpc, open, onOpenChange, onDone }: { o: OverviewResult; version: number; changesOracle: boolean; rpc: Rpc; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const draft = o.state === "draft";
  const hosts = o.benchHosts.length || 1;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={draft ? `Approve spec v${version} and calibrate` : changesOracle ? `Approve spec v${version} and recalibrate` : `Apply spec v${version}`}
      description="This is a human control. It is recorded in the study's audit log and raises a notice, the same as the CLI command."
      confirmLabel={draft ? "Approve and calibrate" : changesOracle ? "Approve and recalibrate" : "Apply spec"}
      onConfirm={async () => {
        const r = await rpc.call("study.spec.approve", { slug: o.slug, version, confirm: true });
        toast.success(r.message);
        onDone();
      }}
    >
      <p className="font-medium">What happens</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {draft ? (
          <>
            <li>Spec v{version} becomes the approved oracle (metric, scope, commands and protocol as shown on the Oracle tab).</li>
            <li>Calibration runs the gates on the base commit, then repeated A/A measurements on {hosts} bench host{hosts === 1 ? "" : "s"} to learn the noise floor and the smallest detectable effect.</li>
            <li>No worker starts yet. When calibration finishes you review it and start the study.</li>
          </>
        ) : changesOracle ? (
          <>
            <li>The oracle changes: measurements in flight are cancelled and queued candidates go back to the gate (they keep their place).</li>
            <li>Best ({o.bestSha?.slice(0, 10) ?? "?"}) is calibrated under the new oracle; segment {o.segment.k + 1} starts when you approve that calibration.</li>
            <li>Workers keep editing meanwhile.</li>
          </>
        ) : (
          <>
            <li>Spec v{version} replaces v{o.specVersion} now. The oracle is unchanged, so there is no recalibration and segment {o.segment.k} continues.</li>
          </>
        )}
      </ul>
      <p className="text-xs text-muted-foreground">
        CLI equivalent: <Mono>{draft || changesOracle ? `bb study calibrate ${o.slug}` : `bb study approve ${o.slug}`}</Mono>
      </p>
    </ConfirmDialog>
  );
}

export function StartDialog({ o, rpc, open, onOpenChange, onDone }: { o: OverviewResult; rpc: Rpc; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const c = o.calibration;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Approve the calibration and start"
      description="This is a human control. It is recorded in the study's audit log and raises a notice, the same as the CLI command."
      confirmLabel="Approve and start"
      onConfirm={async () => {
        const r = await rpc.call("study.start", { slug: o.slug, confirm: true });
        toast.success(r.message);
        onDone();
      }}
    >
      <p className="font-medium">Calibration</p>
      <p className="text-muted-foreground">
        Noise floor {frac(c.noiseFloor)} per pair · a win must clear {frac(c.mde)} (MDE) · about {duration(c.evalSeconds)} per evaluation.
      </p>
      <p className="font-medium">What happens</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>
          Up to {o.maxWorkers} worker thread{o.maxWorkers === 1 ? "" : "s"} spawn in their own worktrees and spend tokens; the bench measures one candidate at a time per host.
        </li>
        <li>
          The study stops itself at {o.maxCandidates} candidates or {o.maxBenchHours} bench hour{o.maxBenchHours === 1 ? "" : "s"}, whichever comes first, and proposes a harvest.
        </li>
        <li>Nothing is pushed anywhere. You can pause, steer the ideas, or lower concurrency at any time.</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        CLI equivalent: <Mono>bb study start {o.slug}</Mono>
      </p>
    </ConfirmDialog>
  );
}

export function HarvestDialog({ slug, promotions, restart, rpc, open, onOpenChange, onDone }: { slug: string; promotions: number; restart: boolean; rpc: Rpc; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [onePer, setOnePer] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={restart ? "Start a new harvest (dry run)" : "Start the harvest (dry run)"}
      description="Harvest turns the promotions on best into reviewable changesets with measured contributions. A dry run: nothing is pushed."
      confirmLabel="Start harvest"
      onConfirm={async () => {
        const r = await rpc.call("study.harvest.start", { slug, ...(restart ? { restart: true } : {}), ...(onePer ? { onePerPromotion: true } : {}) });
        toast.success(r.message.split("\n")[0] ?? r.message);
        onDone();
      }}
    >
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>No new workers start and submissions close; candidates in flight finish first, so best is final.</li>
        <li>{onePer ? `Each of the ${promotions} promotion(s) becomes its own changeset.` : `The strategist groups the ${promotions} promotion(s) into changesets (or one per promotion if it doesn't answer).`}</li>
        <li>Each changeset is reverted from best and measured (its contribution), checked alone on its PR base, and drafted as a local branch with a PR body.</li>
        <li>Harvest uses bench time; it counts toward the bench budget but is never blocked by it.</li>
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={onePer} onChange={(e) => setOnePer(e.target.checked)} /> One changeset per promotion (skip the strategist's grouping)
      </label>
      <p className="text-xs text-muted-foreground">
        CLI equivalent: <Mono>bb study harvest {slug}{restart ? " --restart" : ""}{onePer ? " --one-per-promotion" : ""}</Mono>
      </p>
    </ConfirmDialog>
  );
}

export function ArchiveDialog({ slug, rpc, open, onOpenChange, onDone }: { slug: string; rpc: Rpc; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  // The study thread is the conversation that created the study; once the study ends it has nothing left to do.
  const [archiveThread, setArchiveThread] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Archive ${slug}`}
      description="Archiving ends the study for good."
      confirmLabel="Archive study"
      confirmVariant="destructive"
      onConfirm={async () => {
        const r = await rpc.call("study.archive", { slug, confirm: true, archiveThread });
        toast.success(r.message.split("\n")[0] ?? r.message);
        onDone();
      }}
    >
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>Live workers stop and their threads are archived; a running harvest is cancelled.</li>
        <li>Bench checkouts and bench clones are removed.</li>
        <li>{archiveThread ? "The study thread is archived too." : "The study thread stays in the sidebar."}</li>
        <li>
          Kept: every candidate ref (<Mono>refs/studies/{slug}/c/*</Mono>), the best branch <Mono>studies/{slug}/best</Mono>, harvest branches and exports, and the study's history on this page.
        </li>
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className={cn("size-4 rounded", FOCUS_RING)} checked={archiveThread} onChange={(e) => setArchiveThread(e.target.checked)} />
        Also archive the study thread
      </label>
      <p className="text-xs text-muted-foreground">
        CLI equivalent: <Mono>bb study archive {slug}{archiveThread ? " --archive-thread" : ""}</Mono>
      </p>
    </ConfirmDialog>
  );
}

/** The "Needs you" list: what waits for the human, each with the action that resolves it. */
export function NeedsYou({ o, rpc, onChanged, go }: { o: OverviewResult; rpc: Rpc; onChanged: () => void; go: (t: Tab) => void }) {
  const nav = useBbNavigate();
  const [dialog, setDialog] = useState<null | { kind: "approve"; version: number; changesOracle: boolean } | { kind: "start" } | { kind: "harvest" }>(null);
  const resume = async () => {
    try {
      toast.success((await rpc.call("study.resume", { slug: o.slug })).message);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  if (!o.needs.length) return null;
  const button = (n: NeedsYouItem) => {
    const a = n.action;
    if (!a) return null;
    switch (a.kind) {
      case "approve_spec":
        return (
          <Button size="sm" onClick={() => setDialog({ kind: "approve", version: a.version, changesOracle: a.changesOracle })}>
            {o.state === "draft" ? "Approve and calibrate…" : a.changesOracle ? "Approve and recalibrate…" : "Apply spec…"}
          </Button>
        );
      case "start":
        return <Button size="sm" onClick={() => setDialog({ kind: "start" })}>Approve and start…</Button>;
      case "harvest":
        return <Button size="sm" onClick={() => setDialog({ kind: "harvest" })}>Start harvest…</Button>;
      case "resume":
        return (
          <Button size="sm" variant="outline" onClick={() => void resume()}>
            Resume
          </Button>
        );
      case "open_harvest":
        return <Button size="sm" onClick={() => go("harvest")}>Review harvest</Button>;
      case "open_bench":
        return (
          <Button size="sm" variant="outline" onClick={() => go("bench")}>
            Open Bench
          </Button>
        );
      case "open_thread":
        return o.studyThreadId ? (
          <Button size="sm" variant="outline" onClick={() => nav.toThread(o.studyThreadId!)}>
            Open study thread
          </Button>
        ) : null;
    }
  };
  return (
    <section aria-labelledby="needs-you" className="space-y-2">
      <h2 id="needs-you" className="text-sm font-semibold">
        Needs you <span className="ml-1 rounded-full bg-foreground px-1.5 text-xs text-background">{o.needs.length}</span>
      </h2>
      <ul className="space-y-2">
        {o.needs.map((n) => (
          <li key={n.id}>
            <Callout
              tone={n.tone}
              title={n.title}
              actions={
                <>
                  {n.tab !== "overview" && n.action?.kind !== "open_harvest" && n.action?.kind !== "open_bench" ? (
                    <Button size="sm" variant="ghost" onClick={() => go(n.tab)}>
                      Open {n.tab}
                    </Button>
                  ) : null}
                  {button(n)}
                </>
              }
            >
              {n.detail}
              {n.at ? ` · ${ago(n.at)}` : ""}
              {n.command ? (
                <>
                  {" "}
                  · CLI <Mono>{n.command}</Mono>
                </>
              ) : null}
            </Callout>
          </li>
        ))}
      </ul>
      {dialog?.kind === "approve" ? <ApproveSpecDialog o={o} version={dialog.version} changesOracle={dialog.changesOracle} rpc={rpc} open onOpenChange={(v) => !v && setDialog(null)} onDone={onChanged} /> : null}
      {dialog?.kind === "start" ? <StartDialog o={o} rpc={rpc} open onOpenChange={(v) => !v && setDialog(null)} onDone={onChanged} /> : null}
      {dialog?.kind === "harvest" ? <HarvestDialog slug={o.slug} promotions={o.trajectory.steps.length - 1} restart={false} rpc={rpc} open onOpenChange={(v) => !v && setDialog(null)} onDone={onChanged} /> : null}
    </section>
  );
}
