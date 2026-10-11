// What the Bench tab, the Overview, the Live bench strip and `bb study bench`
// show about remote bench hosts: each entry (provider, shape, lifetime, seed)
// and each machine (state, expiry, rotation, its own calibration, what it
// measures). Read only; built from the remote_hosts and bench_hosts rows.
import type { Engine } from "../engine.ts";
import type { RemoteHostRow, StudyRow } from "../db/store.ts";
import { safeJson } from "../prompts.ts";
import type { StudySpec } from "../spec.ts";

export interface RemoteMachineView {
  id: number;
  benchHostId: string;
  name: string;
  provider: string;
  slot: string;
  /** creating | joining | calibrating | ready | retiring | gone */
  state: RemoteHostRow["state"];
  /** The state in words, with what it does now. */
  stateText: string;
  phase: string | null;
  cores: number;
  memoryGb: number | null;
  /** What the machine reports: OS, arch, CPU model, visible CPUs and quota. */
  shape: { os: string; arch: string; cpuModel: string | null; nproc: number | null; quota: number | null; memoryGb: number | null } | null;
  /** The visible CPU count differs from the cores asked for (thread pools sized from it would differ from the target machine). */
  shapeWarning: string | null;
  createdAt: number;
  readyAt: number | null;
  expiresAt: number | null;
  leftAt: number | null;
  leftReason: string | null;
  joinSeconds: number | null;
  /** Rotation in words: "replaces #3", "rotating out: #5 took its slot", "replacement starts in 4 min". */
  rotation: string | null;
  replaces: number | null;
  replacedBy: number | null;
  calibration: { noiseFloor: number | null; mde: number | null; sideRuns: number | null; runSeconds: number | null; sha: string | null; at: number | null } | null;
  /** The candidate it measures (or gates) now. */
  measuring: number | null;
  gating: number | null;
  measured: number;
  error: string | null;
}

export interface RemoteEntryView {
  index: number;
  provider: string;
  hosts: number;
  cores: number;
  memoryGb: number | null;
  lifetimeMinutes: number;
  rotateLeadMinutes: number;
  gates: boolean;
  setup: boolean;
  seed: { state: "ok" | "refused" | "failed" | "not built"; bytes: number | null; files: number | null; at: number | null; detail: string | null } | null;
  /** Why no new machine is added now (repeated failures, a refused seed). */
  blocked: string | null;
}

export interface RemoteView {
  entries: RemoteEntryView[];
  machines: RemoteMachineView[];
  /** Live machines (cost: what runs now). */
  live: number;
  baseBundle: { bytes: number | null; sha: string; cached: boolean } | null;
}

const STATE_WORDS: Record<RemoteHostRow["state"], string> = {
  creating: "being created",
  joining: "joining",
  calibrating: "calibrating",
  ready: "measuring",
  retiring: "retiring",
  gone: "gone",
};

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : `${m} min`;
}

