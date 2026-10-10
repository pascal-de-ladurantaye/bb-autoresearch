// Text the plugin sends to agents: worker briefs, verdict messages, and
// strategist round digests. Everything is built from plugin state and
// bounded, so the study thread can be compacted without losing state.
import type { CandidateRow, FindingRow, IdeaRow, StudyRow, ThreadRow } from "./db/store.ts";
import { formatPct, type StudySpec } from "./spec.ts";
import type { RoundTrigger } from "./scheduler.ts";
import { ciText as ciRange, improvementText, type MetricInfo } from "./present.ts";
import { changeWords, headroom, headroomWords, rangeWords, relativeWords, type GuardrailJudgement, type Position } from "./guardrails.ts";

/**
 * A message for an agent thread: a short `summary` a human skimming the
 * thread understands in one line, and the complete `detail` the agent needs.
 * The BB adapter sends `detail` as an agent-only input block (hidden from the
 * human's timeline, still in the agent's context); the agent sees both.
 */
export interface AgentMessage {
  summary: string;
  detail: string;
}

/** The whole message as one text (tool results, logs, tests). */
export function messageText(m: string | AgentMessage): string {
  return typeof m === "string" ? m : m.detail ? `${m.summary}\n\n${m.detail}` : m.summary;
}

function metricOf(spec: StudySpec): MetricInfo {
  return { name: spec.metric.name, unit: spec.metric.unit, direction: spec.metric.direction };
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Quote untrusted text (agent- or human-authored) as data. */
function quoted(text: string, max = 600): string {
  return clip(text.replace(/\s+/gu, " ").trim(), max);
}

/** Seconds as "42 s", "3.5 min", or "2.25 h". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "n/a";
  if (seconds < 120) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

export function ciText(c: Pick<CandidateRow, "effect" | "ci_lo" | "ci_hi">): string {
  if (c.effect === null) return "";
  const ci = c.ci_lo !== null && c.ci_hi !== null && c.ci_lo !== c.ci_hi ? ` [${formatPct(c.ci_lo)}, ${formatPct(c.ci_hi)}]` : "";
  return `${formatPct(c.effect)}${ci}`;
}

function scopeBlock(spec: StudySpec): string {
  return [
    `- Editable: ${spec.scope.editable.map((g) => `\`${g}\``).join(", ")}`,
    `- Protected (never touch): ${spec.scope.protected.length ? spec.scope.protected.map((g) => `\`${g}\``).join(", ") : "none"}`,
    `- Diff limits: ${spec.scope.max_files} files, ${spec.scope.max_lines} changed lines vs best`,
    ...(spec.scope.ignore?.length
      ? [`- Never committed (build outputs and caches): ${spec.scope.ignore.slice(0, 16).map((g) => `\`${g}\``).join(", ")}. The snapshot leaves untracked files matching these out; a candidate that adds one anyway is rejected.`]
      : []),
  ].join("\n");
}

export interface BriefInput {
  study: StudyRow;
  spec: StudySpec;
  idea: IdeaRow;
  dossier: string | null;
  bestDiag: string[];
  relatedFindings: Array<FindingRow & { title?: string | null }>;
  mde: number | null;
  /** Best's position per guardrail against the segment base (remaining room under the total limit). */
  guardrailPositions?: Record<string, Position>;
}

/** One line per guardrail: the room left under its total limit against the segment base. */
export function headroomLines(spec: StudySpec, positions: Record<string, Position> | undefined): string[] {
  if (!positions) return [];
  return spec.guardrail.map((g) => headroomWords(g.name, positions[g.name] ?? null, g.max_total_regression ?? g.max_regression));
}

