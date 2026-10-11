import { describe, expect, it } from "vitest";
import { bestBranch, candidateRef, oracleHash, parseSpec, segmentRef } from "../src/spec.ts";
import { DETERMINISTIC_SPEC } from "./helpers.ts";

const DESIGN_EXAMPLE = `
[study]
slug = "routing-p99"
objective = "Reduce p99 latency of the routing filter under the replay workload."
base = "main"

[metric]
name = "p99_us"
unit = "us"
direction = "lower"

[[guardrail]]
name = "rss_mb"
max_regression = "5%"

[[guardrail]]
name = "throughput_rps"
max_regression = "2%"
direction = "higher"

[scope]
editable = ["source/filters/routing/**", "source/common/matcher/**"]
protected = ["bench/**", "test/**"]

[oracle]
build = "bazel build //source/exe:envoy-static -c opt"
gate = ["bazel test //test/filters/routing/... -c opt"]
measure = "bench/replay.sh --workload=prod-sample"
noise = "noisy"
bench_hosts = ["local"]

[oracle.holdout]
measure = "/srv/holdout/replay.sh --workload=holdout-a"

[budget]
max_workers = 4
max_candidates = 200
max_bench_hours = 24
deadline = "2026-10-16"

[agents]
strategist = { provider = "claude-code" }
worker = { provider = "codex" }
max_submissions_per_worker = 3
`;

describe("parseSpec", () => {
  it("accepts the design's example (with a local bench host) and fills defaults", () => {
    const r = parseSpec(DESIGN_EXAMPLE);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.spec.study.slug).toBe("routing-p99");
    expect(r.spec.guardrail).toEqual([
      { name: "rss_mb", max_regression: 0.05, max_total_regression: 0.05, direction: "lower" },
      { name: "throughput_rps", max_regression: 0.02, max_total_regression: 0.02, direction: "higher" },
    ]);
    expect(r.spec.oracle.gate).toEqual(["bazel test //test/filters/routing/... -c opt"]);
    expect(r.spec.oracle.protocol).toMatchObject({ n_min: 6, n_max: 20, confidence: 0.95, min_effect: 0.01, confirm: true });
    expect(r.spec.agents).toMatchObject({ max_submissions_per_worker: 3, strategist_every: 5, stall_after: 10 });
    expect(r.spec.agents.worker.provider).toBe("codex");
    expect(r.spec.oracle.holdout).toMatchObject({ runs: 3, max_regression: 0.01 });
    expect(r.spec.oracle.drift).toEqual({ every: 10, pairs: 6, max_ratio: 2, recalibrate_below: 0.6 });
    expect(r.spec.oracle.health).toMatchObject({ enabled: true, max_load: 0.8, retry_seconds: 60 });
    expect(r.warnings.some((w) => w.includes("W=1"))).toBe(false);
  });

  it("accepts a single gate string and percentage tolerances", () => {
    const r = parseSpec(`${DETERMINISTIC_SPEC.replace('gate = ["gate.sh"]', 'gate = "gate.sh"')}\n[oracle.protocol]\ntolerance = "0.5%"\n`);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.spec.oracle.gate).toEqual(["gate.sh"]);
    expect(r.spec.oracle.protocol.tolerance).toBeCloseTo(0.005);
    expect(r.spec.budget.max_candidates).toBe(3);
  });

  it("rejects invalid TOML with a one-line error", () => {
    const r = parseSpec("[study\nslug=");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^TOML: /u);
  });

  it("reports field paths for schema errors", () => {
    const r = parseSpec(DETERMINISTIC_SPEC.replace('slug = "toy-size"', 'slug = "Bad Slug"').replace('direction = "lower"', 'direction = "down"'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("study.slug");
      expect(r.errors.join("\n")).toContain("metric.direction");
    }
  });

  it("rejects unknown keys, n_min > n_max, bad percentages, and duplicate bench hosts", () => {
    expect(parseSpec(DETERMINISTIC_SPEC.replace("[budget]", "[budget]\nmax_tokens = 5")).ok).toBe(false);
    const p = parseSpec(DETERMINISTIC_SPEC.replace('noise = "deterministic"', 'noise = "noisy"\n[oracle.protocol]\nn_min = 30\nn_max = 10'));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.errors.join()).toContain("n_min must be <= n_max");
    expect(parseSpec(DETERMINISTIC_SPEC.replace('max_regression = "5%"', 'max_regression = "five"')).ok).toBe(false);
    // Remote bench host names parse here and are resolved against BB hosts by the engine.
    expect(parseSpec(DETERMINISTIC_SPEC.replace('noise = "deterministic"', 'noise = "deterministic"\nbench_hosts = ["bench-x86-01"]')).ok).toBe(true);
    const dup = parseSpec(DETERMINISTIC_SPEC.replace('noise = "deterministic"', 'noise = "deterministic"\nbench_hosts = ["a", "A"]'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join()).toContain("listed twice");
  });

  it("rejects globs that escape the repo and paths both editable and protected", () => {
    expect(parseSpec(DETERMINISTIC_SPEC.replace('editable = ["src/**"]', 'editable = ["../x/**"]')).ok).toBe(false);
    expect(parseSpec(DETERMINISTIC_SPEC.replace('protected = ["bench/**"]', 'protected = ["src/**"]')).ok).toBe(false);
  });

  it("requires idle_abandon > idle_nudge", () => {
    expect(parseSpec(DETERMINISTIC_SPEC.replace("idle_abandon_minutes = 20", "idle_abandon_minutes = 5")).ok).toBe(false);
  });
});

describe("oracle hash and refs", () => {
  it("is stable across non-oracle changes and changes with the oracle", () => {
    const a = parseSpec(DETERMINISTIC_SPEC);
    const b = parseSpec(DETERMINISTIC_SPEC.replace("max_candidates = 3", "max_candidates = 9"));
    const c = parseSpec(DETERMINISTIC_SPEC.replace('measure = "measure.sh"', 'measure = "measure2.sh"'));
    if (!a.ok || !b.ok || !c.ok) throw new Error("parse");
    expect(oracleHash(a.spec)).toBe(oracleHash(b.spec));
    expect(oracleHash(a.spec)).not.toBe(oracleHash(c.spec));
    expect(oracleHash(a.spec, "p1")).not.toBe(oracleHash(a.spec, "p2"));
    // Bench operations (health, drift schedule) are not part of how a commit is judged.
    const tuned = parseSpec(`${DETERMINISTIC_SPEC}\n[oracle.health]\nmax_load = 3\n[oracle.drift]\nevery = 50\n`);
    if (!tuned.ok) throw new Error(tuned.errors.join());
    expect(oracleHash(tuned.spec)).toBe(oracleHash(a.spec));
  });
  it("names refs per the git model", () => {
    expect(bestBranch("x")).toBe("studies/x/best");
    expect(candidateRef("x", 3)).toBe("refs/studies/x/c/3");
    expect(segmentRef("x", 1)).toBe("refs/studies/x/segment/1");
  });
});

describe("skill example", () => {
  it("the study-create skill's example spec is valid", async () => {
    const { readFileSync } = await import("node:fs");
    const skill = readFileSync(new URL("../skills/study-create/SKILL.md", import.meta.url), "utf8");
    const toml = /```toml\n([\s\S]*?)```/u.exec(skill)![1]!;
    const r = parseSpec(toml);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.spec.study.slug).toBe("parser-speed");
  });
});
