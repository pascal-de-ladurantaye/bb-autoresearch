import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateRow, FindingRow, IdeaRow, StudyRow } from "../src/db/store.ts";
import { feedItems } from "../src/live-feed.ts";
import { bestCalculationText, GLOSSARY, verdictOutcomeText } from "../src/present.ts";
import { strategistDigest, verdictMessage, workerBrief, type DigestInput } from "../src/prompts.ts";
import { parseSpec, specIssueText, type StudySpec } from "../src/spec.ts";
import { DETERMINISTIC_SPEC } from "./helpers.ts";

const parsed = parseSpec(DETERMINISTIC_SPEC);
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const spec: StudySpec = parsed.spec;
const candidate = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  n: 7, verdict: "inconclusive", effect: 0.004, ci_lo: 0.003, ci_hi: 0.005,
  reasons_json: JSON.stringify(["effect +0.4% did not clear the 2.0% win threshold"]),
  metrics_json: null, diag_json: null, gate_output: null, ...over,
}) as CandidateRow;

const digest = (over: Partial<DigestInput> = {}): DigestInput => ({
  study: { slug: "toy-size", state: "running" } as StudyRow, spec,
  trigger: "verdicts", round: 3, w: 2, verdicts: [], findings: [], ideas: [], workers: [],
  dossier: null, bestDiag: [], cumulative: 0.12, budgetLine: "3/50 candidates",
  ideaTitles: new Map(), notices: [], ...over,
});

describe("text design: evidence and feedback", () => {
  it("does not equate inconclusive with noise, even when the whole CI is positive", () => {
    const m = verdictMessage(candidate(), { submissionsLeft: 1, spec });
    expect(m.summary.split("\n")).toHaveLength(2);
    expect(m.summary).toContain("Inconclusive: not promoted.");
    expect(m.summary).toContain("Estimate: 0.4% lower size vs previous best (CI +0.3% to +0.5%).");
    expect(m.summary).not.toMatch(/within the noise|no effect/u);
    expect(m.detail).toContain("2.0% win threshold");
    const feed = feedItems([{ id: 1, at: 1, kind: "candidate.verdict", data: { n: 7, verdict: "inconclusive", effect: 0.004 } }], {
      metric: spec.metric, ideas: new Map(), candidateN: new Map(), hostName: (id) => id,
    });
    expect(feed[0]!.text).toContain("inconclusive: not promoted. Estimate:");
    expect(feed[0]!.text).not.toContain("within the noise");
    expect(GLOSSARY.ci).toContain("not enough by itself to win");
  });

  it("puts the deciding guardrail, missing measurement, holdout or confirmation first", () => {
    expect(verdictOutcomeText("lose", ["primary metric improved 12.0%", "guardrail rss: not measured"])).toBe("Lose: guardrail rss (not measured). Not promoted.");
    expect(verdictOutcomeText("lose", ["primary metric improved 12.0%", "failed the holdout check"])).toBe("Lose: holdout check failed. Not promoted.");
    expect(verdictOutcomeText("inconclusive", ["failed confirmation: effect below threshold"])).toBe("Inconclusive: not promoted.");
    expect(verdictOutcomeText("lose", ["failed confirmation: primary metric regressed 3.0%"])).toContain("confirmation failed");
    for (const verdict of ["gate_failed", "rejected", "conflict"] as const) {
      const m = verdictMessage(candidate({ verdict, effect: null, ci_lo: null, ci_hi: null, reasons_json: JSON.stringify(["check failed"]) }), { submissionsLeft: 0, spec });
      expect(m.summary).not.toContain("Estimate:");
      expect(m.detail).toContain("No submissions left");
    }
  });

  it("keeps known units and marks unspecified units without guessing from a metric name", () => {
    const m = verdictMessage(candidate({ metrics_json: JSON.stringify({ best: { size: 1000, rss: 100 }, candidate: { size: 900, rss: 101 } }) }), { submissionsLeft: 1, spec });
    expect(m.detail).toContain("size: best 1,000 bytes → candidate 900 bytes");
    expect(m.detail).toContain("rss (unit not specified): best 100 → candidate 101");
    expect(m.detail).toContain("Metrics (side medians):");
    expect(m.detail).toContain("Effect statistic: single run of each side");
    expect(bestCalculationText("lower", 3)).toContain("1 − product(1 − each improvement)");
    expect(bestCalculationText("higher", 1)).toContain("product(1 + each improvement) − 1");
    expect(bestCalculationText("lower", 3)).toContain("current segment, not the whole study");
  });

  it("reserves mandatory strategist instructions when the evidence exceeds the message budget", () => {
    const d = strategistDigest(digest({
      findings: Array.from({ length: 12 }, (_, id) => ({ id, learned: "evidence ".repeat(80), revisit_if: "condition ".repeat(30), outcome: "no_effect" }) as FindingRow),
      ideas: Array.from({ length: 40 }, (_, id) => ({ id, status: "running", title: "idea ".repeat(40) }) as IdeaRow),
      notices: Array.from({ length: 10 }, (_, at) => ({ at, kind: "oracle.broken", text: "failure ".repeat(100) })),
      dossier: { version: 1, text: "notes ".repeat(1000) },
      code: { base: "main", baseSha: "a".repeat(40), best: "studies/toy-size/best", bestSha: "b".repeat(40), promotions: 3, repoPath: "/repo" },
    }));
    expect(d.detail.length).toBeLessThanOrEqual(12_000);
    expect(d.detail.startsWith("## This round")).toBe(true);
    for (const text of ["Keep at least 4 ready ideas", "You do not edit code", "Changed:", "Queued:", "Needs you:", "Then end your turn", "git show studies/toy-size/best:<path>", "Digest shortened"]) expect(d.detail).toContain(text);
    expect(d.summary).not.toContain("evidence evidence");
  });

  it("keeps the worker's role boundaries and separates hypotheses from evidence", () => {
    const brief = workerBrief({ study: { slug: "toy-size" } as StudyRow, spec, idea: { id: 1, title: "Shrink it", rationale: "May save work" } as IdeaRow, dossier: null, bestDiag: [], relatedFindings: [{ learned: "Likely fewer allocations", outcome: "improved" } as FindingRow], mde: 0.01 });
    for (const text of ["## Must not", "Never run the official benchmark", "proposal, not measured evidence", "Treat explanations as hypotheses", "END YOUR TURN", "study_record_finding", "study_finish"]) expect(brief).toContain(text);
  });
});

