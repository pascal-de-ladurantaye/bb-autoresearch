// @vitest-environment jsdom
// v0.2.1 fixes, rendered: the Oracle tab's noise sentence per noise class,
// a guardrail loss explained on the Candidates list, the Live card, the feed
// and in replay, single-run wording on the bench strip and the CI band of a
// deterministic measurement, and the Overview's state-aware "Now" hint.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { MeasureBand } from "../src/band.ts";
import type { Engine } from "../src/engine.ts";
import type { LiveView } from "../src/live-model.ts";
import { noiseFloorText } from "../src/present.ts";
import { deterministicWords } from "../src/app/live/CiBand.tsx";
import { nowHint } from "../src/app/format.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

configure({ asyncUtilTimeout: 8000 });

const METHODS = ["studies.list", "studies.attention", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.oracle", "study.bench", "study.live", "study.replay", "thread.study", "thread.badge", "study.notices.seen", "study.archive"];
const T = 1_800_000_000_000;

function detView(band: MeasureBand | null, pairs = { run: "measure" as const, done: 0, of: 1 }): LiveView {
  return {
    studyId: "s1",
    slug: "toy-size",
    state: "running",
    statusLine: "Running: 1 worker editing, measuring c/2.",
    metric: { name: "size", unit: "bytes", direction: "lower" },
    noise: "deterministic",
    now: T,
    lastEventId: 10,
    studyThreadId: "thr_study",
    best: { text: null, n: null, at: null, value: null, movedAt: null, history: [], rebases: [] },
    counts: { candidates: 2, maxCandidates: 6, workers: 1, targetWorkers: 1, queue: 0 },
    workers: [],
    cards: [{ n: 2, ideaId: 3, ideaTitle: "Shrink", workerKey: null, stage: "measuring", column: "bench", stageAt: T - 5000, verdict: null, effect: null, effectText: null, cause: null, hostId: "host_test", pairs, rebases: 0, submittedAt: T - 9000, decidedAt: null }],
    queue: [],
    bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: true, deferredUntil: null, current: { kind: "measure", n: 2, stage: "measuring", pairs, startedAt: T - 5000 }, utilization: 0.5, windowSeconds: 600 }],
    ideas: { next: [], total: 0 },
    feed: [],
    bands: band ? [band] : [],
  };
}

const detBand = (over: Partial<Extract<MeasureBand, { kind: "deterministic" }>> = {}): MeasureBand => ({ kind: "deterministic", candidate: 20, n: 2, startedAt: T - 5000, guardrails: [], final: null, tolerance: 0, best: null, value: null, effect: null, ...over });

