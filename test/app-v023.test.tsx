// @vitest-environment jsdom
// v0.2.3 fixes, rendered: the Live header's worker count, one queue position
// for lanes and cards, the CI band's label layout (no overlaps, region names
// outside the plot), its placeholder before the first pair, the expensive
// band drawn in pixels, the trajectory chart's ticks and x axis, and the
// candidate detail's band, statistic note and samples table.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { ExpensiveBand, NoisyBand } from "../src/band.ts";
import type { Engine } from "../src/engine.ts";
import type { LiveView } from "../src/live-model.ts";
import { bandLabels, noisyPlaceholder } from "../src/app/live/CiBand.tsx";
import { TrajectoryChart, trajectoryAxes } from "../src/app/TrajectoryChart.tsx";
import { FakeHost, FakePort, fakeHostSpec, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

configure({ asyncUtilTimeout: 8000 });

const METHODS = ["studies.list", "studies.attention", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.oracle", "study.bench", "study.live", "study.replay", "thread.study", "thread.badge", "study.notices.seen"];
const T = 1_800_000_000_000;

function noisyBand(over: Partial<NoisyBand> = {}, points = 9): NoisyBand {
  const pts = Array.from({ length: points }, (_, i) => {
    const n = i + 1;
    const half = n === 1 ? null : 0.12 / Math.sqrt(n);
    return { n, at: T - 40_000 + n * 2000, m: 0.05, lo: half === null ? null : 0.05 - half, hi: half === null ? null : 0.05 + half };
  });
  return { kind: "noisy", candidate: 12, n: 2, startedAt: T - 38_000, guardrails: [], final: null, nMin: 6, nMax: 20, mde: 0.01, confidence: 0.95, bootstrap: 2000, exact: true, runs: [{ run: "measure", points: pts, gr: {} }], ...over };
}

function fixture(over: Partial<LiveView> = {}): LiveView {
  return {
    studyId: "s1",
    slug: "toy-size",
    state: "running",
    statusLine: "Running: 3 workers: 1 editing, 1 waiting for the bench, 1 finishing; measuring c/2, 2 queued for the bench.",
    metric: { name: "ops", unit: "ops", direction: "lower" },
    noise: "noisy",
    now: T,
    lastEventId: 100,
    studyThreadId: "thr_study",
    best: { text: null, n: null, at: null, value: null, movedAt: null, history: [], rebases: [] },
    counts: { candidates: 4, maxCandidates: 8, workers: 3, finishing: 1, targetWorkers: 2, queue: 2 },
    workers: [
      { key: 1, threadId: "thr_w1", ideaId: 3, ideaTitle: "Memoize fib", theme: "algo", phase: "waiting", phaseAt: T - 5_000, spawnedAt: T - 300_000, submissions: 1, maxSubmissions: 2, candidate: 3, candidateStage: "queued", queuePosition: 2, action: null },
      { key: 2, threadId: "thr_w2", ideaId: 4, ideaTitle: "Use a set", theme: "data", phase: "editing", phaseAt: T - 5_000, spawnedAt: T - 90_000, submissions: 0, maxSubmissions: 2, candidate: null, candidateStage: null, queuePosition: null, action: null },
      { key: 3, threadId: "thr_w3", ideaId: 5, ideaTitle: "Inline", theme: "algo", phase: "finishing", phaseAt: T - 5_000, spawnedAt: T - 90_000, submissions: 1, maxSubmissions: 1, candidate: 2, candidateStage: "measuring", queuePosition: null, action: null },
    ],
    cards: [
      { n: 2, ideaId: 5, ideaTitle: "Inline", workerKey: 3, stage: "measuring", column: "bench", stageAt: T - 42_000, verdict: null, effect: null, effectText: null, cause: null, hostId: "host_test", pairs: { run: "measure", done: 0, of: 20 }, rebases: 0, submittedAt: T - 80_000, decidedAt: null },
      { n: 3, ideaId: 3, ideaTitle: "Memoize fib", workerKey: 1, stage: "queued", column: "queue", stageAt: T - 10_000, verdict: null, effect: null, effectText: null, cause: null, hostId: null, pairs: null, rebases: 0, submittedAt: T - 20_000, decidedAt: null },
      { n: 4, ideaId: 6, ideaTitle: "Other", workerKey: null, stage: "queued", column: "queue", stageAt: T - 9_000, verdict: null, effect: null, effectText: null, cause: null, hostId: null, pairs: null, rebases: 0, submittedAt: T - 19_000, decidedAt: null },
    ],
    queue: [3, 4],
    bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: null, healthRecord: "missing", deferredUntil: null, current: { kind: "measure", n: 2, stage: "measuring", pairs: { run: "measure", done: 0, of: 20 }, startedAt: T - 42_000 }, utilization: 0.7, windowSeconds: 600 }],
    ideas: { next: [], total: 0 },
    feed: [],
    // The measurement has started but no pair is done yet.
    bands: [noisyBand({ runs: [] })],
    ...over,
  };
}

