// In-app approval, start, harvest (a freeze) and archive (RPC), the
// Needs-you derivation behind them, notices with actions, and the study
// thread messages (short summary, agent-only detail).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Engine } from "../src/engine.ts";
import { needsYou, noticeAction } from "../src/views.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

describe("human interface: in-app actions and Needs you", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  let engine!: Engine;
  const call = async <T = any>(method: string, input?: unknown, caller?: { kind: "plugin"; pluginId: string }) =>
    (await harness.behavior.callRpc(method, input ?? null, caller ? { experimental_caller: caller } : undefined)) as T;
  const study = () => engine.study("toy-size");
  const kinds = () => needsYou(engine, study()).map((n) => n.kind);
  const events = (kind: string) => engine.ctx.store.events(study().id, { kinds: [kind] });

  beforeEach(async () => {
    host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch", "study-harvest"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0, harvestPollMs: 5 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec() }, { threadId: "thr_study", projectId: "proj_1" });
  });
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });

  it("approve the spec in the app: confirmation required, version checked, audited with a notice", async () => {
    expect(kinds()).toEqual(["approve_spec"]);
    await expect(call("study.spec.approve", { slug: "toy-size", version: 1 })).rejects.toThrow(/confirmation required: this approves spec v1 of toy-size and starts calibration/u);
    await expect(call("study.spec.approve", { slug: "toy-size", version: 7, confirm: true })).rejects.toThrow(/spec v7 is not the one waiting \(v1 is\)/u);
    await expect(call("study.spec.approve", { slug: "toy-size", version: 1, confirm: true }, { kind: "plugin", pluginId: "other" })).rejects.toThrow(/for humans/u);
    expect(study().state).toBe("draft");
    const r = await call("study.spec.approve", { slug: "toy-size", version: 1, confirm: true });
    expect(r.message).toContain("Spec v1 approved");
    await engine.waitForCalibration("toy-size", 10_000);
    const audit = events("control.calibrate");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe("rpc:client");
    expect(engine.ctx.store.notices(study().id).some((n) => n.kind === "control.calibrate" && n.text.includes("spec v1 approved and calibration started"))).toBe(true);
    // Calibration is ready: the next thing that needs the human is starting.
    expect(kinds()).toEqual(["start"]);
    expect(noticeAction("calibration.ready", study())).toMatchObject({ tab: "oracle", label: "Review calibration and start" });
  });

  it("start in the app: only after calibration, confirmation required, audited", async () => {
    await expect(call("study.start", { slug: "toy-size", confirm: true })).rejects.toThrow(/no finished calibration to approve/u);
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await expect(call("study.start", { slug: "toy-size" })).rejects.toThrow(/confirmation required: this approves the calibration of toy-size and starts running/u);
    expect((await call("study.start", { slug: "toy-size", confirm: true })).message).toContain("is running");
    expect(study().state).toBe("running");
    expect(events("control.start")).toHaveLength(1);
    expect(kinds()).toEqual([]);
  });

  it("a pending spec without an oracle change is applied in place", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec().replace("max_candidates = 3", "max_candidates = 4") }, { threadId: "thr_study", projectId: "proj_1" });
    const item = needsYou(engine, study()).find((n) => n.kind === "pending_spec")!;
    expect(item.action).toEqual({ kind: "approve_spec", version: 2, changesOracle: false });
    const r = await call("study.spec.approve", { slug: "toy-size", version: 2, confirm: true });
    expect(r.message).toContain("spec v2 applied");
    expect(study().spec_version).toBe(2);
    expect(events("control.approve")).toHaveLength(1);
  });

  it("budget exhausted asks for a harvest; a frozen harvest asks for an agent", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await engine.systemPause(study().id, "budget exhausted: 3/3 candidates");
    expect(kinds()).toEqual(["budget_exhausted"]);
    expect(needsYou(engine, study())[0]!.action).toEqual({ kind: "harvest" });
    const notice = engine.ctx.store.notices(study().id).find((n) => n.kind === "budget.exhausted")!;
    expect(notice.text).toMatch(/paused itself: budget exhausted.*Next: harvest the wins on the Harvest tab/u);
    await call("study.harvest.start", { slug: "toy-size" });
    await engine.waitForHarvest("toy-size", 10_000);
    expect(kinds()).toEqual(["harvest_frozen"]);
    expect(needsYou(engine, study())[0]).toMatchObject({ title: expect.stringContaining("ask an agent to harvest it"), action: { kind: "open_harvest" }, command: "bb study evidence toy-size" });
    // The attention count for the nav panel.
    expect((await call("studies.attention")).total).toBe(1);
  });

  it("a drift pause is an alert that names the fix", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await engine.systemPause(study().id, "noise drift on local: 4.0× the calibrated noise");
    const [item] = needsYou(engine, study());
    expect(item).toMatchObject({ kind: "drift", tone: "alert", tab: "bench", action: { kind: "resume" } });
    // A pause by the human needs nothing.
    await call("study.resume", { slug: "toy-size" });
    await call("study.pause", { slug: "toy-size" });
    expect(kinds()).toEqual([]);
  });

  it("a failed calibration is an alert plus a fresh approval once the spec is revised", async () => {
    host.gateFailures.set("T0", 99);
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    expect(study().calibration_status).toBe("failed");
    expect(kinds()).toEqual(["calibration_failed", "approve_spec"]);
    expect(needsYou(engine, study())[0]!.detail).toContain("Ask the study thread to revise the spec");
  });

  it("a harvest the plugin drafted before 1.0 stays readable; publishing and keep/drop are gone", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    const s = study();
    const { store } = engine.ctx;
    store.setStudyState(s.id, "harvesting", "test");
    const h = store.insertHarvest({ study_id: s.id, from_state: "paused" }, "test");
    const a = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 1, title: "A", rationale: "", candidates_json: "[]", commits_json: "[]", paths_json: "[]" });
    store.updateChangeset(a.id, { branch: "studies/toy-size/harvest/h1/01-a", standalone_sha: "aaa1111", standalone_status: "pass", pr_title: "A", pr_body: "a", human_choice: "keep" });
    store.updateHarvest(h.id, { state: "ready", finished_at: Date.now(), publish_state: "dry-run", grouping_source: "strategist" });
    const v = await call("study.harvest", { slug: "toy-size" });
    expect(v.harvest).toMatchObject({ legacy: true, frozenRef: null });
    expect(v.harvest.changesets[0]).toMatchObject({ k: 1, choice: "keep", pr: { branch: "studies/toy-size/harvest/h1/01-a", body: "a" } });
    expect(v.harvest).not.toHaveProperty("canPublish");
    // It asks for an agent to finish it, never for the plugin to publish.
    expect(kinds()).toEqual(["harvest_frozen"]);
    expect(needsYou(engine, study())[0]!.title).toContain("drafted before 1.0");
    for (const method of ["study.harvest.plan", "study.harvest.publish", "study.harvest.choice"]) await expect(call(method, { slug: "toy-size", harvestId: h.id })).rejects.toThrow(/no rpc method/u);
    // Its best is frozen: the Harvest tab offers no new freeze, and starting one shows it and changes nothing.
    expect(v).toMatchObject({ canStart: false, canRefreeze: true });
    const shown = await call("study.harvest.start", { slug: "toy-size" });
    expect(shown).toMatchObject({ ok: true, message: expect.stringContaining("harvest h1 (from before 1.0) froze best") });
    expect(store.harvests(s.id)).toHaveLength(1);
    expect(events("control.harvest")).toHaveLength(0);
    // `bb study harvest` (here from the study thread: a read) shows it too, the bug 1.0.0 had: it started h2.
    const cliShown = await harness.behavior.runCli(["harvest", "toy-size"], { threadId: "thr_study" });
    expect(cliShown.exitCode, cliShown.stderr).toBe(0);
    expect(cliShown.stdout).toContain("Harvest h1 of toy-size");
    expect(store.harvests(s.id)).toHaveLength(1);
    // `--refreeze` is the way to a v1 freeze with a pinned ref; the old one stays in the history and readable by id.
    const refrozen = await harness.behavior.runCli(["harvest", "toy-size", "--refreeze", "--wait"]);
    expect(refrozen.exitCode, refrozen.stderr).toBe(0);
    const now = await call("study.harvest", { slug: "toy-size" });
    expect(now.harvest).toMatchObject({ seq: 2, state: "frozen", legacy: false });
    expect(now.history.map((x: { seq: number; legacy: boolean }) => [x.seq, x.legacy])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect((await call("study.harvest", { slug: "toy-size", harvestId: h.id })).harvest).toMatchObject({ seq: 1, legacy: true });
  });

  it("archive in the app needs confirmation and is audited", async () => {
    await expect(call("study.archive", { slug: "toy-size" })).rejects.toThrow(/confirmation required: this archives toy-size/u);
    expect((await call("study.archive", { slug: "toy-size", confirm: true })).message).toContain("archived");
    expect(study().state).toBe("archived");
    expect(events("control.archive")).toHaveLength(1);
    expect(needsYou(engine, study())).toEqual([]);
    // Without archiveThread the study thread stays.
    expect(port.threads.get("thr_study")!.archivedAt).toBeNull();
    // Asking again with archiveThread archives just the thread.
    expect((await call("study.archive", { slug: "toy-size", confirm: true, archiveThread: true })).message).toBe("toy-size is already archived; its study thread is archived now.");
    expect(port.threads.get("thr_study")!.archivedAt).not.toBeNull();
  });

  it("archive with the study thread: the confirmation says so, the thread is archived and stopped, and it is audited", async () => {
    await expect(call("study.archive", { slug: "toy-size", archiveThread: true })).rejects.toThrow(/and the study thread is archived/u);
    const r = await call("study.archive", { slug: "toy-size", confirm: true, archiveThread: true });
    expect(r.message).toMatch(/archived: 0 worker\(s\) stopped, bench checkouts removed, study thread archived\./u);
    expect(port.threads.get("thr_study")!.archivedAt).not.toBeNull();
    expect(port.stopped).toContain("thr_study");
    expect(events("study_thread.archived")).toHaveLength(1);
    expect(JSON.parse(events("control.archive")[0]!.data_json)).toMatchObject({ archiveThread: true });
  });

  it("notices: new until seen, audit notices don't count, each kind names its action", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    const before = (await call("studies.list")).studies[0];
    expect(before.unreadNotices).toBe(1); // calibration.ready (control.calibrate is audit-only)
    await call("study.notices.seen", { slug: "toy-size" });
    expect((await call("studies.list")).studies[0].unreadNotices).toBe(0);
    const o = await call("study.overview", { slug: "toy-size" });
    const ready = o.notices.find((n: { kind: string }) => n.kind === "calibration.ready");
    expect(ready.summary).toMatch(/^Calibration of `toy-size` is ready\. Next: review it and start the study on the Oracle tab/u);
    expect(ready.action).toMatchObject({ tab: "oracle" });
    expect(o.notices.find((n: { kind: string }) => n.kind === "control.calibrate").audit).toBe(true);
    expect(noticeAction("control.pause", study())).toBeNull();
    expect(noticeAction("harvest.ready", study())).toMatchObject({ tab: "harvest" });
    expect(noticeAction("harvest.frozen", study())).toMatchObject({ tab: "harvest" });
  });

  it("study thread and worker messages: outcome and measurement for the human, the full detail agent-only", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitFor(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { title: "drop trailing whitespace" }, { threadId: "thr_w1" });
    await waitFor(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
    const verdict = port.sent.find((m) => m.threadId === "thr_w1" && m.text.includes("Verdict"))!;
    expect(verdict.summary).toBe("[autoresearch] Verdict for c/1: Win: promoted to best.\nEstimate: 20.0% lower size vs previous best (single run, no CI).");
    expect(verdict.agentOnly).toContain("study_record_finding");
    expect(verdict.agentOnly).toContain("Effect (better is positive): +20.00%");
    const round = port.sent.find((m) => m.threadId === "thr_study" && m.summary.startsWith("[autoresearch] Strategist round"))!;
    expect(round.summary.length).toBeLessThan(400);
    expect(round.summary).not.toContain("\n");
    expect(round.agentOnly).toContain("## Idea board");
    expect(round.agentOnly).toContain("study_queue_ideas");
  });
});
