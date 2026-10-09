// `bb study` — the human's controls. Output is bounded; human controls are
// refused when invoked from a study's own worker or strategist thread.
import { PluginCliError, cliCommand, defineCli, type PluginCliContext, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import { EngineError, type Caller, type Engine } from "./engine.ts";
import { errText } from "./pipeline.ts";
import { ciText, clip, formatDuration, safeJson } from "./prompts.ts";
import { benchHostsView, segmentView, utilization } from "./views.ts";
import { formatPct } from "./spec.ts";
import type { CalibrationReport } from "./calibration.ts";

const MAX = 60_000;

function out(text: string) {
  return { exitCode: 0, stdout: `${clip(text, MAX)}\n` };
}

function guardHuman(engine: Engine, ctx: PluginCliContext, allowStrategist = false): string {
  if (ctx.threadId) {
    const row = engine.ctx.store.threadById(ctx.threadId);
    if (row?.role === "worker" || (row?.role === "strategist" && !allowStrategist)) {
      throw new PluginCliError("this is a human control; study agents cannot run it", { code: "forbidden", hint: "Ask the human to run it." });
    }
    return ctx.threadId;
  }
  return "human";
}

/** Caller info for the audit log. The thread id comes from the invoking shell's environment, so it is evidence, not proof. */
function caller(ctx: PluginCliContext): Caller {
  return { via: "cli", threadId: ctx.threadId ?? null };
}

async function wrap(fn: () => Promise<{ exitCode: number; stdout: string }> | { exitCode: number; stdout: string }) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngineError) throw new PluginCliError(e.message, { code: "study_error" });
    if (e instanceof PluginCliError) throw e;
    throw new PluginCliError(errText(e), { code: "internal" });
  }
}

const slugArg = [{ name: "slug", description: "Study slug (see `bb study list`)", required: true }] as const;

