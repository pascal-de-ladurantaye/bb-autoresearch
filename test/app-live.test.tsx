// @vitest-environment jsdom
// Live view (part 1), frontend: the Live tab (default while Running) and the
// study thread's Live panel, in empty, loading, error, running and finished
// states; realtime deltas applied locally; one transcript at a time; and
// "Open beside the study thread" through the header badge.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import { slugFromParams } from "../src/app/live/LivePanel.tsx";
import { groupFeed } from "../src/app/live/LiveStudy.tsx";
import { defaultTab, explicitTab } from "../src/app/StudiesPage.tsx";
import { LIVE_CHANNEL, type LiveView } from "../src/live-model.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

configure({ asyncUtilTimeout: 8000 });

const METHODS = ["studies.list", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.live", "thread.study", "thread.badge", "study.notices.seen", "study.pause"];

/** A running study's live view, by hand (states the fake host can't hold still for). */
function liveFixture(over: Partial<LiveView> = {}): LiveView {
  const t = 1_800_000_000_000;
  return {
    studyId: "s1",
    slug: "toy-size",
    state: "running",
    statusLine: "Running: 2 workers editing, measuring c/2, 1 in the bench queue.",
    metric: { name: "ops", unit: "ops", direction: "lower" },
    noise: "noisy",
    now: t,
    lastEventId: 100,
    studyThreadId: "thr_study",
    best: { text: "23.4% fewer ops", n: 1, at: t - 60_000, value: 0.234, movedAt: t - 60_000, history: [{ at: t - 60_000, n: 1, value: 0.234 }], rebases: [] },
    counts: { candidates: 4, maxCandidates: 6, workers: 2, targetWorkers: 3, queue: 1 },
    workers: [
      { key: 1, threadId: "thr_w1", ideaId: 3, ideaTitle: "Memoize fib", theme: "algo", phase: "measuring", phaseAt: t - 42_000, spawnedAt: t - 300_000, submissions: 1, maxSubmissions: 2, candidate: 2, candidateStage: "measuring", queuePosition: null, action: null },
      { key: 2, threadId: "thr_w2", ideaId: 4, ideaTitle: "Use a set", theme: "data", phase: "editing", phaseAt: t - 5_000, spawnedAt: t - 90_000, submissions: 0, maxSubmissions: 2, candidate: null, candidateStage: null, queuePosition: null, action: null },
    ],
    cards: [
      { n: 1, ideaId: 1, ideaTitle: "Closed form sum", workerKey: null, stage: "decided", column: "promoted", stageAt: t - 60_000, verdict: "win", effect: 0.234, effectText: "23.4% fewer ops", cause: null, hostId: "host_test", pairs: { run: "confirm", done: 6, of: 6 }, rebases: 0, submittedAt: t - 200_000, decidedAt: t - 60_000 },
      { n: 2, ideaId: 3, ideaTitle: "Memoize fib", workerKey: 1, stage: "measuring", column: "bench", stageAt: t - 42_000, verdict: null, effect: null, effectText: null, cause: null, hostId: "host_test", pairs: { run: "measure", done: 3, of: 6 }, rebases: 0, submittedAt: t - 80_000, decidedAt: null },
      { n: 3, ideaId: 5, ideaTitle: "Inline the loop", workerKey: null, stage: "queued", column: "queue", stageAt: t - 10_000, verdict: null, effect: null, effectText: null, cause: null, hostId: null, pairs: null, rebases: 0, submittedAt: t - 30_000, decidedAt: null },
      { n: 4, ideaId: 6, ideaTitle: "Precompute table", workerKey: null, stage: "decided", column: "verdict", stageAt: t - 20_000, verdict: "lose", effect: -0.004, effectText: "0.4% more ops (worse)", cause: null, hostId: "host_test", pairs: { run: "measure", done: 6, of: 6 }, rebases: 0, submittedAt: t - 100_000, decidedAt: t - 20_000 },
    ],
    queue: [3],
    bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: true, deferredUntil: null, current: { kind: "measure", n: 2, stage: "measuring", pairs: { run: "measure", done: 3, of: 6 }, startedAt: t - 42_000 }, utilization: 0.73, windowSeconds: 600 }],
    ideas: { next: [{ id: 7, title: "Vectorize the inner loop", theme: "algo", pinned: true, source: "human", blocked: null }], total: 3 },
    feed: [
      { id: 90, at: t - 50_000, candidate: 3, text: "c/3 tests started", tone: "info" },
      { id: 91, at: t - 42_000, candidate: 2, text: "c/2 on the bench (local)", tone: "info" },
      { id: 92, at: t - 20_000, candidate: 4, text: "c/4 lost: 0.4% more ops (worse)", tone: "lose" },
      { id: 93, at: t - 10_000, candidate: 3, text: "c/3 tests passed in 41 s, queued for the bench", tone: "info" },
    ],
    bands: [],
    ...over,
  };
}

