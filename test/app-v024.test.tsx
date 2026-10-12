// @vitest-environment jsdom
// v0.2.4 fixes, rendered: the Tests card and the lane while a candidate waits
// for the bench to run its tests (B1), the confirmation's placeholder while
// its first pair runs (B4), unmeasured verdicts on the trajectory (B6),
// guardrail sentences that wrap and a region legend when "continue" can't be
// labelled (B10), the header's "no win yet" aligned (B10), the futility stop
// on the band (A1), and best vs base across segments in the Live header (A7).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { NoisyBand } from "../src/band.ts";
import type { LiveView } from "../src/live-model.ts";
import { noisyPlaceholder, runWords } from "../src/app/live/CiBand.tsx";
import { TrajectoryChart } from "../src/app/TrajectoryChart.tsx";
import { FakeHost, FakePort, fakeHostSpec } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

configure({ asyncUtilTimeout: 8000 });

const METHODS = ["studies.list", "studies.attention", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.oracle", "study.bench", "study.live", "study.replay", "thread.study", "thread.badge", "study.notices.seen"];
const T = 1_800_000_000_000;

function points(n: number, m: number, half: (k: number) => number) {
  return Array.from({ length: n }, (_, i) => ({ n: i + 1, at: T - 40_000 + i * 2000, m, lo: i ? m - half(i + 1) : null, hi: i ? m + half(i + 1) : null }));
}

function noisyBand(over: Partial<NoisyBand> = {}): NoisyBand {
  return { kind: "noisy", candidate: 12, n: 2, startedAt: T - 38_000, guardrails: [], final: null, nMin: 6, nMax: 20, mde: 0.02, confidence: 0.95, bootstrap: 2000, exact: true, runs: [{ run: "measure", points: points(9, 0.05, (k) => 0.12 / Math.sqrt(k)), gr: {} }], futility: true, earlyLoseFrom: 3, earlyLoseConfidence: 0.99, ...over };
}

function fixture(over: Partial<LiveView> = {}): LiveView {
  return {
    studyId: "s1",
    slug: "toy-size",
    state: "running",
    statusLine: "Running: 2 workers: 1 waiting for the bench, 1 being measured; measuring c/2, 1 in tests.",
    metric: { name: "time", unit: "s", direction: "lower" },
    noise: "noisy",
    now: T,
    lastEventId: 100,
    studyThreadId: "thr_study",
    best: { text: null, n: null, at: null, value: null, movedAt: null, history: [], rebases: [] },
    counts: { candidates: 3, maxCandidates: 8, workers: 2, finishing: 0, targetWorkers: 2, queue: 0 },
    workers: [
      { key: 1, threadId: "thr_w1", ideaId: 3, ideaTitle: "Memoize fib", theme: "algo", phase: "waiting", phaseAt: T - 79_000, spawnedAt: T - 300_000, submissions: 1, maxSubmissions: 2, candidate: 3, candidateStage: "gating", queuePosition: null, action: null },
      { key: 2, threadId: "thr_w2", ideaId: 4, ideaTitle: "Inline", theme: "data", phase: "measuring", phaseAt: T - 5_000, spawnedAt: T - 90_000, submissions: 1, maxSubmissions: 2, candidate: 2, candidateStage: "confirming", queuePosition: null, action: null },
    ],
    cards: [
      { n: 2, ideaId: 4, ideaTitle: "Inline", workerKey: 2, stage: "confirming", column: "bench", stageAt: T - 2_000, verdict: null, effect: null, effectText: null, cause: null, hostId: "host_test", pairs: { run: "confirm", done: 0, of: 20 }, rebases: 0, submittedAt: T - 80_000, decidedAt: null },
      { n: 3, ideaId: 3, ideaTitle: "Memoize fib", workerKey: 1, stage: "gating", column: "gates", stageAt: T - 79_000, verdict: null, effect: null, effectText: null, cause: null, hostId: null, pairs: null, rebases: 0, submittedAt: T - 80_000, decidedAt: null },
    ],
    queue: [3],
    queueTests: [3],
    singleMachine: { text: "Single-machine mode is on.", quietBench: false },
    bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: true, deferredUntil: null, current: { kind: "measure", n: 2, stage: "confirming", pairs: { run: "confirm", done: 0, of: 20 }, startedAt: T - 42_000 }, utilization: 0.7, windowSeconds: 600 }],
    ideas: { next: [], total: 0 },
    feed: [],
    // The measurement won after 9 pairs; the confirmation's first pair is running.
    bands: [noisyBand({ runs: [{ run: "measure", points: points(9, 0.08, (k) => 0.05 / Math.sqrt(k)), gr: {} }] })],
    ...over,
  };
}

