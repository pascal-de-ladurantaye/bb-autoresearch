// v0.2.4 wording and view models (pure): Up next counts what really runs
// (B2), only actionable notices are "for you" (B3), "no change" instead of
// "0.0% better" (B5), unmeasured verdicts on the trajectory (B6), verdict
// reasons in the page's CI format (B7), the headline across segments (A7),
// the Tests stage while waiting for the bench (B1).
import { describe, expect, it } from "vitest";
import type { IdeaRow, StudyRow } from "../src/db/store.ts";
import { gatingText, stageText } from "../src/live-model.ts";
import { bestHeadlineText, measuredCiText, reasonText, segmentRawText } from "../src/present.ts";
import { isActionableNotice, strategistDigest } from "../src/prompts.ts";
import { themeWait, upNext } from "../src/scheduler.ts";
import { parseSpec } from "../src/spec.ts";
import { decideVerdict } from "../src/verdict.ts";
import { guardrailStatus } from "../src/views.ts";

const idea = (id: number, theme: string, over: Partial<IdeaRow> = {}): IdeaRow => ({ id, theme, title: `idea ${id}`, status: "queued", pinned: 0, priority: 0, source: "strategist", variation_of: null, ...over }) as IdeaRow;

function spec() {
  const r = parseSpec(`
[study]
slug = "ui"
objective = "Wording checks for the page."
[metric]
name = "time"
unit = "s"
direction = "lower"
[scope]
editable = ["src/**"]
[oracle]
measure = "m"
gate = ["g"]
noise = "noisy"
`);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
}

describe("Up next (B2)", () => {
  it("an idea queued ahead on the same theme is not counted as running", () => {
    // W = 2: one per theme at a time. Nothing runs; #1 goes first, #2 waits behind it.
    const order = upNext([idea(1, "algorithms"), idea(2, "algorithms")], [], 2);
    expect(order.map((o) => [o.idea.id, o.blocked])).toEqual([
      [1, null],
      [2, "waits: #1 first on algorithms (1 at a time)"],
    ]);
    // One really running: that's what it says.
    const running = upNext([idea(2, "algorithms")], [idea(9, "algorithms", { status: "running" })], 2);
    expect(running[0]!.blocked).toBe("waits: 1 running on algorithms");
    expect(themeWait("algo", [{ theme: "algo" }], [{ id: 4, theme: "algo" }], 4)).toBe("waits: 1 running and #4 first on algo");
  });
});

