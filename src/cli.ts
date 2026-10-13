// `bb study` — the human's controls. Output is bounded; human controls are
// refused when invoked from a study's own worker or strategist thread.
//
// Every command takes `--json` and then prints exactly one JSON document built
// from the same view models the study page uses (src/views.ts). Text output
// uses the same numbers and wording as the page (src/present.ts: an
// improvement is positive when it is better, in the metric's own terms).
import { remoteGates } from "./single-machine.ts";
import { remoteLines, remoteView } from "./remote/view.ts";
import { mib, type ArtifactUsage } from "./remote/fleet.ts";
import { PluginCliError, cliCommand, defineCli, type PluginCliContext, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import { EngineError, type Caller, type Engine } from "./engine.ts";
import { errText, evalTimes } from "./pipeline.ts";
import { clip, formatDuration, safeJson } from "./prompts.ts";
import { ciText, magnitudePct, reasonText, sharePct, signedPct, verdictCause } from "./present.ts";
import {
  adhocRunView,
  benchHostsView,
  benchView,
  harvestView,
  ideasView,
  needsYou,
  oracleView,
  overview,
  segmentView,
  singleMachineView,
  studySummary,
  usageView,
  utilization,
  type NeedsYouItem,
} from "./views.ts";
import type { StudyRow } from "./db/store.ts";
import { studyReport } from "./report.ts";
import { studyEvidence } from "./evidence.ts";

/** Text output bound (characters). */
const MAX = 60_000;
/** JSON output bound (characters): long arrays and strings are trimmed to fit, never the document itself. */
const JSON_MAX = 200_000;

type CliOut = { exitCode: number; stdout: string };

function out(text: string): CliOut {
  return { exitCode: 0, stdout: `${clip(text, MAX)}\n` };
}

function trimJson(v: unknown, arr: number, str: number): unknown {
  if (typeof v === "string") return v.length > str ? clip(v, str) : v;
  if (Array.isArray(v)) return v.slice(0, arr).map((x) => trimJson(x, arr, str));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimJson(x, arr, str)]));
  return v;
}

const TRIM_STEPS: Array<[number, number]> = [
  [200, 50_000],
  [100, 20_000],
  [50, 8_000],
  [20, 4_000],
  [10, 2_000],
  [5, 1_000],
  [1, 400],
  [0, 200],
];

/** One JSON document on stdout, bounded by trimming long arrays and strings (marked `truncated: true`). */
export function jsonOut(value: Record<string, unknown>): CliOut {
  const full = JSON.stringify(value);
  if (full.length <= JSON_MAX) return { exitCode: 0, stdout: `${full}\n` };
  for (const [a, s] of TRIM_STEPS) {
    const text = JSON.stringify({ ...(trimJson(value, a, s) as Record<string, unknown>), truncated: true });
    if (text.length <= JSON_MAX) return { exitCode: 0, stdout: `${text}\n` };
  }
  return { exitCode: 0, stdout: `${JSON.stringify({ truncated: true, message: "output too large for JSON; use the text output" })}\n` };
}

function respond(json: boolean | undefined, text: () => string, data: () => Record<string, unknown>): CliOut {
  return json ? jsonOut(data()) : out(text());
}

/**
 * Measurement and gate requests: any thread but a study's own worker (a
 * worker measuring its own candidates would spend the bench budget outside
 * the pipeline). The study thread and ordinary threads may: harvesting is
 * their job.
 */
function guardAgent(engine: Engine, ctx: PluginCliContext): string {
  if (ctx.threadId) {
    const row = engine.ctx.store.threadById(ctx.threadId);
    if (row?.role === "worker") throw new PluginCliError("study workers can't request measurements or gates; the plugin measures your submissions", { code: "forbidden", hint: "Submit with study_submit_candidate." });
    return ctx.threadId;
  }
  return "human";
}

/** A measurement or gate run: its line, or the whole result in JSON. */
function runOut(engine: Engine, slug: string, id: number, json: boolean | undefined): CliOut {
  const row = engine.ctx.store.adhocRun(id)!;
  const v = adhocRunView(row);
  return respond(
    json,
    () => {
      const lines = [v.line];
      const r = v.result;
      if (r?.kind === "measure") {
        lines.push(...kv([
          ["A", `${r.a.ref} ${r.a.sha.slice(0, 10)}`],
          ["B", `${r.b.ref} ${r.b.sha.slice(0, 10)}`],
          ["Host", r.host.name],
          ["Reasons", r.reasons.map((x) => reasonText(x)).join("; ")],
          ...Object.entries(r.guardrails).map(([name, g]): [string, string] => [`Guardrail ${name}`, `${g.state}: ${clip(g.text, 200)}`]),
          ["Bench time", formatDuration(row.bench_seconds)],
        ]));
      } else if (r?.kind === "gate") {
        for (const c of r.commands) lines.push(`  ${c.ok ? (c.flaky ? "flaky" : "pass") : "FAIL"} \`${clip(c.command, 120)}\` (${formatDuration(c.seconds)})${c.ok ? "" : `\n${c.tail.split("\n").slice(-15).map((l) => `    ${l}`).join("\n")}`}`);
      }
      if (row.state === "queued" || row.state === "running") lines.push(`Still ${row.state}. \`bb study results ${slug} r${row.seq} --wait\` waits for it.`);
      return lines.join("\n");
    },
    () => ({ run: v }),
  );
}

function evidenceText(doc: Awaited<ReturnType<typeof studyEvidence>>): string {
  const frozen = doc.git.frozen;
  const lines = [
    `Evidence of ${doc.study.slug} (${doc.study.state}) · format ${doc.format} v${doc.version} · use --json for the full document`,
    ...kv([
      ["Base → best", `${doc.git.base?.slice(0, 10) ?? "?"} → ${doc.git.best?.slice(0, 10) ?? "?"} (${doc.git.bestBranch})`],
      ["Frozen", frozen ? `h${frozen.harvest} ${frozen.best?.slice(0, 10)} (${frozen.ref})` : "no harvest frozen"],
      ["Metric", `${doc.study.metric.name}, ${doc.study.metric.direction} is better · ${doc.study.noise} oracle`],
      ["Candidates", `${doc.candidates.length} · findings ${doc.findings.length} · runs ${doc.runs.length}`],
    ]),
    "",
    `Promotions on best (${doc.promotions.length}, oldest first)`,
    ...(doc.promotions.length ? doc.promotions.map((p) => `  ${p.sha.slice(0, 10)} ${p.n !== null ? `c/${p.n} ` : ""}${clip(p.title, 90)} (${p.paths.length} file(s))`) : ["  none"]),
  ];
  if (doc.promotionsError) lines.push(`  (could not read best's log: ${clip(doc.promotionsError, 200)})`);
  return lines.join("\n");
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

/** What to run next after a refused command: the command the message names, else what the study waits for, else `show`. */
export function errorHint(engine: Engine, message: string, slug?: string): { code: string; hint: string } {
  if (/^no study named/u.test(message)) return { code: "not_found", hint: "Run `bb study list` to see the study slugs." };
  const named = /`(bb study [^`]+)`/u.exec(message)?.[1];
  if (named) return { code: "study_error", hint: `Run \`${named}\`.` };
  const s = slug ? engine.ctx.store.study(slug) : undefined;
  if (!s) return { code: "study_error", hint: "Run `bb study list`, then `bb study show <slug>`." };
  const next = s.state === "archived" ? null : needsYou(engine, s).find((n) => n.command);
  if (next) return { code: "study_error", hint: `${next.title}: run \`${next.command}\` (or see \`bb study show ${s.slug}\`).` };
  if (s.state === "paused") return { code: "study_error", hint: `The study is paused: \`bb study resume ${s.slug}\` resumes it; \`bb study show ${s.slug}\` has details.` };
  return { code: "study_error", hint: `The study is ${s.state}; see \`bb study show ${s.slug}\`.` };
}

