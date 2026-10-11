// The improvement convention (src/present.ts): better is positive, in the
// metric's own terms, for both directions, plus the guardrail status and
// metrics table view models (src/views.ts) that sit on top of it.
import { describe, expect, it } from "vitest";
import {
  amountText,
  ciText,
  compound,
  factorOf,
  factorText,
  formatValue,
  improvementOf,
  improvementText,
  magnitudePct,
  rawChange,
  shareOfGain,
  sharePct,
  signedPct,
  vsBaseFromVsBest,
} from "../src/present.ts";
import { parseSpec, type StudySpec } from "../src/spec.ts";
import { guardrailStatus, metricsTable, worstGuardrail } from "../src/views.ts";
import { DETERMINISTIC_SPEC } from "./helpers.ts";

const ops = { name: "ops", unit: "opcodes", direction: "lower" as const };
const latency = { name: "p99", unit: "ms", direction: "lower" as const };
const rps = { name: "throughput", unit: "rps", direction: "higher" as const };

function spec(toml: string): StudySpec {
  const r = parseSpec(toml);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
}

describe("present: the improvement convention", () => {
  it("signed: better is positive, zero has no sign, missing is a dash", () => {
    expect(signedPct(0.7469)).toBe("+74.7%");
    expect(signedPct(-0.031)).toBe("−3.1%");
    expect(signedPct(0)).toBe("0.0%");
    expect(signedPct(-0.00001)).toBe("0.0%");
    expect(signedPct(null)).toBe("—");
    expect(signedPct(Number.NaN)).toBe("—");
    expect(magnitudePct(-0.0096)).toBe("0.96%");
  });

  it("words, lower is better: a positive improvement is a decrease", () => {
    expect(improvementText(0.747, ops)).toBe("74.7% fewer ops (4.0×)");
    expect(improvementText(0.12, latency)).toBe("12.0% lower p99");
    expect(improvementText(-0.031, latency)).toBe("3.1% higher p99 (worse)");
    expect(improvementText(0, latency)).toBe("no measurable change");
    expect(improvementText(null, latency)).toBe("—");
  });

  it("words, higher is better: a positive improvement is an increase", () => {
    expect(improvementText(0.25, rps)).toBe("25.0% higher throughput");
    expect(improvementText(1.5, rps)).toBe("150.0% higher throughput (2.5×)");
    expect(improvementText(-0.1, rps)).toBe("10.0% lower throughput (worse)");
  });

  it("factor: base/best for lower, best/base for higher, only when large", () => {
    expect(factorOf(0.75, "lower")).toBeCloseTo(4);
    expect(factorOf(0.5, "higher")).toBeCloseTo(1.5);
    expect(factorOf(1, "lower")).toBeNull();
    expect(factorText(0.1, "lower")).toBe("");
    expect(factorText(0.9992, "lower")).toBe("1,250×");
  });

  it("compound: reductions multiply remaining fractions, gains multiply factors", () => {
    expect(compound([0.5, 0.5], "lower")).toBeCloseTo(0.75);
    expect(compound([0.1, 0.1], "higher")).toBeCloseTo(0.21);
    expect(compound([], "lower")).toBe(0);
  });

  it("relative-to-best totals convert to relative-to-base in both directions", () => {
    // Lower: base 4, best 1 → t = (4-1)/1 = 3, vs base = 3/4 = 0.75.
    expect(vsBaseFromVsBest(3, "lower")).toBeCloseTo(0.75);
    // Higher: base 100, best 150 → t = (150-100)/150 = 1/3, vs base = 0.5.
    expect(vsBaseFromVsBest(1 / 3, "higher")).toBeCloseTo(0.5);
    expect(vsBaseFromVsBest(null, "lower")).toBeNull();
  });

  it("CI text orders its bounds and keeps the sign convention", () => {
    expect(ciText(0.05, 0.03)).toBe("CI +3.0% to +5.0%");
    expect(ciText(-0.01, 0.02)).toBe("CI −1.0% to +2.0%");
    expect(ciText(null, 0.02)).toBe("");
  });

  it("shares of the gain, raw values and amounts", () => {
    expect(shareOfGain(0.5, 2)).toBeCloseTo(0.25);
    expect(shareOfGain(0.5, 0)).toBeNull();
    expect(shareOfGain(0.5, null)).toBeNull();
    expect(sharePct(0.8133)).toBe("81%");
    expect(sharePct(0.004)).toBe("0.4%");
    expect(formatValue(210802)).toBe("210,802");
    expect(formatValue(1.23456)).toBe("1.235");
    expect(rawChange(210802, 53300, "opcodes")).toBe("210,802 → 53,300 opcodes");
    expect(rawChange(null, 1, "x")).toBe("");
    expect(amountText(1200, ops)).toBe("≈ 1,200 fewer opcodes");
    expect(amountText(12, latency)).toBe("≈ 12 ms less");
    expect(amountText(40, rps)).toBe("≈ 40 rps more");
    expect(improvementOf(200, 150, "lower")).toBeCloseTo(0.25);
    expect(improvementOf(200, 150, "higher")).toBeCloseTo(-0.25);
  });
});

