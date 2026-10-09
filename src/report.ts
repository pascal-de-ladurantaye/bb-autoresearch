// Markdown for humans: PR bodies for harvested changesets and the study
// report (trajectory, wins, notable losses, dossier, calibration and
// segments, harvest result). Pure functions of the store. Nothing here reads
// holdout numbers or the holdout command (only pass/fail on candidates).
import type { Ctx } from "./context.ts";
import type { CandidateRow, ChangesetRow, HarvestRow, StudyRow } from "./db/store.ts";
import { harvestAccounting, type Accounting, type Estimate } from "./harvest-math.ts";
import type { StackRecord } from "./harvest.ts";
import { clip, formatDuration, safeJson } from "./prompts.ts";
import { formatPct, type StudySpec } from "./spec.ts";

const pct = (v: number | null | undefined) => formatPct(v ?? null);

function ci(lo: number | null, hi: number | null): string {
  return lo === null || hi === null ? "" : ` (CI ${pct(lo)}..${pct(hi)})`;
}

export function estimateText(e: Estimate | null): string {
  return e ? `${pct(e.value)}${ci(e.lo, e.hi)}` : "not measured";
}

/** The accounting (sum of contributions vs total) for a harvest, from its rows. */
export function accountingFor(ctx: Ctx, h: HarvestRow): Accounting {
  const cs = ctx.store.changesets(h.id);
  const stacks = safeJson<StackRecord[]>(h.stacks_json) ?? [];
  return harvestAccounting({
    changesets: cs.map((c) => ({ id: c.id, k: c.k, title: c.title, estimate: c.contribution === null ? null : { value: c.contribution, lo: c.ci_lo, hi: c.ci_hi } })),
    stacks: stacks.map((s) => ({ members: s.members, estimate: s.estimate })),
    total: h.total_effect === null ? null : { value: h.total_effect, lo: h.total_ci_lo, hi: h.total_ci_hi },
  });
}

export function accountingText(a: Accounting): string[] {
  const lines: string[] = [];
  lines.push(`- Total gain (base vs best, relative to best): ${estimateText(a.total)}`);
  lines.push(`- Sum of contributions: ${a.sum === null ? "n/a" : `${pct(a.sum)}${a.sumHalfWidth !== null ? ` ± ${(a.sumHalfWidth * 100).toFixed(2)}%` : ""}`} over ${a.items.filter((i) => i.estimate).length} term(s)`);
  if (a.gap !== null) lines.push(`- Gap (total − sum): ${pct(a.gap)}${a.gapHalfWidth !== null ? ` (CI half-width ${(a.gapHalfWidth * 100).toFixed(2)}%)` : ""}`);
  if (a.missing.length) lines.push(`- Not measured: ${a.missing.join(", ")}`);
  if (a.interaction) {
    lines.push(
      a.missing.length && (a.gap === null || a.gapHalfWidth === null || Math.abs(a.gap) <= a.gapHalfWidth)
        ? "- **Warning:** some contributions could not be measured, so the sum does not account for the whole gain."
        : "- **Interaction warning:** the gap is larger than its CI. The changesets interact (their effects do not add), so a PR's contribution depends on which others land with it.",
    );
  } else if (a.gap !== null) lines.push("- The contributions add up to the total gain within the CI.");
  return lines;
}

function linkedFindings(ctx: Ctx, study: StudyRow, cs: ChangesetRow): string[] {
  const nums = safeJson<number[]>(cs.candidates_json) ?? [];
  const out: string[] = [];
  for (const n of nums) {
    const c = ctx.store.candidateByN(study.id, n);
    if (!c) continue;
    const fs = ctx.store.db.prepare(`SELECT * FROM findings WHERE study_id = ? AND (candidate_id = ? OR (idea_id IS NOT NULL AND idea_id = ?)) ORDER BY id LIMIT 5`).all(study.id, c.id, c.idea_id ?? -1) as Array<{ id: number; outcome: string; learned: string; revisit_if: string }>;
    for (const f of fs) out.push(`- Finding #${f.id} (c/${n}, ${f.outcome}): ${clip(f.learned.replace(/\s+/gu, " "), 400)}${f.revisit_if ? ` Revisit if: ${clip(f.revisit_if, 160)}` : ""}`);
  }
  return [...new Set(out)];
}