export function studyCli(engine: Engine): PluginCliRegistration {
  const { store } = engine.ctx;
  return defineCli({
    name: "study",
    summary: "Autoresearch studies: measured, agent-driven code optimization",
    commands: {
      list: cliCommand({
        summary: "List studies with state, best vs base, and budget",
        run: () =>
          wrap(() => {
            const rows = store.studies();
            if (!rows.length) return out("No studies. Start one by asking an agent to use the study-create skill.");
            const lines = rows.slice(0, 100).map((s) => {
              let spec;
              try {
                spec = store.spec(s);
              } catch {
                spec = null;
              }
              const live = store.threads(s.id, { role: "worker", states: ["spawning", "active", "finishing"] }).length;
              return `${s.slug.padEnd(24)} ${s.state.padEnd(12)} best vs base ${formatPct(engine.cumulative(s))} · ${live} worker(s) · ${spec ? engine.budgetLine(s, spec) : "no spec"}`;
            });
            return out(lines.join("\n"));
          }),
      }),
      show: cliCommand({
        summary: "Show a study: spec, calibration, best, ideas, candidates, workers, recent events",
        positionals: slugArg,
        options: { events: { type: "integer", min: 0, max: 200, default: 12, description: "Recent events to show (max 200)" } },
        run: (input) => wrap(() => out(showStudy(engine, input.positionals.slug, input.options.events ?? 12))),
      }),
      calibrate: cliCommand({
        summary: "Approve the current spec and run calibration (gates on base, A/A noise measurement)",
        positionals: slugArg,
        options: { wait: { type: "boolean", description: "Wait for calibration to finish (up to --timeout)" }, timeout: { type: "duration", defaultUnit: "m", min: 1_000, max: 30 * 60_000, default: 25 * 60_000, description: "Max wait with --wait (default 25m, max 30m)" } },
        run: (input, ctx) =>
          wrap(async () => {
            const actor = guardHuman(engine, ctx);
            const text = await engine.calibrate(input.positionals.slug, actor);
            await engine.auditControl(input.positionals.slug, "calibrate", caller(ctx), `spec approved and calibration started`, { spec_version: engine.study(input.positionals.slug).spec_version });
            if (!input.options.wait) return out(text);
            await engine.waitForCalibration(input.positionals.slug, input.options.timeout ?? 25 * 60_000);
            return out(`${text}\n\n${calibrationText(engine, input.positionals.slug)}`);
          }),
      }),
      start: cliCommand({
        summary: "Approve calibration and start running (or resume)",
        positionals: slugArg,
        run: (input, ctx) =>
          wrap(async () => {
            const text = await engine.start(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "start", caller(ctx), "calibration approved / study started");
            return out(text);
          }),
      }),
      approve: cliCommand({
        summary: "Apply a pending spec whose oracle is unchanged (budget, agents); oracle changes need `calibrate`",
        positionals: slugArg,
        run: (input, ctx) =>
          wrap(async () => {
            const text = engine.approve(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "approve", caller(ctx), "pending spec applied without recalibration");
            return out(text);
          }),
      }),
      drift: cliCommand({
        summary: "Run a drift check (A/A on best) on every bench host at its next free slot",
        positionals: slugArg,
        run: (input, ctx) =>
          wrap(async () => {
            const text = engine.requestDrift(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "drift", caller(ctx), "drift check requested");
            return out(text);
          }),
      }),
      bench: cliCommand({
        summary: "Bench hosts: health, transfers, drift checks, segments",
        positionals: slugArg,
        run: (input) => wrap(() => out(benchText(engine, input.positionals.slug))),
      }),
      pause: cliCommand({
        summary: "Pause: no new workers; running workers finish their current submission",
        positionals: slugArg,
        run: (input, ctx) =>
          wrap(async () => {
            const text = engine.pause(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "pause", caller(ctx), "study paused");
            return out(text);
          }),
      }),
      resume: cliCommand({
        summary: "Resume a paused study",
        positionals: slugArg,
        run: (input, ctx) =>
          wrap(async () => {
            const before = engine.study(input.positionals.slug).pause_reason;
            const text = engine.resume(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "resume", caller(ctx), `study resumed${before ? ` (was paused: ${clip(before, 200)})` : ""}`);
            return out(text);
          }),
      }),
      concurrency: cliCommand({
        summary: "Set a study's max concurrent workers (overrides budget.max_workers; `auto` returns to the spec)",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "workers", description: "1-64, or auto", required: true },
        ] as const,
        run: (input, ctx) =>
          wrap(async () => {
            const actor = guardHuman(engine, ctx);
            const v = input.positionals.workers.trim();
            const n = v === "auto" ? null : Number(v);
            if (n !== null && !Number.isInteger(n)) throw new EngineError("workers must be an integer from 1 to 64, or auto");
            const text = engine.setConcurrency(input.positionals.slug, n, actor);
            await engine.auditControl(input.positionals.slug, "concurrency", caller(ctx), `max workers ${n === null ? "back to the spec" : `set to ${engine.maxWorkers(engine.study(input.positionals.slug))}${n !== engine.maxWorkers(engine.study(input.positionals.slug)) ? ` (requested ${n}, clamped)` : ""}`}`, { requested: n });
            return out(text);
          }),
      }),
      archive: cliCommand({
        summary: "Stop a study for good: stop workers, archive their threads, remove bench checkouts (refs are kept)",
        positionals: slugArg,
        run: (input, ctx) =>
          wrap(async () => {
            const actor = guardHuman(engine, ctx);
            await engine.auditControl(input.positionals.slug, "archive", caller(ctx), "study archived");
            return out(await engine.archiveStudy(input.positionals.slug, actor));
          }),
      }),
      workers: cliCommand({
        summary: "List a study's worker threads",
        positionals: slugArg,
        run: (input) =>
          wrap(() => {
            const s = engine.study(input.positionals.slug);
            const rows = store.threads(s.id, { role: "worker" }).slice(-50);
            if (!rows.length) return out("No workers yet.");
            return out(rows.map((w) => `${w.thread_id ?? "(spawning)"} idea #${w.idea_id ?? "?"} ${w.state} · ${w.submissions} submission(s)${w.end_reason ? ` · ${w.end_reason}` : ""}`).join("\n"));
          }),
      }),
      "ideas add": cliCommand({
        summary: "Add (and pin) an idea to a study's queue",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "title", description: "Idea title (quote it)", required: true },
        ] as const,
        options: {
          rationale: { type: "string", description: "Why it might help (max 2000 chars)" },
          theme: { type: "string", description: "Theme used for diversity (max 60 chars)" },
          priority: { type: "integer", min: -100, max: 100, default: 0, description: "Higher runs first (-100..100)" },
          "start-ref": { type: "string", description: 'Start from a candidate, e.g. "c/12"' },
          "variation-of": { type: "integer", min: 1, max: 1_000_000_000, description: "Id of the idea this varies" },
          "no-pin": { type: "boolean", description: "Don't pin (human ideas are pinned by default)" },
        },
        run: (input, ctx) =>
          wrap(async () => {
            const actor = guardHuman(engine, ctx, true);
            const idea = engine.addIdea(
              input.positionals.slug,
              {
                title: input.positionals.title,
                rationale: input.options.rationale,
                theme: input.options.theme,
                priority: input.options.priority,
                pinned: !input.options["no-pin"],
                startRef: input.options["start-ref"] ?? null,
                variationOf: input.options["variation-of"] ?? null,
              },
              actor,
              actor === "human" || store.threadById(actor)?.role !== "strategist" ? "human" : "strategist",
            );
            if (idea.source === "human") await engine.auditControl(input.positionals.slug, "idea_added", caller(ctx), `idea #${idea.id} added${idea.pinned ? " (pinned)" : ""}: ${clip(idea.title, 120)}`, { idea: idea.id });
            return out(`Idea #${idea.id} queued${idea.pinned ? " (pinned)" : ""}: ${idea.title}`);
          }),
      }),
      "ideas list": cliCommand({
        summary: "List a study's ideas",
        positionals: slugArg,
        run: (input) =>
          wrap(() => {
            const s = engine.study(input.positionals.slug);
            const rows = store.ideas(s.id).slice(0, 100);
            return out(rows.length ? rows.map((i) => `#${i.id} ${i.status.padEnd(9)} p=${i.priority}${i.pinned ? " pinned" : ""} [${i.source}] ${clip(i.title, 100)}${i.theme ? ` (${i.theme})` : ""}`).join("\n") : "No ideas.");
          }),
      }),
      harvest: cliCommand({
        summary: "Turn base→best into reviewable PRs (arrives in M3)",
        positionals: slugArg,
        run: (input) =>
          wrap(() => {
            engine.study(input.positionals.slug);
            return out(`Harvest (ablation + draft PRs) arrives in M3. Until then the promoted commits are on branch studies/${input.positionals.slug}/best, one squashed commit per win.`);
          }),
      }),
    },
  });
}

