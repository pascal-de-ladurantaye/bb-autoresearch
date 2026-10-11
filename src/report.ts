// Markdown for humans: PR bodies for harvested changesets and the study
// report (trajectory, wins, notable losses, dossier, calibration and
// segments, harvest result). Pure functions of the store. Nothing here reads
// holdout numbers or the holdout command (only pass/fail on candidates).
import type { Ctx } from "./context.ts";
import type { CandidateRow, ChangesetRow, HarvestRow, StudyRow } from "./db/store.ts";
import { harvestAccounting, type Accounting, type Estimate } from "./harvest-math.ts";
import type { GuardrailCost, StackRecord } from "./harvest.ts";
import { changeWords, headroomWords, relativeWords, invertRegression, promotionChain, rangeWords, storedEstimate, type GuardrailJudgement, type StoredGuardrails } from "./guardrails.ts";
import { bestGuardrailPositions, segmentGuardrailCalibration } from "./pipeline.ts";
import { amountText, ciRangeText, ciText, clipWords, compound, improvementText, magnitudePct, shareOfGain, sharePct, signedPct, vsBaseFromVsBest, type MetricInfo } from "./present.ts";
import { clip, formatDuration, safeJson } from "./prompts.ts";
import type { StudySpec } from "./spec.ts";

// Every number follows src/present.ts: better is positive, in the metric's
// own terms; harvest contributions are shares of the base→best gain.
const pct = (v: number | null | undefined) => signedPct(v ?? null, 2);

function ci(lo: number | null, hi: number | null): string {
  return lo === null || hi === null ? "" : ` (${ciText(lo, hi, 2)})`;
}

function metricOf(spec: StudySpec): MetricInfo {
  return { name: spec.metric.name, unit: spec.metric.unit, direction: spec.metric.direction };
}

/** An improvement in words with its CI: "62.9% fewer ops (CI +62.6% to +63.3%)". */
function better(spec: StudySpec, v: number | null, lo: number | null = null, hi: number | null = null): string {
  return v === null ? "not measured" : `${improvementText(v, metricOf(spec), { factor: false })}${lo !== null && hi !== null ? ` (${ciText(lo, hi)})` : ""}`;
}

