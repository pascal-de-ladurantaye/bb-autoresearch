// Bench host list shared by the Overview and the Bench tab.
import type { OverviewResult } from "../views.ts";
import { shortSha } from "./format.ts";
import { expiryText } from "./RemoteBench.tsx";

export type BenchHostView = OverviewResult["benchHosts"][number];

export function BenchHostList({ hosts, queueDepth }: { hosts: BenchHostView[]; queueDepth: number }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Bench hosts">
      {hosts.map((h) => (
        <li key={h.hostId} className="space-y-0.5 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{h.name}</span>
            <span className="text-xs text-muted-foreground">{h.mode === "clone" ? "own clone · git bundles" : h.mode === "remote" ? `remote · ${h.remote?.provider ?? "provider"} · ${h.remote?.cores ?? "?"} cores${h.remote?.expiresAt ? ` · ${expiryText(h.remote.expiresAt)}` : ""}${h.remote?.rotation ? ` · ${h.remote.rotation}` : ""}` : "local checkouts"}</span>
            <span className={h.status === "offline" ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{h.status === "offline" ? "✗ offline" : h.status}</span>
            <span className={h.healthOk === false ? "text-xs text-warning-text" : "text-xs text-success"}>
              {h.healthOk === null ? "health not checked" : h.healthOk ? "✓ healthy" : "⚠ unhealthy"}
            </span>
            <span className="text-xs text-muted-foreground">
              drift {h.driftStatus ?? "not run"} ({h.evalsSinceDrift}/{h.driftEvery || "off"})
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {h.measuring !== null ? `measuring c/${h.measuring}` : h.gating !== null ? `testing c/${h.gating} (${h.mode === "remote" ? "gates on this machine" : "single-machine mode: tests hold the bench"})` : "idle"}
            {h.progress ? ` · ${h.progress}` : ""} · queue {queueDepth} · best build {h.bestBuildSha ? shortSha(h.bestBuildSha) : "not cached"}
            {h.mode === "clone" || h.mode === "remote" ? ` · ${h.bundles} bundle(s), ${Math.round(h.bundleBytes / 1024)} KiB` : ""}
            {h.deferredUntil ? ` · deferred until ${new Date(h.deferredUntil).toLocaleTimeString()}` : ""}
          </div>
          {h.problems.length ? <div className="text-xs text-warning-text">{h.problems.join("; ")}</div> : null}
          {h.healthSummary ? <div className="truncate text-xs text-muted-foreground">{h.healthSummary}</div> : null}
        </li>
      ))}
    </ul>
  );
}