async function wrap(engine: Engine, slug: string | undefined, fn: () => Promise<CliOut> | CliOut): Promise<CliOut> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngineError) {
      const { code, hint } = errorHint(engine, e.message, slug);
      throw new PluginCliError(e.message, { code, hint });
    }
    if (e instanceof PluginCliError) throw e;
    throw new PluginCliError(errText(e), { code: "internal" });
  }
}

// ------------------------------------------------------------ formatting

/** `Key: value` lines with aligned values; rows without a value are skipped. */
function kv(rows: Array<[string, string | null | undefined | false]>, indent = "  "): string[] {
  const list = rows.filter((r): r is [string, string] => typeof r[1] === "string" && r[1] !== "");
  const w = Math.max(0, ...list.map(([k]) => k.length + 1));
  return list.map(([k, v]) => `${indent}${`${k}:`.padEnd(w)} ${v}`);
}

/** Aligned columns with a header row; the last column isn't padded. */
function table(headers: string[], rows: string[][], indent = "  "): string[] {
  if (!rows.length) return [`${indent}none`];
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => `${indent}${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join("  ")}`.trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** A titled section: a blank line, the title, then its lines. */
function section(title: string, body: string[]): string[] {
  return ["", title, ...body];
}

const time = (ms: number) => new Date(ms).toISOString().slice(5, 19).replace("T", " ");

function needLine(n: NeedsYouItem, slug?: string): string {
  const how = n.command ? `\`${n.command}\`` : n.action?.kind === "open_thread" ? "ask the study thread to revise the spec" : "open the study page";
  return `${slug ? `${slug}: ` : ""}${n.tone === "alert" ? "[alert] " : ""}${n.title} → ${how}`;
}

function needsLines(needs: NeedsYouItem[], withDetail: boolean): string[] {
  const lines: string[] = [];
  for (const n of needs) {
    lines.push(`  - ${needLine(n)}`);
    if (withDetail && n.detail) lines.push(`      ${clip(n.detail.replace(/\s+/gu, " "), 300)}`);
  }
  return lines;
}

function needsShort(engine: Engine, s: StudyRow): string {
  if (s.state === "archived") return "—";
  const needs = needsYou(engine, s);
  if (!needs.length) return "—";
  return `${needs.length}: ${needs[0]!.short}${needs.length > 1 ? ", …" : ""}`;
}

/** Best vs base the way the page says it: words, raw values, CI. */
function bestLine(o: ReturnType<typeof overview>): string {
  if (o.best.value === null) return o.headline;
  return [o.best.text, o.best.raw, o.best.ciText].filter(Boolean).join(" · ");
}

/** One candidate: `c/6 win +4.2% (CI +3.7% to +5.2%)`. */
function candidateLine(c: { n: number; stage: string; verdict: string | null; effect: number | null; ci_lo: number | null; ci_hi: number | null; idea_id: number | null; reasons_json: string | null }): string {
  const what = c.stage === "decided" ? (c.verdict ?? "decided") : c.stage;
  const ci = c.ci_lo !== null && c.ci_hi !== null && c.ci_lo !== c.ci_hi ? ` (${ciText(c.ci_lo, c.ci_hi)})` : "";
  const eff = c.effect !== null ? ` ${signedPct(c.effect)}${ci}` : "";
  // A win's reason restates its effect; other verdicts say why (a guardrail loss names the guardrail, not the primary win).
  const reasons = safeJson<string[]>(c.reasons_json) ?? [];
  const reason = c.verdict === "win" ? undefined : (verdictCause(c.verdict, reasons) ?? reasons[0]);
  return `c/${c.n} ${what}${eff} · idea #${c.idea_id ?? "?"}${reason ? ` · ${clip(reasonText(reason), 100)}` : ""}`;
}

function studyState(engine: Engine, slug: string) {
  const s = engine.ctx.store.study(slug);
  return s ? studySummary(engine, s) : null;
}

/** Controls: the engine's message, plus the study's state in JSON. */
function control(engine: Engine, slug: string, json: boolean | undefined, message: string, extra: () => Record<string, unknown> = () => ({})): CliOut {
  return respond(json, () => message, () => ({ ok: true, message, study: studyState(engine, slug), ...extra() }));
}

const jsonOpt = { json: { type: "boolean", description: "Print machine-readable JSON" } } as const;
const slugArg = [{ name: "slug", description: "Study slug (see `bb study list`)", required: true }] as const;

export function studyCli(engine: Engine): PluginCliRegistration {
  const { store } = engine.ctx;
  return defineCli({
    name: "study",
    summary: "Autoresearch studies: measured, agent-driven code optimization",
    commands: {
      list: cliCommand({
        summary: "List studies (active first): state, what needs you, best vs base, candidates, bench time",
        options: { ...jsonOpt },
        run: (input) => wrap(engine, undefined, () => listStudies(engine, input.options.json)),
      }),
      needs: cliCommand({
        summary: "What needs you (approvals, system pauses, failures, a frozen harvest), with the command for each",
        positionals: [{ name: "slug", description: "Only this study (default: every active study)" }] as const,
        options: { ...jsonOpt },
        run: (input) =>
          wrap(engine, input.positionals.slug, () => {
            const rows = input.positionals.slug ? [engine.study(input.positionals.slug)] : store.studies().filter((s) => s.state !== "archived");
            const studies = rows.map((s) => ({ slug: s.slug, needs: s.state === "archived" ? [] : needsYou(engine, s) })).filter((x) => x.needs.length || input.positionals.slug);
            const total = studies.reduce((a, x) => a + x.needs.length, 0);
            return respond(
              input.options.json,
              () => (total ? studies.flatMap((x) => x.needs.map((n) => needLine(n, x.slug))).join("\n") : "Nothing needs you."),
              () => ({ total, studies }),
            );
          }),
      }),
      show: cliCommand({
        summary: "Show a study: what needs you, best vs base, spec, bench, calibration, ideas, candidates, workers, recent events",
        positionals: slugArg,
        options: { ...jsonOpt, events: { type: "integer", min: 0, max: 200, default: 12, description: "Recent events to show (max 200)" } },
        run: (input) =>
          wrap(engine, input.positionals.slug, () =>
            respond(
              input.options.json,
              () => showStudy(engine, input.positionals.slug, input.options.events ?? 12),
              () => overview(engine, engine.study(input.positionals.slug)),
            ),
          ),
      }),
      calibrate: cliCommand({
        summary: "Approve the current spec and run calibration (gates on base, A/A noise measurement)",
        positionals: slugArg,
        options: { ...jsonOpt, wait: { type: "boolean", description: "Wait for calibration to finish (up to --timeout)" }, timeout: { type: "duration", defaultUnit: "m", min: 1_000, max: 30 * 60_000, default: 25 * 60_000, description: "Max wait with --wait (default 25m, max 30m)" } },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const slug = input.positionals.slug;
            const actor = guardHuman(engine, ctx);
            const text = await engine.calibrate(slug, actor);
            await engine.auditControl(slug, "calibrate", caller(ctx), `spec approved and calibration started`, { spec_version: engine.study(slug).spec_version });
            if (input.options.wait) await engine.waitForCalibration(slug, input.options.timeout ?? 25 * 60_000);
            const message = input.options.wait ? `${text}\n\n${calibrationText(engine, slug)}` : text;
            return control(engine, slug, input.options.json, message, () => ({ calibration: oracleView(engine, engine.study(slug)).calibration }));
          }),
      }),
      start: cliCommand({
        summary: "Approve calibration and start running (or resume)",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const text = await engine.start(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "start", caller(ctx), "calibration approved / study started");
            return control(engine, input.positionals.slug, input.options.json, text);
          }),
      }),
      approve: cliCommand({
        summary: "Apply a pending spec whose oracle is unchanged (budget, agents); oracle changes need `calibrate`",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const text = engine.approve(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "approve", caller(ctx), "pending spec applied without recalibration");
            return control(engine, input.positionals.slug, input.options.json, text);
          }),
      }),
      drift: cliCommand({
        summary: "Run a drift check (A/A on best) on every bench host at its next free slot",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const text = engine.requestDrift(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "drift", caller(ctx), "drift check requested");
            return control(engine, input.positionals.slug, input.options.json, text);
          }),
      }),
      bench: cliCommand({
        summary: "Bench hosts: health, queue, transfers, drift checks, segments",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input) =>
          wrap(engine, input.positionals.slug, async () => {
            const s0 = engine.study(input.positionals.slug);
            // Seeds and base bundles on the edit host: only asked for when the study has remote bench hosts.
            const artifacts = engine.ctx.store.artifacts(s0.id).length || hasRemoteBench(engine, s0) ? await engine.fleet.artifactUsage(s0) : null;
            return respond(
              input.options.json,
              () => benchText(engine, input.positionals.slug, artifacts),
              () => {
                const s = engine.study(input.positionals.slug);
                return { slug: s.slug, state: s.state, segment: segmentView(engine, s), ...benchView(engine, s), segments: oracleView(engine, s).segments, artifacts };
              },
            );
          }),
      }),
      pause: cliCommand({
        summary: "Pause: no new workers; running workers finish their current submission",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const text = engine.pause(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "pause", caller(ctx), "study paused");
            return control(engine, input.positionals.slug, input.options.json, text);
          }),
      }),
      resume: cliCommand({
        summary: "Resume a paused study",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const before = engine.study(input.positionals.slug).pause_reason;
            const text = engine.resume(input.positionals.slug, guardHuman(engine, ctx));
            await engine.auditControl(input.positionals.slug, "resume", caller(ctx), `study resumed${before ? ` (was paused: ${clip(before, 200)})` : ""}`);
            return control(engine, input.positionals.slug, input.options.json, text);
          }),
      }),
      concurrency: cliCommand({
        summary: "Set a study's max concurrent workers (overrides budget.max_workers; `auto` returns to the spec)",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "workers", description: "1-64, or auto", required: true },
        ] as const,
        options: { ...jsonOpt },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const actor = guardHuman(engine, ctx);
            const v = input.positionals.workers.trim();
            const n = v === "auto" ? null : Number(v);
            if (n !== null && !Number.isInteger(n)) throw new PluginCliError("workers must be an integer from 1 to 64, or auto", { code: "invalid_value", hint: `For example \`bb study concurrency ${input.positionals.slug} 4\` or \`bb study concurrency ${input.positionals.slug} auto\`.` });
            const text = engine.setConcurrency(input.positionals.slug, n, actor);
            await engine.auditControl(input.positionals.slug, "concurrency", caller(ctx), `max workers ${n === null ? "back to the spec" : `set to ${engine.maxWorkers(engine.study(input.positionals.slug))}${n !== engine.maxWorkers(engine.study(input.positionals.slug)) ? ` (requested ${n}, clamped)` : ""}`}`, { requested: n });
            return control(engine, input.positionals.slug, input.options.json, text);
          }),
      }),
      archive: cliCommand({
        summary: "Stop a study for good: stop workers, archive their threads, remove bench checkouts (refs are kept); --archive-thread also archives the study thread",
        positionals: slugArg,
        options: { ...jsonOpt, "archive-thread": { type: "boolean", description: "Also archive the study thread (the conversation that created the study)" } },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const actor = guardHuman(engine, ctx);
            const archiveThread = Boolean(input.options["archive-thread"]);
            await engine.auditControl(input.positionals.slug, "archive", caller(ctx), `study archived${archiveThread ? " with its study thread" : ""}`, { archiveThread });
            return control(engine, input.positionals.slug, input.options.json, await engine.archiveStudy(input.positionals.slug, actor, { archiveThread }));
          }),
      }),
      workers: cliCommand({
        summary: "List a study's worker threads (newest 50)",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input) =>
          wrap(engine, input.positionals.slug, () => {
            const s = engine.study(input.positionals.slug);
            const rows = store.threads(s.id, { role: "worker" }).slice(-50);
            const workers = rows.map((w) => ({ threadId: w.thread_id, ideaId: w.idea_id, state: w.state, submissions: w.submissions, endReason: w.end_reason, spawnedAt: w.spawned_at, endedAt: w.ended_at }));
            return respond(
              input.options.json,
              () =>
                rows.length
                  ? [`Workers of ${s.slug} (${rows.length})`, ...table(["THREAD", "IDEA", "STATE", "SUBMISSIONS", "ENDED"], workers.map((w) => [w.threadId ?? "(spawning)", `#${w.ideaId ?? "?"}`, w.state, String(w.submissions), w.endReason ? clip(w.endReason, 80) : ""]))].join("\n")
                  : "No workers yet.",
              () => ({ workers }),
            );
          }),
      }),
      "ideas add": cliCommand({
        summary: "Add (and pin) an idea to a study's queue",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "title", description: "Idea title (quote it)", required: true },
        ] as const,
        options: {
          ...jsonOpt,
          rationale: { type: "string", description: "Why it might help (max 2000 chars)" },
          theme: { type: "string", description: "Theme used for diversity (max 60 chars)" },
          priority: { type: "integer", min: -100, max: 100, default: 0, description: "Higher runs first (-100..100)" },
          "start-ref": { type: "string", description: 'Start from a candidate, e.g. "c/12"' },
          "variation-of": { type: "integer", min: 1, max: 1_000_000_000, description: "Id of the idea this varies" },
          "no-pin": { type: "boolean", description: "Don't pin (human ideas are pinned by default)" },
        },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
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
            const message = `Idea #${idea.id} queued${idea.pinned ? " (pinned)" : ""}: ${idea.title}`;
            return respond(input.options.json, () => message, () => ({ ok: true, message, idea: ideasView(engine, engine.study(input.positionals.slug)).find((i) => i.id === idea.id) ?? null }));
          }),
      }),
      "ideas list": cliCommand({
        summary: "List a study's ideas",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input) =>
          wrap(engine, input.positionals.slug, () => {
            const s = engine.study(input.positionals.slug);
            const ideas = ideasView(engine, s);
            return respond(
              input.options.json,
              () =>
                ideas.length
                  ? [
                      `Ideas of ${s.slug} (${ideas.length})`,
                      ...table(
                        ["ID", "STATUS", "PRIORITY", "SOURCE", "BEST", "TITLE"],
                        ideas.slice(0, 100).map((i) => [`#${i.id}`, i.status, `${i.priority}${i.pinned ? " pinned" : ""}`, i.source, i.bestEffect === null ? "—" : signedPct(i.bestEffect), `${clip(i.title, 100)}${i.theme ? ` (${i.theme})` : ""}`]),
                      ),
                    ].join("\n")
                  : "No ideas.",
              () => ({ ideas }),
            );
          }),
      }),
      harvest: cliCommand({
        summary: "Freeze best for harvest (no new workers, submissions closed), or show the current harvest; an agent then harvests it with the study-harvest skill",
        positionals: slugArg,
        options: {
          ...jsonOpt,
          publish: { type: "boolean", description: "Removed in 1.0: an agent publishes with the repository's own tools (study-harvest skill)" },
          harvest: { type: "integer", min: 1, max: 1_000_000, description: "Show harvest h<N> instead of the latest (read only)" },
          wait: { type: "boolean", description: "Wait for best to freeze (in-flight candidates finish first; up to --timeout)" },
          timeout: { type: "duration", defaultUnit: "m", min: 1_000, max: 30 * 60_000, default: 25 * 60_000, description: "Max wait with --wait (default 25m, max 30m)" },
        },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const slug = input.positionals.slug;
            if (input.options.publish) {
              throw new PluginCliError("the plugin no longer drafts or publishes PRs (1.0): an agent does, with the repository's own tools", {
                code: "removed",
                hint: `Ask an agent to harvest ${slug} with the study-harvest skill and to publish when you say so. It starts from \`bb study evidence ${slug} --json\`.`,
              });
            }
            const s0 = engine.study(slug);
            const seq = input.options.harvest;
            if (seq !== undefined) {
              const h = store.harvests(s0.id).find((x) => x.seq === seq);
              if (!h) throw new PluginCliError(`${slug} has no harvest h${seq}`, { code: "not_found", hint: `\`bb study harvest ${slug}\` shows the latest.` });
              return respond(input.options.json, () => harvestText(engine, slug, h.id), () => harvestView(engine, s0, h.id));
            }
            const view = () => harvestView(engine, engine.study(slug));
            const before = store.latestHarvest(s0.id);
            // An archived study can't harvest again, but its last harvest stays readable.
            if (s0.state === "archived") return respond(input.options.json, () => harvestText(engine, slug), () => view());
            // Showing a harvest that is waiting or frozen is a read; starting one is a human control.
            const showing = s0.state === "harvesting" && before && ["waiting", "frozen"].includes(before.state);
            const actor = showing ? (ctx.threadId ?? "human") : guardHuman(engine, ctx);
            const r = engine.startHarvest(slug, actor);
            if (r.started) await engine.auditControl(slug, "harvest", caller(ctx), `harvest h${r.harvest.seq} started: best freezes for an agent to harvest`, { harvest: r.harvest.id });
            if (input.options.wait) await engine.waitForHarvest(slug, input.options.timeout ?? 25 * 60_000);
            const started = r.started && r.harvest.id !== before?.id;
            return respond(
              input.options.json,
              () => (started && !input.options.wait ? r.text : `${started ? `${r.text}\n\n` : ""}${harvestText(engine, slug)}`),
              () => ({ ...(started ? { message: r.text } : {}), ...view() }),
            );
          }),
      }),
      measure: cliCommand({
        summary: "Measure B against A (any two commits) with the study's protocol, guardrails and bench hosts; counts as bench time",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "a", description: "Reference side A: a sha, branch, tag, best, base, c/<n>, or rev syntax (best~1)", required: true },
          { name: "b", description: "Side B, measured against A (better is positive)", required: true },
        ] as const,
        options: {
          ...jsonOpt,
          pairs: { type: "integer", min: 2, max: 200, description: "Pairs to measure (noisy oracles; default: the study's n_max)" },
          host: { type: "string", description: "Bench host name or id (default: the quietest free host when the run starts, each judged with its own win threshold; a remote-only study frozen for harvest waits for its machines)" },
          detach: { type: "boolean", description: "Return at once with the run id; read it later with `bb study results <slug> <id>`" },
          timeout: { type: "duration", defaultUnit: "m", min: 1_000, max: 30 * 60_000, default: 25 * 60_000, description: "Max wait (default 25m, max 30m); the run continues after it" },
        },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const { slug, a, b } = input.positionals;
            const actor = guardAgent(engine, ctx);
            const row = await engine.requestMeasure(slug, { refA: a, refB: b, pairs: input.options.pairs ?? null, host: input.options.host ?? null }, actor);
            if (!input.options.detach) await engine.primitives.wait(row.id, input.options.timeout ?? 25 * 60_000);
            return runOut(engine, slug, row.id, input.options.json);
          }),
      }),
      gate: cliCommand({
        summary: "Run the study's gates on any commit (edit host; single-machine mode takes the bench lock)",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "ref", description: "A sha, branch, tag, best, base, c/<n>, or rev syntax", required: true },
        ] as const,
        options: {
          ...jsonOpt,
          detach: { type: "boolean", description: "Return at once with the run id; read it later with `bb study results <slug> <id>`" },
          timeout: { type: "duration", defaultUnit: "m", min: 1_000, max: 30 * 60_000, default: 25 * 60_000, description: "Max wait (default 25m, max 30m); the run continues after it" },
        },
        run: (input, ctx) =>
          wrap(engine, input.positionals.slug, async () => {
            const { slug, ref } = input.positionals;
            const actor = guardAgent(engine, ctx);
            const row = await engine.requestGate(slug, { ref }, actor);
            if (!input.options.detach) await engine.primitives.wait(row.id, input.options.timeout ?? 25 * 60_000);
            return runOut(engine, slug, row.id, input.options.json);
          }),
      }),
      results: cliCommand({
        summary: "Measurements and gates asked for with `bb study measure|gate` (newest first), or one of them in full",
        positionals: [
          { name: "slug", description: "Study slug", required: true },
          { name: "id", description: "A run id (r3 or 3); omit for the list" },
        ] as const,
        options: {
          ...jsonOpt,
          wait: { type: "boolean", description: "With an id: wait for it to finish (up to --timeout)" },
          timeout: { type: "duration", defaultUnit: "m", min: 1_000, max: 30 * 60_000, default: 25 * 60_000, description: "Max wait with --wait (default 25m, max 30m)" },
        },
        run: (input) =>
          wrap(engine, input.positionals.slug, async () => {
            const slug = input.positionals.slug;
            const s = engine.study(slug);
            if (input.positionals.id !== undefined) {
              const seq = Number(String(input.positionals.id).replace(/^r/u, ""));
              if (!Number.isInteger(seq) || seq < 1) throw new PluginCliError(`${JSON.stringify(input.positionals.id)} is not a run id`, { code: "invalid_value", hint: `Run ids look like r3; \`bb study results ${slug}\` lists them.` });
              const row = engine.adhocRun(slug, seq);
              if (input.options.wait) await engine.primitives.wait(row.id, input.options.timeout ?? 25 * 60_000);
              return runOut(engine, slug, row.id, input.options.json);
            }
            const runs = store.adhocRuns(s.id, { limit: 50 }).map(adhocRunView);
            return respond(
              input.options.json,
              () => (runs.length ? [`Measurements and gates of ${slug} (newest first)`, ...runs.map((r) => `  ${r.line}`)].join("\n") : `No measurements or gates asked for yet. \`bb study measure ${slug} <A> <B>\` and \`bb study gate ${slug} <ref>\` run them.`),
              () => ({ runs }),
            );
          }),
      }),
      evidence: cliCommand({
        summary: "Everything an agent needs to harvest: candidates, commit messages, diffs, verdicts, guardrails, findings, segments, base/best, runs (stable JSON with --json)",
        positionals: slugArg,
        options: {
          ...jsonOpt,
          samples: { type: "boolean", description: "Include each candidate's raw samples (large)" },
          candidates: { type: "string", description: "Only these candidates, e.g. 3,7,12 (default: all)" },
        },
        run: (input) =>
          wrap(engine, input.positionals.slug, async () => {
            const slug = input.positionals.slug;
            const s = engine.study(slug);
            const only = input.options.candidates ? input.options.candidates.split(/[,\s]+/u).filter(Boolean).map((x) => Number(x.replace(/^c\//u, ""))) : null;
            if (only?.some((n) => !Number.isInteger(n) || n < 1)) throw new PluginCliError("--candidates takes candidate numbers, e.g. 3,7,12", { code: "invalid_value" });
            const doc = await studyEvidence(engine.ctx, s, store.spec(s), { samples: Boolean(input.options.samples), candidates: only });
            if (!input.options.json) return out(evidenceText(doc));
            const text = JSON.stringify(doc);
            if (text.length <= JSON_MAX) return { exitCode: 0, stdout: `${text}\n` };
            // Too large for one CLI response: the whole document goes to a file on this machine, never trimmed.
            const dir = await engine.ctx.bb.hostRunner(s.host_id!).writeExport(`${slug}-evidence`, [{ path: "evidence.json", content: text }]);
            return { exitCode: 0, stdout: `${JSON.stringify({ format: doc.format, version: doc.version, file: `${dir.replace(/\/$/u, "")}/evidence.json`, bytes: text.length })}\n` };
          }),
      }),
      report: cliCommand({
        summary: "Print the study report (Markdown): trajectory, wins, notable losses, dossier, calibration, harvest",
        positionals: slugArg,
        options: { ...jsonOpt },
        run: (input) =>
          wrap(engine, input.positionals.slug, () => {
            const s = engine.study(input.positionals.slug);
            const markdown = studyReport(engine.ctx, s, store.spec(s), store.latestHarvest(s.id) ?? null);
            return respond(input.options.json, () => markdown, () => ({ markdown }));
          }),
      }),
    },
  });
}

