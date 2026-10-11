// Bench machine health: policy over the host's HealthReport, and the check
// the pipeline runs before every measurement, calibration, and drift check.
// A failing check defers the measurement (the candidate stays queued, the
// host waits `retry_seconds`); a host unhealthy longer than
// `notify_after_minutes` raises a notice.
import { benchRunner } from "./bench.ts";
import type { Ctx } from "./context.ts";
import type { BenchHostRow, StudyRow } from "./db/store.ts";
import type { HealthReport } from "./host/contract.ts";
import type { StudySpec } from "./spec.ts";

export type HealthPolicy = StudySpec["oracle"]["health"];

export interface HealthAssessment {
  ok: boolean;
  problems: string[];
  /** One line for the human: load, top process, governor, power. */
  summary: string;
}

export function assessHealth(r: HealthReport, p: HealthPolicy): HealthAssessment {
  const problems: string[] = [];
  const perCpu = r.cpus > 0 ? r.loadavg[0]! / r.cpus : r.loadavg[0]!;
  if (perCpu > p.max_load) problems.push(`load ${r.loadavg[0]!.toFixed(2)} on ${r.cpus} CPUs (${perCpu.toFixed(2)} per CPU, limit ${p.max_load})`);
  const ignore = new Set(p.ignore_processes.map((x) => x.toLowerCase()));
  const top = r.topProcesses.find((x) => !ignore.has(x.command.toLowerCase()));
  if (top && top.cpu > p.max_process_cpu) problems.push(`competing process ${top.command} (pid ${top.pid}) at ${top.cpu.toFixed(0)}% CPU (limit ${p.max_process_cpu}%)`);
  if (p.require_governor && r.governor !== null && r.governor !== p.require_governor) problems.push(`CPU governor is ${r.governor}, not ${p.require_governor}`);
  if (p.require_turbo_off && r.turbo === true) problems.push("turbo/boost is on");
  if (p.require_ac_power && r.onAcPower === false) problems.push("running on battery power");
  if (r.cpuSpeedLimit !== null && r.cpuSpeedLimit < p.min_cpu_speed_limit) problems.push(`CPU speed limited to ${r.cpuSpeedLimit}% (thermal)`);
  const parts = [
    `load ${r.loadavg.map((v) => v.toFixed(2)).join("/")} on ${r.cpus} CPUs`,
    top ? `top ${top.command} ${top.cpu.toFixed(0)}%` : null,
    r.governor !== null ? `governor ${r.governor}` : null,
    r.turbo !== null ? `turbo ${r.turbo ? "on" : "off"}` : null,
    r.onAcPower !== null ? (r.onAcPower ? "AC power" : "battery") : null,
    r.cpuSpeedLimit !== null ? `speed limit ${r.cpuSpeedLimit}%` : null,
    r.notDetectable.length ? `not detectable: ${r.notDetectable.join(", ")}` : null,
  ].filter(Boolean);
  return { ok: problems.length === 0, problems, summary: `${r.hostname} (${r.platform}/${r.arch}): ${parts.join(" · ")}` };
}

export interface HealthCheckOutcome extends HealthAssessment {
  /** True when the check was skipped (health.enabled = false). */
  skipped: boolean;
}

/**
 * Probe a bench host, record the result, and update its row. Unhealthy
 * hosts are deferred; a notice goes out once per unhealthy streak after
 * `notify_after_minutes`.
 */
export async function checkHealth(
  ctx: Ctx,
  study: StudyRow,
  host: BenchHostRow,
  spec: StudySpec,
  context: "measure" | "calibration" | "drift" | "profile" | "manual",
  notify: (kind: string, text: string) => Promise<void>,
): Promise<HealthCheckOutcome> {
  const policy = spec.oracle.health;
  if (!policy.enabled) return { ok: true, problems: [], summary: "health checks disabled", skipped: true };
  const { store } = ctx;
  const report = await benchRunner(ctx, host).health();
  const a = assessHealth(report, policy);
  const now = ctx.now();
  store.addHealthCheck({ study_id: study.id, host_id: host.host_id, context, ok: a.ok ? 1 : 0, problems_json: JSON.stringify(a.problems), report_json: JSON.stringify(report) });
  // Every result is also an event, so a replay shows the bench's health at any moment (append-only; since v0.2.3).
  store.event(study.id, "bench.health", "plugin", { host: host.host_id, ok: a.ok, context });
  const fresh = store.benchHost(study.id, host.host_id) ?? host;
  if (a.ok) {
    store.updateBenchHost(study.id, host.host_id, { health_ok: 1, health_at: now, health_json: JSON.stringify({ summary: a.summary, problems: [] }), unhealthy_since: null, unhealthy_notified_at: null, deferred_until: null });
    if (fresh.health_ok === 0) store.event(study.id, "bench.healthy", "plugin", { host: host.host_id });
    return { ...a, skipped: false };
  }
  const since = fresh.unhealthy_since ?? now;
  store.updateBenchHost(study.id, host.host_id, {
    health_ok: 0,
    health_at: now,
    health_json: JSON.stringify({ summary: a.summary, problems: a.problems }),
    unhealthy_since: since,
    deferred_until: now + policy.retry_seconds * 1000,
  });
  store.event(study.id, "bench.unhealthy", "plugin", { host: host.host_id, context, problems: a.problems.slice(0, 5) });
  if (fresh.unhealthy_notified_at === null && now - since >= policy.notify_after_minutes * 60_000) {
    store.updateBenchHost(study.id, host.host_id, { unhealthy_notified_at: now });
    await notify(
      "bench.unhealthy",
      `Bench host ${host.name} has failed its health check for ${Math.round((now - since) / 60_000)} min, so measurements on it wait. Next: quiet the machine, or loosen [oracle.health] with a spec change (Bench tab).\n${a.problems.join("; ")}. (${a.summary})`,
    );
  }
  return { ...a, skipped: false };
}