export function workerBrief(b: BriefInput): string {
  const { spec, idea } = b;
  const metric = `${spec.metric.name}${spec.metric.unit ? ` (${spec.metric.unit})` : ""}, ${spec.metric.direction} is better`;
  const lines = [
    `# Autoresearch worker · study \`${b.study.slug}\` · idea #${idea.id}`,
    "",
    "You are a short-lived worker in a measured optimization study. You get one idea, a fresh worktree branched from the study's current best, and a few submissions. The plugin measures every submission on its own oracle and decides keep or discard. You never run the official benchmark yourself and you never decide what is kept.",
    "",
    "## Objective",
    quoted(spec.study.objective, 1500),
    "",
    `Primary metric: ${metric}.${b.mde !== null ? ` A win must clear about ${formatPct(b.mde)} with confidence.` : ""}`,
    spec.guardrail.length
      ? `Guardrails (a win that breaks one is a lose): ${spec.guardrail.map((g) => `${g.name} at most ${pctAbs(g.max_regression)} worse than best per step and ${pctAbs(g.max_total_regression ?? g.max_regression)} worse than the segment base in total`).join("; ")}. Each is judged on a CI: it breaks only when the whole CI is beyond a limit.`
      : "",
    ...(b.guardrailPositions && spec.guardrail.length ? [`Guardrail headroom now: ${headroomLines(spec, b.guardrailPositions).join("; ")}.`] : []),
    spec.oracle.holdout ? "A win must also pass a hidden holdout workload on the bench host before it is promoted. You only learn pass or fail; do not special-case the benchmark input." : "",
    "",
    "## Scope (enforced at submission)",
    scopeBlock(spec),
    "",
    "## Your idea",
    `**${quoted(idea.title, 200)}**${idea.theme ? ` (theme: ${quoted(idea.theme, 60)})` : ""}`,
    idea.rationale ? `Rationale: ${quoted(idea.rationale, 1200)}` : "",
    idea.start_ref ? `Starting point: \`${idea.start_ref}\`` : "",
    "",
  ];
  if (b.relatedFindings.length) {
    lines.push("## Related findings from earlier workers");
    for (const f of b.relatedFindings.slice(0, 6)) {
      lines.push(`- [${f.outcome}]${f.title ? ` ${quoted(f.title, 80)}:` : ""} ${quoted(f.learned, 300)}${f.revisit_if ? ` (revisit if: ${quoted(f.revisit_if, 120)})` : ""}`);
    }
    lines.push("");
  }
  if (b.dossier) lines.push("## Dossier (strategist's map of the codebase)", clip(b.dossier, 3000), "");
  if (b.bestDiag.length) lines.push("## Diagnostics from the current best", "```", clip(b.bestDiag.join("\n"), 1500), "```", "");
  lines.push(
    "## Loop",
    "1. Understand the relevant code. Stay inside the editable scope.",
    "2. Make the change, then run a fast local check (build or a focused test). Do not run long benchmarks.",
    "3. Call `study_submit_candidate` with a one-paragraph summary. The plugin commits your worktree for you, rebases it onto the current best, runs the gates, and queues it for the bench. Then END YOUR TURN; the verdict arrives later as a message.",
    "4. Read the verdict. Refine and resubmit, or stop.",
    `5. Before you stop: call \`study_record_finding\` (what you learned, why it won or lost, when it is worth revisiting), then \`study_finish\`. \`study_finish\` refuses until a finding is recorded.`,
    "",
    `Other workers run in parallel on other ideas. When one of them wins, \`studies/${b.study.slug}/best\` moves: your next submission is rebased onto it automatically. Only a CONFLICT verdict needs you to rebase by hand.`,
    "",
    "## Limits",
    `- At most ${spec.agents.max_submissions_per_worker} submissions. One submission in flight at a time.`,
    `- If you go idle without a pending verdict for ${spec.agents.idle_nudge_minutes} min you get one nudge; after ${spec.agents.idle_abandon_minutes} min you are stopped and the idea is marked abandoned.`,
    "- Ideas you notice but won't pursue: `study_propose_idea`.",
    "- Do not edit protected paths, the benchmark, or the tests to make numbers look better: those submissions are rejected.",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function verdictMessage(c: CandidateRow, opts: { submissionsLeft: number; spec: StudySpec; guardrailPositions?: Record<string, Position> }): AgentMessage {
  const reasons = safeJson<string[]>(c.reasons_json) ?? [];
  const metrics = safeJson<{ best?: Record<string, number>; candidate?: Record<string, number>; guardrails?: Record<string, number>; guardrailJudgement?: Record<string, GuardrailJudgement> }>(c.metrics_json);
  const diag = safeJson<string[]>(c.diag_json) ?? [];
  const head: Record<string, string> = {
    win: "WIN: promoted to best",
    lose: "LOSE",
    inconclusive: "INCONCLUSIVE",
    gate_failed: "GATE FAILED",
    conflict: "CONFLICT",
    rejected: "REJECTED (scope)",
  };
  const metric = metricOf(opts.spec);
  const effect = c.effect === null ? "" : `, ${improvementText(c.effect, metric, { digits: 1, factor: false })} than best${c.ci_lo !== null && c.ci_hi !== null && c.ci_lo !== c.ci_hi ? ` (${ciRange(c.ci_lo, c.ci_hi)})` : ""}`;
  const judged = Object.values(metrics?.guardrailJudgement ?? {});
  const flagged = judged.filter((g) => g.state === "inconclusive").map((g) => g.name);
  const brokeOnly = judged.filter((g) => g.state === "broken" || g.state === "missing").map((g) => g.name);
  // The human-visible line stays short: guardrail names only; the details are in the agent-only block.
  const guardrailNote = brokeOnly.length && c.verdict === "lose" && /^(initial )?primary metric improved/u.test(reasons[0] ?? "")
    ? ` Broke guardrail ${brokeOnly.join(", ")}.`
    : flagged.length && c.verdict === "win"
      ? ` Guardrail ${flagged.join(", ")} inconclusive (flagged).`
      : "";
  const firstReason = reasons[0] && c.verdict !== "win" && !guardrailNote ? ` ${clip(reasons[0], 160)}` : "";
  const summary = `[autoresearch] Verdict for c/${c.n}: ${head[c.verdict ?? ""] ?? c.verdict}${effect}.${firstReason}${guardrailNote}`;
  const lines = [`Effect (better is positive): ${c.effect !== null ? ciText(c) : "not measured"}`];
  for (const r of reasons.slice(0, 8)) lines.push(`- ${clip(r, 400)}`);
  if (metrics?.best && metrics.candidate) {
    const keys = [opts.spec.metric.name, ...opts.spec.guardrail.map((g) => g.name)];
    const parts = keys.filter((k) => metrics.best?.[k] !== undefined).map((k) => `${k}: best ${fmtNum(metrics.best![k]!)} → candidate ${fmtNum(metrics.candidate?.[k])}`);
    if (parts.length) lines.push(`Metrics (median): ${parts.join("; ")}`);
  }
  if (metrics?.guardrails && opts.spec.guardrail.length) {
    const parts = opts.spec.guardrail.map((g) => {
      const j = metrics.guardrailJudgement?.[g.name];
      const r = metrics.guardrails?.[g.name];
      if (r === undefined || r === null || Number.isNaN(r)) return `${g.name} missing`;
      if (!j?.step || !j.total) return `${g.name} ${changeWords(r)} (limit ${pctAbs(g.max_regression)} worse) ${r > g.max_regression ? "BROKEN" : "ok"}`;
      const ci = (x: { lo: number | null; hi: number | null }) => {
        const t = rangeWords(x.lo, x.hi);
        return t ? `, ${t}` : "";
      };
      return (
        `${g.name} ${relativeWords(j.step.regression, "best")}${ci(j.step)} (limit ${pctAbs(j.step.limit)}) ${STATE[j.step.state]}; ` +
        `${relativeWords(j.total.regression, "the segment base")}${ci(j.total)} (total limit ${pctAbs(j.total.limit)}) ${STATE[j.total.state]}`
      );
    });
    lines.push(`Guardrails (per step vs best; in total vs the segment base, with this candidate): ${parts.join(" · ")}`);
    if (judged.some((g) => g.state === "inconclusive")) {
      lines.push("An inconclusive guardrail is not a rejection: its CI straddles the limit. It is flagged so the strategist and the human see it; another change that adds to it may be rejected.");
    }
  }
  const room = headroomLines(opts.spec, opts.guardrailPositions);
  if (room.length) lines.push(`Guardrail headroom now (best vs the segment base): ${room.join("; ")}.`);
  if (c.gate_output) lines.push("Gate output (tail):", "```", clip(c.gate_output, 2500), "```");
  if (diag.length) lines.push("Diagnostics:", "```", clip(diag.join("\n"), 1500), "```");
  if (c.verdict === "conflict") {
    const branch = `studies/${opts.spec.study.slug}/best`;
    lines.push(
      `Best moved while your candidate waited and your change no longer applies. In your worktree run \`git rebase ${branch}\` (the branch is local; no fetch needed), resolve the conflicts, run your fast local check, and resubmit.`,
    );
  }
  lines.push(
    opts.submissionsLeft > 0
      ? `You have ${opts.submissionsLeft} submission(s) left. Refine and call study_submit_candidate, or call study_record_finding then study_finish.`
      : "No submissions left: call study_record_finding, then study_finish.",
  );
  return { summary, detail: lines.join("\n") };
}

export function nudgeMessage(minutes: number): string {
  return `[autoresearch] You have been idle for ${minutes.toFixed(0)} minutes with no submission pending. Either study_submit_candidate, or study_record_finding and study_finish. If you stay idle you will be stopped and the idea marked abandoned.`;
}

export interface DigestInput {
  study: StudyRow;
  spec: StudySpec;
  trigger: RoundTrigger;
  round: number;
  w: number;
  verdicts: CandidateRow[];
  findings: FindingRow[];
  ideas: IdeaRow[];
  workers: ThreadRow[];
  dossier: { version: number; text: string } | null;
  bestDiag: string[];
  cumulative: number | null;
  budgetLine: string;
  ideaTitles: Map<number, string>;
  notices: Array<{ at: number; kind: string; text: string }>;
  /** Best's position per guardrail against the segment base. */
  guardrailPositions?: Record<string, Position>;
}

const TRIGGER_TEXT: Record<RoundTrigger, string> = {
  start: "study started",
  verdicts: "new verdicts",
  queue_low: "idea queue is low",
  stall: "stall",
  human: "the human sent a message",
};

export function strategistDigest(d: DigestInput): AgentMessage {
  const queued = d.ideas.filter((i) => i.status === "queued");
  const running = d.ideas.filter((i) => i.status === "running");
  const counts = new Map<string, number>();
  for (const i of d.ideas) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  const metric = metricOf(d.spec);
  const wins = d.verdicts.filter((c) => c.verdict === "win");
  // Guardrails with less than a fifth of their total limit left (only these reach the human-visible line).
  const tight = d.spec.guardrail
    .filter((g) => {
      const pos = d.guardrailPositions?.[g.name];
      const limit = g.max_total_regression ?? g.max_regression;
      return pos && pos.steps > 0 && headroom(pos, limit).point < 0.2 * limit;
    })
    .map((g) => g.name);
  const verdictSummary = d.verdicts.length
    ? `${d.verdicts.length} new verdict${d.verdicts.length === 1 ? "" : "s"} (${[...new Set(d.verdicts.map((c) => c.verdict))].map((v) => `${d.verdicts.filter((c) => c.verdict === v).length} ${v}`).join(", ")})`
    : "no new verdicts";
  const summary =
    `[autoresearch] Strategist round ${d.round} (${TRIGGER_TEXT[d.trigger]}): ${verdictSummary}` +
    `${wins.length ? `, best now ${improvementText(d.cumulative, metric)} vs base` : d.cumulative !== null ? `, best ${improvementText(d.cumulative, metric)} vs base` : ""}` +
    ` · ${queued.length} idea${queued.length === 1 ? "" : "s"} queued · ${d.workers.length} worker${d.workers.length === 1 ? "" : "s"}${d.notices.length ? ` · ${d.notices.length} notice${d.notices.length === 1 ? "" : "s"} for you on the Studies page` : ""}` +
    `${tight.length ? ` · guardrail ${tight.join(", ")} near its total limit` : ""}.`;
  const lines = [
    `Strategist round ${d.round} · study \`${d.study.slug}\` · trigger: ${TRIGGER_TEXT[d.trigger]}`,
    "",
    `Objective: ${quoted(d.spec.study.objective, 400)}`,
    `Metric: ${d.spec.metric.name} (${d.spec.metric.direction} is better) · best vs base: ${d.cumulative === null ? "no promotion yet" : formatPct(d.cumulative)} · state: ${d.study.state} · workers: ${d.workers.length}/${d.w}`,
    `Budget: ${d.budgetLine}`,
    ...(d.spec.guardrail.length && d.guardrailPositions
      ? [
          `Guardrail headroom (total limit vs the segment base; a win that would push best beyond it is rejected): ${headroomLines(d.spec, d.guardrailPositions).join("; ")}.`,
          ...(tight.length ? [`Little room left on ${tight.join(", ")}: prefer ideas that don't cost them, or that win some of it back.`] : []),
        ]
      : []),
    "",
  ];
  if (d.notices.length) {
    lines.push(`## Notices for the human (${d.notices.length})`, "Relay these to the human in one or two lines; do not act on them yourself.");
    for (const n of d.notices.slice(0, 10)) lines.push(`- ${new Date(n.at).toISOString().slice(0, 16).replace("T", " ")} [${n.kind}] ${quoted(n.text, 500)}`);
    lines.push("");
  }
  if (d.trigger === "stall") {
    lines.push(`**Stall:** no win in the last ${d.spec.agents.stall_after} verdicts. Propose structurally different directions, not variations of what lost.`, "");
  }
  lines.push(`## Verdicts since last round (${d.verdicts.length})`);
  if (!d.verdicts.length) lines.push("none");
  for (const c of d.verdicts.slice(-15)) {
    const reasons = safeJson<string[]>(c.reasons_json) ?? [];
    lines.push(`- c/${c.n} idea #${c.idea_id ?? "?"} ${quoted(d.ideaTitles.get(c.idea_id ?? -1) ?? "", 60)}: **${c.verdict}** ${ciText(c)} ${reasons[0] ? `· ${quoted(reasons[0], 160)}` : ""}`);
  }
  lines.push("", `## Findings (${d.findings.length} new)`);
  if (!d.findings.length) lines.push("none");
  for (const f of d.findings.slice(0, 12)) {
    lines.push(`- idea #${f.idea_id ?? "?"} [${f.outcome}] ${quoted(f.learned, 280)}${f.revisit_if ? ` · revisit if: ${quoted(f.revisit_if, 100)}` : ""}`);
  }
  lines.push("", `## Idea board · ${[...counts].map(([k, v]) => `${k} ${v}`).join(" · ") || "empty"}`);
  for (const i of running) lines.push(`- running #${i.id} ${quoted(i.title, 100)}${i.theme ? ` [${quoted(i.theme, 30)}]` : ""}`);
  for (const i of queued.slice(0, 15)) lines.push(`- queued #${i.id} p=${i.priority}${i.pinned ? " (pinned)" : ""}${i.variation_of ? ` (variation of #${i.variation_of})` : ""} ${quoted(i.title, 100)}${i.theme ? ` [${quoted(i.theme, 30)}]` : ""}`);
  const lost = d.ideas.filter((i) => i.status === "lost").slice(-10);
  for (const i of lost) lines.push(`- lost #${i.id} ${quoted(i.title, 100)}${i.theme ? ` [${quoted(i.theme, 30)}]` : ""}`);
  if (queued.length > 15) lines.push(`- … ${queued.length - 15} more queued`);
  if (d.bestDiag.length) lines.push("", "## Best diagnostics", "```", clip(d.bestDiag.join("\n"), 1200), "```");
  lines.push("", `## Dossier${d.dossier ? ` (v${d.dossier.version})` : ""}`, d.dossier ? clip(d.dossier.text, 1500) : "empty: write one with study_update_dossier once you have read the code.");
  lines.push(
    "",
    "## This round",
    `- Keep at least ${d.w + 2} ready ideas, diverse across themes (at most ${Math.ceil(d.w / 2)} workers run one theme at once): \`study_queue_ideas\` (title, rationale, theme, priority, optional start_ref and variation_of).`,
    "- Lost ideas are not assigned again. To retry one differently, queue a new idea with `variation_of` set to the lost idea's id.",
    "- Retire dead directions with `study_retire_idea`; record what is known in `study_update_dossier`.",
    "- `study_search_findings` searches all findings and verdicts.",
    "- You do not edit code, run benchmarks, or decide verdicts. Concurrency, budget, oracle and pausing are human controls.",
    "- Reply to the human in two or three short lines (what changed, what you queued, anything they should decide), then end your turn.",
  );
  return { summary, detail: clip(lines.join("\n"), 12_000) };
}

export function safeJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const STATE: Record<string, string> = { ok: "ok", inconclusive: "INCONCLUSIVE", broken: "BROKEN" };
const pctAbs = (f: number) => `${(Math.abs(f) * 100).toFixed(1)}%`;

function fmtNum(v: number | undefined): string {
  if (v === undefined) return "n/a";
  return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toPrecision(4);
}

export interface HarvestRoundInput {
  study: StudyRow;
  spec: StudySpec;
  harvest: { id: number };
  promotions: Array<{ sha: string; n: number | null; title: string; paths: string[] }>;
  candidates: Map<number, CandidateRow | undefined>;
  dossier: { version: number; text: string } | null;
}

/** The harvest grouping round: one turn asking the strategist for study_propose_harvest. */
export function harvestRoundPrompt(d: HarvestRoundInput): AgentMessage {
  const summary = `[autoresearch] Harvest h${d.harvest.id}: please group the ${d.promotions.length} promotion${d.promotions.length === 1 ? "" : "s"} on best into changesets (one PR each) with study_propose_harvest.`;
  const lines = [
    `Harvest h${d.harvest.id} · study \`${d.study.slug}\` · group the promotions into changesets`,
    "",
    `Best is final for this harvest: ${d.promotions.length} promotion(s) on \`studies/${d.study.slug}/best\`, oldest first. Each changeset becomes one PR; the plugin then measures each one's contribution by reverting it from best (ablation), checks it alone on the base, and drafts the PRs. You don't run anything.`,
    "",
    "## Promotions",
  ];
  for (const p of d.promotions) {
    const c = p.n !== null ? d.candidates.get(p.n) : undefined;
    lines.push(`- ${p.n !== null ? `c/${p.n}` : p.sha.slice(0, 10)} ${quoted(p.title, 120)}${c ? ` · ${ciText(c)}` : ""} · files: ${p.paths.slice(0, 8).join(", ")}${p.paths.length > 8 ? `, … ${p.paths.length - 8} more` : ""}`);
  }
  if (d.dossier) lines.push("", `## Dossier (v${d.dossier.version})`, clip(d.dossier.text, 1500));
  lines.push(
    "",
    "## This round",
    "- Call `study_propose_harvest` once with `groups`: each group has a title (the PR title), the candidate numbers it contains, and a rationale (the PR's why).",
    "- Group by theme: promotions that are one idea refined twice, or that only make sense together, belong in one changeset. Unrelated wins stay separate so each PR can be reviewed and reverted alone.",
    "- Every promotion must be in exactly one group. The tool rejects unknown or duplicated candidates; fix and call it again.",
    "- If you don't answer, the plugin uses one changeset per promotion.",
    "- Keep your reply short, then end your turn.",
  );
  return { summary, detail: clip(lines.join("\n"), 12_000) };
}