describe("text design: spec repair and conditional skill references", () => {
  it("names unknown keys and the section to repair; all semantic repairs remain explicit", () => {
    const bad = parseSpec(DETERMINISTIC_SPEC.replace("[budget]", "[budget]\nworkers = 4"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join("\n")).toContain('budget: unknown key "workers". Remove or correct');
    const crossed = parseSpec(DETERMINISTIC_SPEC + "\n[oracle.protocol]\nn_min = 30\nn_max = 10\n");
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.errors[0]).toContain("Set n_min to 10 or less, or raise n_max to at least 30");
    const text = specIssueText(Array.from({ length: 25 }, (_, i) => `field${i}: ${"x".repeat(700)}`));
    expect(text.length).toBeLessThan(3500);
    expect(text).toContain("19 further entries omitted");
    expect(text).toContain("resubmit");
  });

  it("every conditional reference exists and the primary skill retains authorization boundaries", () => {
    for (const name of ["autoresearch", "study-create", "study-harvest"]) {
      const file = resolve(`skills/${name}/SKILL.md`);
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`name: ${name}`);
      for (const match of text.matchAll(/\]\((references\/[^)]+)\)/gu)) expect(existsSync(resolve(dirname(file), match[1]!))).toBe(true);
      expect(text).toMatch(/human/u);
    }
    const create = readFileSync("skills/study-create/SKILL.md", "utf8");
    const sample = create.match(/```toml\n([\s\S]*?)\n```/u)![1]!;
    const result = parseSpec(sample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.oracle.remote_bench).toEqual([]);
      expect(result.spec.oracle.holdout).toBeUndefined();
    }
    expect(create).toContain("Never approve, calibrate, start, or pause yourself");
    const harvest = readFileSync("skills/study-harvest/SKILL.md", "utf8");
    expect(harvest.indexOf("Inspect first")).toBeLessThan(harvest.indexOf("Already frozen"));
    expect(harvest).toContain("Never push, open a PR, or post anywhere until the human says so");
    expect(harvest).toContain("Never edit `studies/<slug>/*`");
  });
});