function schedulerLine(engine: Engine, s: ReturnType<Engine["study"]>): string {
  const t = engine.ctx.store.study(s.id)!;
  const tEval = engine.pipeline.recentEvalSeconds(t);
  const tThink = engine.thinkSeconds(t);
  return `Scheduler: W ${t.target_workers ?? "?"} of max ${engine.maxWorkers(t)}${t.max_workers_override !== null ? " (human override)" : ""} · bench queue ${engine.benchDepth(t.id)} · think ≈ ${tThink === null ? "?" : formatDuration(tThink)} · eval ≈ ${tEval === null ? "?" : formatDuration(tEval)}`;
}

function utilizationLine(engine: Engine, s: ReturnType<Engine["study"]>): string {
  const u = utilization(engine, s);
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  return `Bench: busy ${formatDuration(u.busySeconds)} of ${formatDuration(u.runningSeconds)} running (${pct(u.ratio)}; ${pct(u.steadyRatio)} since the first submission) · overlapping measurements ${u.overlaps}`;
}

function segmentLine(engine: Engine, s: ReturnType<Engine["study"]>): string {
  const seg = segmentView(engine, s);
  const pending = s.pending_spec_version !== null ? ` · spec v${s.pending_spec_version} pending approval (${seg.pendingChangesOracle ? "oracle change: `bb study calibrate`" : "no oracle change: `bb study approve`"})` : "";
  return `Segment ${seg.k}${seg.oracleHash ? ` (oracle ${seg.oracleHash}, spec v${seg.specVersion ?? "?"}, baseline ${seg.baselineSha?.slice(0, 10) ?? "?"})` : ""} · ${seg.count} segment(s)${pending}`;
}

