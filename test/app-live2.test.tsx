// @vitest-environment jsdom
// Live view (part 2), frontend: the CI band (noisy, deterministic,
// expensive) with its decision in words, band points applied live, the last
// action line, the best-moved moment (count-up, sparkline, rebase notices,
// reduced motion), and replay: scrubber, speeds, next win, keyboard, the
// position in the URL, the entry points, and the transcript note.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { MeasureBand, NoisyBand } from "../src/band.ts";
import { LIVE_CHANNEL, type LiveView } from "../src/live-model.ts";
import { parseSubPath } from "../src/app/StudiesPage.tsx";
import { FakeHost, FakePort, fakeHostSpec } from "./helpers.ts";
import { syntheticBundle } from "./replay-fixtures.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

configure({ asyncUtilTimeout: 8000 });

const METHODS = ["studies.list", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.live", "study.replay", "thread.study", "thread.badge", "study.notices.seen", "study.pause"];
const T = 1_800_000_000_000;

function noisyBand(over: Partial<NoisyBand> = {}, points = 9, decide = true): NoisyBand {
  const pts = Array.from({ length: points }, (_, i) => {
    const n = i + 1;
    const half = n === 1 ? null : 0.12 / Math.sqrt(n);
    return { n, at: T - 40_000 + n * 2000, m: 0.05, lo: half === null ? null : 0.05 - half, hi: half === null ? null : 0.05 + half };
  });
  // The stop: at pair 9 the low end clears the 1% threshold.
  if (decide) pts[points - 1] = { ...pts[points - 1]!, lo: 0.021, hi: 0.079 };
  return {
    kind: "noisy",
    candidate: 12,
    n: 2,
    startedAt: T - 38_000,
    guardrails: [{ name: "rss", direction: "lower", limit: 0.05, totalLimit: 0.12, prior: { regression: 0.03, lo: 0.02, hi: 0.04, steps: 1 } }],
    final: null,
    nMin: 6,
    nMax: 20,
    mde: 0.01,
    confidence: 0.95,
    bootstrap: 2000,
    exact: true,
    runs: [{ run: "measure", points: pts, gr: { rss: pts.map((_, i) => 0.01 + 0.001 * i) } }],
    ...over,
  };
}

function fixture(over: Partial<LiveView> = {}): LiveView {
  return {
    studyId: "s1",
    slug: "toy-size",
    state: "running",
    statusLine: "Running: 2 workers editing, measuring c/2.",
    metric: { name: "ops", unit: "ops", direction: "lower" },
    noise: "noisy",
    now: T,
    lastEventId: 100,
    studyThreadId: "thr_study",
    best: { text: "20.0% fewer ops", n: 1, at: T - 600_000, value: 0.2, movedAt: T - 600_000, history: [{ at: T - 600_000, n: 1, value: 0.2 }], rebases: [] },
    counts: { candidates: 2, maxCandidates: 6, workers: 2, targetWorkers: 3, queue: 0 },
    workers: [
      { key: 1, threadId: "thr_w1", ideaId: 3, ideaTitle: "Memoize fib", theme: "algo", phase: "measuring", phaseAt: T - 42_000, spawnedAt: T - 300_000, submissions: 1, maxSubmissions: 2, candidate: 2, candidateStage: "measuring", queuePosition: null, action: { label: "running python3 bench/measure.py", at: T - 50_000 } },
      { key: 2, threadId: "thr_w2", ideaId: 4, ideaTitle: "Use a set", theme: "data", phase: "editing", phaseAt: T - 5_000, spawnedAt: T - 90_000, submissions: 0, maxSubmissions: 2, candidate: null, candidateStage: null, queuePosition: null, action: { label: "editing src/toy.py", at: T - 4_000 } },
    ],
    cards: [
      { n: 1, ideaId: 1, ideaTitle: "Closed form sum", workerKey: null, stage: "decided", column: "promoted", stageAt: T - 600_000, verdict: "win", effect: 0.2, effectText: "20.0% fewer ops", cause: null, hostId: "host_test", pairs: { run: "confirm", done: 6, of: 20 }, rebases: 0, submittedAt: T - 700_000, decidedAt: T - 600_000 },
      { n: 2, ideaId: 3, ideaTitle: "Memoize fib", workerKey: 1, stage: "measuring", column: "bench", stageAt: T - 42_000, verdict: null, effect: null, effectText: null, cause: null, hostId: "host_test", pairs: { run: "measure", done: 9, of: 20 }, rebases: 0, submittedAt: T - 80_000, decidedAt: null },
    ],
    queue: [],
    bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: true, deferredUntil: null, current: { kind: "measure", n: 2, stage: "measuring", pairs: { run: "measure", done: 9, of: 20 }, startedAt: T - 42_000 }, utilization: 0.7, windowSeconds: 600 }],
    ideas: { next: [{ id: 7, title: "Vectorize", theme: "algo", pinned: false, source: "human", blocked: "waits: 1 running on algo" }], total: 1 },
    feed: [],
    bands: [noisyBand()],
    ...over,
  };
}