function overlaps(ys: number[], gap: number): boolean {
  const s = [...ys].sort((a, b) => a - b);
  return s.some((y, i) => i > 0 && y - s[i - 1]! < gap - 1e-9);
}

describe("CI band label layout (pure)", () => {
  const H = 160;
  const top = 12;
  const bottom = H - 20;
  const mapper = (domain: [number, number]) => (v: number) => top + ((domain[1] - Math.max(domain[0], Math.min(domain[1], v))) / (domain[1] - domain[0])) * (bottom - top);
  for (const [name, domain, mde] of [
    ["a small threshold on a large scale (+1.0% next to 0)", [-0.05, 0.9], 0.01],
    ["a typical band", [-0.02, 0.035], 0.01],
    ["a tiny lose region", [-0.001, 0.2], 0.02],
    ["a large lose region", [-0.3, 0.05], 0.01],
  ] as Array<[string, [number, number], number]>) {
    it(`never overlaps axis or region labels: ${name}`, () => {
      const l = bandLabels(domain, mde, mapper(domain), top, bottom);
      expect(overlaps(l.axis.map((a) => a.y), 11)).toBe(false);
      expect(overlaps(l.regions.map((r) => r.y), 11)).toBe(false);
      // 0 is always labelled, where it is.
      // (clamped into the plot by at most a couple of pixels at its edge)
      expect(Math.abs(l.axis.find((a) => a.key === "zero")!.y - mapper(domain)(0))).toBeLessThan(3);
      expect(l.regions.some((r) => r.key === "win")).toBe(true);
      for (const a of l.axis) expect(a.y).toBeGreaterThanOrEqual(top);
    });
  }
});

