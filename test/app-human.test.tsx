// @vitest-environment jsdom
// The human interface in the app: every tab's loading, error, empty and
// populated states, the Needs-you area and its confirmed actions, keyboard
// tabs, secondary metrics and guardrail status, the nav badge, and the
// publish dialog. Real RPC handlers unless a state needs a stub.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Engine } from "../src/engine.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

const METHODS = [
  "studies.list",
  "studies.attention",
  "study.overview",
  "study.ideas",
  "study.candidates",
  "study.candidate",
  "study.findings",
  "study.oracle",
  "study.bench",
  "study.harvest",
  "study.harvest.plan",
  "study.harvest.publish",
  "study.harvest.start",
  "study.report",
  "study.spec.approve",
  "study.start",
  "study.pause",
  "study.resume",
  "study.archive",
  "study.notices.seen",
  "thread.badge",
];

// The full suite runs real-git tests in parallel; give async queries room under load.
configure({ asyncUtilTimeout: 8000 });

describe("frontend: human interface", () => {
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
    const fake = createFakePluginHost({ pluginId: "autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
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
  async function open(subPath: string, over: Record<string, (input: unknown) => Promise<unknown>> = {}) {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const page = renderSlot(app.navPanels[0]!, { subPath }, { rpc: rpc(over) });
    pages.push(page);
    return page;
  }
  const hang = () => new Promise<never>(() => undefined);
  const boom = () => Promise.reject(new Error("server unavailable"));
  async function runningWithWin() {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitUntil(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { summary: "drop trailing whitespace" }, { threadId: "thr_w1" });
    await waitUntil(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
  }

  it("draft: Needs you leads, and approving goes through a dialog that states what happens", async () => {
    const page = await open("toy-size/overview");
    await page.findByText("Needs you");
    expect(page.getByText("Approve spec v1 and calibrate")).toBeTruthy();
    expect(page.getByText(/Draft: spec v1 waits for your approval/u)).toBeTruthy();
    // No running-state clutter for a draft.
    expect(page.queryByText(/Workers \(/u)).toBeNull();
    fireEvent.click(page.getByRole("button", { name: "Approve and calibrate…" }));
    await page.findByText(/repeated A\/A measurements on 1 bench host/u);
    expect(page.getAllByText("bb study calibrate toy-size").length).toBeGreaterThan(0);
    expect(page.inspection.rpcCalls.some((c) => c.method === "study.spec.approve")).toBe(false);
    fireEvent.click(page.getByRole("button", { name: "Approve and calibrate" }));
    await waitFor(() => expect(page.inspection.rpcCalls.find((c) => c.method === "study.spec.approve")?.input).toEqual({ slug: "toy-size", version: 1, confirm: true }));
    await engine.waitForCalibration("toy-size", 10_000);
    await waitUntil(() => engine.study("toy-size").calibration_status === "ready");
    // Then: start, from the Oracle tab this time (close the first page: queries are document-wide).
    for (const p of pages.splice(0)) p.lifecycle.unmount();
    const oracle = await open("toy-size/oracle");
    fireEvent.click(await oracle.findByRole("button", { name: "Approve and start…" }));
    await oracle.findByText(/Up to 1 worker thread spawn/u);
    fireEvent.click(oracle.getByRole("button", { name: "Approve and start" }));
    await waitFor(() => expect(oracle.inspection.rpcCalls.find((c) => c.method === "study.start")?.input).toEqual({ slug: "toy-size", confirm: true }));
    await waitUntil(() => engine.study("toy-size").state === "running");
  });

  it("tabs are a keyboard tablist", async () => {
    const page = await open("toy-size/overview");
    const tab = await page.findByRole("tab", { name: /overview/iu });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    expect(JSON.stringify(page.inspection.navigateCalls.at(-1))).toContain("toy-size/ideas");
    fireEvent.keyDown(tab, { key: "End" });
    expect(JSON.stringify(page.inspection.navigateCalls.at(-1))).toContain("toy-size/harvest");
    expect(page.getByRole("tabpanel")).toBeTruthy();
  });

  it("loading and error states: the page and every tab", async () => {
    const close = () => {
      for (const p of pages.splice(0)) p.lifecycle.unmount();
    };
    const loading = await open("toy-size/overview", { "study.overview": hang });
    await loading.findByRole("status", { name: "Loading study…" });
    close();
    const failing = await open("toy-size/overview", { "study.overview": boom });
    await failing.findByText(/Couldn't load the study: server unavailable/u);
    expect(failing.getByRole("button", { name: "Retry" })).toBeTruthy();
    close();
    const tabs: Array<[string, string, string]> = [
      ["findings", "study.findings", "Loading findings…"],
      ["oracle", "study.oracle", "Loading the oracle…"],
      ["bench", "study.bench", "Loading the bench…"],
      ["harvest", "study.harvest", "Loading the harvest…"],
      ["candidates", "study.candidates", "Loading candidates…"],
    ];
    for (const [tab, method, label] of tabs) {
      const l = await open(`toy-size/${tab}`, { [method]: hang });
      await l.findByRole("status", { name: label });
      close();
      const e = await open(`toy-size/${tab}`, { [method]: boom });
      await e.findByText(/server unavailable/u);
      expect(e.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
      close();
    }
    const ideas = await open("toy-size/ideas", { "study.ideas": hang });
    await ideas.findByRole("status", { name: "Loading ideas…" });
  });

  it("empty states say what will fill them", async () => {
    const cands = await open("toy-size/candidates");
    await cands.findByText(/No candidates yet: workers submit them once the study is running/u);
    const findings = await open("toy-size/findings");
    await findings.findByText(/No findings yet/u);
    const bench = await open("toy-size/bench");
    await bench.findByText(/No drift checks yet/u);
    const harvest = await open("toy-size/harvest");
    await harvest.findByText(/Nothing to harvest yet: no candidate has been promoted/u);
    expect((harvest.getByRole("button", { name: "Start harvest…" }) as HTMLButtonElement).disabled).toBe(true);
    const overview = await open("toy-size/overview");
    await overview.findByText(/The trajectory appears once candidates are measured/u);
  });

  it("populated: best vs base in words, guardrails on the Overview and per candidate", async () => {
    await runningWithWin();
    const page = await open("toy-size/overview");
    await page.findAllByText("20.0% lower size");
    expect(page.getByText(/1,000 → 800 bytes/u)).toBeTruthy();
    const sec = await page.findByLabelText("Secondary metrics");
    expect(sec.textContent).toMatch(/rss.*guardrail · lower is better.*100 → 100.*no change vs the segment base.*ok/u);
    const cands = await open("toy-size/candidates");
    const table = await cands.findByLabelText("Candidates");
    expect(table.textContent).toMatch(/c\/1.*win.*\+20\.0%.*ok \(1\)/u);
    const detail = await open("toy-size/candidates/1");
    const metrics = await detail.findByLabelText("Metrics");
    expect(metrics.textContent).toMatch(/sizeprimary · lower is better1,000 bytes800 bytes\+20\.00% · 20\.00% lower size/u);
    expect(metrics.textContent).toMatch(/rssguardrail · lower is better/u);
  });

  it("guardrail states render with words (warn, broken) and informational metrics have no direction", async () => {
    await runningWithWin();
    const { store } = engine.ctx;
    const c = store.candidateByN(engine.study("toy-size").id, 1)!;
    store.updateCandidate(c.id, { metrics_json: JSON.stringify({ best: { size: 1000, rss: 100, wall_ms: 10 }, candidate: { size: 800, rss: 104.5, wall_ms: 12 }, guardrails: { rss: 0.045 } }) });
    const warn = await open("toy-size/candidates");
    expect((await warn.findByLabelText("Candidates")).textContent).toContain("rss near limit");
    for (const p of pages.splice(0)) p.lifecycle.unmount();
    store.updateCandidate(c.id, { metrics_json: JSON.stringify({ best: { size: 1000, rss: 100, wall_ms: 10 }, candidate: { size: 800, rss: 110, wall_ms: 12 }, guardrails: { rss: 0.1 } }) });
    const broken = await open("toy-size/candidates/1");
    expect((await broken.findByLabelText("Candidates")).textContent).toContain("rss BROKEN");
    const metrics = await broken.findByLabelText("Metrics");
    expect(metrics.textContent).toMatch(/rssguardrail · lower is better100110.*BROKEN/u);
    expect(metrics.textContent).toMatch(/wall_msinformational1012\+20\.0% \(informational, no direction\)/u);
  });

  it("no secondary metrics: the section is absent", async () => {
    await harness.lifecycle.dispose();
    host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    const noGuardrail = fakeHostSpec().replace('[[guardrail]]\nname = "rss"\nmax_regression = "5%"\n', "");
    await harness.behavior.callAgentTool("study_propose", { spec_toml: noGuardrail }, { threadId: "thr_study", projectId: "proj_1" });
    const page = await open("toy-size/overview");
    await page.findByText("Needs you");
    expect(page.queryByText(/Secondary metrics/u)).toBeNull();
  });

  it("the nav badge counts what needs the human; the study list marks it", async () => {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const Accessory = app.navPanels[0]!.experimental_sidebarAccessory!;
    const badge = renderSlot({ component: Accessory } as never, {}, { rpc: rpc() });
    pages.push(badge);
    await badge.findByLabelText("1 item need you");
    const list = await open("");
    await list.findByText(/needs you/u);
    expect(list.getByRole("button", { name: "New study" })).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "New study" }));
    expect(list.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toCompose" });
  });

  it("publish dialog shows the plan and why it can't run yet", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    const s = engine.study("toy-size");
    const { store } = engine.ctx;
    store.setStudyState(s.id, "harvesting", "test");
    const h = store.insertHarvest({ study_id: s.id, from_state: "paused", measure_standalone: 1 }, "test");
    const cs = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 1, title: "Drop whitespace", rationale: "", candidates_json: "[]", commits_json: "[]", paths_json: "[]" });
    store.updateChangeset(cs.id, { branch: "studies/toy-size/harvest/h1/01-drop", standalone_sha: "abc1234", standalone_status: "pass", pr_title: "Drop whitespace", pr_body: "body" });
    store.updateHarvest(h.id, { state: "ready", finished_at: Date.now(), publish_state: "dry-run" });
    const page = await open("toy-size/harvest");
    fireEvent.click(await page.findByRole("button", { name: "Publish draft PRs…" }));
    await page.findByText(/Publishing can't run yet/u);
    expect(page.getByText(/no remote named "origin"/u)).toBeTruthy();
    expect(page.getAllByText("studies/toy-size/harvest/h1/01-drop").length).toBeGreaterThan(0);
    const confirm = page.getByRole("button", { name: /Push 1 branch and open draft PRs/u }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