describe("notices for the human (B3)", () => {
  it("four new bests are updates, not four notices for you", () => {
    const s = parseSpec(`
[study]
slug = "ui"
objective = "Wording checks for the page."
[metric]
name = "time"
direction = "lower"
[scope]
editable = ["src/**"]
[oracle]
measure = "m"
gate = ["g"]
noise = "noisy"
`);
    if (!s.ok) throw new Error("spec");
    const notices = [1, 2, 3, 4].map((i) => ({ at: i, kind: "best.new", text: `New best: c/${i}.` }));
    const d = strategistDigest({ study: { slug: "ui", state: "running" } as StudyRow, spec: s.spec, trigger: "verdicts", round: 3, w: 2, verdicts: [], findings: [], ideas: [], workers: [], dossier: null, bestDiag: [], cumulative: 0.5, budgetLine: "", ideaTitles: new Map(), notices });
    expect(d.summary).not.toMatch(/for you/u);
    expect(d.detail).toMatch(/## Updates \(4, informational\)/u);
    expect(d.detail).not.toMatch(/## Notices for the human/u);
    const mixed = strategistDigest({ study: { slug: "ui", state: "running" } as StudyRow, spec: s.spec, trigger: "verdicts", round: 3, w: 2, verdicts: [], findings: [], ideas: [], workers: [], dossier: null, bestDiag: [], cumulative: 0.5, budgetLine: "", ideaTitles: new Map(), notices: [...notices, { at: 5, kind: "harvest.ready", text: "Harvest h1 is ready." }] });
    expect(mixed.summary).toMatch(/· 1 notice for you on the Studies page/u);
    for (const k of ["best.new", "budget.threshold", "stall", "segment.recalibrated", "control.pause"]) expect(isActionableNotice(k)).toBe(false);
    for (const k of ["drift", "budget.exhausted", "harvest.ready", "calibration.failed", "spec.proposed", "oracle.broken"]) expect(isActionableNotice(k)).toBe(true);
  });
});

describe("guardrail wording (B5)", () => {
  it("a tiny change reads 'no change', like the Live rows", () => {
    const g = guardrailStatus({ name: "rss", direction: "lower", limit: 0.1, totalLimit: 0.15, reference: 100, value: 99.997, regression: -0.00003, ci: null, against: "base" });
    expect(g.text).toMatch(/^no change from the segment base/u);
    expect(g.text).not.toMatch(/0\.0% better/u);
    const small = guardrailStatus({ name: "rss", direction: "lower", limit: 0.1, totalLimit: 0.15, reference: 100, value: 99.9, regression: -0.0004, ci: null, against: "base" });
    expect(small.text).toMatch(/^no change from the segment base/u);
    const real = guardrailStatus({ name: "rss", direction: "lower", limit: 0.1, totalLimit: 0.15, reference: 100, value: 103, regression: 0.03, ci: null, against: "base" });
    expect(real.text).toMatch(/^3\.0% worse than the segment base/u);
  });
});

describe("verdict reasons (B7)", () => {
  it("say 'CI +13.6% to +22.0%, 6 pairs', and older raw reasons are rewritten for display", () => {
    const v = decideVerdict({ decision: "win", effect: 0.178, ciLo: 0.1358, ciHi: 0.2199, n: 6, guardrails: {}, bestMetrics: {}, candidateMetrics: {}, bestDiag: [], candidateDiag: [], bestRun: null }, spec(), { mde: 0.02 });
    expect(v.reasons[0]).toBe("primary metric improved 17.8% (CI +13.6% to +22.0%, 6 pairs)");
    expect(reasonText("primary metric improved 17.80% (CI 13.58%..21.99%, n=6)")).toBe("primary metric improved 17.8% (CI +13.6% to +22.0%, 6 pairs)");
    expect(reasonText("initial primary metric improved 2.00% (n=6)")).toBe("initial primary metric improved 2.0% (6 pairs)");
    expect(reasonText("effect 1.45% (CI -3.14%..6.15%, n=20) did not clear the minimum detectable effect")).toBe("effect +1.4% (CI −3.1% to +6.2%, 20 pairs) did not clear the minimum detectable effect");
    expect(measuredCiText(0.1, 0.1, 1, "deterministic")).toBe("single run");
    // Futility and early losses say why they stopped.
    const f = decideVerdict({ decision: "inconclusive", stop: "futility", effect: 0.004, ciLo: -0.01, ciHi: 0.015, n: 8, guardrails: {}, bestMetrics: {}, candidateMetrics: {}, bestDiag: [], candidateDiag: [], bestRun: null }, spec(), { mde: 0.02 });
    expect(f.reasons[0]).toBe("effect +0.4% (CI −1.0% to +1.5%, 8 pairs) can no longer clear the 2.0% win threshold: stopped early (futility: the CI's high end is below it)");
    const e = decideVerdict({ decision: "lose", stop: "early", effect: -0.1, ciLo: -0.14, ciHi: -0.06, n: 3, guardrails: {}, bestMetrics: {}, candidateMetrics: {}, bestDiag: [], candidateDiag: [], bestRun: null }, spec(), { mde: 0.02 });
    expect(e.reasons[0]).toBe("primary metric regressed 10.0% (CI −14.0% to −6.0% at 99%, 3 pairs): stopped early, the whole CI is below 0 before pair 6");
  });
});

describe("best vs base across segments (A7)", () => {
  it("names the segments the headline spans and labels the raw values as this segment's", () => {
    const m = { name: "time", unit: "s", direction: "lower" as const };
    expect(bestHeadlineText(0.818, m, 3)).toBe("81.8% lower time (5.5×) across 3 segments");
    expect(bestHeadlineText(0.818, m, 1)).toBe("81.8% lower time (5.5×)");
    expect(segmentRawText(3.619, 2.039, "s", 3)).toBe("this segment 3.619 → 2.039 s");
    expect(segmentRawText(3.619, 2.039, "s", 1)).toBe("3.619 → 2.039 s");
  });
});

describe("the Tests stage in single-machine mode (B1)", () => {
  it("waiting for the bench lock reads differently from tests running", () => {
    expect(gatingText([2], 2)).toBe("waiting for the bench to run tests");
    expect(gatingText([2], 3)).toBe("tests running");
    expect(stageText("gating", undefined, 3)).toBe("tests running");
    expect(stageText("queued", [3], 3)).toBe("queued");
  });
});