function studyLink(ctx: Ctx, study: StudyRow, tab = "harvest"): string {
  const url = ctx.bb.appUrl();
  const path = `studies/${study.slug}/${tab}`;
  return url ? `${url.replace(/\/$/u, "")}/plugins/autoresearch/${path}` : `BB Studies page \`${path}\``;
}

/** PR body for one changeset: what and why, measured contribution, standalone effect, findings, study link. */
export function prBody(ctx: Ctx, study: StudyRow, spec: StudySpec, h: HarvestRow, cs: ChangesetRow, all: ChangesetRow[]): string {
  const nums = safeJson<number[]>(cs.candidates_json) ?? [];
  const cands = nums.map((n) => ctx.store.candidateByN(study.id, n)).filter((c): c is CandidateRow => Boolean(c));
  const deps = (safeJson<number[]>(cs.depends_on_json) ?? []).map((id) => all.find((c) => c.id === id)).filter((c): c is ChangesetRow => Boolean(c));
  const lines = [
    `## What`,
    clip(cs.title, 200),
    "",
    ...cands.map((c) => `- c/${c.n}: ${clip(c.summary.split("\n")[0] ?? "", 200)} (measured ${pct(c.effect)}${ci(c.ci_lo, c.ci_hi)} when promoted)`),
    "",
    `## Why`,
    clip(cs.rationale || "Promoted by the autoresearch study because it measurably improved the metric.", 2000),
    "",
    `## Measured effect on \`${spec.metric.name}\` (${spec.metric.direction} is better, ${spec.oracle.noise} oracle)`,
    `- Contribution (ablation: best without this change, measured against best): ${cs.contribution === null ? `not measured alone (${cs.ablation_status}${cs.ablation_detail ? `: ${clip(cs.ablation_detail, 200)}` : ""})` : `${pct(cs.contribution)}${ci(cs.ci_lo, cs.ci_hi)}, n=${cs.n ?? "?"}`}${cs.droppable ? " — **no measurable contribution: consider dropping this PR**" : ""}`,
    `- Standalone (applied on ${cs.pr_base === "base" || !cs.pr_base ? `\`${spec.study.base}\` at the study base` : `${cs.pr_base}`}): ${standaloneText(cs)}`,
  ];
  if (deps.length) lines.push(`- Depends on: ${deps.map((d) => `#${d.k} ${clip(d.title, 60)}`).join(", ")}${cs.dependency_reason ? ` (${clip(cs.dependency_reason, 300)})` : ""}`);
  const dependents = all.filter((o) => (safeJson<number[]>(o.depends_on_json) ?? []).includes(cs.id));
  if (dependents.length) lines.push(`- Needed by: ${dependents.map((d) => `#${d.k} ${clip(d.title, 60)}`).join(", ")}`);
  const f = linkedFindings(ctx, study, cs);
  if (f.length) lines.push("", "## Findings", ...f);
  lines.push(
    "",
    "---",
    `From autoresearch study \`${study.slug}\` (harvest h${h.id}, changeset #${cs.k} of ${all.length}). Study: ${studyLink(ctx, study)}. Every number above is a plugin measurement on the study's bench, not an agent's claim.`,
  );
  return clip(lines.join("\n"), 60_000);
}

export function standaloneText(cs: ChangesetRow): string {
  switch (cs.standalone_status) {
    case "pass":
      return cs.standalone_effect === null ? "gates pass (effect not measured)" : `gates pass; effect ${pct(cs.standalone_effect)}${ci(cs.standalone_ci_lo, cs.standalone_ci_hi)}`;
    case "pending":
      return "not checked yet";
    default:
      return `${cs.standalone_status}${cs.standalone_detail ? `: ${clip(cs.standalone_detail, 200)}` : ""}`;
  }
}