describe("frontend: Live tab and Live panel", () => {
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
  async function app() {
    return await loadPluginApp(() => import("../app.tsx"));
  }
  async function page(subPath: string, over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    const p = renderSlot((await app()).navPanels[0]!, { subPath }, { rpc: rpc(over) });
    pages.push(p);
    return p;
  }
  async function panel(threadId: string, params: unknown = null, over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    const a = await app();
    const reg = a.threadPanelActions.find((x) => x.id === "study-live")!;
    const p = renderSlot(reg as never, { threadId, params } as never, { rpc: rpc(over) });
    pages.push(p);
    return p;
  }
  async function running() {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitUntil(() => port.spawned.length >= 1);
  }

  it("registers the Live panel as a thread panel action (flush layout)", async () => {
    const a = await app();
    expect(a.threadPanelActions.map((x) => ({ id: x.id, title: x.title, layout: x.layout }))).toEqual([{ id: "study-live", title: "Study live view", layout: "flush" }]);
    expect(slugFromParams({ slug: "toy-size" })).toBe("toy-size");
    expect(slugFromParams({ slug: "../etc" })).toBeNull();
    expect(slugFromParams(["toy-size"])).toBeNull();
    expect(slugFromParams(null)).toBeNull();
  });

  it("the Live tab is the default while Running; Overview otherwise; an explicit tab wins", async () => {
    expect(explicitTab("toy-size")).toBeNull();
    expect(explicitTab("toy-size/live")).toBe("live");
    expect(defaultTab("running")).toBe("live");
    expect(defaultTab("paused")).toBe("overview");
    // Draft: Overview by default.
    const draft = await page("toy-size");
    await draft.findByText("Trajectory");
    expect(draft.getByRole("tab", { name: /overview/iu }).getAttribute("aria-selected")).toBe("true");
    draft.lifecycle.unmount();
    await running();
    const live = await page("toy-size");
    await waitFor(() => expect(live.getByRole("tab", { name: /live/iu }).getAttribute("aria-selected")).toBe("true"));
    await live.findByRole("region", { name: "Workers" });
    expect(live.getByRole("region", { name: "Candidates in the pipeline" })).toBeTruthy();
    expect(live.getByRole("button", { name: /Worker on idea #1, Shrink the output: (starting|reading the code) for/u })).toBeTruthy();
    expect(live.getByRole("region", { name: "Up next" }).textContent).toMatch(/No queued ideas/u);
    // Explicit Overview still opens the Overview.
    live.lifecycle.unmount();
    const ov = await page("toy-size/overview");
    await ov.findByText("Trajectory");
    expect(ov.getByRole("tab", { name: /overview/iu }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders a running study: lanes in words, cards per column, bench with pair progress, idea queue, grouped feed", async () => {
    const p = await page("toy-size/live", { "study.live": async () => liveFixture() });
    await p.findByText("Live");
    const lanes = p.getByRole("region", { name: "Workers" });
    expect(within(lanes).getByRole("button", { name: /Worker on idea #3, Memoize fib: being measured for 42 seconds, submission 1 of 2, c\/2 measuring/u })).toBeTruthy();
    expect(within(lanes).getByRole("button", { name: /Worker on idea #4, Use a set: editing for/u })).toBeTruthy();
    const pipeline = p.getByRole("region", { name: "Candidates in the pipeline" });
    expect(within(pipeline).getByRole("listitem", { name: "Bench: 1" }).textContent).toMatch(/c\/2.*Memoize fib.*measuring · pair 3 of ≤6/u);
    expect(within(pipeline).getByRole("listitem", { name: "Queue: 1" }).textContent).toMatch(/c\/3.*1st in line/u);
    expect(within(pipeline).getByRole("listitem", { name: "Promoted: 1" }).textContent).toMatch(/c\/1.*win.*23\.4% fewer ops/u);
    expect(within(pipeline).getByRole("listitem", { name: "Verdict: 1" }).textContent).toMatch(/c\/4.*lose.*0\.4% more ops \(worse\)/u);
    const bench = p.getByRole("region", { name: "Bench" });
    expect(bench.textContent).toMatch(/local.*healthy.*c\/2.*measuring.*pair 3 of ≤6/u);
    expect(bench.textContent).toMatch(/busy 73% of the last 10 min/u);
    expect(bench.textContent).toMatch(/Queue:\s*c\/3/u);
    expect(p.getByRole("region", { name: "Up next" }).textContent).toMatch(/#7 Vectorize the inner loop.*algo.*and 2 more/u);
    const feed = p.getByRole("log", { name: /Event feed/u });
    // Grouped by candidate: c/3's two lines sit under one c/3 header, newest group last.
    expect(feed.textContent).toMatch(/c\/4 · Precompute table.*lost: 0\.4% more ops.*c\/3 · Inline the loop.*tests started.*tests passed in 41 s/u);
    expect(p.getAllByText("23.4% fewer ops", { exact: false }).length).toBeGreaterThan(0);
    // Clicking a card opens the candidate.
    fireEvent.click(within(pipeline).getByRole("button", { name: /^c\/2, Memoize fib/u }));
    expect(p.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "toy-size/candidates/2" } });
  });

  it("applies realtime deltas locally: a card moves, pairs count up, a phase changes, an idea leaves the queue", async () => {
    const p = await page("toy-size/live", { "study.live": async () => liveFixture() });
    await p.findByText("Live");
    const t = 1_800_000_000_000;
    await p.behavior.emitRealtime(LIVE_CHANNEL, {
      s: "s1",
      d: [
        { k: "stage", id: 101, t, c: 3, to: "measuring" },
        { k: "pair", id: 102, t, c: 2, run: "measure", i: 5, of: 6 },
        { k: "phase", id: 103, t, w: 2, to: "testing" },
        { k: "idea", id: 104, t, i: 7, to: "running" },
      ],
    });
    const pipeline = p.getByRole("region", { name: "Candidates in the pipeline" });
    await waitFor(() => expect(within(pipeline).getByRole("listitem", { name: "Bench: 2" }).textContent).toMatch(/c\/2.*pair 5 of ≤6.*c\/3/u));
    expect(within(pipeline).getByRole("listitem", { name: "Queue: 0" })).toBeTruthy();
    expect(p.getByRole("button", { name: /Worker on idea #4, Use a set: testing locally for/u })).toBeTruthy();
    expect(p.getByRole("region", { name: "Up next" }).textContent).not.toMatch(/Vectorize/u);
    // Another study's deltas are ignored.
    await p.behavior.emitRealtime(LIVE_CHANNEL, { s: "other", d: [{ k: "phase", id: 200, t, w: 2, to: "verdict" }] });
    expect(p.getByRole("button", { name: /Use a set: testing locally/u })).toBeTruthy();
  });

  it("shows one worker's transcript at a time (read-only ThreadChat timeline)", async () => {
    const p = await page("toy-size/live", { "study.live": async () => liveFixture() });
    const lane1 = await p.findByRole("button", { name: /Worker on idea #3/u });
    fireEvent.click(lane1);
    await waitFor(() => expect(p.getAllByTestId("bb-thread-chat")).toHaveLength(1));
    const chat = p.getByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thr_w1");
    expect(chat.getAttribute("data-variant")).toBe("timeline");
    expect(lane1.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(p.getByRole("button", { name: /Worker on idea #4/u }));
    await waitFor(() => expect(p.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_w2"));
    expect(p.getAllByTestId("bb-thread-chat")).toHaveLength(1);
    fireEvent.click(p.getByRole("button", { name: "Close the transcript" }));
    await waitFor(() => expect(p.queryByTestId("bb-thread-chat")).toBeNull());
  });

  it("loading, error and the calm not-running state that points to the Overview", async () => {
    const loading = await page("toy-size/live", { "study.live": () => new Promise<never>(() => undefined) });
    await loading.findByRole("status", { name: "Loading the live view…" });
    loading.lifecycle.unmount();
    const failing = await page("toy-size/live", { "study.live": () => Promise.reject(new Error("server unavailable")) });
    await failing.findByText(/Couldn't load the live view: server unavailable/u);
    failing.lifecycle.unmount();
    const paused = liveFixture({ state: "paused", statusLine: "Paused by you.", workers: [], cards: liveFixture().cards.filter((c) => c.stage === "decided"), queue: [] });
    const calm = await page("toy-size/live", { "study.live": async () => paused });
    await calm.findByText(/The study is paused/u);
    expect(calm.getByText("Not running")).toBeTruthy();
    expect(calm.getByRole("region", { name: "Last verdicts" }).textContent).toMatch(/c\/4.*c\/1|c\/1.*c\/4/u);
    fireEvent.click(calm.getByRole("button", { name: "Open the Overview" }));
    expect(calm.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "toy-size/overview" } });
  });

  it("the Live panel resolves its study from the study thread or a worker thread, and says so when the thread has none", async () => {
    await running();
    const fromStudy = await panel("thr_study");
    await fromStudy.findByRole("region", { name: "Workers" });
    expect(fromStudy.getByText("toy-size")).toBeTruthy();
    expect(fromStudy.queryByTestId("bb-thread-chat")).toBeNull();
    // Compact layout: no "open beside" button inside the panel.
    expect(fromStudy.queryByRole("button", { name: /Open beside/u })).toBeNull();
    fromStudy.lifecycle.unmount();
    // From a worker thread: that worker's transcript is selected.
    const fromWorker = await panel("thr_w1");
    await waitFor(() => expect(fromWorker.getByTestId("bb-thread-chat").getAttribute("data-thread-id")).toBe("thr_w1"));
    fromWorker.lifecycle.unmount();
    // Params name the study explicitly.
    const fromParams = await panel("thr_unrelated", { slug: "toy-size" });
    await fromParams.findByRole("region", { name: "Workers" });
    fromParams.lifecycle.unmount();
    const none = await panel("thr_unrelated");
    await none.findByText(/isn't part of an autoresearch study/u);
    fireEvent.click(none.getByRole("button", { name: "Open Studies" }));
    expect(none.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "studies" });
    // Panel links go to the study page.
    const p = await panel("thr_study", null, { "study.live": async () => liveFixture() });
    fireEvent.click(await p.findByRole("button", { name: /^c\/2, Memoize fib/u }));
    expect(p.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "studies", options: { subPath: "toy-size/candidates/2" } });
  });

  it("opens the Live panel beside the study thread: from the Live tab via the header badge, and from the badge itself", async () => {
    await running();
    const a = await app();
    const p = await page("toy-size/live");
    fireEvent.click(await p.findByRole("button", { name: "Open beside the study thread" }));
    expect(p.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_study" });
    // The study thread's header badge mounts on the thread surface and opens the panel.
    const badge = renderSlot(a.threadHeaderActions[0]!, { threadId: "thr_study", projectId: "proj_1", isCompactViewport: false } as never, { rpc: rpc(), openThreadPanel: () => true });
    pages.push(badge);
    await waitFor(() => expect(badge.inspection.navigateCalls).toContainEqual({ method: "openThreadPanel", options: { actionId: "study-live", title: "Live · toy-size", params: { slug: "toy-size" } } }));
    // The request is used once.
    const opened = badge.inspection.navigateCalls.filter((c) => c.method === "openThreadPanel").length;
    // The badge's own Live button opens it too.
    fireEvent.click(await badge.findByRole("button", { name: "Open the live view of toy-size beside this thread" }));
    expect(badge.inspection.navigateCalls.filter((c) => c.method === "openThreadPanel").length).toBe(opened + 1);
    // Worker threads get no Live button.
    const workerBadge = renderSlot(a.threadHeaderActions[0]!, { threadId: "thr_w1", projectId: "proj_1", isCompactViewport: false } as never, { rpc: rpc() });
    pages.push(workerBadge);
    await within(workerBadge.container).findByRole("button", { name: /Autoresearch: Worker for study/u });
    expect(within(workerBadge.container).queryByRole("button", { name: /live view/u })).toBeNull();
  });

  it("motion: a card that moves column glides there; nothing animates under prefers-reduced-motion or without rendered frames", async () => {
    const calls: Keyframe[][] = [];
    const proto = HTMLElement.prototype as unknown as { animate?: unknown; getBoundingClientRect: () => DOMRect };
    const originalAnimate = proto.animate;
    const originalRect = proto.getBoundingClientRect;
    proto.animate = function (frames: Keyframe[]) {
      calls.push(frames);
      return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
    };
    // jsdom has no layout: place each element by the pipeline column it sits in.
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const col = this.closest("li[aria-label]");
      const x = col?.parentElement ? [...col.parentElement.children].indexOf(col) * 100 : 0;
      return { left: x, top: 0, right: x + 90, bottom: 40, width: 90, height: 40, x, y: 0, toJSON() {} } as DOMRect;
    };
    // The page renders frames (the view skips animation when it doesn't, e.g. a hidden tab).
    const w = window as unknown as { requestAnimationFrame?: (cb: (t: number) => void) => number };
    const originalRaf = w.requestAnimationFrame;
    w.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0) as unknown as number;
    const setReduced = (reduce: boolean) => {
      (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} });
    };
    try {
      for (const reduce of [false, true]) {
        calls.length = 0;
        setReduced(reduce);
        const p = await page("toy-size/live", { "study.live": async () => liveFixture() });
        await p.findByText("Live");
        expect(p.container.querySelector("[data-reduced-motion]") !== null).toBe(reduce);
        await new Promise((r) => setTimeout(r, 20));
        // c/3 leaves the queue for the bench.
        await p.behavior.emitRealtime(LIVE_CHANNEL, { s: "s1", d: [{ k: "stage", id: 300, t: 1_800_000_000_000, c: 3, to: "measuring" }] });
        await waitFor(() => expect(within(p.getByRole("region", { name: "Candidates in the pipeline" })).getByRole("listitem", { name: "Bench: 2" })).toBeTruthy());
        const moves = calls.filter((f) => /translate\(-100px, 0px\)/u.test(JSON.stringify(f)));
        if (reduce) expect(calls).toHaveLength(0);
        else expect(moves.length).toBeGreaterThan(0);
        p.lifecycle.unmount();
      }
      // A page that renders no frames (a hidden tab) doesn't start animations that would freeze mid-flight.
      calls.length = 0;
      setReduced(false);
      w.requestAnimationFrame = () => 0;
      const hidden = await page("toy-size/live", { "study.live": async () => liveFixture() });
      await hidden.findByText("Live");
      await hidden.behavior.emitRealtime(LIVE_CHANNEL, { s: "s1", d: [{ k: "stage", id: 300, t: 1_800_000_000_000, c: 3, to: "measuring" }] });
      await waitFor(() => expect(within(hidden.getByRole("region", { name: "Candidates in the pipeline" })).getByRole("listitem", { name: "Bench: 2" })).toBeTruthy());
      expect(calls).toHaveLength(0);
    } finally {
      proto.animate = originalAnimate;
      proto.getBoundingClientRect = originalRect;
      w.requestAnimationFrame = originalRaf;
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });

  it("the Live tab switches to the compact layout when its area is narrow (e.g. beside an open side panel)", async () => {
    const proto = HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    try {
      const p = await page("toy-size/live", { "study.live": async () => liveFixture() });
      await p.findByText("Live");
      await waitFor(() => expect(p.container.querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("compact"));
      // Still offers to open beside the study thread (it is the Live tab).
      expect(p.getByRole("button", { name: "Open beside the study thread" })).toBeTruthy();
      p.lifecycle.unmount();
    } finally {
      proto.getBoundingClientRect = original;
    }
    const wide = await page("toy-size/live", { "study.live": async () => liveFixture() });
    await waitFor(() => expect(wide.container.querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("wide"));
  });

  it("groups the feed by candidate, newest group last", () => {
    const g = groupFeed([
      { id: 1, at: 0, candidate: 1, text: "c/1 tests started", tone: "info" },
      { id: 2, at: 0, candidate: null, text: "A worker picked idea #2", tone: "info" },
      { id: 3, at: 0, candidate: 2, text: "c/2 tests started", tone: "info" },
      { id: 4, at: 0, candidate: 1, text: "c/1 won", tone: "win" },
    ]);
    expect(g.map((x) => [x.candidate, x.items.map((i) => i.id)])).toEqual([
      [null, [2]],
      [2, [3]],
      [1, [1, 4]],
    ]);
  });
});
