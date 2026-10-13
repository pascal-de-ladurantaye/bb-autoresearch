// @vitest-environment jsdom
// The study page and header badge rendered against the real RPC handlers
// (fake plugin host + fake bench host behind them).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

// The full suite runs real-git tests in parallel; give async queries room under load.
configure({ asyncUtilTimeout: 8000 });

describe("frontend: Studies panel and thread badge", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;

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
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitUntil(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { title: "drop trailing whitespace" }, { threadId: "thr_w1" });
    await waitUntil(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
  });
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });

  /** RPC handlers for renderSlot that forward to the real plugin. */
  function realRpc() {
    const methods = ["studies.list", "study.overview", "study.ideas", "study.candidates", "study.candidate", "thread.badge", "study.pause", "study.resume", "study.concurrency", "ideas.add", "ideas.update", "ideas.reorder", "ideas.veto"];
    return Object.fromEntries(methods.map((m) => [m, (input: unknown) => harness.behavior.callRpc(m, input ?? null)])) as never;
  }

  it("registers the Studies nav panel and the thread header badge", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    expect(app.navPanels.map((p) => p.path)).toEqual(["studies"]);
    expect(app.threadHeaderActions.map((a) => a.id)).toEqual(["study-badge"]);
  });

  it("lists studies and opens the study page", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const list = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: realRpc() });
    await list.findByText("toy-size");
    // Better is positive, in the metric's own words.
    expect(await list.findByText("20.0% lower size")).toBeTruthy();
    fireEvent.click(list.getByText("toy-size"));
    expect(list.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel" });
    list.lifecycle.unmount();

    const page = renderSlot(app.navPanels[0]!, { subPath: "toy-size/overview" }, { rpc: realRpc() });
    await page.findByText("Trajectory");
    await page.findByText(/Best vs base \(size, lower is better\)/u);
    expect(page.getAllByText("20.0% lower size").length).toBeGreaterThan(0);
    // The raw values travel with the improvement.
    expect(page.getByText(/1,000 → 800/u)).toBeTruthy();
    // M2: bench hosts with health, drift and segment on the Overview.
    await page.findByText(/Bench hosts \(1\) · segment 1/u);
    expect(page.getByLabelText("Bench hosts").textContent).toMatch(/local checkouts.*healthy.*drift not run/u);
    // Pause from the page: the real handler runs.
    fireEvent.click(await page.findByText("Pause"));
    await waitFor(() => expect(page.inspection.rpcCalls.some((c) => c.method === "study.pause")).toBe(true));
    expect((await harness.behavior.callRpc("studies.list", null)) as { studies: Array<{ state: string }> }).toMatchObject({ studies: [{ state: "paused" }] });
  });

  it("shows the idea board and the candidates table with a detail view", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const ideas = renderSlot(app.navPanels[0]!, { subPath: "toy-size/ideas" }, { rpc: realRpc() });
    await ideas.findByText("Shrink the output");
    expect(ideas.getByText("Running · 1")).toBeTruthy();
    expect(ideas.getByText("Queued · 0")).toBeTruthy();
    ideas.lifecycle.unmount();

    const cands = renderSlot(app.navPanels[0]!, { subPath: "toy-size/candidates/1" }, { rpc: realRpc() });
    // The worker's commit message, used verbatim for the candidate and its commit on best.
    const message = await cands.findByLabelText("Commit message");
    expect(message.textContent).toContain("drop trailing whitespace");
    expect(message.textContent).toContain("its commit on best");
    expect(cands.getByText("Commit message (the worker's)")).toBeTruthy();
    await cands.findByText(/Samples \(size/u);
    expect((await cands.findAllByText("src/a.ts")).length).toBeGreaterThan(0);
    await cands.findByText("Diff · 1 file(s)");
    fireEvent.click(await cands.findByText("Worker thread"));
    expect(cands.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread" });
  });

  it("badge: study and worker threads get one, other threads don't", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const badge = app.threadHeaderActions[0]!;
    const study = renderSlot(badge, { threadId: "thr_study", projectId: "proj_1", isCompactViewport: false }, { rpc: realRpc() });
    await study.findByText(/20\.0% lower size · 1 worker/u);
    study.lifecycle.unmount();
    const worker = renderSlot(badge, { threadId: "thr_w1", projectId: "proj_1", isCompactViewport: false }, { rpc: realRpc() });
    await worker.findByText(/toy-size · idea #1 · submission 1\/2/u);
    worker.lifecycle.unmount();
    const other = renderSlot(badge, { threadId: "thr_x", projectId: "proj_1", isCompactViewport: false }, { rpc: realRpc() });
    await waitFor(() => expect(other.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(other.container.textContent).toBe("");
  });
});