function benchLines(engine: Engine, s: ReturnType<Engine["study"]>): string[] {
  const hosts = benchHostsView(engine, s);
  if (!hosts.length) return ["Bench hosts: none yet (set at calibration)"];
  return hosts.map(
    (h) =>
      `Bench host ${h.name} [${h.mode === "clone" ? "own clone via git bundles" : "local checkouts"}] ${h.status}` +
      ` · health ${h.healthOk === null ? "not checked" : h.healthOk ? "ok" : `FAILING (${h.problems.join("; ")})`}${h.deferredUntil ? ` · deferred until ${new Date(h.deferredUntil).toISOString().slice(11, 19)}` : ""}` +
      ` · ${h.measuring !== null ? `measuring c/${h.measuring}` : "idle"} · drift ${h.driftStatus ?? "not run"} (${h.evalsSinceDrift}/${h.driftEvery} evals)` +
      ` · cached best build ${h.bestBuildSha ? h.bestBuildSha.slice(0, 10) : "none"}${h.lastTransfer ? ` · last bundle ${h.lastTransfer}` : ""}${h.healthSummary ? `\n    ${h.healthSummary}` : ""}`,
  );
}

function benchText(engine: Engine, slug: string): string {
  const { store } = engine.ctx;
  const s = engine.study(slug);
  const lines = [`Study ${s.slug} · ${s.state}`, segmentLine(engine, s), ...benchLines(engine, s), ""];
  const transfers = store.transfers(s.id, 20);
  lines.push(`Transfers (git bundles, newest first): ${transfers.length}`);
  for (const t of transfers) lines.push(`  ${new Date(t.at).toISOString().slice(5, 19)} ${t.host_id} ${t.purpose} ${t.sha.slice(0, 10)} ${t.ok ? `${t.bytes} B in ${t.chunks} chunk(s), ${Math.round(t.ms)} ms` : `FAILED: ${clip(t.error ?? "", 200)}`}`);
  const health = store.healthChecks(s.id, { limit: 10 });
  lines.push(`Health checks (newest first): ${health.length}`);
  for (const h of health) lines.push(`  ${new Date(h.at).toISOString().slice(5, 19)} ${h.host_id} ${h.context} ${h.ok ? "ok" : `FAIL ${clip((safeJson<string[]>(h.problems_json) ?? []).join("; "), 200)}`}`);
  const drift = store.driftChecks(s.id, 10);
  lines.push(`Drift checks (newest first): ${drift.length}`);
  for (const d of drift) lines.push(`  ${new Date(d.started_at).toISOString().slice(5, 19)} ${d.host_id} segment ${d.segment} ${d.status}${d.ratio !== null ? ` · noise ${formatPct(d.noise)} vs calibrated ${formatPct(d.calibrated)} = ${d.ratio.toFixed(2)}× over ${d.pairs} pairs` : ""}`);
  const segs = store.segments(s.id);
  lines.push(`Segments: ${segs.length}`);
  for (const g of segs) lines.push(`  ${g.k}: oracle ${g.oracle_hash} · spec v${g.spec_version ?? "?"} · baseline ${g.baseline_sha.slice(0, 10)} · MDE ${formatPct(g.mde)} · noise ${formatPct(g.noise_floor)}`);
  return lines.join("\n");
}

function calibrationText(engine: Engine, slug: string): string {
  const s = engine.study(slug);
  const report = safeJson<CalibrationReport>(s.calibration_json);
  if (s.calibration_status === "running") return "Calibration: running.";
  if (!report) return `Calibration: ${s.calibration_status ?? "not run"}.`;
  if (!report.ok) return `Calibration FAILED (study back in draft):\n${report.problems.map((p) => `- ${clip(p, 600)}`).join("\n")}`;
  const next = s.calibration_approved_at === null ? `\nApprove and start with \`bb study start ${slug}\`.` : "";
  return `Calibration ${s.calibration_approved_at === null ? "ready" : "approved"} (baseline ${report.baselineSha.slice(0, 10)}, oracle ${report.oracleHash}):\n${report.report}${next}`;
}