function listStudies(engine: Engine, json: boolean | undefined): CliOut {
  const all = engine.ctx.store.studies();
  const rows = [...all.filter((s) => s.state !== "archived"), ...all.filter((s) => s.state === "archived")].slice(0, 200);
  return respond(
    json,
    () => {
      if (!rows.length) return "No studies. Start one by asking an agent to use the study-create skill.";
      const sums = rows.map((s) => ({ s, sum: studySummary(engine, s) }));
      const lines = table(
        ["SLUG", "STATE", "NEEDS YOU", "BEST VS BASE", "CANDIDATES", "BENCH"],
        sums.map(({ s, sum }) => [
          s.slug,
          s.state,
          needsShort(engine, s),
          sum.headline,
          `${sum.candidates}/${sum.maxCandidates}`,
          `${formatDuration(sum.benchSeconds)} of ${sum.maxBenchHours} h`,
        ]),
        "",
      );
      const waiting = sums.filter((x) => x.sum.needsYou > 0).length;
      if (waiting) lines.push("", `${waiting} ${waiting === 1 ? "study needs" : "studies need"} you: \`bb study needs\` lists what and how.`);
      return lines.join("\n");
    },
    () => ({ studies: rows.map((s) => studySummary(engine, s)) }),
  );
}

function schedulerLine(engine: Engine, s: StudyRow): string {
  const t = engine.ctx.store.study(s.id)!;
  const times = evalTimes(engine.ctx.store, t);
  const tEval = times.tEval;
  const tThink = engine.thinkSeconds(t);
  const parts = times.serialized ? ` (tests ${times.gate === null ? "?" : formatDuration(times.gate)} + measurement ${times.measure === null ? "?" : formatDuration(times.measure)}, single-machine mode)` : "";
  return `W ${t.target_workers ?? "?"} of max ${engine.maxWorkers(t)}${t.max_workers_override !== null ? " (human override)" : ""} · bench queue ${engine.benchDepth(t.id)} · think ≈ ${tThink === null ? "?" : formatDuration(tThink)} · eval ≈ ${tEval === null ? "?" : formatDuration(tEval)}${parts}`;
}