/** Raw value of the primary metric on best (the promoted candidate's median), for metric units. */
function bestRaw(ctx: Ctx, study: StudyRow, spec: StudySpec): number | null {
  const promoted = ctx.store.candidates(study.id, { stages: ["decided"] }).find((c) => c.promoted_sha === study.best_sha);
  const v = promoted ? safeJson<{ candidate?: Record<string, number> }>(promoted.metrics_json)?.candidate?.[spec.metric.name] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A relative-to-best term as a share of the harvest's total gain: "83.0% of the gain (CI 82.5% to 83.3%) · ≈ 171,456 fewer opcodes". */
export function shareText(e: Estimate | null, total: number | null, metric: MetricInfo, raw: number | null = null): string {
  if (!e) return "not measured";
  const share = shareOfGain(e.value, total);
  if (share === null) return `${pct(e.value)} vs best (total gain not measured)`;
  const lo = e.lo === null ? null : shareOfGain(e.lo, total);
  const hi = e.hi === null ? null : shareOfGain(e.hi, total);
  const units = raw !== null ? ` · ${amountText(e.value * Math.abs(raw), metric)}` : "";
  return `${sharePct(share, 1)} of the gain${lo !== null && hi !== null ? ` (CI ${sharePct(Math.min(lo, hi), 1)} to ${sharePct(Math.max(lo, hi), 1)})` : ""}${units}`;
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

export function accountingText(a: Accounting, spec?: StudySpec): string[] {
  const lines: string[] = [];
  const t = a.total?.value ?? null;
  const share = (v: number | null) => (v === null || t === null || t === 0 ? null : v / t);
  if (spec && t !== null) {
    const m = metricOf(spec);
    const vb = vsBaseFromVsBest(t, m.direction);
    const lo = vsBaseFromVsBest(a.total?.lo, m.direction);
    const hi = vsBaseFromVsBest(a.total?.hi, m.direction);
    lines.push(`- Measured gain (base vs best): ${improvementText(vb, m)}${lo !== null && hi !== null ? ` (${ciText(lo, hi)})` : ""}`);
  } else lines.push(`- Measured gain (base vs best): ${a.total ? "see below" : "not measured"}`);
  lines.push(`- Explained by the ${a.items.filter((i) => i.estimate).length} measured term(s): ${a.sum === null || share(a.sum) === null ? "n/a" : `${sharePct(share(a.sum), 1)} of the gain${a.sumHalfWidth !== null ? ` ± ${sharePct(share(a.sumHalfWidth), 1)}` : ""}`}`);
  if (a.gap !== null && share(a.gap) !== null) lines.push(`- Unexplained: ${sharePct(share(a.gap), 1)}${a.gapHalfWidth !== null ? ` (noise allows ± ${sharePct(share(a.gapHalfWidth), 1)})` : ""}`);
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
    for (const f of fs) out.push(`- Finding #${f.id} (c/${n}, ${f.outcome}): ${clipWords(f.learned.replace(/\s+/gu, " "), 400)}${f.revisit_if ? ` Revisit if: ${clipWords(f.revisit_if, 160)}` : ""}`);
  }
  return [...new Set(out)];
}

function studyLink(ctx: Ctx, study: StudyRow, tab = "harvest"): string {
  const url = ctx.bb.appUrl();
  const path = `studies/${study.slug}/${tab}`;
  return url ? `${url.replace(/\/$/u, "")}/plugins/${ctx.bb.pluginId()}/${path}` : `BB Studies page \`${path}\``;
}

/** The ablation in words, never a signed "+22.00% worse": "best with this change reverted is 22.00% worse than best". */
export function revertedWords(contribution: number): string {
  if (Math.abs(contribution) < 0.00005) return "best with this change reverted measures the same as best";
  return `best with this change reverted is ${magnitudePct(contribution, 2)} ${contribution > 0 ? "worse" : "better"} than best`;
}

/** PR body for one changeset: what and why, measured contribution, standalone effect, findings, study link. */
export function prBody(ctx: Ctx, study: StudyRow, spec: StudySpec, h: HarvestRow, cs: ChangesetRow, all: ChangesetRow[]): string {
  const nums = safeJson<number[]>(cs.candidates_json) ?? [];
  const cands = nums.map((n) => ctx.store.candidateByN(study.id, n)).filter((c): c is CandidateRow => Boolean(c));
  const deps = (safeJson<number[]>(cs.depends_on_json) ?? []).map((id) => all.find((c) => c.id === id)).filter((c): c is ChangesetRow => Boolean(c));
  const metric = metricOf(spec);
  const raw = bestRaw(ctx, study, spec);
  const lines = [
    `## What`,
    clipWords(cs.title, 200),
    "",
    ...cands.map((c) => `- c/${c.n}: ${clipWords(c.summary.split("\n")[0] ?? "", 200)} (when promoted: ${better(spec, c.effect, c.ci_lo, c.ci_hi)} than the best before it)`),
    "",
    `## Why`,
    clipWords(cs.rationale || "Promoted by the autoresearch study because it measurably improved the metric.", 2000),
    "",
    `## Measured effect on \`${spec.metric.name}\` (${spec.metric.direction} is better, ${spec.oracle.noise} oracle)`,
    `- Contribution: ${cs.contribution === null ? `not measured alone (${cs.ablation_status}${cs.ablation_detail ? `: ${clipWords(cs.ablation_detail, 200)}` : ""})` : `${shareText({ value: cs.contribution, lo: cs.ci_lo, hi: cs.ci_hi }, h.total_effect, metric, raw)} the study found (${cs.n ?? "?"} pairs; ablation: ${revertedWords(cs.contribution)})`}${cs.droppable ? " — **no measurable contribution: consider dropping this PR**" : ""}`,
    `- Alone on ${cs.pr_base === "base" || !cs.pr_base ? `\`${spec.study.base}\`, the study base` : `the PR below it (${cs.pr_base})`}: ${standaloneText(cs, spec)}`,
  ];
  if (deps.length) lines.push(`- Depends on: ${deps.map((d) => `#${d.k} ${clipWords(d.title, 60)}`).join(", ")}${cs.dependency_reason ? ` (${clipWords(cs.dependency_reason, 300)})` : ""}`);
  const dependents = all.filter((o) => (safeJson<number[]>(o.depends_on_json) ?? []).includes(cs.id));
  if (dependents.length) lines.push(`- Needed by: ${dependents.map((d) => `#${d.k} ${clipWords(d.title, 60)}`).join(", ")}`);
  const f = linkedFindings(ctx, study, cs);
  if (f.length) lines.push("", "## Findings", ...f);
  lines.push(
    "",
    "---",
    `From autoresearch study \`${study.slug}\` (harvest h${h.id}, changeset #${cs.k} of ${all.length}). Study: ${studyLink(ctx, study)}. Every number above is a plugin measurement on the study's bench, not an agent's claim.`,
  );
  return clip(lines.join("\n"), 60_000);
}

