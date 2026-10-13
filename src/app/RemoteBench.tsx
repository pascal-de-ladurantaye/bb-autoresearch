// Remote bench hosts on the Bench tab: each `[[oracle.remote_bench]]` entry
// (provider, shape, lifetime, seed) and each machine (state, expiry,
// rotation, its own calibration, what it measures). Read only.
import { cn } from "@/lib/utils";
import type { RemoteMachineView, RemoteView } from "../remote/view.ts";
import { ago, bytes, duration, frac } from "./format.ts";
import { EmptyState } from "./ui.tsx";

const STATE_TONE: Record<RemoteMachineView["state"], string> = {
  creating: "text-muted-foreground",
  joining: "text-muted-foreground",
  calibrating: "text-muted-foreground",
  ready: "text-success",
  retiring: "text-warning-text",
  gone: "text-muted-foreground",
};
const STATE_GLYPH: Record<RemoteMachineView["state"], string> = { creating: "◌", joining: "◌", calibrating: "◐", ready: "●", retiring: "◑", gone: "○" };

/** "ends in 12 min" / "ended 3 min ago". */
export function expiryText(at: number | null, now = Date.now()): string | null {
  if (at === null) return null;
  const d = at - now;
  return d >= 0 ? `ends in ${duration(d / 1000)}` : `ended ${duration(-d / 1000)} ago`;
}

export function RemoteBench({ v, onOpenCandidate, now = Date.now() }: { v: RemoteView; onOpenCandidate: (n: number) => void; now?: number }) {
  const live = v.machines.filter((m) => m.state !== "gone");
  const gone = v.machines.filter((m) => m.state === "gone").slice(0, 8);
  return (
    <div className="space-y-3">
      <ul className="space-y-1 text-sm" aria-label="Remote bench entries">
        {v.entries.map((e) => (
          <li key={e.index} className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{e.provider}</span>
              <span className="text-xs text-muted-foreground">
                {e.hosts} machine{e.hosts === 1 ? "" : "s"} × {e.cores} cores{e.memoryGb ? `, ${e.memoryGb} GB` : ""} · {e.lifetimeMinutes} min each, replaced {e.rotateLeadMinutes} min before the end{e.gates ? " · gates run there" : ""}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {e.seed ? (
                <span className={cn(e.seed.state === "refused" || e.seed.state === "failed" ? "text-destructive" : "")}>
                  seed {e.seed.state === "ok" ? `ready (${bytes(e.seed.bytes)}, ${e.seed.files ?? "?"} files, built ${ago(e.seed.at, now)})` : e.seed.state}
                  {e.seed.detail ? `: ${e.seed.detail}` : ""}
                </span>
              ) : (
                "no seed"
              )}
              {e.setup ? " · setup runs on each machine" : ""}
              {v.baseBundle ? ` · repository ${bytes(v.baseBundle.bytes)} (shallow at the study base)` : ""}
            </div>
            {e.machine ? <div className="text-xs text-muted-foreground">machine: {Object.entries(e.machine).map(([k, x]) => `${k}=${String(x)}`).join(", ")}</div> : null}
            {e.blocked ? <div className="text-xs text-warning-text">⚠ no new machine: {e.blocked}</div> : null}
          </li>
        ))}
      </ul>
      {live.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Remote machines">
          {live.map((m) => (
            <li key={m.id} className="space-y-0.5 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-muted-foreground">slot {m.slot} · {m.cores} cores{m.shape?.nproc ? ` (${m.shape.nproc} CPUs visible)` : ""}</span>
                <span className={cn("text-xs", STATE_TONE[m.state])}>
                  {STATE_GLYPH[m.state]} {m.measuring !== null ? (
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpenCandidate(m.measuring!)}>
                      {m.stateText}
                    </button>
                  ) : (
                    m.stateText
                  )}
                </span>
                {expiryText(m.expiresAt, now) ? <span className="text-xs text-muted-foreground">{expiryText(m.expiresAt, now)}</span> : null}
                {m.rotation ? <span className="text-xs text-muted-foreground">· {m.rotation}</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {m.calibration?.noiseFloor !== null && m.calibration?.noiseFloor !== undefined
                  ? `own calibration: noise ${frac(m.calibration.noiseFloor)} per pair, win threshold ${frac(m.calibration.mde)}${m.calibration.sideRuns && m.calibration.sideRuns > 1 ? `, ${m.calibration.sideRuns} runs a side` : ""}${m.calibration.at ? ` (${ago(m.calibration.at, now)})` : ""}`
                  : "not calibrated yet"}
                {m.joinSeconds !== null ? ` · joined in ${duration(m.joinSeconds)}` : ""} · {m.measured} measured
                {m.shape ? ` · ${m.shape.os}/${m.shape.arch}${m.shape.cpuModel ? ` · ${m.shape.cpuModel}` : ""}` : ""}
              </div>
              {m.machine || (m.shape && Object.keys(m.shape.extra).length) ? (
                <div className="text-xs text-muted-foreground">
                  {m.machine ? `asked for: ${Object.entries(m.machine).map(([k, x]) => `${k}=${String(x)}`).join(", ")}` : ""}
                  {m.machine && m.shape && Object.keys(m.shape.extra).length ? " · " : ""}
                  {m.shape && Object.keys(m.shape.extra).length ? `reports: ${Object.entries(m.shape.extra).slice(0, 12).map(([k, x]) => `${k}=${x}`).join(", ")}` : ""}
                </div>
              ) : null}
              {m.shapeWarning ? <div className="text-xs text-warning-text">⚠ {m.shapeWarning}</div> : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No remote machine runs now: they join while the study runs (or calibrates) and are destroyed when it pauses or ends.</EmptyState>
      )}
      {gone.length ? (
        <div className="text-xs text-muted-foreground">
          Recently gone: {gone.map((m) => `${m.name} (${m.leftReason ?? "left"}${m.leftAt ? `, ${ago(m.leftAt, now)}` : ""})`).join(" · ")}
        </div>
      ) : null}
    </div>
  );
}
