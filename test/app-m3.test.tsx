// @vitest-environment jsdom
// M3 study page tabs (Findings, Oracle, Bench, Harvest) rendered against the
// real RPC handlers, with extra state seeded straight into the store.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Engine } from "../src/engine.ts";
import { DETERMINISTIC_SPEC, FakeHost, FakePort, fakeHostSpec, waitFor as waitUntil } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

const SPEC = fakeHostSpec(DETERMINISTIC_SPEC.replace('noise = "deterministic"\n', 'noise = "deterministic"\n\n[oracle.holdout]\nmeasure = "holdout-secret-cmd"\n'));

const METHODS = [
  "studies.list",
  "study.overview",
  "study.ideas",
  "study.candidates",
  "study.candidate",
  "study.findings",
  "study.oracle",
  "study.bench",
  "study.harvest",
  "study.report",
  "study.harvest.start",
  "study.pause",
  "study.resume",
  "study.concurrency",
];

// The full suite runs real-git tests in parallel; give async queries room under load.
configure({ asyncUtilTimeout: 8000 });

describe("frontend: M3 study tabs", () => {
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
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    await harness.behavior.callAgentTool("study_propose", { spec_toml: SPEC }, { threadId: "thr_study", projectId: "proj_1" });
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitUntil(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { summary: "drop trailing whitespace" }, { threadId: "thr_w1" });
    await waitUntil(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
  });
  afterEach(async () => {
    for (const p of pages.splice(0)) p.lifecycle.unmount();
    await harness.lifecycle.dispose();
  });

  function realRpc() {
    return Object.fromEntries(METHODS.map((m) => [m, (input: unknown) => harness.behavior.callRpc(m, input ?? null)])) as never;
  }
  const study = () => engine.study("toy-size");
  async function open(subPath: string) {
    const app = await loadPluginApp(() => import("../app.tsx"));
    const page = renderSlot(app.navPanels[0]!, { subPath }, { rpc: realRpc() });
    pages.push(page);
    return page;
  }

  it("parses the new tab routes", async () => {
    const { parseSubPath } = await import("../src/app/StudiesPage.tsx");
    expect(parseSubPath("toy-size/harvest")).toEqual({ slug: "toy-size", tab: "harvest", candidate: null, replay: null });
    expect(parseSubPath("toy-size/findings")).toMatchObject({ tab: "findings" });
    expect(parseSubPath("toy-size/candidates/3")).toEqual({ slug: "toy-size", tab: "candidates", candidate: 3, replay: null });
    expect(parseSubPath("toy-size/nope")).toMatchObject({ tab: "overview" });
  });

  it("findings: empty state", async () => {
    const page = await open("toy-size/findings");
    await page.findByText(/No findings yet/u);
  });

  it("findings: lists findings, searches with the query, opens the candidate and the thread", async () => {
    const s = study();
    const { store } = engine.ctx;
    const c1 = store.candidateByN(s.id, 1)!;
    store.addFinding({ study_id: s.id, idea_id: 1, candidate_id: c1.id, thread_id: "thr_w1", outcome: "win", learned: "Trailing whitespace was 20% of the output.", revisit_if: "the output format changes", evidence: "size 1000 -> 800" }, "test");
    store.addFinding({ study_id: s.id, idea_id: null, candidate_id: null, thread_id: null, outcome: "dead_end", learned: "Gzip is out of scope.", revisit_if: "", evidence: "" }, "test");
    const page = await open("toy-size/findings");
    await page.findByText("Trailing whitespace was 20% of the output.");
    expect(page.getByText("Gzip is out of scope.")).toBeTruthy();
    expect(page.getByText("the output format changes")).toBeTruthy();
    expect(page.getByLabelText("Findings").textContent).toMatch(/Shrink the output.*size.*c\/1.*win.*\+20\.0%/u);
    // A finding without an idea says so (no blank theme).
    expect(page.getByLabelText("Findings").textContent).toMatch(/not tied to an idea· no theme/u);

    fireEvent.change(page.getByLabelText("Search findings"), { target: { value: "gzip" } });
    await waitFor(() => expect(page.inspection.rpcCalls.some((c) => c.method === "study.findings" && (c.input as { query?: string }).query === "gzip")).toBe(true));
    await waitFor(() => expect(page.queryByText("Trailing whitespace was 20% of the output.")).toBeNull());
    expect(page.getByText("Gzip is out of scope.")).toBeTruthy();

    fireEvent.change(page.getByLabelText("Search findings"), { target: { value: "" } });
    fireEvent.change(page.getByLabelText("Filter by outcome"), { target: { value: "win" } });
    await page.findByText("Trailing whitespace was 20% of the output.");
    await waitFor(() => expect(page.queryByText("Gzip is out of scope.")).toBeNull());
    expect(page.inspection.rpcCalls.some((c) => c.method === "study.findings" && (c.input as { outcome?: string }).outcome === "win")).toBe(true);

    fireEvent.click(page.getByText("c/1"));
    expect(page.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel" });
    expect(JSON.stringify(page.inspection.navigateCalls.at(-1))).toContain("toy-size/candidates/1");
    fireEvent.click(page.getByText("Thread"));
    expect(page.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread" });
  });

  it("oracle: active TOML without the holdout command, pending spec diff and CLI command", async () => {
    const revised = SPEC.replace("Make the toy program's output smaller.", "Make the output much smaller.");
    await harness.behavior.callAgentTool("study_propose", { spec_toml: revised }, { threadId: "thr_study", projectId: "proj_1" });
    const page = await open("toy-size/oracle");
    const active = await page.findByLabelText("Active spec");
    expect(active.textContent).toContain('slug = "toy-size"');
    expect(active.textContent).toContain("[oracle.holdout] is configured and hidden");
    await page.findByText("Pending spec v2");
    expect(page.getByText("bb study approve toy-size")).toBeTruthy();
    const diff = page.getByLabelText("Pending spec diff").textContent ?? "";
    expect(diff).toContain("+ objective = \"Make the output much smaller.\"");
    expect(diff).toContain("- objective = \"Make the toy program's output smaller.\"");
    expect(page.getByLabelText("Segments").textContent).toMatch(/1\s*active/u);
    expect(page.getByLabelText("Spec versions").textContent).toMatch(/v2pending/u);
    expect(page.queryByRole("button", { name: /approve/iu })).toBeNull();
    expect(page.container.textContent).not.toContain("holdout-secret-cmd");
  });

  it("bench: health check and transfer rows", async () => {
    const s = study();
    const { store } = engine.ctx;
    const hostId = store.benchHosts(s.id)[0]!.host_id;
    store.addHealthCheck({ study_id: s.id, host_id: hostId, context: "pre-measure", ok: 0, problems_json: JSON.stringify(["load 7.5 above 2"]), report_json: JSON.stringify({ loadavg: [7.5, 3, 1], cpus: 8 }) });
    store.addTransfer({ study_id: s.id, host_id: hostId, sha: "abcdef1234567890", purpose: "candidate", bytes: 2048, chunks: 1, ms: 42, ok: 0, error: "bundle too large" });
    const page = await open("toy-size/bench");
    const health = await page.findByLabelText("Health checks");
    expect(health.textContent).toMatch(/pre-measure.*problems.*load 7\.5 above 2.*load 7\.50\/3\.00\/1\.00 on 8 CPUs/u);
    const transfers = page.getByLabelText("Bundle transfers");
    expect(transfers.textContent).toMatch(/abcdef1234.*candidate.*2\.0 KiB.*42 ms.*failed: bundle too large/u);
    expect(page.getByLabelText("Bench hosts")).toBeTruthy();
    expect(page.getByLabelText("Bench intervals").textContent).toContain("c/1");
  });

  it("harvest: empty state starts a dry run", async () => {
    const page = await open("toy-size/harvest");
    await page.findByText(/A dry run: nothing is pushed until you publish/u);
    expect(page.getByText("bb study harvest toy-size")).toBeTruthy();
    fireEvent.click(await page.findByRole("button", { name: "Start harvest…" }));
    // A deliberate step: the dialog says what happens, then the confirm button starts it.
    await page.findByText(/candidates in flight finish first/u);
    fireEvent.click(await page.findByRole("button", { name: "Start harvest" }));
    await waitFor(() => expect(page.inspection.rpcCalls.find((c) => c.method === "study.harvest.start")?.input).toEqual({ slug: "toy-size" }));
    await waitUntil(() => engine.ctx.store.latestHarvest(study().id) !== undefined);
    expect(study().state).toBe("harvesting");
    await page.findByText(/Harvest h1/u);
  });

  it("harvest: changesets, contribution, dependency, interaction warning, PR body, publish command", async () => {
    const s = study();
    const { store } = engine.ctx;
    store.setStudyState(s.id, "harvesting", "test");
    const h = store.insertHarvest({ study_id: s.id, from_state: "running", measure_standalone: 1 }, "test");
    const cs1 = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 1, title: "Drop trailing whitespace", rationale: "First win.", candidates_json: "[1]", commits_json: "[]", paths_json: '["src/a.ts"]' });
    const cs2 = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 2, title: "Compact the header", rationale: "Builds on #1.", candidates_json: "[1]", commits_json: "[]", paths_json: '["src/a.ts"]' });
    store.updateChangeset(cs1.id, { ablation_status: "measured", contribution: 0.05, ci_lo: 0.04, ci_hi: 0.06, n: 5, stack: 1, branch: "studies/toy-size/pr/1", pr_status: "drafted", pr_title: "Drop trailing whitespace", pr_body: "## Why\nWhitespace-body-marker", standalone_status: "pass" });
    store.updateChangeset(cs2.id, { ablation_status: "measured", contribution: 0.08, ci_lo: 0.07, ci_hi: 0.09, n: 5, depends_on_json: JSON.stringify([cs1.id]), dependency_reason: "touches the same lines", stack: 1, pr_base: "studies/toy-size/pr/1", standalone_status: "conflict", standalone_detail: "does not apply on base" });
    store.updateHarvest(h.id, {
      state: "ready",
      finished_at: Date.now(),
      grouping_source: "strategist",
      total_effect: 0.2,
      total_ci_lo: 0.19,
      total_ci_hi: 0.21,
      total_n: 5,
      total_vs_base: 0.2,
      stacks_json: JSON.stringify([{ stack: 1, members: [cs1.id, cs2.id], status: "not_needed", estimate: null, n: null, detail: null }]),
      publish_state: "dry-run",
      export_dir: "/exports/h1",
    });
    const page = await open("toy-size/harvest");
    const list = await page.findByLabelText("Changesets");
    // Contributions are shares of the base→best gain (0.05 of 0.2 = 25%), with the CI.
    expect(list.textContent).toMatch(/#1Drop trailing whitespace.*Contributes 25.0% of the gain \(CI 20.0% to 30.0%\).*5 pairs/u);
    expect(list.textContent).toMatch(/#2Compact the header.*Builds on #1/u);
    expect(list.textContent).toContain("#2 builds on this one.");
    expect(list.textContent).toMatch(/Ships in stack 1 \(#1 → #2\), as the first PR, based on main/u);
    expect(list.textContent).toContain("Alone on its PR base (stacked on studies/toy-size/pr/1): conflict: does not apply on base");
    expect(list.textContent).not.toContain("base base");
    expect(page.getByRole("alert").textContent).toMatch(/The changes interact/u);
    expect(page.getByLabelText("Stacks").textContent).toContain("#1 → #2");
    fireEvent.click(page.getByText(/PR preview: Drop trailing whitespace/u));
    expect(page.getByText(/Whitespace-body-marker/u)).toBeTruthy();
    expect(page.getByText("bb study harvest toy-size --publish")).toBeTruthy();
    expect(page.getByText("/exports/h1")).toBeTruthy();
    // Publishing is in the app now, behind a confirmation.
    expect(page.getByRole("button", { name: "Publish draft PRs…" })).toBeTruthy();
    // A new dry run is offered once this one is ready.
    fireEvent.click(page.getByRole("button", { name: "Start a new harvest…" }));
    fireEvent.click(await page.findByRole("button", { name: "Start harvest" }));
    await waitFor(() => expect(page.inspection.rpcCalls.find((c) => c.method === "study.harvest.start")?.input).toEqual({ slug: "toy-size", restart: true }));
    await waitUntil(() => store.harvests(s.id).length === 2);
    // Report on demand.
    fireEvent.click(page.getByRole("button", { name: "Show report" }));
    expect((await page.findByLabelText("Study report")).textContent).toContain("toy-size");
  });

  it("overview: provider usage line and a harvest link", async () => {
    const s = study();
    const h = engine.ctx.store.insertHarvest({ study_id: s.id, from_state: "running", measure_standalone: 1 }, "test");
    engine.ctx.store.updateHarvest(h.id, { state: "failed", finished_at: Date.now(), error: "boom" });
    const page = await open("toy-size/overview");
    expect((await page.findByLabelText("Provider usage")).textContent).toMatch(/Provider usage:/u);
    await page.findByText(/Harvest h1: failed/u);
    fireEvent.click(page.getByText("Open Harvest"));
    expect(JSON.stringify(page.inspection.navigateCalls.at(-1))).toContain("toy-size/harvest");
  });
});