describe("frontend: v0.2.4 fixes", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  const pages: Array<ReturnType<typeof renderSlot>> = [];

  beforeEach(async () => {
    host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch", "study-harvest"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 } })(fake.bb);
    harness = fake.harness;
    await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec() }, { threadId: "thr_study", projectId: "proj_1" });
  });
  afterEach(async () => {
    for (const p of pages.splice(0)) p.lifecycle.unmount();
    await harness.lifecycle.dispose();
  });

  function rpc(over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    return { ...Object.fromEntries(METHODS.map((m) => [m, (input: unknown) => harness.behavior.callRpc(m, input ?? null)])), ...over } as never;
  }
  async function page(subPath: string, over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const p = renderSlot(app.navPanels[0]!, { subPath }, { rpc: rpc(over) });
    pages.push(p);
    return p;
  }

  it("B1: a candidate waiting for the bench lock to run its tests says so on its card, its lane and in the queue", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture() });
    const pipeline = await p.findByRole("region", { name: "Candidates in the pipeline" });
    const tests = within(pipeline).getByRole("listitem", { name: "Tests: 1" });
    expect(tests.textContent).toMatch(/c\/3.*waiting for the bench to run tests · 1:19/u);
    expect(tests.textContent).not.toMatch(/tests running/u);
    const lane = within(p.getByRole("region", { name: "Workers" })).getByRole("button", { name: /Worker on idea #3/u });
    expect(lane.textContent).toMatch(/waiting for the bench.*c\/3 waiting for the bench to run tests/u);
    expect(p.getByRole("region", { name: "Bench" }).textContent).toMatch(/c\/3 tests/u);
    // Once its gates hold the bench, it is "tests running" everywhere.
    pages.splice(0).forEach((x) => x.lifecycle.unmount());
    const running = fixture({ queue: [], queueTests: [], bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: true, deferredUntil: null, current: { kind: "gate", n: 3, startedAt: T - 3000 }, utilization: 0.7, windowSeconds: 600 }] });
    const q = await page("toy-size/live", { "study.live": async () => running });
    const card = within(await q.findByRole("region", { name: "Candidates in the pipeline" })).getByRole("listitem", { name: "Tests: 1" });
    expect(card.textContent).toMatch(/tests running/u);
  });

  it("B4: the confirmation keeps a placeholder while its first pair runs", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture() });
    const m = await p.findByRole("article", { name: "CI band of c/2" });
    const placeholders = [...m.querySelectorAll("[data-band-placeholder]")].map((x) => x.textContent);
    expect(placeholders).toEqual([noisyPlaceholder({ nMax: 20 }, "confirm")]);
    expect(m.querySelector("svg")).toBeTruthy(); // the measurement's band is still drawn
  });

  it("A1: a futility stop is marked on the band and said in words", () => {
    const b = noisyBand({ runs: [{ run: "measure", points: points(8, 0.002, (k) => 0.04 / Math.sqrt(k)), gr: {} }] });
    // hi at pair 8 = 0.002 + 0.0141 < 0.02: futility (and not before n_min).
    const words = runWords(b, b.runs[0]!);
    expect(words).toMatch(/^Decided after 6 of 20 pairs: inconclusive\./u);
    expect(words).toMatch(/high end is below the \+2\.0% threshold, so more pairs can't make it a win/u);
  });

  it("A1: a futility stop renders its tag on the decision marker", async () => {
    const b = noisyBand({ runs: [{ run: "measure", points: points(6, 0.002, (k) => 0.03 / Math.sqrt(k)), gr: {} }], final: { at: T, guardrails: [] } });
    const p = await page("toy-size/live", { "study.live": async () => fixture({ bands: [b], cards: [] }) });
    const m = await p.findByRole("article", { name: "CI band of c/2" });
    expect(m.querySelector("[data-decision]")?.textContent).toBe("6 of 20 · can't win");
    expect(m.textContent).toMatch(/futility: it can no longer win/u);
  });

  it("B10: guardrail sentences wrap; a region legend replaces a label that can't fit; 'no win yet' lines up", async () => {
    const g = { name: "mem_kb", state: "ok" as const, step: { regression: 0.003, lo: 0.001, hi: 0.005, limit: 0.1, state: "ok" as const }, total: { regression: 0.021, lo: 0.01, hi: 0.03, limit: 0.15, state: "ok" as const }, final: true };
    // A big effect: the +2.0% threshold sits next to 0 on this scale, so "continue" has no room.
    const big = noisyBand({ runs: [{ run: "measure", points: points(9, 0.8, () => 0.02), gr: {} }], final: { at: T, guardrails: [g] } });
    const p = await page("toy-size/live", { "study.live": async () => fixture({ bands: [big, { ...big, n: 3, candidate: 13 }], cards: [] }) });
    const m = await p.findByRole("article", { name: "CI band of c/2" });
    const text = m.querySelector("[data-guardrail-text]")!;
    expect(text.className).not.toMatch(/\btruncate\b/u);
    expect(text.textContent).toMatch(/within the 10\.0% limit · in total 2\.1% worse than the segment base \(CI 1\.0% to 3\.0% worse\), within the 15\.0% total limit$/u);
    expect(m.querySelector('[data-region-labels] [data-label="continue"]')).toBeNull();
    expect(m.querySelector("[data-region-legend]")?.textContent).toBe("Regions: lose below 0 · continue from 0 to +2.0% · win above +2.0%");
    const best = p.container.querySelector("[data-best-value]")!;
    expect(best.textContent).toBe("no win yet");
    expect(best.className).toMatch(/-mx-1/u);
  });

  it("A7: the Live header says how many segments the headline spans, with this segment's raw values", async () => {
    const p = await page("toy-size/live", {
      "study.live": async () => fixture({ best: { text: "81.8% lower time (5.5×) across 3 segments", segments: 3, raw: "this segment 3.619 → 2.039 s", n: 9, at: T - 100_000, value: 0.818, movedAt: T - 100_000, history: [{ at: T - 200_000, n: 4, value: 0.5 }, { at: T - 100_000, n: 9, value: 0.818 }], rebases: [] } }),
    });
    const best = await p.findByText(/across 3 segments/u);
    expect(best.closest("[data-best-value]")?.textContent).toMatch(/best vs base81\.8% lower time \(5\.5×\) across 3 segments/u);
    expect(p.container.querySelector("[data-best-raw]")?.textContent).toBe("this segment 3.619 → 2.039 s");
  });
});

describe("trajectory (B6)", () => {
  it("a conflict (no measurement) gets an 'other verdicts' mark on the best line", () => {
    const data = {
      points: [
        { n: 1, verdict: "win", effect: 0.1, position: 0.1, at: 1 },
        { n: 2, verdict: "conflict", effect: null, position: 0.1, at: 2 },
      ],
      steps: [
        { n: 0, value: 0 },
        { n: 1, value: 0.1 },
      ],
    };
    const r = render(<TrajectoryChart data={data} metric={{ name: "ops", unit: "ops", direction: "lower" }} lastN={2} />);
    const mark = r.getByRole("button", { name: /c\/2 .*not measured \(shown on the best line at the time\)/u });
    expect(mark.querySelector("circle[fill='none']")).toBeTruthy();
    r.unmount();
  });
});