/** The study report: trajectory, wins, notable losses and why, dossier, calibration and segments, harvest result. */
export function studyReport(ctx: Ctx, study: StudyRow, spec: StudySpec, harvest: HarvestRow | null): string {
  const { store } = ctx;
  const decided = store.decided(study.id, 5000);
  const wins = decided.filter((c) => c.verdict === "win");
  const counts = new Map<string, number>();
  for (const c of decided) counts.set(c.verdict ?? "?", (counts.get(c.verdict ?? "?") ?? 0) + 1);
  const titles = new Map(store.ideas(study.id).map((i) => [i.id, i.title] as const));
  const cumulative = wins.reduce((acc, c) => (c.effect === null ? acc : 1 - (1 - acc) * (1 - c.effect)), 0);
  const budget = store.budget(study);
  const tokens = store.studyTokens(study.id);
  const lines: string[] = [
    `# Study report: ${study.slug}`,
    "",
    `> ${clip(spec.study.objective, 600)}`,
    "",
    `- State: ${study.state} · metric \`${spec.metric.name}\`${spec.metric.unit ? ` (${spec.metric.unit})` : ""}, ${spec.metric.direction} is better · ${spec.oracle.noise} oracle`,
    `- Base \`${study.base_sha?.slice(0, 10) ?? "?"}\` → best \`${study.best_sha?.slice(0, 10) ?? "?"}\` (branch \`studies/${study.slug}/best\`): ${wins.length ? `${pct(cumulative)} (compounded promoted effects)` : "no promotion"}`,
    `- Candidates: ${decided.length} decided (${[...counts].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}) · bench time ${formatDuration(budget.bench_seconds)} of ${spec.budget.max_bench_hours} h${tokens !== null ? ` · ${tokens.toLocaleString("en-US")} tokens${wins.length ? ` (${Math.round(tokens / wins.length).toLocaleString("en-US")} per win)` : ""}` : ""}`,
    `- Guardrails: ${spec.guardrail.map((g) => `${g.name} ≤ ${pct(g.max_regression)} worse`).join(", ") || "none"}${spec.oracle.holdout ? " · holdout: configured (results private)" : ""}`,
    "",
    "## Trajectory",
    "",
    "| # | Idea | Verdict | Effect | CI | Best after |",
    "|---|---|---|---|---|---|",
  ];
  let cum = 0;
  for (const c of decided.slice(-200)) {
    if (c.verdict === "win" && c.effect !== null) cum = 1 - (1 - cum) * (1 - c.effect);
    lines.push(`| c/${c.n} | ${mdCell(titles.get(c.idea_id ?? -1) ?? c.summary.split("\n")[0] ?? "", 60)} | ${c.verdict} | ${pct(c.effect)} | ${c.ci_lo !== null && c.ci_hi !== null ? `${pct(c.ci_lo)}..${pct(c.ci_hi)}` : ""} | ${pct(cum)} |`);
  }
  if (decided.length > 200) lines.push(`| … | ${decided.length - 200} earlier candidates omitted | | | | |`);
  lines.push("", "## Wins", "");
  if (!wins.length) lines.push("No promotions.");
  for (const c of wins) lines.push(`- **c/${c.n}** ${mdText(titles.get(c.idea_id ?? -1) ?? "", 120)}: ${pct(c.effect)}${ci(c.ci_lo, c.ci_hi)} · ${mdText(c.summary.split("\n")[0] ?? "", 200)}`);
  lines.push("", "## Notable losses and why", "");
  const losses = decided
    .filter((c) => ["lose", "inconclusive", "gate_failed", "rejected", "conflict"].includes(c.verdict ?? ""))
    .sort((a, b) => Math.abs(b.effect ?? 0) - Math.abs(a.effect ?? 0))
    .slice(0, 12);
  if (!losses.length) lines.push("None.");
  for (const c of losses) {
    const reasons = safeJson<string[]>(c.reasons_json) ?? [];
    const finding = store.findings(study.id, { limit: 200 }).find((f) => f.candidate_id === c.id);
    lines.push(`- c/${c.n} ${mdText(titles.get(c.idea_id ?? -1) ?? "", 100)}: **${c.verdict}** ${pct(c.effect)}${reasons[0] ? ` — ${mdText(reasons[0], 200)}` : ""}${finding ? `. Learned: ${mdText(finding.learned, 300)}` : ""}`);
  }
  lines.push("", "## Dossier", "");
  const dossier = store.dossier(study.id);
  lines.push(dossier ? clip(dossier.text, 8000) : "No dossier was written.");
  lines.push("", "## Calibration and segments", "");
  for (const g of store.segments(study.id)) {
    lines.push(`- Segment ${g.k}: oracle \`${g.oracle_hash}\`, spec v${g.spec_version ?? "?"}, baseline \`${g.baseline_sha.slice(0, 10)}\`, noise floor ${pct(g.noise_floor)}, MDE ${pct(g.mde)}, ≈${formatDuration(g.eval_seconds ?? 0)} per evaluation.${g.report ? ` ${mdText(g.report, 400)}` : ""}`);
  }
  const drift = store.driftChecks(study.id, 50);
  if (drift.length) lines.push(`- Drift checks: ${drift.length} (${drift.filter((d) => d.status === "drift").length} over the limit)`);
  if (harvest) lines.push("", ...harvestSection(ctx, study, spec, harvest));
  lines.push("", `_Generated by the autoresearch plugin at ${new Date(ctx.now()).toISOString()}. Study: ${studyLink(ctx, study, "overview")}._`);
  return clip(lines.join("\n"), 400_000);
}