describe("views: guardrail status (the one place the UI decides it)", () => {
  const base = { name: "rss", direction: "lower" as const, limit: 0.05, against: "best" as const };
  it("pass, warn within 20% of the limit, broken, missing", () => {
    expect(guardrailStatus({ ...base, reference: 100, value: 101 })).toMatchObject({ state: "pass", label: "ok" });
    expect(guardrailStatus({ ...base, reference: 100, value: 104.5 })).toMatchObject({ state: "warn", label: "near limit" });
    expect(guardrailStatus({ ...base, reference: 100, value: 106 })).toMatchObject({ state: "broken", label: "BROKEN" });
    expect(guardrailStatus({ ...base, reference: null, value: 106 })).toMatchObject({ state: "missing", label: "not measured", regression: null });
    expect(guardrailStatus({ ...base, reference: 100, value: 95 }).text).toBe("5.0% better than best (limit 5.0% worse)");
  });
  it("higher is better: a decrease is the regression", () => {
    const g = { name: "precision", direction: "higher" as const, limit: 0.05, against: "best" as const };
    expect(guardrailStatus({ ...g, reference: 10, value: 9 })).toMatchObject({ state: "broken" });
    expect(guardrailStatus({ ...g, reference: 10, value: 11 })).toMatchObject({ state: "pass", improvement: expect.closeTo(0.1, 5) });
  });
  it("the verdict's recorded regression wins over the two medians", () => {
    expect(guardrailStatus({ ...base, reference: 100, value: 100, regression: 0.049 })).toMatchObject({ state: "warn" });
  });
  it("against the segment base: judged on the total limit with its CI", () => {
    const s = guardrailStatus({ ...base, against: "base", totalLimit: 0.1, reference: 100, value: 102, ci: { lo: 0.01, hi: 0.03 } });
    expect(s.text).toBe("2.0% worse than the segment base (CI 1.0% to 3.0% worse; total limit 10.0% worse) · 5.0% per step");
    expect(s.ci).toEqual({ lo: 0.01, hi: 0.03 });
    expect(s.cumulative).toMatchObject({ regression: 0.02, limit: 0.1, state: "ok", headroom: expect.closeTo(0.08, 9) });
    expect(s).toMatchObject({ state: "pass", used: expect.closeTo(0.2, 9) });
  });
  it("worst state first", () => {
    expect(worstGuardrail([])).toBeNull();
    const ok = guardrailStatus({ ...base, reference: 100, value: 100 });
    const warn = guardrailStatus({ ...base, reference: 100, value: 104.5 });
    expect(worstGuardrail([ok, warn])).toBe("warn");
  });
});

describe("views: metrics table", () => {
  const noGuardrail = spec(DETERMINISTIC_SPEC.replace('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\n', ""));
  const withGuardrail = spec(DETERMINISTIC_SPEC);
  const higher = spec(DETERMINISTIC_SPEC.replace('direction = "lower"', 'direction = "higher"').replace('name = "rss"\nmax_regression = "5%"', 'name = "rss"\nmax_regression = "5%"\ndirection = "higher"'));
  it("no measurement, no rows", () => {
    expect(metricsTable(withGuardrail, null)).toEqual([]);
  });
  it("only the primary metric (no secondary metrics)", () => {
    const rows = metricsTable(noGuardrail, JSON.stringify({ best: { size: 1000 }, candidate: { size: 800 } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "primary", improvement: expect.closeTo(0.2, 5), text: "20.00% lower size", unit: "bytes" });
  });
  it("informational metrics carry a raw change and no direction", () => {
    const rows = metricsTable(noGuardrail, JSON.stringify({ best: { size: 1000, wall_ms: 10 }, candidate: { size: 800, wall_ms: 12 } }));
    expect(rows[1]).toMatchObject({ name: "wall_ms", kind: "info", direction: null, improvement: null, change: expect.closeTo(0.2, 5) });
    expect(rows[1]!.text).toContain("informational");
  });
  it("guardrail warn and broken, lower is better", () => {
    const warn = metricsTable(withGuardrail, JSON.stringify({ best: { size: 1000, rss: 100 }, candidate: { size: 800, rss: 104.5 }, guardrails: { rss: 0.045 } }));
    expect(warn[1]!.guardrail).toMatchObject({ state: "warn" });
    const broken = metricsTable(withGuardrail, JSON.stringify({ best: { size: 1000, rss: 100 }, candidate: { size: 800, rss: 110 }, guardrails: { rss: 0.1 } }));
    expect(broken[1]!.guardrail).toMatchObject({ state: "broken", label: "BROKEN" });
  });
  it("higher is better for both the primary metric and the guardrail", () => {
    const rows = metricsTable(higher, JSON.stringify({ best: { size: 1000, rss: 100 }, candidate: { size: 1200, rss: 95.8 } }));
    expect(rows[0]).toMatchObject({ improvement: expect.closeTo(0.2, 5), text: "20.00% higher size" });
    expect(rows[1]!.guardrail).toMatchObject({ state: "warn", regression: expect.closeTo(0.042, 5) });
  });
});