describe("frontend: Live view part 2", () => {
  let harness: Harness;
  let port: FakePort;
  const pages: Array<ReturnType<typeof renderSlot>> = [];

  beforeEach(async () => {
    const host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
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
  async function app() {
    return await loadPluginApp(() => import("../app.tsx"));
  }
  async function page(subPath: string, over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    const p = renderSlot((await app()).navPanels[0]!, { subPath }, { rpc: rpc(over) });
    pages.push(p);
    return p;
  }

  it("draws the CI band against zero and the win threshold, the regions in words, and marks where it stopped", async () => {
    const decided = noisyBand({ n: 2 });
    const early = noisyBand({ n: 3, candidate: 13, runs: [{ run: "measure", points: noisyBand({}, 3, false).runs[0]!.points, gr: {} }] }, 3, false);
    const v = fixture({ bands: [decided, early], cards: [...fixture().cards, { ...fixture().cards[1]!, n: 3, ideaTitle: "Inline", stage: "measuring", pairs: { run: "measure", done: 3, of: 20 } }] });
    const p = await page("toy-size/live", { "study.live": async () => v });
    const section = await p.findByRole("region", { name: "Measurements" });
    const c2 = within(section).getByRole("article", { name: "CI band of c/2" });
    expect(c2.textContent).toMatch(/Decided after 9 of 20 pairs: win · CI \+2\.1% to \+7\.9%/u);
    // The chart's accessible name says it in a sentence; regions and the stop are drawn.
    expect(within(c2).getByRole("img", { name: /Decided after 9 of 20 pairs: win\. Estimate \+5\.0%, CI \+2\.1% to \+7\.9%: the CI cleared the \+1\.0% threshold\./u })).toBeTruthy();
    expect(c2.querySelector('[data-region="win"]')).toBeTruthy();
    expect(c2.querySelector('[data-region="lose"]')).toBeTruthy();
    expect(c2.querySelector("[data-decision]")?.textContent).toBe("9 of 20");
    expect(c2.querySelectorAll("[data-seg]").length).toBe(7); // segments between the 8 points with a CI
    // Guardrails, compactly, with a running estimate.
    expect(within(c2).getByRole("listitem", { name: /Guardrail rss: ok so far\. .*than best .*vs the 5\.0% limit · total .* vs 12\.0%/u })).toBeTruthy();
    // Before n_min: no decision yet, said so.
    const c3 = within(section).getByRole("article", { name: "CI band of c/3" });
    expect(c3.textContent).toMatch(/Pair 3 of up to 20: no decision before pair 6/u);
    expect(c3.querySelector("[data-decision]")).toBeNull();
  });

  it("confirmation is a second phase; deterministic and expensive measurements get their own pictures", async () => {
    const withConfirm = noisyBand({ runs: [noisyBand().runs[0]!, { run: "confirm", points: noisyBand({}, 4, false).runs[0]!.points, gr: {} }] });
    const det: MeasureBand = { kind: "deterministic", candidate: 20, n: 4, startedAt: T - 5000, guardrails: [], final: null, tolerance: 0.005, best: { v: 1000, at: T - 5000 }, value: { v: 980, at: T - 4000 }, effect: 0.02 };
    const exp: MeasureBand = { kind: "expensive", candidate: 21, n: 5, startedAt: T - 9000, guardrails: [], final: null, sigma: 0.01, z: 2.13, minEffect: 0.01, k: 3, baseline: [0.004, -0.006, 0, 0.01, -0.008], baselineAt: T - 9000, screen: { n: 1, at: T - 8000, m: 0.06, lo: -0.023, hi: 0.023 }, confirm: [{ n: 1, at: T - 6000, m: 0.055, lo: 0.04, hi: 0.07 }] };
    const cards = [...fixture().cards, { ...fixture().cards[1]!, n: 4, stage: "measuring" as const }, { ...fixture().cards[1]!, n: 5, stage: "measuring" as const }];
    const p = await page("toy-size/live", { "study.live": async () => fixture({ bands: [withConfirm, det, exp], cards }) });
    const section = await p.findByRole("region", { name: "Measurements" });
    const c2 = within(section).getByRole("article", { name: "CI band of c/2" });
    expect(within(c2).getByRole("figure", { name: /Measurement of c\/2/u })).toBeTruthy();
    expect(within(c2).getByRole("figure", { name: /Confirmation · fresh pairs of c\/2/u }).textContent).toMatch(/Pair 4 of up to 20: no decision before pair 6/u);
    expect(within(section).getByRole("article", { name: "CI band of c/4" }).textContent).toMatch(/Single run: \+2\.00% vs best, better by more than the 0\.50% tolerance: win\. 1,000 → 980 ops\./u);
    expect(within(section).getByRole("article", { name: "CI band of c/5" }).textContent).toMatch(/Screen \+6\.0%: beyond the ±.*noise band, so 3 confirmation runs\.Confirmed mean \+5\.5% over 1 of 3 runs\./u);
  });

  it("applies band points live: the band grows and the card's pair count moves pair by pair", async () => {
    const start = noisyBand({}, 7, false);
    const p = await page("toy-size/live", { "study.live": async () => fixture({ bands: [start], cards: fixture().cards.map((c) => (c.n === 2 ? { ...c, pairs: { run: "measure" as const, done: 6, of: 20 } } : c)) }) });
    const section = await p.findByRole("region", { name: "Measurements" });
    expect(section.querySelectorAll("[data-seg]").length).toBe(5);
    await p.behavior.emitRealtime(LIVE_CHANNEL, { s: "s1", d: [{ k: "band", id: 0, t: T, c: 2, run: "measure", p: { n: 8, at: T, m: 0.05, lo: 0.02, hi: 0.08 } }] });
    await waitFor(() => expect(section.querySelectorAll("[data-seg]").length).toBe(6));
    expect(within(section).getByRole("article", { name: "CI band of c/2" }).textContent).toMatch(/Decided after 8 of 20 pairs: win/u);
    const pipeline = p.getByRole("region", { name: "Candidates in the pipeline" });
    expect(within(pipeline).getByRole("listitem", { name: "Bench: 1" }).textContent).toMatch(/pair 8 of ≤20/u);
  });

  it("each lane shows its last action; Up next says why an idea waits", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture() });
    const lane = await p.findByRole("button", { name: /Worker on idea #4, Use a set: editing for .*Last action: editing src\/toy\.py, 4 seconds ago/u });
    expect(lane.querySelector("[data-action]")?.textContent).toMatch(/editing src\/toy\.py.*0:04 ago/u);
    expect(p.getByRole("region", { name: "Up next" }).textContent).toMatch(/#7 Vectorize.*waits: 1 running on algo/u);
  });

  it("best moved: the card lands in Promoted, the number counts up, the sparkline steps, and the other lanes say they rebase", async () => {
    const w = window as unknown as { requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (h: number) => void };
    const raf = w.requestAnimationFrame;
    const caf = w.cancelAnimationFrame;
    w.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
    w.cancelAnimationFrame = (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
    const setReduced = (reduce: boolean) => ((window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      for (const reduce of [false, true]) {
        setReduced(reduce);
        let moved = false;
        const before = fixture({ now: Date.now() });
        const after = (): LiveView => {
          const now = Date.now();
          return fixture({
            now,
            best: { text: "36.0% fewer ops", n: 2, at: now - 200, value: 0.36, movedAt: now - 300, history: [...before.best.history, { at: now - 300, n: 2, value: 0.36 }], rebases: [2] },
            cards: before.cards.map((c) => (c.n === 2 ? { ...c, stage: "decided" as const, column: "promoted" as const, verdict: "win", effect: 0.2, effectText: "20.0% fewer ops", decidedAt: now - 200 } : c)),
            bench: before.bench.map((h) => ({ ...h, current: null })),
            bands: [{ ...noisyBand(), final: { at: now - 400, guardrails: [] } }],
          });
        };
        const p = await page("toy-size/live", { "study.live": async () => (moved ? after() : before) });
        await p.findByText("Live");
        await new Promise((r) => setTimeout(r, 1700)); // FLIP's warm-up: items present at load don't fly in
        expect(p.container.querySelector("[data-rebase]")).toBeNull();
        moved = true;
        await p.behavior.emitRealtime(LIVE_CHANNEL, { s: "s1", d: [{ k: "best", id: 150, t: Date.now(), c: 2 }] });
        const header = () => p.container.querySelector("[data-best-value]")!;
        await waitFor(() => expect(header().getAttribute("data-best-value")).toBe("0.36"));
        // Count up through intermediate values (only when motion is allowed).
        const seen = new Set<string>();
        for (let i = 0; i < 30; i++) {
          seen.add(header().textContent ?? "");
          await new Promise((r) => setTimeout(r, 30));
        }
        const intermediate = [...seen].filter((s) => !/20\.0% fewer ops|36\.0% fewer ops/u.test(s));
        if (reduce) expect(intermediate).toEqual([]);
        else expect(intermediate.length).toBeGreaterThan(0);
        await waitFor(() => expect(header().textContent).toMatch(/36\.0% fewer ops.*best moved: c\/2/u));
        // The card is in Promoted; the sparkline has two steps; lane 2 rebases on its next submission, lane 1 (the winner) doesn't.
        const pipeline = p.getByRole("region", { name: "Candidates in the pipeline" });
        expect(within(pipeline).getByRole("listitem", { name: "Promoted: 2" })).toBeTruthy();
        expect(p.getByRole("img", { name: "Trajectory: best moved 2 times" })).toBeTruthy();
        expect(p.getByRole("button", { name: /Worker on idea #4.*Best moved: rebases on its next submission/u }).querySelector("[data-rebase]")?.textContent).toBe("best moved: rebases on next submit");
        expect(p.getByRole("button", { name: /Worker on idea #3/u }).querySelector("[data-rebase]")).toBeNull();
        p.lifecycle.unmount();
      }
    } finally {
      w.requestAnimationFrame = raf;
      w.cancelAnimationFrame = caf;
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });

  it("a page that draws a frame only now and then (an occluded window) gets no animations: nothing freezes mid-flight", async () => {
    const calls: unknown[] = [];
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const original = proto.animate;
    proto.animate = function (frames: unknown) {
      calls.push(frames);
      return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
    };
    const w = window as unknown as { requestAnimationFrame?: (cb: (t: number) => void) => number };
    const raf = w.requestAnimationFrame;
    // One frame per second: each probe's second frame comes ~1 s after the first.
    let next = performance.now();
    w.requestAnimationFrame = (cb) => {
      next = Math.max(next + 1000, performance.now());
      return setTimeout(() => cb(next), 5) as unknown as number;
    };
    try {
      const p = await page("toy-size/live", { "study.live": async () => fixture() });
      await p.findByText("Live");
      await new Promise((r) => setTimeout(r, 1700));
      await p.behavior.emitRealtime(LIVE_CHANNEL, { s: "s1", d: [{ k: "stage", id: 300, t: T, c: 2, to: "confirming" }, { k: "phase", id: 301, t: T, w: 2, to: "testing" }] });
      await waitFor(() => expect(p.getByRole("button", { name: /Use a set: testing locally/u })).toBeTruthy());
      expect(calls).toHaveLength(0);
    } finally {
      proto.animate = original;
      w.requestAnimationFrame = raf;
    }
  });

  it("the rebase notice is for a few seconds only", async () => {
    const p = await page("toy-size/live", { "study.live": async () => fixture({ best: { ...fixture().best, movedAt: T - 10_000, rebases: [2] } }) });
    await p.findByText("Live");
    expect(p.container.querySelector("[data-rebase]")).toBeNull();
  });

  // ------------------------------------------------------------ replay

  const bundle = () => {
    const b = syntheticBundle(1200);
    return { ...b, slug: "toy-size" };
  };

  it("parses the replay route", () => {
    expect(parseSubPath("toy-size/live/replay/12345")).toMatchObject({ tab: "live", replay: { at: 12345 } });
    expect(parseSubPath("toy-size/live/replay")).toMatchObject({ tab: "live", replay: { at: null } });
    expect(parseSubPath("toy-size/live")).toMatchObject({ replay: null });
    expect(parseSubPath("toy-size/live/replay/nope")).toMatchObject({ replay: { at: null } });
  });

  it("replays at a position from the URL: the scrubber, milestones, keyboard control, speeds, next win, and the URL following", async () => {
    const b = bundle();
    const span = b.end - b.start;
    const p = await page("toy-size/live/replay/60000", { "study.replay": async () => b });
    const slider = await p.findByRole("slider", { name: "Replay position" });
    expect(p.getByText("Replay")).toBeTruthy();
    expect(slider.getAttribute("aria-valuenow")).toBe("60");
    expect(Number(slider.getAttribute("aria-valuemax"))).toBe(Math.round(span / 1000));
    // Milestone markers for wins and best moves.
    expect(p.container.querySelectorAll('[data-milestone="win"],[data-milestone="best"]').length).toBeGreaterThan(0);
    // Paused at a URL position; the board is the replayed moment.
    expect(p.getByRole("button", { name: "Play the replay" })).toBeTruthy();
    const value = () => Number(slider.getAttribute("aria-valuenow"));
    fireEvent.keyDown(slider, { key: "End" });
    await waitFor(() => expect(value()).toBe(Math.round(span / 1000)));
    fireEvent.keyDown(slider, { key: "Home" });
    await waitFor(() => expect(value()).toBe(0));
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(() => expect(value()).toBe(Math.round(span / 100 / 1000)));
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(value()).toBe(Math.round((span / 100 + span / 10) / 1000)));
    // N: the next win (a few seconds before it, so the moment plays).
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "n" });
    const firstWin = b.events.find((e) => e.kind === "candidate.verdict" && e.data.verdict === "win")!.at;
    await waitFor(() => expect(value()).toBe(Math.round((firstWin - Math.min(3000, span / 50) - b.start) / 1000)));
    // The URL follows (replace, so back doesn't step through positions).
    await waitFor(() => expect(p.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: expect.stringMatching(/^toy-size\/live\/replay\/\d+$/u), replace: true } }));
    // Speeds: keys 1-4 and the radio group.
    fireEvent.keyDown(slider, { key: "4" });
    expect(p.getByRole("radio", { name: /600 times/u }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(p.getByRole("radio", { name: /10 times/u }));
    expect(p.getByRole("radio", { name: /10 times/u }).getAttribute("aria-checked")).toBe("true");
    // Play at 10×, then 600×: the position advances about speed × wall time.
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: " " });
    expect(await p.findByRole("button", { name: "Pause the replay" })).toBeTruthy();
    const w0 = Date.now();
    await new Promise((r) => setTimeout(r, 600));
    const at10 = value() / ((Date.now() - w0) / 1000);
    fireEvent.keyDown(slider, { key: "4" });
    const v1 = value();
    const w1 = Date.now();
    await new Promise((r) => setTimeout(r, 600));
    const at600 = (value() - v1) / ((Date.now() - w1) / 1000);
    expect(at10).toBeGreaterThan(3);
    expect(at10).toBeLessThan(14);
    expect(at600).toBeGreaterThan(150);
    expect(at600).toBeLessThan(700);
    fireEvent.keyDown(slider, { key: "k" });
    expect(await p.findByRole("button", { name: "Play the replay" })).toBeTruthy();
  });

  it("replay entry points: the calm state, the Live header, the Overview, and the side panel", async () => {
    const paused = fixture({ state: "archived", workers: [], cards: fixture().cards.filter((c) => c.stage === "decided"), bench: [], bands: [] });
    const calm = await page("toy-size/live", { "study.live": async () => paused });
    fireEvent.click(await calm.findByRole("button", { name: "Replay this study" }));
    expect(calm.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "toy-size/live/replay" } });
    calm.lifecycle.unmount();
    const live = await page("toy-size/live", { "study.live": async () => fixture() });
    fireEvent.click(await live.findByRole("button", { name: "Replay this study from the start" }));
    expect(live.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "toy-size/live/replay" } });
    live.lifecycle.unmount();
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    const ov = await page("toy-size/overview");
    fireEvent.click(await ov.findByRole("button", { name: "Replay this study in the Live view" }));
    expect(ov.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "toy-size/live/replay" } });
    ov.lifecycle.unmount();
    // The side panel switches between Live and Replay in place.
    const a = await app();
    const reg = a.threadPanelActions.find((x) => x.id === "study-live")!;
    const panel = renderSlot(reg as never, { threadId: "thr_study", params: { slug: "toy-size" } } as never, { rpc: rpc({ "study.live": async () => fixture(), "study.replay": async () => bundle() }) });
    pages.push(panel);
    fireEvent.click(await panel.findByRole("tab", { name: "Replay" }));
    expect(await panel.findByRole("slider", { name: "Replay position" })).toBeTruthy();
    expect(panel.getByRole("tab", { name: "Replay" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(panel.getByRole("tab", { name: "Live" }));
    await waitFor(() => expect(panel.queryByRole("slider")).toBeNull());
  });

  it("in replay, a worker's transcript says it is the current one, not the one at this moment", async () => {
    const b = bundle();
    // A moment with live workers.
    const at = b.events.find((e) => e.kind === "worker.action")!.at - b.start + 1;
    const p = await page(`toy-size/live/replay/${at}`, { "study.replay": async () => b });
    const lane = await p.findByRole("button", { name: /Worker on idea #1/u });
    fireEvent.click(lane);
    await waitFor(() => expect(p.getByTestId("bb-thread-chat")).toBeTruthy());
    expect(p.getByRole("note").textContent).toMatch(/Current transcript, not at this moment/u);
  });
});