describe("trajectory axes (pure)", () => {
  it("nice y ticks and candidate numbers on x", () => {
    const data = {
      points: [
        { n: 1, verdict: "win", effect: 0.1, position: 0.1, at: 1 },
        { n: 2, verdict: "lose", effect: -0.079, position: 0.02, at: 2 },
        { n: 5, verdict: "win", effect: 0.1, position: 0.191, at: 3 },
      ],
      steps: [
        { n: 0, value: 0 },
        { n: 1, value: 0.1 },
        { n: 5, value: 0.191 },
      ],
    };
    const a = trajectoryAxes(data, 7, "lower", 640);
    expect(a.yTicks).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
    expect(a.yDigits).toBe(0);
    expect(a.xTicks).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Narrow: fewer x ticks, still whole candidate numbers.
    const narrow = trajectoryAxes(data, 40, "lower", 240);
    expect(narrow.xTicks.every((n) => Number.isInteger(n) && n >= 1)).toBe(true);
    expect(narrow.xTicks.length).toBeLessThanOrEqual(5);
  });

  it("renders at a fixed font size with labelled candidate numbers", () => {
    const data = { points: [{ n: 1, verdict: "win", effect: 0.123, position: 0.123, at: 1 }, { n: 3, verdict: "lose", effect: -0.05, position: 0.07, at: 2 }], steps: [{ n: 0, value: 0 }, { n: 1, value: 0.123 }] };
    const r = render(<TrajectoryChart data={data} metric={{ name: "ops", unit: "ops", direction: "lower" }} lastN={3} />);
    const svg = r.container.querySelector("svg")!;
    expect(svg.getAttribute("height")).toBe("220");
    expect(svg.getAttribute("class") ?? "").not.toMatch(/h-auto/u);
    const x = r.container.querySelector("[data-x-axis]")!;
    expect(x.textContent).toMatch(/^1.*2.*3.*candidate \(c\/N\)$/u);
    const ticks = [...r.container.querySelectorAll("svg > g.text-border text")].map((t) => t.textContent);
    for (const t of ticks) expect(t).toMatch(/^(0%|[+−]\d+(\.\d)?%)$/u);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    r.unmount();
  });
});

