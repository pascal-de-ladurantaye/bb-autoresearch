// @vitest-environment jsdom
// Single-machine mode on the surfaces: Oracle tab, Overview, Bench tab, the
// Live bench strip ("testing c/N" holds the bench), `bb study show`, and the
// message.dispatch hook registration (quiet bench).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Engine } from "../src/engine.ts";
import type { LiveView } from "../src/live-model.ts";
import { FakeHost, FakePort, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

configure({ asyncUtilTimeout: 8000 });

const SPEC = `
[study]
slug = "toy-sm"
objective = "Make the toy program faster on this laptop."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"

[scope]
editable = ["src/**"]

[oracle]
gate = ["gate run"]
measure = "measure run"
noise = "noisy"
quiet_bench = true

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 4
calibration_pairs = 4
bootstrap = 200
confirm = false

[budget]
max_workers = 2
max_candidates = 5
`;

const METHODS = ["studies.list", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.oracle", "study.bench", "study.live", "study.notices.seen", "thread.badge", "thread.study"];

describe("frontend: single-machine mode", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  let engine: Engine;
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
    await harness.behavior.callAgentTool("study_propose", { spec_toml: SPEC }, { threadId: "thr_study", projectId: "proj_1" });
    await harness.behavior.runCli(["calibrate", "toy-sm", "--wait"]);
  });
  afterEach(async () => {
    for (const p of pages.splice(0)) p.lifecycle.unmount();
    await harness.lifecycle.dispose();
  });

  function rpc(over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    return { ...Object.fromEntries(METHODS.map((m) => [m, (input: unknown) => harness.behavior.callRpc(m, input ?? null)])), ...over } as never;
  }
  async function open(subPath: string, over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const page = renderSlot(app.navPanels[0]!, { subPath }, { rpc: rpc(over) });
    pages.push(page);
    return page;
  }

  it("registers the message.dispatch hook (quiet bench); it proceeds for threads that aren't workers", async () => {
    const hook = harness.registrations.hooks["message.dispatch"];
    expect(hook).toBeTruthy();
    const decision = await hook!({ thread: { id: "thr_human" }, attempt: "start-turn", host: { id: "host_test" }, environment: null } as never);
    expect(decision).toEqual({ action: "proceed" });
  });

  it("the Oracle tab and the calibration report say single-machine mode is on and what it does", async () => {
    const page = await open("toy-sm/oracle");
    const text = await page.findByLabelText("Single-machine mode");
    expect(text.textContent).toMatch(/Single-machine mode is on \(auto: a bench host is the edit machine\): gates take the bench lock/u);
    expect(text.textContent).toMatch(/Quiet bench is on/u);
    expect(text.textContent).toMatch(/neither is part of the oracle hash/u);
    expect(page.container.textContent).toMatch(/Single-machine mode: on · quiet bench/u);
    await waitFor(() => expect(page.container.textContent).toMatch(/Gates take [\d.]+ s on the edit host, holding the bench/u));
  });

  it("bb study show prints the single-machine line; Overview, Bench and Live show the gate holding the bench", async () => {
    const show = await harness.behavior.runCli(["show", "toy-sm"]);
    expect(show.stdout).toMatch(/Single machine:\s+Single-machine mode is on/u);
    await harness.behavior.runCli(["ideas", "add", "toy-sm", "Faster loop", "--theme", "loop"]);
    await harness.behavior.runCli(["start", "toy-sm"]);
    await waitUntil(() => port.spawned.length >= 1);
    // Hold the gate so the page sees it on the bench.
    host.delays = { gate: 1500, measure: 1 };
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 1100);
    await harness.behavior.callAgentTool("study_submit_candidate", { title: "unroll the loop" }, { threadId: "thr_w1" });
    await waitUntil(() => host.active.gate > 0);
    const shown = await harness.behavior.runCli(["show", "toy-sm"]);
    expect(shown.stdout).toMatch(/testing c\/1 \(gates hold the bench\)/u);
    const ov = await open("toy-sm/overview");
    await waitFor(() => expect(ov.getByLabelText("Bench hosts").textContent).toMatch(/testing c\/1 \(single-machine mode: tests hold the bench\)/u));
    ov.lifecycle.unmount();
    const bench = await open("toy-sm/bench");
    await waitFor(() => expect(bench.getByLabelText("Bench hosts").textContent).toMatch(/testing c\/1/u));
    expect(bench.container.textContent).toMatch(/Single-machine mode is on/u);
    bench.lifecycle.unmount();
    const live = await open("toy-sm/live");
    const strip = await live.findByRole("region", { name: "Bench" });
    await waitFor(() => expect(strip.textContent).toMatch(/c\/1.*testing \(single-machine mode: tests hold the bench\)/u));
    expect(strip.textContent).toMatch(/Single-machine mode: tests and measurements take turns on the bench; new worker turns wait while a measurement runs/u);
    await waitUntil(() => engine.ctx.store.candidateByN(engine.study("toy-sm").id, 1)?.stage === "decided", 15_000);
  });

  it("the Live queue marks candidates waiting to run their tests", async () => {
    const base = (await harness.behavior.callRpc("study.live", { slug: "toy-sm" })) as LiveView;
    const fixture: LiveView = {
      ...base,
      state: "running",
      queue: [3, 4],
      queueTests: [4],
      bench: [{ hostId: "host_test", name: "local", status: "online", healthOk: true, deferredUntil: null, current: { kind: "gate", n: 2, startedAt: base.now - 5000 }, utilization: 0.5, windowSeconds: 600 }],
      singleMachine: { text: "Single-machine mode is on.", quietBench: false },
    };
    const live = await open("toy-sm/live", { "study.live": async () => fixture });
    const strip = await live.findByRole("region", { name: "Bench" });
    await waitFor(() => expect(strip.textContent).toMatch(/c\/2.*testing/u));
    expect(live.getByRole("button", { name: "c/4, 2nd in the bench queue, waiting to run its tests. Open the candidate." })).toBeTruthy();
    expect(live.getByRole("button", { name: "c/3, 1st in the bench queue. Open the candidate." })).toBeTruthy();
    expect(strip.textContent).not.toMatch(/new worker turns wait/u);
  });
});