export function remoteView(engine: Engine, s: StudyRow, spec: StudySpec | null): RemoteView {
  const { store } = engine.ctx;
  const now = engine.ctx.now();
  const rows = store.remoteHosts(s.id, { limit: 40 });
  const entries = spec?.oracle.remote_bench ?? [];
  const measuring = store.candidates(s.id, { stages: ["measuring", "confirming", "promoting"] });
  const gating = store.benchIntervals(s.id, { since: now }).filter((i) => i.kind === "gate" && i.ended_at === null);
  const names = new Map(store.benchHosts(s.id, { all: true }).map((h) => [h.host_id, h.name] as const));
  const machines = rows.map((r): RemoteMachineView => {
    const info = safeJson<{ os?: string; arch?: string; cpuModel?: string | null; nproc?: number | null; cpuQuotaCores?: number | null; memoryBytes?: number | null }>(r.info_json);
    const cal = safeJson<{ noiseFloor?: number; mde?: number; sideRuns?: number | null; runSeconds?: number | null; sha?: string; at?: number }>(r.calibration_json);
    const replacedBy = rows.find((x) => x.replaces === r.id)?.id ?? null;
    const entry = entries[r.entry];
    let rotation: string | null = null;
    if (r.replaces !== null && r.state !== "gone") rotation = r.state === "ready" ? `replaced #${r.replaces}` : `replacement for #${r.replaces}`;
    else if (r.state === "retiring") rotation = replacedBy !== null ? `rotating out: #${replacedBy} took its slot` : (r.left_reason ?? "retiring");
    else if (r.state === "ready" && replacedBy !== null) rotation = `replacement #${replacedBy} is joining`;
    else if (r.state === "ready" && r.expires_at !== null && entry) {
      const lead = engine.fleet.rotationLeadMs(s, r.entry, entry);
      const at = r.expires_at - lead;
      rotation = at > now ? `replacement starts in ${minutes(at - now)}` : "replacement due";
    }
    const quota = info?.cpuQuotaCores ?? null;
    const nproc = info?.nproc ?? null;
    const shapeWarning = nproc !== null && nproc !== r.cores ? `the machine shows ${nproc} CPUs${quota !== null ? ` for a quota of ${quota}` : ""}, while ${r.cores} were asked for: code that sizes thread pools from the CPU count behaves differently here (AUTORESEARCH_CORES=${r.cores} is set for every command)` : null;
    const m = measuring.find((c) => c.bench_host_id === r.bench_host_id);
    const g = gating.find((i) => i.host_id === r.bench_host_id);
    const stateText =
      r.state === "ready"
        ? m
          ? `measuring c/${m.n}`
          : g
            ? `testing c/${store.candidate(g.candidate_id ?? -1)?.n ?? "?"}`
            : "ready, idle"
        : r.state === "gone"
          ? `gone: ${r.left_reason ?? "left"}`
          : `${STATE_WORDS[r.state]}${r.phase ? `: ${r.phase}` : ""}`;
    return {
      id: r.id,
      benchHostId: r.bench_host_id,
      name: names.get(r.bench_host_id) ?? r.bench_host_id,
      provider: r.provider,
      slot: r.slot,
      state: r.state,
      stateText,
      phase: r.phase,
      cores: r.cores,
      memoryGb: r.memory_gb,
      shape: info ? { os: info.os ?? "?", arch: info.arch ?? "?", cpuModel: info.cpuModel ?? null, nproc, quota, memoryGb: info.memoryBytes ? Math.round((info.memoryBytes / 2 ** 30) * 10) / 10 : null } : null,
      shapeWarning,
      createdAt: r.created_at,
      readyAt: r.ready_at,
      expiresAt: r.expires_at,
      leftAt: r.left_at,
      leftReason: r.left_reason,
      joinSeconds: r.join_seconds,
      rotation,
      replaces: r.replaces,
      replacedBy,
      calibration: cal ? { noiseFloor: cal.noiseFloor ?? null, mde: cal.mde ?? null, sideRuns: cal.sideRuns ?? null, runSeconds: cal.runSeconds ?? null, sha: cal.sha ?? null, at: cal.at ?? null } : null,
      measuring: m?.n ?? null,
      gating: g ? (store.candidate(g.candidate_id ?? -1)?.n ?? null) : null,
      measured: store.candidates(s.id, { stages: ["decided"] }).filter((c) => c.bench_host_id === r.bench_host_id).length,
      error: r.error,
    };
  });
  const artifacts = store.artifacts(s.id);
  const base = artifacts.find((a) => a.kind === "base" && a.key === (s.base_sha ?? ""));
  return {
    entries: entries.map((e, i): RemoteEntryView => {
      const seedRow = artifacts.find((a) => a.kind === "seed" && a.entry === i);
      const block = engine.fleet.entryBlock(s.id, i);
      const seedDetail = seedRow ? safeJson<{ findings?: Array<{ path: string; rule: string }>; error?: string | null; output?: string }>(seedRow.detail_json) : null;
      return {
        index: i,
        provider: e.provider,
        hosts: e.hosts,
        cores: e.cores,
        memoryGb: e.memory_gb ?? null,
        lifetimeMinutes: e.lifetime_minutes,
        rotateLeadMinutes: Math.round(engine.fleet.rotationLeadMs(s, i, e) / 6_000) / 10,
        gates: e.gates,
        setup: Boolean(e.setup),
        seed: e.seed
          ? {
              state: seedRow?.state ?? "not built",
              bytes: seedRow?.bytes ?? null,
              files: seedRow?.files ?? null,
              at: seedRow?.created_at ?? null,
              detail:
                seedRow?.state === "refused"
                  ? seedDetail?.error ?? `credential scan matched: ${(seedDetail?.findings ?? []).slice(0, 8).map((f) => `${f.path} (${f.rule})`).join(", ")}${(seedDetail?.findings?.length ?? 0) > 8 ? ", …" : ""}`
                  : seedRow?.state === "failed"
                    ? `${seedDetail?.error ?? "failed"}${seedDetail?.output ? `: ${seedDetail.output.slice(-300)}` : ""}`
                    : null,
            }
          : null,
        blocked: block ? (block.seedRefused ? "the seed was refused: fix it or seed_allow with a spec change" : block.until !== null && block.until > now ? `${block.failures} failed join(s); next try in ${minutes(block.until - now)}: ${block.last.slice(0, 300)}` : null) : null,
      };
    }),
    machines,
    live: rows.filter((r) => r.state !== "gone").length,
    baseBundle: base ? { bytes: base.bytes, sha: base.key, cached: Boolean(safeJson<{ cached?: boolean }>(base.detail_json)?.cached) } : null,
  };
}