export function harvestSection(ctx: Ctx, study: StudyRow, spec: StudySpec, h: HarvestRow): string[] {
  const cs = ctx.store.changesets(h.id);
  const stacks = safeJson<StackRecord[]>(h.stacks_json) ?? [];
  const lines = [
    `## Harvest h${h.id} (${h.state})`,
    "",
    `Grouping: ${h.grouping_source ?? "pending"}${h.grouping_notes ? ` (${mdText(h.grouping_notes, 300)})` : ""}. Base \`${h.base_sha?.slice(0, 10) ?? "?"}\`, best \`${h.best_sha?.slice(0, 10) ?? "?"}\`. Contributions come from ablation: best with the changeset reverted, measured against best with the study's ${spec.oracle.noise} protocol, so a positive number is how much the change helps relative to best.`,
    "",
    "| # | Changeset | Candidates | Contribution | Standalone | Depends on | PR branch |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of cs) {
    const deps = (safeJson<number[]>(c.depends_on_json) ?? []).map((id) => `#${cs.find((x) => x.id === id)?.k ?? "?"}`);
    lines.push(
      `| ${c.k} | ${mdCell(c.title, 60)}${c.droppable ? " (droppable)" : ""} | ${(safeJson<number[]>(c.candidates_json) ?? []).map((n) => `c/${n}`).join(", ")} | ${c.contribution === null ? c.ablation_status : `${pct(c.contribution)}${ci(c.ci_lo, c.ci_hi)}`} | ${mdCell(standaloneText(c), 60)} | ${deps.join(", ") || "—"} | ${c.branch ? `\`${c.branch}\`` : "—"} |`,
    );
  }
  if (stacks.length) {
    lines.push("", "Stacks (dependent changesets, PRs stacked in this order):");
    for (const s of stacks) lines.push(`- Stack ${s.stack}: ${s.members.map((id) => `#${cs.find((x) => x.id === id)?.k ?? "?"}`).join(" → ")}${s.status === "measured" ? `; ablated together: ${estimateText(s.estimate)}` : s.status === "not_needed" ? "" : `; joint ablation ${s.status}${s.detail ? ` (${mdText(s.detail, 200)})` : ""}`}`);
  }
  const drop = cs.filter((c) => c.droppable);
  if (drop.length) lines.push("", `Droppable (no measurable contribution; the human decides): ${drop.map((c) => `#${c.k} ${mdText(c.title, 60)}`).join(", ")}.`);
  lines.push("", "### Sum of contributions vs total gain", "", ...accountingText(accountingFor(ctx, h)));
  if (h.total_vs_base !== null) lines.push(`- Relative to base, best is ${pct(h.total_vs_base)} better (measured).`);
  lines.push(`- Harvest bench time: ${formatDuration(h.bench_seconds)}.`);
  return lines;
}

function mdCell(s: string, max: number): string {
  return clip(s.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim(), max);
}
function mdText(s: string, max: number): string {
  return clip(s.replace(/\s+/gu, " ").trim(), max);
}