describe("frontend: v0.2.3 fixes", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  let engine!: Engine;
  const pages: Array<ReturnType<typeof renderSlot>> = [];

  beforeEach(async () => {
    host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
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

  it("the header counts workers against the target without '3 workers (up to 2)'", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture() });
    const status = await p.findByText(/Running: 3 workers: 1 editing/u);
    expect(status).toBeTruthy();
    const header = await p.findByText(/4 of 8 candidates/u);
    expect(header.textContent).toBe("4 of 8 candidates · 2 workers + 1 finishing · target now 2 (no new worker until fewer)");
    expect(p.container.textContent).not.toMatch(/\(up to 2\)/u);
  });

  it("the lane and the Queue card give the same position, from the view's queue", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture() });
    const lanes = await p.findByRole("region", { name: "Workers" });
    const lane = within(lanes).getByRole("button", { name: /Worker on idea #3, Memoize fib/u });
    // The stale server position (2) loses to the queue the cards read.
    expect(lane.textContent).toMatch(/c\/3 queued, 1st in line/u);
    expect(lane.textContent).not.toMatch(/2nd/u);
    const pipeline = p.getByRole("region", { name: "Candidates in the pipeline" });
    expect(within(pipeline).getByRole("listitem", { name: "Queue: 2" }).textContent).toMatch(/c\/3.*1st in line.*c\/4.*2nd in line/u);
  });

  it("before the first pair the band says what runs, and the bench strip never says 'pair 0'", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture() });
    const m = await p.findByRole("article", { name: "CI band of c/2" });
    expect(m.querySelector("[data-band-placeholder]")?.textContent).toBe(noisyPlaceholder({ nMax: 20 }, "measure"));
    const bench = p.getByRole("region", { name: "Bench" });
    expect(bench.textContent).toMatch(/first pair of ≤20 running/u);
    expect(bench.textContent).not.toMatch(/pair 0/u);
    // Replayed studies from before health events say so.
    expect(bench.textContent).toMatch(/health not recorded/u);
  });

  it("draws region names outside the plot and axis labels that don't collide", async () => {
    // A big effect: the +1.0% threshold sits a pixel above 0 on this scale.
    const big = noisyBand({ runs: [{ run: "measure", points: Array.from({ length: 9 }, (_, i) => ({ n: i + 1, at: T - 30_000 + i * 1000, m: 0.8, lo: i ? 0.78 : null, hi: i ? 0.82 : null })), gr: {} }] });
    const p = await page("toy-size/live", { "study.live": async () => fixture({ bands: [big] }) });
    const m = await p.findByRole("article", { name: "CI band of c/2" });
    const svg = m.querySelector("svg")!;
    const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    const ys = (sel: string) => [...svg.querySelectorAll(`${sel} text`)].map((t) => Number(t.getAttribute("y")));
    expect(overlaps(ys("[data-axis-labels] [data-label]"), 11)).toBe(false);
    expect(overlaps(ys("[data-region-labels]"), 11)).toBe(false);
    // The region names sit right of the plot area, so they never cover the band or the decision line.
    const plotRight = Number(svg.querySelector("clipPath rect")!.getAttribute("x")) + Number(svg.querySelector("clipPath rect")!.getAttribute("width"));
    for (const t of svg.querySelectorAll("[data-region-labels] text")) expect(Number(t.getAttribute("x"))).toBeGreaterThan(plotRight);
    expect(plotRight).toBeLessThan(width);
  });

  it("the expensive band draws in pixels: no stretched SVG text", async () => {
    const band: ExpensiveBand = { kind: "expensive", candidate: 12, n: 2, startedAt: T - 9000, guardrails: [], final: null, sigma: 0.02, z: 2, minEffect: 0.01, k: 3, baseline: [0, 0.01, -0.01, 0.005], baselineAt: T - 9000, screen: { n: 1, at: T - 5000, m: 0.08, lo: null, hi: null }, confirm: [{ n: 1, at: T - 3000, m: 0.07, lo: 0.04, hi: 0.1 }] };
    const p = await page("toy-size/live", { "study.live": async () => fixture({ noise: "expensive", bands: [band] }) });
    const m = await p.findByRole("article", { name: "CI band of c/2" });
    const svg = m.querySelector("svg")!;
    expect(svg.getAttribute("preserveAspectRatio")).toBeNull();
    expect(svg.getAttribute("height")).toMatch(/^\d+$/u);
    expect(m.textContent).toMatch(/baseline.*screen.*mean 1/u);
  });

  it("the candidate detail shows how the verdict formed, which statistic the headline is, and all samples on demand", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitUntil(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { summary: "smaller output" }, { threadId: "thr_w1" });
    await waitUntil(() => engine.study("toy-size") && engine.ctx.store.candidateByN(engine.study("toy-size").id, 1)?.stage === "decided");
    // The real detail, with many noisy pairs (a long samples table) and a headline that differs from the medians.
    const real = (await harness.behavior.callRpc("study.candidate", { slug: "toy-size", n: 1 })) as { candidate: Record<string, unknown> & { metricRows: Array<Record<string, unknown>> } };
    const samples = Array.from({ length: 30 }, (_, i) => [
      { run: "measure", pair: i, side: "best", metric: "size", value: 1000, at: T, id: 2 * i },
      { run: "measure", pair: i, side: "candidate", metric: "size", value: 800 + i, at: T, id: 2 * i + 1 },
    ]).flat();
    const detail = { ...real.candidate, noise: "noisy", samples, effect: 0.0572, effectStatistic: "median of the per-pair changes, the verdict's estimate", metricRows: real.candidate.metricRows.map((r) => (r.kind === "primary" ? { ...r, improvement: 0.062 } : r)) };
    const p = await page("toy-size/candidates/1", { "study.candidate": async () => ({ candidate: detail }) });
    const verdict = await p.findByText("How the verdict formed");
    expect(verdict).toBeTruthy();
    expect(p.container.querySelector("[data-band]")).toBeTruthy();
    expect(p.container.querySelector("[data-statistic-note]")?.textContent).toMatch(/The headline \+5\.72% is the median of the per-pair changes.*median of each side \(\+6\.20%\)/u);
    const table = p.getByRole("table", { name: "Samples" });
    expect(within(table).getAllByRole("row")).toHaveLength(13); // header + 12
    expect(table.textContent).toMatch(/pair 1/u);
    expect(table.textContent).not.toMatch(/pair 0/u);
    expect(table.closest(".max-h-56")).toBeNull();
    fireEvent.click(p.getByRole("button", { name: "Show all 30 pairs" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(31));
  });
});