export function standaloneText(cs: ChangesetRow, spec?: StudySpec): string {
  switch (cs.standalone_status) {
    case "pass":
      return cs.standalone_effect === null
        ? "gates pass (effect not measured)"
        : spec
          ? `gates pass; ${better(spec, cs.standalone_effect, cs.standalone_ci_lo, cs.standalone_ci_hi)}`
          : `gates pass; effect ${pct(cs.standalone_effect)}${ci(cs.standalone_ci_lo, cs.standalone_ci_hi)}`;
    case "pending":
      return "not checked yet";
    default:
      return `${cs.standalone_status}${cs.standalone_detail ? `: ${clipWords(cs.standalone_detail, 200)}` : ""}`;
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
  const metric = metricOf(spec);
  const cumulative = compound(wins.filter((c) => c.effect !== null).map((c) => c.effect!), metric.direction);
  const budget = store.budget(study);
  const tokens = store.studyTokens(study.id);
  const lines: string[] = [
    `# Study report: ${study.slug}`,
    "",
    `> ${clip(spec.study.objective, 600)}`,
    "",
    `- State: ${study.state} · metric \`${spec.metric.name}\`${spec.metric.unit ? ` (${spec.metric.unit})` : ""}, ${spec.metric.direction} is better · ${spec.oracle.noise} oracle`,
    `- Base \`${study.base_sha?.slice(0, 10) ?? "?"}\` → best \`${study.best_sha?.slice(0, 10) ?? "?"}\` (branch \`studies/${study.slug}/best\`): ${wins.length ? `${improvementText(cumulative, metric)} (compounded from the promoted candidates)` : "no promotion"}`,
    `- Convention: every improvement is better-is-positive in the metric's own direction; "+10%" means 10% ${spec.metric.direction === "lower" ? "lower" : "higher"} ${spec.metric.name}.`,
    `- Candidates: ${decided.length} decided (${[...counts].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}) · bench time ${formatDuration(budget.bench_seconds)} of ${spec.budget.max_bench_hours} h${tokens !== null ? ` · ${tokens.toLocaleString("en-US")} tokens${wins.length ? ` (${Math.round(tokens / wins.length).toLocaleString("en-US")} per win)` : ""}` : ""}`,
    `- Guardrails: ${spec.guardrail.map((g) => `${g.name} at most ${magnitudePct(g.max_regression, 1)} worse per promotion and ${magnitudePct(g.max_total_regression ?? g.max_regression, 1)} in total against the segment base`).join(", ") || "none"}${spec.oracle.holdout ? " · holdout: configured (results private)" : ""}`,
    "",
    "## Trajectory",
    "",
    "| # | Idea | Verdict | Improvement vs best then | CI | Best vs base after |",
    "|---|---|---|---|---|---|",
  ];
  let cum = 0;
  for (const c of decided.slice(-200)) {
    if (c.verdict === "win" && c.effect !== null) cum = compound([cum, c.effect], metric.direction);
    lines.push(`| c/${c.n} | ${mdCell(titles.get(c.idea_id ?? -1) ?? c.summary.split("\n")[0] ?? "", 60)} | ${c.verdict} | ${signedPct(c.effect)} | ${c.ci_lo !== null && c.ci_hi !== null ? ciRangeText(c.ci_lo, c.ci_hi) : ""} | ${signedPct(cum)} |`);
  }
  if (decided.length > 200) lines.push(`| … | ${decided.length - 200} earlier candidates omitted | | | | |`);
  lines.push("", "## Wins", "");
  if (!wins.length) lines.push("No promotions.");
  for (const c of wins) lines.push(`- **c/${c.n}** ${mdText(titles.get(c.idea_id ?? -1) ?? "", 120)}: ${better(spec, c.effect, c.ci_lo, c.ci_hi)} than the best before it · ${mdText(c.summary.split("\n")[0] ?? "", 200)}`);
  lines.push("", "## Notable losses and why", "");
  const losses = decided
    .filter((c) => ["lose", "inconclusive", "gate_failed", "rejected", "conflict"].includes(c.verdict ?? ""))
    .sort((a, b) => Math.abs(b.effect ?? 0) - Math.abs(a.effect ?? 0))
    .slice(0, 12);
  if (!losses.length) lines.push("None.");
  for (const c of losses) {
    const reasons = safeJson<string[]>(c.reasons_json) ?? [];
    const finding = store.findings(study.id, { limit: 200 }).find((f) => f.candidate_id === c.id);
    lines.push(`- c/${c.n} ${mdText(titles.get(c.idea_id ?? -1) ?? "", 100)}: **${c.verdict}** ${signedPct(c.effect)}${reasons[0] ? ` — ${mdText(reasons[0], 200)}` : ""}${finding ? `. Learned: ${mdText(finding.learned, 300)}` : ""}`);
  }
  if (spec.guardrail.length) lines.push("", ...guardrailSection(ctx, study, spec));
  lines.push("", "## Dossier", "");
  const dossier = store.dossier(study.id);
  lines.push(dossier ? clip(dossier.text, 8000) : "No dossier was written.");
  lines.push("", "## Calibration and segments", "");
  for (const g of store.segments(study.id)) {
    lines.push(`- Segment ${g.k}: oracle \`${g.oracle_hash}\`, spec v${g.spec_version ?? "?"}, baseline \`${g.baseline_sha.slice(0, 10)}\`, noise floor ${magnitudePct(g.noise_floor)}, win threshold (MDE) ${magnitudePct(g.mde)}, ≈${formatDuration(g.eval_seconds ?? 0)} per evaluation.${g.report ? ` ${mdText(g.report, 400)}` : ""}`);
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
    `Grouping: ${h.grouping_source ?? "pending"}${h.grouping_notes ? ` (${mdText(h.grouping_notes, 300)})` : ""}. Base \`${h.base_sha?.slice(0, 10) ?? "?"}\`, best \`${h.best_sha?.slice(0, 10) ?? "?"}\`. Contributions come from ablation: best with the changeset reverted, measured against best with the study's ${spec.oracle.noise} protocol. Each is shown as its share of the measured base→best gain.`,
    "",
    "| # | Changeset | Candidates | Share of the gain | Alone on its PR base | Depends on | PR branch |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of cs) {
    const deps = (safeJson<number[]>(c.depends_on_json) ?? []).map((id) => `#${cs.find((x) => x.id === id)?.k ?? "?"}`);
    lines.push(
      `| ${c.k} | ${mdCell(c.title, 60)}${c.droppable ? " (droppable)" : ""} | ${(safeJson<number[]>(c.candidates_json) ?? []).map((n) => `c/${n}`).join(", ")} | ${c.contribution === null ? `not measured alone (${c.ablation_status})` : mdCell(shareText({ value: c.contribution, lo: c.ci_lo, hi: c.ci_hi }, h.total_effect, metricOf(spec)), 80)} | ${mdCell(standaloneText(c, spec), 80)} | ${deps.join(", ") || "—"} | ${c.branch ? `\`${c.branch}\`` : "—"} |`,
    );
  }
  if (stacks.length) {
    lines.push("", "Stacks (dependent changesets, PRs stacked in this order):");
    for (const s of stacks) lines.push(`- Stack ${s.stack}: ${s.members.map((id) => `#${cs.find((x) => x.id === id)?.k ?? "?"}`).join(" → ")}${s.status === "measured" ? `; together: ${shareText(s.estimate, h.total_effect, metricOf(spec))}` : s.status === "not_needed" ? "" : `; joint ablation ${s.status}${s.detail ? ` (${mdText(s.detail, 200)})` : ""}`}`);
  }
  const drop = cs.filter((c) => c.droppable);
  if (drop.length) lines.push("", `Droppable (no measurable contribution; the human decides): ${drop.map((c) => `#${c.k} ${mdText(c.title, 60)}`).join(", ")}.`);
  lines.push("", "### Sum of contributions vs total gain", "", ...accountingText(accountingFor(ctx, h), spec));
  if (spec.guardrail.length) lines.push("", ...harvestGuardrailLines(ctx, study, spec, h, cs));
  const vb = vsBaseFromVsBest(h.total_effect, spec.metric.direction);
  if (vb !== null) lines.push(`- For the record: relative to best the total gain is ${pct(h.total_effect)}; relative to base it is ${improvementText(vb, metricOf(spec))}.`);
  lines.push(`- Harvest bench time: ${formatDuration(h.bench_seconds)}.`);
  return lines;
}

/**
 * The study's guardrails: each one's cumulative position (best vs the
 * segment base, compounded over the promotion chain with a CI), the room
 * left under its total limit, every promotion's step, the candidates it
 * rejected or flagged, and its calibrated noise.
 */
export function guardrailSection(ctx: Ctx, study: StudyRow, spec: StudySpec): string[] {
  const { store } = ctx;
  const positions = bestGuardrailPositions(store, study, spec);
  const seg = store.segment(study.id, study.segment);
  const chain = promotionChain(store.candidates(study.id, { stages: ["decided"] }), seg?.baseline_sha ?? study.base_sha, study.best_sha);
  const calibration = new Map(segmentGuardrailCalibration(store, study).map((g) => [g.name, g] as const));
  const decided = store.decided(study.id, 5000);
  const lines = [
    `## Guardrails (segment ${study.segment})`,
    "",
    "Each win is checked twice: against the best before it (per-step limit) and, compounded with every promotion since the segment base, against that base (total limit). Both are judged on a CI: a guardrail breaks only when the whole CI is beyond a limit, and is flagged inconclusive when the CI straddles it.",
    "",
  ];
  for (const g of spec.guardrail) {
    const total = g.max_total_regression ?? g.max_regression;
    const pos = positions[g.name] ?? null;
    const cal = calibration.get(g.name);
    lines.push(`### ${g.name} (${g.direction} is better; ${magnitudePct(g.max_regression, 1)} per step, ${magnitudePct(total, 1)} total)`, "");
    lines.push(`- Best vs the segment base: ${pos && pos.steps ? `${changeWords(pos.regression)}${rangeWords(pos.lo, pos.hi) ? ` (${rangeWords(pos.lo, pos.hi)})` : ""}, compounded over ${pos.steps} promotion(s)${pos.missing ? `, ${pos.missing} without a measurement` : ""}` : "no promotion yet"}.`);
    lines.push(`- Headroom: ${headroomWords(g.name, pos, total)}.`);
    if (cal) lines.push(`- Calibration: ${cal.text}.`);
    if (chain.length) {
      lines.push("", "| Promotion | Step vs best | CI | Best vs base after |", "|---|---|---|---|");
      for (const c of chain) {
        const m = safeJson<StoredGuardrails>(c.metrics_json);
        const e = storedEstimate(m, g.name);
        const j = m?.guardrailJudgement?.[g.name];
        lines.push(`| c/${c.n} | ${e ? changeWords(e.regression) : "not measured"} | ${e ? rangeWords(e.lo, e.hi) || "—" : "—"} | ${j?.total ? changeWords(j.total.regression) : "—"} |`);
      }
      lines.push("");
    }
    const judged = decided
      .map((c) => ({ c, j: safeJson<StoredGuardrails>(c.metrics_json)?.guardrailJudgement?.[g.name] as GuardrailJudgement | undefined }))
      .filter((x) => x.j && (x.j.state === "broken" || x.j.state === "inconclusive"));
    const rejected = judged.filter((x) => x.j!.state === "broken" && x.c.verdict === "lose" && /^(initial )?primary metric improved/u.test((safeJson<string[]>(x.c.reasons_json) ?? [])[0] ?? ""));
    const flagged = judged.filter((x) => x.j!.state === "inconclusive" && x.c.verdict === "win");
    if (rejected.length) lines.push(`- Wins it rejected: ${rejected.map((x) => `c/${x.c.n} (${mdText(x.j!.text.replace(/^guardrail [^:]+: /u, ""), 220)})`).join("; ")}.`);
    if (flagged.length) lines.push(`- Promotions flagged inconclusive on it: ${flagged.map((x) => `c/${x.c.n}`).join(", ")}.`);
  }
  return lines;
}

/** Harvest: what the whole study and each changeset cost each guardrail, measured by ablation (relative to best). */
function harvestGuardrailLines(ctx: Ctx, study: StudyRow, spec: StudySpec, h: HarvestRow, cs: ChangesetRow[]): string[] {
  const chain = bestGuardrailPositions(ctx.store, study, spec);
  const total = safeJson<Record<string, GuardrailCost>>(h.total_guardrails_json);
  const per = cs.map((c) => ({ c, g: safeJson<Record<string, GuardrailCost>>(c.guardrails_json) }));
  if (!total && !per.some((x) => x.g)) return [];
  const lines = ["### Guardrails at harvest", "", "Measured with the harvest's own pairs: the base against best, and best with each changeset reverted against best. A cost is relative to best; positive means the changes make the guardrail worse."];
  for (const g of spec.guardrail) {
    const t = total?.[g.name];
    const vsBase = t ? invertRegression(-t.value, g.direction) : null;
    // The cost's CI maps to best-vs-base monotonically (decreasing in the base's regression against best).
    const vsBaseCi = t && t.lo !== null && t.hi !== null ? rangeWords(invertRegression(-t.lo, g.direction), invertRegression(-t.hi, g.direction)) : "";
    const pos = chain[g.name];
    const verdicts = pos && pos.steps ? `; the verdicts' compounded estimate was ${changeWords(pos.regression)}${rangeWords(pos.lo, pos.hi) ? ` (${rangeWords(pos.lo, pos.hi)})` : ""}` : "";
    const parts = per.filter((x) => x.g?.[g.name]).map((x) => `#${x.c.k} ${changeWords(x.g![g.name]!.value)}${rangeWords(x.g![g.name]!.lo, x.g![g.name]!.hi) ? ` (${rangeWords(x.g![g.name]!.lo, x.g![g.name]!.hi)})` : ""}`);
    lines.push(
      `- ${g.name}: ${t && vsBase !== null ? `best: ${relativeWords(vsBase, "base")}${vsBaseCi ? ` (${vsBaseCi})` : ""}, measured directly (total limit ${magnitudePct(g.max_total_regression ?? g.max_regression, 1)})${verdicts}` : "base vs best not measured"}${parts.length ? `; per changeset: ${parts.join(", ")}` : ""}.`,
    );
  }
  return lines;
}

function mdCell(s: string, max: number): string {
  return clipWords(s.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim(), max);
}
function mdText(s: string, max: number): string {
  return clipWords(s.replace(/\s+/gu, " ").trim(), max);
}