/** One line per live machine for `bb study show` / `bb study bench`. */
export function remoteLines(v: RemoteView, now: number): string[] {
  const out: string[] = [];
  for (const e of v.entries) {
    out.push(
      `Remote bench ${e.index + 1}: ${e.provider} · ${e.hosts} machine(s) × ${e.cores} cores${e.memoryGb ? `, ${e.memoryGb} GB` : ""} · ${e.lifetimeMinutes} min each, replaced ${e.rotateLeadMinutes} min before the end${e.gates ? " · gates run there" : ""}${e.seed ? ` · seed ${e.seed.state}${e.seed.bytes !== null ? ` (${e.seed.bytes < 10_240 ? `${e.seed.bytes} B` : `${Math.round(e.seed.bytes / 1024)} KiB`})` : ""}` : ""}`,
    );
    if (e.seed?.detail) out.push(`  seed: ${e.seed.detail}`);
    if (e.blocked) out.push(`  no new machine: ${e.blocked}`);
  }
  for (const m of v.machines.filter((x) => x.state !== "gone")) {
    const cal = m.calibration?.noiseFloor !== null && m.calibration?.noiseFloor !== undefined ? ` · noise ${(m.calibration.noiseFloor * 100).toFixed(2)}%, win threshold ${((m.calibration.mde ?? 0) * 100).toFixed(2)}%` : "";
    const exp = m.expiresAt !== null ? ` · ends in ${minutes(Math.max(0, m.expiresAt - now))}` : "";
    out.push(`  ${m.name} (slot ${m.slot}, ${m.cores} cores${m.shape?.nproc ? `, ${m.shape.nproc} CPUs visible` : ""}): ${m.stateText}${exp}${cal}${m.rotation ? ` · ${m.rotation}` : ""} · measured ${m.measured}`);
    if (m.shapeWarning) out.push(`    note: ${m.shapeWarning}`);
  }
  const gone = v.machines.filter((x) => x.state === "gone").slice(0, 5);
  if (gone.length) out.push(`  recently gone: ${gone.map((m) => `#${m.id} (${m.leftReason ?? "left"})`).join("; ")}`);
  return out;
}