export function showStudy(engine: Engine, slug: string, eventCount: number): string {
  const { store } = engine.ctx;
  const s = engine.study(slug);
  const spec = store.spec(s);
  const lines = [
    `Study ${s.slug} · ${s.state}${s.pause_reason ? ` (${s.pause_reason})` : ""} · spec v${s.spec_version}${store.specVersion(s.id, s.spec_version)?.approved_at ? " approved" : " not approved"}`,
    `Objective: ${clip(spec.study.objective, 300)}`,
    `Metric: ${spec.metric.name}${spec.metric.unit ? ` (${spec.metric.unit})` : ""}, ${spec.metric.direction} is better · noise ${spec.oracle.noise}${spec.guardrail.length ? ` · guardrails ${spec.guardrail.map((g) => `${g.name}≤${formatPct(g.max_regression)}`).join(", ")}` : ""}`,
    `Scope: editable ${spec.scope.editable.join(", ")} · protected ${spec.scope.protected.join(", ") || "none"}`,
    `Oracle: build ${spec.oracle.build ? "`" + clip(spec.oracle.build, 80) + "`" : "none"} · gate ${spec.oracle.gate.map((g) => "`" + clip(g, 60) + "`").join(", ") || "none"} · measure \`${clip(spec.oracle.measure, 80)}\`${spec.oracle.holdout ? " · holdout: configured (hidden from agents)" : ""}`,
    segmentLine(engine, s),
    `Repo: ${s.repo_path} (host ${s.host_id}) · study thread ${s.study_thread_id ?? "none"}`,
    `Best: ${s.best_sha?.slice(0, 10) ?? "not set"} (branch studies/${s.slug}/best) · base ${s.base_sha?.slice(0, 10) ?? "?"} · best vs base ${formatPct(engine.cumulative(s))}`,
    `Budget: ${engine.budgetLine(s, spec)} · strategist rounds ${s.rounds}${s.round_in_flight ? " (one in flight)" : ""}`,
    schedulerLine(engine, s),
    utilizationLine(engine, s),
    ...benchLines(engine, s),
    calibrationText(engine, slug),
    "",
  ];
  const ideas = store.ideas(s.id);
  const counts = new Map<string, number>();
  for (const i of ideas) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  lines.push(`Ideas: ${[...counts].map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  for (const i of ideas.filter((x) => x.status === "queued" || x.status === "running").slice(0, 10)) {
    lines.push(`  #${i.id} ${i.status} p=${i.priority}${i.pinned ? " pinned" : ""} ${clip(i.title, 90)}`);
  }
  const cands = store.candidates(s.id, { order: "desc", limit: 10 });
  lines.push(`Candidates: ${store.candidateCount(s.id)} total`);
  for (const c of cands) {
    const reasons = safeJson<string[]>(c.reasons_json) ?? [];
    lines.push(`  c/${c.n} idea #${c.idea_id ?? "?"} ${c.stage}${c.verdict ? ` ${c.verdict}` : ""} ${ciText(c)}${reasons[0] ? ` · ${clip(reasons[0], 100)}` : ""}`);
  }
  const workers = store.threads(s.id, { role: "worker", states: ["spawning", "active", "finishing"] });
  lines.push(`Workers: ${workers.length} live`);
  for (const w of workers) lines.push(`  ${w.thread_id ?? "(spawning)"} idea #${w.idea_id} ${w.state} · ${w.submissions} submission(s)`);
  const notices = store.notices(s.id, { limit: 5 });
  if (notices.length) {
    lines.push("Notices:");
    for (const n of notices) lines.push(`  ${new Date(n.at).toISOString().slice(5, 16)} [${n.kind}]${n.delivered_round === null ? " (new)" : ""} ${clip(n.text.replace(/\s+/gu, " "), 200)}`);
  }
  const findings = store.findings(s.id, { limit: 5 });
  if (findings.length) {
    lines.push("Recent findings:");
    for (const f of findings) lines.push(`  #${f.id} idea #${f.idea_id ?? "?"} [${f.outcome}] ${clip(f.learned, 120)}`);
  }
  if (eventCount > 0) {
    lines.push("Recent events:");
    for (const e of store.events(s.id, { limit: eventCount })) {
      lines.push(`  ${new Date(e.at).toISOString().slice(5, 19)} ${e.kind} (${clip(e.actor, 24)}) ${clip(e.data_json, 160)}`);
    }
  }
  return lines.join("\n");
}
