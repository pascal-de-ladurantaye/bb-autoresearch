// Text the plugin sends to agents: worker briefs, verdict messages, and
// strategist round digests. Everything is built from plugin state and
// bounded, so the study thread can be compacted without losing state.
import type { CandidateRow, FindingRow, IdeaRow, StudyRow, ThreadRow } from "./db/store.ts";
import { formatPct, type StudySpec } from "./spec.ts";
import type { RoundTrigger } from "./scheduler.ts";

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Quote untrusted text (agent- or human-authored) as data. */
function quoted(text: string, max = 600): string {
  return clip(text.replace(/\s+/gu, " ").trim(), max);
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
    spec.guardrail.length ? `Guardrails (a win that breaks one is a lose): ${spec.guardrail.map((g) => `${g.name} max ${formatPct(g.max_regression)} worse`).join(", ")}.` : "",
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
    "3. Call `submit_candidate` with a one-paragraph summary. The plugin commits your worktree for you. Then END YOUR TURN; the verdict arrives later as a message.",
    "4. Read the verdict. Refine and resubmit, or stop.",
    `5. Before you stop: call \`record_finding\` (what you learned, why it won or lost, when it is worth revisiting), then \`finish\`. \`finish\` refuses until a finding is recorded.`,
    "",
    "## Limits",
    `- At most ${spec.agents.max_submissions_per_worker} submissions. One submission in flight at a time.`,
    `- If you go idle without a pending verdict for ${spec.agents.idle_nudge_minutes} min you get one nudge; after ${spec.agents.idle_abandon_minutes} min you are stopped and the idea is marked abandoned.`,
    "- Ideas you notice but won't pursue: `propose_idea`.",
    "- Do not edit protected paths, the benchmark, or the tests to make numbers look better: those submissions are rejected.",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function verdictMessage(c: CandidateRow, opts: { submissionsLeft: number; spec: StudySpec }): string {
  const reasons = safeJson<string[]>(c.reasons_json) ?? [];
  const metrics = safeJson<{ best?: Record<string, number>; candidate?: Record<string, number>; guardrails?: Record<string, number> }>(c.metrics_json);
  const diag = safeJson<string[]>(c.diag_json) ?? [];
  const head: Record<string, string> = {
    win: "WIN: promoted to best",
    lose: "LOSE",
    inconclusive: "INCONCLUSIVE",
    gate_failed: "GATE FAILED",
    conflict: "CONFLICT",
    rejected: "REJECTED (scope)",
  };
  const lines = [`[autoresearch] Verdict for c/${c.n}: ${head[c.verdict ?? ""] ?? c.verdict}${c.effect !== null ? ` · effect ${ciText(c)}` : ""}`];
  for (const r of reasons.slice(0, 8)) lines.push(`- ${clip(r, 400)}`);
  if (metrics?.best && metrics.candidate) {
    const keys = [opts.spec.metric.name, ...opts.spec.guardrail.map((g) => g.name)];
    const parts = keys.filter((k) => metrics.best?.[k] !== undefined).map((k) => `${k}: best ${fmtNum(metrics.best![k]!)} → candidate ${fmtNum(metrics.candidate?.[k])}`);
    if (parts.length) lines.push(`Metrics (median): ${parts.join("; ")}`);
  }
  if (c.gate_output) lines.push("Gate output (tail):", "```", clip(c.gate_output, 2500), "```");
  if (diag.length) lines.push("Diagnostics:", "```", clip(diag.join("\n"), 1500), "```");
  if (c.verdict === "conflict") lines.push("Best moved and your change no longer applies. Rebase your worktree onto the study's best branch, resolve, and resubmit.");
  lines.push(
    opts.submissionsLeft > 0
      ? `You have ${opts.submissionsLeft} submission(s) left. Refine and call submit_candidate, or call record_finding then finish.`
      : "No submissions left: call record_finding, then finish.",
  );
  return lines.join("\n");
}

export function nudgeMessage(minutes: number): string {
  return `[autoresearch] You have been idle for ${minutes.toFixed(0)} minutes with no submission pending. Either submit_candidate, or record_finding and finish. If you stay idle you will be stopped and the idea marked abandoned.`;
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
}

const TRIGGER_TEXT: Record<RoundTrigger, string> = {
  start: "study started",
  verdicts: "new verdicts",
  queue_low: "idea queue is low",
  stall: "stall",
  human: "the human sent a message",
};

export function strategistDigest(d: DigestInput): string {
  const queued = d.ideas.filter((i) => i.status === "queued");
  const running = d.ideas.filter((i) => i.status === "running");
  const counts = new Map<string, number>();
  for (const i of d.ideas) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  const lines = [
    `[autoresearch] Strategist round ${d.round} · study \`${d.study.slug}\` · trigger: ${TRIGGER_TEXT[d.trigger]}`,
    "",
    `Objective: ${quoted(d.spec.study.objective, 400)}`,
    `Metric: ${d.spec.metric.name} (${d.spec.metric.direction} is better) · best vs base: ${d.cumulative === null ? "no promotion yet" : formatPct(d.cumulative)} · state: ${d.study.state} · workers: ${d.workers.length}/${d.w}`,
    `Budget: ${d.budgetLine}`,
    "",
  ];
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
  for (const i of queued.slice(0, 15)) lines.push(`- queued #${i.id} p=${i.priority}${i.pinned ? " (pinned)" : ""} ${quoted(i.title, 100)}${i.theme ? ` [${quoted(i.theme, 30)}]` : ""}`);
  if (queued.length > 15) lines.push(`- … ${queued.length - 15} more queued`);
  if (d.bestDiag.length) lines.push("", "## Best diagnostics", "```", clip(d.bestDiag.join("\n"), 1200), "```");
  lines.push("", `## Dossier${d.dossier ? ` (v${d.dossier.version})` : ""}`, d.dossier ? clip(d.dossier.text, 1500) : "empty: write one with update_dossier once you have read the code.");
  lines.push(
    "",
    "## This round",
    `- Keep at least ${d.w + 2} ready ideas, diverse across themes: \`queue_ideas\` (title, rationale, theme, priority).`,
    "- Retire dead directions with `retire_idea`; record what is known in `update_dossier`.",
    "- `search_findings` searches all findings and verdicts.",
    "- You do not edit code, run benchmarks, or decide verdicts. Concurrency, budget, oracle and pausing are human controls.",
    "- Keep your reply short, then end your turn.",
  );
  return clip(lines.join("\n"), 12_000);
}

export function safeJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function fmtNum(v: number | undefined): string {
  if (v === undefined) return "n/a";
  return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toPrecision(4);
}
