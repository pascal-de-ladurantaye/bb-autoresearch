// In-app approval, start, publish, changeset choice and archive (RPC), the
// Needs-you derivation behind them, notices with actions, and the study
// thread messages (one-line summary, agent-only detail).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Engine } from "../src/engine.ts";
import type { ExecInput, ExecResult } from "../src/host/contract.ts";
import { needsYou, noticeAction } from "../src/views.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

/** An edit host that answers like git push and gh would (never the network). */
class GhHost extends FakeHost {
  ran: string[] = [];
  async exec(input: ExecInput): Promise<ExecResult> {
    this.ran.push(input.command);
    const ok = (stdout = ""): ExecResult => ({ exitCode: 0, timedOut: false, durationMs: 1, stdout, stderr: "" });
    if (input.command === "gh --version") return ok("gh version 2.0");
    if (input.command.startsWith("git push")) return ok();
    if (input.command.startsWith("gh pr create")) return ok(`https://github.com/acme/repo/pull/${this.ran.filter((c) => c.startsWith("gh pr create")).length}\n`);
    return super.exec(input);
  }
}

describe("human interface: in-app actions and Needs you", () => {
  let harness: Harness;
  let host: GhHost;
  let port: FakePort;
  let engine!: Engine;
  const call = async <T = any>(method: string, input?: unknown, caller?: { kind: "plugin"; pluginId: string }) =>
    (await harness.behavior.callRpc(method, input ?? null, caller ? { experimental_caller: caller } : undefined)) as T;
  const study = () => engine.study("toy-size");
  const kinds = () => needsYou(engine, study()).map((n) => n.kind);
  const events = (kind: string) => engine.ctx.store.events(study().id, { kinds: [kind] });

  beforeEach(async () => {
    host = new GhHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0, harvestPollMs: 5, harvestGroupGraceMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
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

  it("budget exhausted asks for a harvest; a ready harvest asks for review", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await engine.systemPause(study().id, "budget exhausted: 3/3 candidates");
    expect(kinds()).toEqual(["budget_exhausted"]);
    expect(needsYou(engine, study())[0]!.action).toEqual({ kind: "harvest" });
    const notice = engine.ctx.store.notices(study().id).find((n) => n.kind === "budget.exhausted")!;
    expect(notice.text).toMatch(/paused itself: budget exhausted.*Next: harvest the wins on the Harvest tab/u);
    await call("study.harvest.start", { slug: "toy-size" });
    await engine.waitForHarvest("toy-size", 10_000);
    expect(kinds()).toEqual(["harvest_ready"]);
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

  it("publish in the app: plan first, confirmation required, refusals and results are kept and audited", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    const s = study();
    const { store } = engine.ctx;
    store.setStudyState(s.id, "harvesting", "test");
    const h = store.insertHarvest({ study_id: s.id, from_state: "paused", measure_standalone: 1 }, "test");
    const a = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 1, title: "A", rationale: "", candidates_json: "[]", commits_json: "[]", paths_json: "[]" });
    const b = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 2, title: "B", rationale: "", candidates_json: "[]", commits_json: "[]", paths_json: "[]" });
    const c = store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 3, title: "C", rationale: "", candidates_json: "[]", commits_json: "[]", paths_json: "[]" });
    store.updateChangeset(a.id, { branch: "studies/toy-size/harvest/h1/01-a", standalone_sha: "aaa1111", standalone_status: "pass", pr_title: "A", pr_body: "a" });
    store.updateChangeset(b.id, { branch: "studies/toy-size/harvest/h1/02-b", standalone_sha: "bbb2222", standalone_status: "pass", pr_base: "#1", depends_on_json: JSON.stringify([a.id]), stack: 1, pr_title: "B", pr_body: "b" });
    store.updateChangeset(c.id, { branch: "studies/toy-size/harvest/h1/03-c", standalone_sha: "ccc3333", standalone_status: "pass", droppable: 1, pr_title: "C", pr_body: "c" });
    store.updateHarvest(h.id, { state: "ready", finished_at: Date.now(), publish_state: "dry-run" });

    // No remote: the plan says so, and a confirmed publish is refused, kept on the harvest, and audited.
    const plan0 = await call("study.harvest.plan", { slug: "toy-size", harvestId: h.id });
    expect(plan0).toMatchObject({ ok: false, remote: "origin", remoteUrl: null });
    expect(plan0.problem).toMatch(/no remote named "origin"/u);
    await expect(call("study.harvest.publish", { slug: "toy-size", harvestId: h.id })).rejects.toThrow(/confirmation required: this pushes 3 branch\(es\) of harvest h1 to origin/u);
    await expect(call("study.harvest.publish", { slug: "toy-size", harvestId: h.id, confirm: true })).rejects.toThrow(/publish refused/u);
    expect(store.harvest(h.id)).toMatchObject({ publish_state: "failed" });
    expect(store.harvest(h.id)!.error).toMatch(/publish refused: the repository has no remote/u);
    expect(events("control.publish")[0]!.data_json).toContain('"failed":true');
    expect(kinds()).toContain("publish_failed");

    // Drop rules: #1 has a dependent, #3 doesn't.
    await expect(call("study.harvest.choice", { slug: "toy-size", harvestId: h.id, k: 1, choice: "drop" })).rejects.toThrow(/#1 can't be dropped: #2 builds on it/u);
    expect((await call("study.harvest.choice", { slug: "toy-size", harvestId: h.id, k: 3, choice: "drop" })).message).toContain("skipped when publishing");
    expect(events("control.harvest_choice")).toHaveLength(1);

    // With a GitHub remote: the plan lists exactly what goes where; publishing opens draft PRs and the URLs stay on the harvest.
    host.remotes = [{ name: "origin", url: "git@github.com:acme/repo.git" }];
    const plan = await call("study.harvest.plan", { slug: "toy-size", harvestId: h.id });
    expect(plan.ok).toBe(true);
    expect(plan.prs).toEqual([
      { k: 1, title: "A", branch: "studies/toy-size/harvest/h1/01-a", base: "main", stacked: false, push: true, skip: null },
      { k: 2, title: "B", branch: "studies/toy-size/harvest/h1/02-b", base: "studies/toy-size/harvest/h1/01-a", stacked: true, push: true, skip: null },
      { k: 3, title: "C", branch: "studies/toy-size/harvest/h1/03-c", base: "main", stacked: false, push: false, skip: "dropped by you" },
    ]);
    const r = await call("study.harvest.publish", { slug: "toy-size", harvestId: h.id, confirm: true });
    expect(r.message).toContain("2 draft PR(s) opened");
    expect(host.ran.filter((x) => x.startsWith("git push"))).toHaveLength(2);
    const v = await call("study.harvest", { slug: "toy-size" });
    expect(v.harvest.published.map((p: { status: string }) => p.status)).toEqual(["opened", "opened", "skipped"]);
    expect(v.harvest.published[2].detail).toBe("dropped by you");
    expect(v.harvest.changesets[0].pr.url).toBe("https://github.com/acme/repo/pull/1");
    expect(store.notices(s.id).some((n) => n.kind === "harvest.published" && n.text.includes("2 draft PR(s) opened"))).toBe(true);
    expect(kinds()).not.toContain("harvest_ready");
  });

  it("archive in the app needs confirmation and is audited", async () => {
    await expect(call("study.archive", { slug: "toy-size" })).rejects.toThrow(/confirmation required: this archives toy-size/u);
    expect((await call("study.archive", { slug: "toy-size", confirm: true })).message).toContain("archived");
    expect(study().state).toBe("archived");
    expect(events("control.archive")).toHaveLength(1);
    expect(needsYou(engine, study())).toEqual([]);
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
  });

  it("study thread and worker messages: one-line summary for the human, the full detail agent-only", async () => {
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitFor(() => port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { summary: "drop trailing whitespace" }, { threadId: "thr_w1" });
    await waitFor(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
    const verdict = port.sent.find((m) => m.threadId === "thr_w1" && m.text.includes("Verdict"))!;
    expect(verdict.summary).toBe("[autoresearch] Verdict for c/1: WIN: promoted to best, 20.0% lower size than best.");
    expect(verdict.agentOnly).toContain("study_record_finding");
    expect(verdict.agentOnly).toContain("Effect (better is positive): +20.00%");
    const round = port.sent.find((m) => m.threadId === "thr_study" && m.summary.startsWith("[autoresearch] Strategist round"))!;
    expect(round.summary.length).toBeLessThan(400);
    expect(round.summary).not.toContain("\n");
    expect(round.agentOnly).toContain("## Idea board");
    expect(round.agentOnly).toContain("study_queue_ideas");
  });
});