describe("frontend: v0.2.1 fixes", () => {
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
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch", "study-harvest"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    // The default test spec is deterministic, with an rss guardrail of 5% per step.
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
  async function runningWithGuardrailLoss() {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitUntil(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800); // 20% smaller
    host.rss.set("T1", 130); // 30% more memory: beyond the 5% guardrail
    await harness.behavior.callAgentTool("study_submit_candidate", { title: "cache everything" }, { threadId: "thr_w1" });
    await waitUntil(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
  }

  it("Oracle tab: a deterministic oracle states its tolerance (no 'per pair', no MDE); a missing floor reads 'not measured'", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await waitUntil(() => engine.study("toy-size").calibration_status === "ready");
    const p = await page("toy-size/oracle");
    const text = await waitFor(() => {
      const t = p.getByText(/Deterministic: single runs, no spread/u).textContent ?? "";
      expect(t).toBeTruthy();
      return t;
    });
    expect(text).toMatch(/a candidate wins when it beats best by more than the tolerance \(0\.00%\)/u);
    expect(p.container.textContent).not.toMatch(/per pair/u);
    expect(p.container.textContent).not.toMatch(/A win must improve by more than/u);
    p.lifecycle.unmount();
    // A noisy oracle without a noise floor (an imported study): "not measured", never "0.00% per pair".
    const real = (await harness.behavior.callRpc("study.oracle", { slug: "toy-size" })) as { calibration: { hosts: Array<Record<string, unknown>> } };
    const patched = { ...real, calibration: { ...real.calibration, noise: "noisy", noiseText: noiseFloorText("noisy", [null]), hosts: real.calibration.hosts.map((h) => ({ ...h, noiseFloor: null })) } };
    const q = await page("toy-size/oracle", { "study.oracle": async () => patched });
    await q.findByText(/Run-to-run noise: not measured\./u);
    expect(q.container.textContent).toMatch(/A win must improve by more than/u);
    expect(q.container.textContent).not.toMatch(/0\.00% per pair/u);
  });

  it("a guardrail loss says why on the Candidates list, the Live card, the feed and in replay, never just 'lose' next to a gain", async () => {
    await runningWithGuardrailLoss();
    const cause = /lost on guardrail rss \(30\.0% worse\)/u;
    const list = await page("toy-size/candidates");
    const table = await list.findByRole("table", { name: "Candidates" });
    await waitFor(() => expect(within(table).getAllByRole("row")[1]!.textContent).toMatch(cause));
    // Deterministic: a single value, not "+20.0% to +20.0%".
    expect(within(table).getAllByRole("row")[1]!.textContent).toMatch(/\+20\.0% \(single run\)/u);
    expect(within(table).getAllByRole("row")[1]!.textContent).not.toMatch(/\+20\.0% to \+20\.0%/u);
    list.lifecycle.unmount();
    const live = await page("toy-size/live");
    const pipeline = await live.findByRole("region", { name: "Candidates in the pipeline" });
    const card = await within(pipeline).findByRole("button", { name: /^c\/1, Shrink the output: lose, lost on guardrail rss \(30\.0% worse\)\./u });
    expect(card.textContent).not.toMatch(/20\.0% lower size/u);
    // The feed groups lines under "c/1 · <idea>".
    const feed = live.getByRole("log").textContent ?? "";
    expect(feed).toMatch(/c\/1 · Shrink the output.*lost on guardrail rss \(30\.0% worse\), despite 20\.0% lower size/u);
    // Deterministic: one run each side, not "1 pair".
    expect(feed).toMatch(/measured: one run each in /u);
    expect(feed).not.toMatch(/1 pair/u);
    live.lifecycle.unmount();
    const replay = await page("toy-size/live/replay/99999999");
    const rp = await replay.findByRole("region", { name: "Candidates in the pipeline" });
    await within(rp).findByRole("button", { name: /^c\/1, Shrink the output: lose, lost on guardrail rss \(30\.0% worse\)\./u });
    // Its CI band shows the primary metric's test; the verdict line under it says what decided it.
    expect((await replay.findByRole("article", { name: "CI band of c/1" })).textContent).toMatch(/Verdict: lose · lost on guardrail rss \(30\.0% worse\)/u);
  });

  it("the bench strip and card of a deterministic measurement say which run, never 'pair 0'", async () => {
    const cases: Array<[MeasureBand | null, RegExp]> = [
      [detBand(), /running best/u],
      [detBand({ best: { v: 1000, at: T - 4000 } }), /running the candidate/u],
      [null, /run 1 of 1/u],
    ];
    for (const [band, words] of cases) {
      const p = await page("toy-size/live", { "study.live": async () => detView(band) });
      const bench = await p.findByRole("region", { name: "Bench" });
      expect(bench.textContent).toMatch(words);
      expect(bench.textContent).not.toMatch(/pair 0/u);
      const pipeline = p.getByRole("region", { name: "Candidates in the pipeline" });
      expect(within(pipeline).getByRole("button", { name: /^c\/2, Shrink: measuring/u }).textContent).toMatch(words);
      expect(pipeline.textContent).not.toMatch(/pair/u);
      p.lifecycle.unmount();
      pages.splice(0);
    }
  });

  it("the CI band of a deterministic measurement reads naturally: one run, its value against the tolerance", async () => {
    expect(deterministicWords({ tolerance: 0, effect: null, best: null })).toBe("Single run: running best, then the candidate (one run each, no spread).");
    expect(deterministicWords({ tolerance: 0, effect: null, best: { v: 1, at: 1 } })).toBe("Single run: best done, running the candidate.");
    expect(deterministicWords({ tolerance: 0, effect: 0.25, best: null })).toBe("Single run: +25.00% vs best: better, so a win (no tolerance).");
    expect(deterministicWords({ tolerance: 0.005, effect: -0.02, best: null })).toBe("Single run: −2.00% vs best, worse by more than the 0.50% tolerance: lose.");
    expect(deterministicWords({ tolerance: 0.005, effect: 0.001, best: null })).toBe("Single run: +0.10% vs best, within the ±0.50% tolerance: inconclusive.");
    const p = await page("toy-size/live", { "study.live": async () => detView(detBand({ tolerance: 0, best: { v: 1000, at: T - 4000 }, value: { v: 750, at: T - 1000 }, effect: 0.25 }), { run: "measure", done: 1, of: 1 }) });
    const article = await p.findByRole("article", { name: "CI band of c/2" });
    expect(article.textContent).toMatch(/deterministic, single run/u);
    expect(article.textContent).toMatch(/Single run: \+25\.00% vs best: better, so a win \(no tolerance\)\. 1,000 → 750 bytes\./u);
    expect(article.textContent).not.toMatch(/±0\.00%/u);
  });

  it("the Overview's 'Now' hint follows the state: no 'before the study starts' once it has run", async () => {
    const o = { workers: 0, targetWorkers: 2, maxWorkers: 3, maxWorkersOverride: null };
    expect(nowHint({ ...o, state: "draft" })).toBe("no workers before the study starts");
    expect(nowHint({ ...o, state: "calibrating" })).toBe("no workers before the study starts");
    expect(nowHint({ ...o, state: "running" })).toBe("target 2 now (W), max 3");
    expect(nowHint({ ...o, state: "paused" })).toBe("paused: no new workers until you resume");
    expect(nowHint({ ...o, state: "paused", workers: 1 })).toBe("paused: 1 finishing, no new workers until you resume");
    expect(nowHint({ ...o, state: "harvesting" })).toBe("harvesting: no new workers");
    expect(nowHint({ ...o, state: "archived" })).toBe("workers stopped for good");
    const draft = await page("toy-size/overview");
    await draft.findByText("no workers before the study starts");
    draft.lifecycle.unmount();
    await runningWithGuardrailLoss();
    await harness.behavior.runCli(["archive", "toy-size"]);
    await waitUntil(() => engine.study("toy-size").state === "archived");
    const archived = await page("toy-size/overview");
    await archived.findByText("workers stopped for good");
    expect(archived.queryByText("no workers before the study starts")).toBeNull();
  });
});