function utilizationLine(engine: Engine, s: StudyRow): string {
  const u = utilization(engine, s);
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  return `busy ${formatDuration(u.busySeconds)} of ${formatDuration(u.runningSeconds)} running (${pct(u.ratio)}; ${pct(u.steadyRatio)} since the first submission)${u.gateSeconds > 0 ? ` · ${formatDuration(u.gateSeconds)} of it gates (${remoteGates(engine.ctx.store.spec(s)) ? "on remote machines" : "single-machine mode"})` : ""} · overlapping bench intervals ${u.overlaps}`;
}

function usageLine(engine: Engine, s: StudyRow): string {
  const u = usageView(engine, s);
  const parts = [
    u.tokens !== null ? `tokens ${u.tokens.toLocaleString("en-US")}${u.maxTokens ? ` of ${u.maxTokens.toLocaleString("en-US")}` : ""}${u.tokensPerWin !== null ? ` (${u.tokensPerWin.toLocaleString("en-US")} per win)` : ""}` : "tokens not reported by the provider",
    u.rateLimited ? `RATE LIMITED until ${new Date(u.rateLimitedUntil!).toISOString().slice(11, 16)} UTC (no new workers)` : null,
    u.maxPercent !== null ? `usage window max ${u.maxPercent.toFixed(0)}%${u.tight ? " (tight: W halved)" : ""}` : null,
    u.projectedBenchSeconds !== null ? `projected bench for the remaining budget ≈ ${formatDuration(u.projectedBenchSeconds)}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function segmentLine(engine: Engine, s: StudyRow): string {
  const seg = segmentView(engine, s);
  const pending = s.pending_spec_version !== null ? ` · spec v${s.pending_spec_version} pending approval (${seg.pendingChangesOracle ? `oracle change: \`bb study calibrate ${s.slug}\`` : `no oracle change: \`bb study approve ${s.slug}\``})` : "";
  return `${seg.k}${seg.oracleHash ? ` (oracle ${seg.oracleHash}, spec v${seg.specVersion ?? "?"}, baseline ${seg.baselineSha?.slice(0, 10) ?? "?"})` : ""} · ${seg.count} segment(s)${pending}`;
}

function benchLines(engine: Engine, s: StudyRow): string[] {
  const hosts = benchHostsView(engine, s);
  const remote = remoteLines(remoteView(engine, s, (() => { try { return engine.ctx.store.spec(s); } catch { return null; } })()), engine.ctx.now());
  if (!hosts.length) return remote.length ? remote : ["  none yet (set at calibration)"];
  return [...hosts.map(
    (h) =>
      `  ${h.name} [${h.mode === "clone" ? "own clone via git bundles" : h.mode === "remote" ? `remote machine (${h.remote?.provider ?? "provider"})` : "local checkouts"}] ${h.status}` +
      ` · health ${h.healthOk === null ? "not checked" : h.healthOk ? "ok" : `FAILING (${h.problems.join("; ")})`}${h.deferredUntil ? ` · deferred until ${new Date(h.deferredUntil).toISOString().slice(11, 19)}` : ""}` +
      `${h.excluded ? ` · NOT USED until the next calibration (${h.excluded})` : h.threshold !== null ? ` · win threshold ${magnitudePct(h.threshold)}${h.noiseFloor !== null ? `, noise ${magnitudePct(h.noiseFloor)}` : ""}` : ""}` +
      ` · ${h.measuring !== null ? `measuring c/${h.measuring}` : h.gating !== null ? `testing c/${h.gating} (gates hold the bench)` : "idle"} · drift ${h.driftStatus ?? "not run"} (${h.evalsSinceDrift}/${h.driftEvery} evals)` +
      `${h.sideRuns && h.sideRuns > 1 ? ` · ${h.sideRuns} runs a side` : ""}${h.runSeconds ? ` · one run ≈ ${h.runSeconds < 10 ? h.runSeconds.toFixed(2) : h.runSeconds.toFixed(1)} s at calibration` : ""}` +
      ` · cached best build ${h.bestBuildSha ? h.bestBuildSha.slice(0, 10) : "none"}${h.lastTransfer ? ` · last bundle ${h.lastTransfer}` : ""}${h.healthSummary ? `\n      ${h.healthSummary}` : ""}`,
  ), ...remote];
}

function hasRemoteBench(engine: Engine, s: StudyRow): boolean {
  try {
    return (engine.ctx.store.spec(s).oracle.remote_bench ?? []).length > 0;
  } catch {
    return false;
  }
}

/** The edit host's seeds and base bundles for remote bench hosts, in one line. */
export function artifactLine(a: ArtifactUsage): string {
  const total = a.seeds.bytes + a.bases.bytes;
  const last = a.lastCleanup ? ` · last cleanup (${a.lastCleanup.reason}) deleted ${a.lastCleanup.files} file(s), ${mib(a.lastCleanup.bytes)}` : "";
  return `${a.seeds.files} seed(s) and ${a.bases.files} base bundle(s) on the edit host, ${mib(total)} · this study uses ${a.study.files} (${mib(a.study.bytes)}); the rest is deleted at the next load or archive unless another study uses it${last}`;
}

function benchText(engine: Engine, slug: string, artifacts: ArtifactUsage | null = null): string {
  const { store } = engine.ctx;
  const s = engine.study(slug);
  const v = benchView(engine, s);
  const lines = [
    `Bench of ${s.slug} · ${s.state}`,
    ...kv([
      ["Segment", segmentLine(engine, s)],
      ["Utilization", utilizationLine(engine, s)],
      ["Queue", v.queue.length ? v.queue.map((q) => `c/${q.n} ${q.stage}${q.benchHostName ? ` on ${q.benchHostName}` : ""}`).join(", ") : "empty"],
      ["Gates", `${v.gates.flaky} flaky · ${v.gates.failed} failed`],
      ["Remote artifacts", artifacts ? artifactLine(artifacts) : undefined],
    ]),
    ...section("Hosts", benchLines(engine, s)),
    ...section(
      "Transfers (git bundles, newest first)",
      table(
        ["AT", "HOST", "PURPOSE", "SHA", "RESULT"],
        v.transfers.slice(0, 20).map((t) => [time(t.at), t.hostName ?? t.hostId, t.purpose, t.sha.slice(0, 10), t.ok ? `${t.bytes} B in ${t.chunks} chunk(s), ${Math.round(t.ms)} ms` : `FAILED: ${clip(t.error ?? "", 200)}`]),
      ),
    ),
    ...section(
      "Health checks (newest first)",
      table(
        ["AT", "HOST", "CONTEXT", "RESULT"],
        v.health.slice(0, 10).map((h) => [time(h.at), h.hostName ?? h.hostId, h.context, h.ok ? `ok${h.summary ? ` · ${h.summary}` : ""}` : `FAIL ${clip(h.problems.join("; "), 200)}`]),
      ),
    ),
    ...section(
      "Drift checks (newest first)",
      table(
        ["STARTED", "HOST", "SEGMENT", "STATUS", "NOISE"],
        v.drift.slice(0, 10).map((d) => [time(d.startedAt), d.hostName ?? d.hostId, String(d.segment), d.status, d.ratio !== null ? `${magnitudePct(d.noise)} vs calibrated ${magnitudePct(d.calibrated)} = ${d.ratio.toFixed(2)}× over ${d.pairs} pairs` : ""]),
      ),
    ),
    ...section(
      "Segments",
      table(
        ["K", "ORACLE", "SPEC", "BASELINE", "MDE", "NOISE FLOOR", "STARTED BY"],
        store.segments(s.id).map((g) => [String(g.k), g.oracle_hash, `v${g.spec_version ?? "?"}`, g.baseline_sha.slice(0, 10), magnitudePct(g.mde), magnitudePct(g.noise_floor), safeJson<{ auto?: boolean }>(g.details_json)?.auto ? "automatic recalibration (same oracle)" : "calibration"]),
      ),
    ),
  ];
  return lines.join("\n");
}

function calibrationText(engine: Engine, slug: string): string {
  const s = engine.study(slug);
  const report = safeJson<{ ok: boolean; problems: string[]; warnings?: string[]; baselineSha: string; oracleHash: string; report: string }>(s.calibration_json);
  if (s.calibration_status === "running") return "Calibration: running.";
  if (!report) return `Calibration: ${s.calibration_status ?? "not run"}.`;
  if (!report.ok) return `Calibration FAILED (study back in draft):\n${report.problems.map((p) => `- ${clip(p, 600)}`).join("\n")}\nAsk the study thread to revise the spec, then \`bb study calibrate ${slug}\`.`;
  const next = s.calibration_approved_at === null ? `\nApprove and start with \`bb study start ${slug}\`.` : "";
  const warnings = (report.warnings ?? []).map((w) => `\nWarning: ${clip(w, 600)}`).join("");
  return `Calibration ${s.calibration_approved_at === null ? "ready" : "approved"} (baseline ${report.baselineSha.slice(0, 10)}, oracle ${report.oracleHash}):\n${report.report}${warnings}${next}`;
}

export function showStudy(engine: Engine, slug: string, eventCount: number): string {
  const { store } = engine.ctx;
  const s = engine.study(slug);
  const spec = store.spec(s);
  const o = overview(engine, s);
  const hv = store.latestHarvest(s.id) ? harvestView(engine, s).harvest : null;
  const lines = [
    `Study ${s.slug} · ${s.state}${s.pause_reason ? ` (${s.pause_reason})` : ""} · spec v${s.spec_version}${store.specVersion(s.id, s.spec_version)?.approved_at ? " approved" : " not approved"}`,
    ...kv([
      ["Status", o.status],
      ["Best vs base", bestLine(o)],
      ["Needs you", o.needs.length ? `${o.needs.length} item(s), below` : "nothing"],
      ["Harvest", hv ? `h${hv.seq} ${hv.state}${hv.headline ? ` · measured ${hv.headline.text}` : ""} · \`bb study harvest ${s.slug}\`` : null],
    ]),
  ];
  if (o.needs.length) lines.push(...section("Needs you", needsLines(o.needs, true)));
  lines.push(
    ...section(
      "Spec",
      kv([
        ["Objective", clip(spec.study.objective, 300)],
        ["Metric", `${spec.metric.name}${spec.metric.unit ? ` (${spec.metric.unit})` : ""}, ${spec.metric.direction} is better · ${spec.oracle.noise} oracle`],
        ["Guardrails", spec.guardrail.map((g) => `${g.name} (limit ${magnitudePct(g.max_regression, 1)} worse per step, ${magnitudePct(g.max_total_regression ?? g.max_regression, 1)} in total)`).join(", ") || "none"],
        ["Scope", `editable ${spec.scope.editable.join(", ")} · protected ${spec.scope.protected.join(", ") || "none"}`],
        ["Oracle", `build ${spec.oracle.build ? "`" + clip(spec.oracle.build, 80) + "`" : "none"} · gate ${spec.oracle.gate.map((g) => "`" + clip(g, 60) + "`").join(", ") || "none"} · measure \`${clip(spec.oracle.measure, 80)}\`${spec.oracle.holdout ? " · holdout: configured (hidden from agents)" : ""}`],
        ["Segment", segmentLine(engine, s)],
        ["Single machine", singleMachineView(engine, s)?.text ?? "n/a"],
        ["Commits", (() => {
          const d = safeJson<{ details?: { commitIdentity?: string; commitIdentitySource?: string } }>(s.calibration_json)?.details;
          return `[git] identity = "${spec.git.identity}"${d?.commitIdentity ? ` · at calibration: ${d.commitIdentity} (${d.commitIdentitySource === "repo" ? "the repository's identity" : d.commitIdentitySource === "fallback" ? "fallback: the repository has no identity configured" : "the plugin's"})` : ""}`;
        })()],
        ["Repo", `${s.repo_path} (host ${s.host_id}) · study thread ${s.study_thread_id ?? "none"}`],
        ["Best", `${s.best_sha?.slice(0, 10) ?? "not set"} (branch studies/${s.slug}/best) · base ${s.base_sha?.slice(0, 10) ?? "?"}`],
      ]),
    ),
    ...section(
      "Budget",
      kv([
        ["Budget", `${engine.budgetLine(s, spec)} · strategist rounds ${s.rounds}${s.round_in_flight ? " (one in flight)" : ""}`],
        ["Scheduler", schedulerLine(engine, s)],
        ["Bench", utilizationLine(engine, s)],
        ["Usage", usageLine(engine, s)],
      ]),
    ),
  );
  if (o.secondary.guardrails.length) {
    lines.push(...section("Guardrails (best vs the segment base)", o.secondary.guardrails.map((g) => `  ${g.name}: ${g.label} · ${g.text}${g.raw ? ` · ${g.raw}` : ""}\n    ${g.headroomText}`)));
  }
  lines.push(...section("Bench hosts", benchLines(engine, s)));
  const cal = o.calibration;
  lines.push(
    ...section("Calibration", [
      ...kv([
        ["MDE", cal.thresholds ? `${cal.thresholds}${cal.thresholds.includes(" on ") ? " (each host decides with its own)" : ""}` : cal.mde !== null ? magnitudePct(cal.mde) : null],
        ["Noise floor", cal.noiseFloor !== null ? magnitudePct(cal.noiseFloor) : null],
        ["Eval", cal.evalSeconds !== null ? formatDuration(cal.evalSeconds) : null],
      ]),
      ...calibrationText(engine, slug)
        .split("\n")
        .map((l) => `  ${l}`),
    ]),
  );
  const ideas = store.ideas(s.id);
  const counts = new Map<string, number>();
  for (const i of ideas) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  lines.push(
    ...section(`Ideas: ${[...counts].map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`, ideas.filter((x) => x.status === "queued" || x.status === "running").slice(0, 10).map((i) => `  #${i.id} ${i.status} p=${i.priority}${i.pinned ? " pinned" : ""} ${clip(i.title, 90)}`)),
  );
  lines.push(...section(`Candidates: ${store.candidateCount(s.id)} total (newest first)`, store.candidates(s.id, { order: "desc", limit: 10 }).map((c) => `  ${candidateLine(c)}`)));
  lines.push(...section(`Workers: ${o.workerList.length} live`, o.workerList.map((w) => `  ${w.threadId ?? "(spawning)"} idea #${w.ideaId ?? "?"} ${w.state} · ${w.phase}${w.candidate !== null ? ` c/${w.candidate}` : ""} · ${w.submissions}/${w.maxSubmissions} submission(s)`)));
  const notices = o.notices.slice(0, 5);
  if (notices.length) {
    lines.push(...section("Notices (newest first)", notices.map((n) => `  ${time(n.at)} [${n.kind}]${n.unseen && !n.audit ? " (new)" : ""} ${clip(n.summary.replace(/\s+/gu, " "), 200)}${n.action?.command && !n.summary.includes(n.action.command) ? ` → \`${n.action.command}\`` : ""}`)));
  }
  const findings = store.findings(s.id, { limit: 5 });
  if (findings.length) lines.push(...section("Recent findings", findings.map((f) => `  #${f.id} idea #${f.idea_id ?? "?"} [${f.outcome}] ${clip(f.learned, 120)}`)));
  if (eventCount > 0) {
    lines.push(...section("Recent events", store.events(s.id, { limit: eventCount }).map((e) => `  ${time(e.at)} ${e.kind} (${clip(e.actor, 24)}) ${clip(e.data_json, 160)}`)));
  }
  return lines.join("\n");
}

export function harvestText(engine: Engine, slug: string, harvestId?: number): string {
  const s = engine.study(slug);
  const v = harvestView(engine, s, harvestId);
  const h = v.harvest;
  if (!h) return `${slug}: no harvest yet. ${v.canStart ? `\`${v.startCommand}\` freezes best for an agent to harvest.` : (v.cannotStartReason ?? "")}`;
  const runsLines = v.runs.length ? section("Measurements and gates asked for (newest first)", v.runs.slice(0, 10).map((r) => `  ${r.line}`)) : [];
  if (!h.legacy) {
    const lines = [
      `Harvest h${h.seq} of ${s.slug} · ${h.state}${h.detail ? ` (${h.detail})` : ""} · study ${s.state}`,
      ...kv([
        ["Error", h.error ? clip(h.error, 300) : null],
        ["Base → best", h.bestSha ? `${h.baseSha?.slice(0, 10) ?? "?"} → ${h.bestSha.slice(0, 10)}${h.frozenRef ? ` (pinned as ${h.frozenRef})` : ""}` : "best not frozen yet"],
      ]),
    ];
    if (h.promotions.length) lines.push(...section(`Promotions (${h.promotions.length}, oldest first)`, h.promotions.map((p) => `  ${p.sha.slice(0, 10)} ${p.n !== null ? `c/${p.n} ` : ""}${clip(p.title, 80)}${p.effectText ? ` · ${p.effectText} when promoted` : ""} · ${p.files} file(s)`)));
    lines.push(...runsLines);
    if (h.state === "frozen") {
      lines.push("", "Next: ask an agent to harvest it with the study-harvest skill, for example:", `  "${v.guide.prompt}"`, "It uses:", ...v.guide.commands.map((c) => `  ${c.command}  (${c.what})`), `Or \`bb study resume ${slug}\` (keep exploring) · \`bb study archive ${slug}\` (done).`);
    }
    return lines.join("\n");
  }
  const acc = h.accounting;
  const lines = [
    `Harvest h${h.seq} of ${s.slug} · ${h.state} (before 1.0)${h.detail ? ` (${h.detail})` : ""} · study ${s.state}`,
    ...kv([
      ["Error", h.error ? clip(h.error, 300) : null],
      ["Base → best", `${h.baseSha?.slice(0, 10) ?? "?"} → ${h.bestSha?.slice(0, 10) ?? "?"} · grouping ${h.groupingSource ?? "pending"}${h.groupingNotes ? ` (${clip(h.groupingNotes, 200)})` : ""} · bench ${formatDuration(h.benchSeconds)}`],
      ["Measured gain", h.headline ? [h.headline.text, h.headline.raw, h.headline.ci].filter(Boolean).join(" · ") : h.state === "ready" || h.state === "failed" ? "not measured" : "not measured yet"],
      ["Explained", acc.explained !== null ? `${sharePct(acc.explained)} of the gain${acc.explainedHalfWidth !== null ? ` ± ${sharePct(acc.explainedHalfWidth)}` : ""}` : null],
      ["Unexplained", acc.unexplained !== null ? `${sharePct(acc.unexplained)}${acc.unexplainedHalfWidth !== null ? ` (noise allows ± ${sharePct(acc.unexplainedHalfWidth)})` : ""}` : null],
      ["Not measured", acc.missing.length ? acc.missing.join(", ") : null],
      [
        "Warning",
        acc.interaction
          ? acc.missing.length
            ? "some contributions could not be measured, so the shares do not account for the whole gain."
            : "the unexplained part is larger than the noise allows: the changesets interact, so a PR's contribution depends on which others land with it."
          : null,
      ],
    ]),
  ];
  const cs = h.changesets;
  const body: string[] = [];
  for (const c of cs) {
    const share = c.contribution ? `${c.contribution.text}${c.contribution.detail ? ` · ${c.contribution.detail}` : ""}` : `not measured alone (${c.ablation.status.replace(/_/gu, " ")})`;
    body.push(`  #${c.k} ${clip(c.title, 70)} [${c.candidates.map((n) => `c/${n}`).join(", ")}] · ${share}${c.droppable ? " · DROPPABLE (CI reaches zero)" : ""}${c.choice ? ` · your choice: ${c.choice}` : ""}`);
    body.push(...kv([
      ["PR base", c.prBaseText],
      ["Standalone", clip(c.standalone.summary, 240)],
      ["Branch", c.pr.branch ? `${c.pr.branch}${c.pr.url ? ` · ${c.pr.url}` : ""}` : c.foldedInto !== null ? `none: ships inside #${c.foldedInto}'s PR` : null],
    ], "      "));
    for (const e of c.explanation) body.push(`      ${e}`);
  }
  lines.push(...section(`Changesets: ${cs.length}`, body.length ? body : ["  none"]));
  if (h.stacks.length) {
    lines.push(...section("Stacks (PR order)", h.stacks.map((st) => `  stack ${st.stack}: ${st.order}${st.contribution ? ` · together ${st.contribution.text}` : ` · ${st.status}`}`)));
  }
  const next = [
    "Drafted by the plugin before 1.0; read only.",
    h.exportDir ? `Dry-run export (report.md, prs/*.md, manifest.json): ${h.exportDir}` : "",
    h.published ? `Published: ${h.published.map((p) => `#${p.k} ${p.url ?? p.status}`).join(" · ")}` : "",
    s.state === "harvesting" && h.publishState !== "published" ? `Next: ask an agent to finish it with the study-harvest skill (it can reuse these branches and drafts) · \`bb study resume ${slug}\` · \`bb study archive ${slug}\`` : "",
  ].filter(Boolean);
  lines.push(...runsLines);
  lines.push("", ...next);
  return lines.join("\n");
}
