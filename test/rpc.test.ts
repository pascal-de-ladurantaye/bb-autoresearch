// bb.rpc handlers: the study page's reads and the human controls.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

describe("rpc: study page data and controls", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  const call = async <T = any>(method: string, input?: unknown, caller?: { kind: "plugin"; pluginId: string }) =>
    (await harness.behavior.callRpc(method, input ?? null, caller ? { experimental_caller: caller } : undefined)) as T;

  beforeEach(async () => {
    host = new FakeHost();
    port = new FakePort(host);
    const base = host.commit("T0", null);
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 } })(fake.bb);
    harness = fake.harness;
    await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec().replace("max_workers = 1", "max_workers = 2") }, { threadId: "thr_study", projectId: "proj_1" });
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"]);
    await harness.behavior.runCli(["start", "toy-size"]);
    await waitFor(() => port.spawned.length >= 1);
  });
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });

  async function winOnce() {
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await harness.behavior.callAgentTool("study_submit_candidate", { summary: "drop trailing whitespace" }, { threadId: "thr_w1" });
    await waitFor(() => port.sent.some((m) => m.threadId === "thr_w1" && m.text.includes("Verdict")));
  }

  it("studies.list and study.overview summarize state, budget, trajectory, utilization", async () => {
    await winOnce();
    const { studies } = await call<{ studies: any[] }>("studies.list");
    expect(studies).toHaveLength(1);
    expect(studies[0]).toMatchObject({ slug: "toy-size", state: "running", candidates: 1, maxCandidates: 3, maxWorkers: 2, metric: { name: "size", direction: "lower" } });
    expect(studies[0].bestVsBase).toBeCloseTo(0.2);
    const o = await call<any>("study.overview", { slug: "toy-size" });
    expect(o.trajectory.points).toEqual([expect.objectContaining({ n: 1, verdict: "win" })]);
    expect(o.trajectory.steps.at(-1).value).toBeCloseTo(0.2);
    expect(o.bestCi).not.toBeNull();
    expect(o.utilization.overlaps).toBe(0);
    expect(o.utilization.runningSeconds).toBeGreaterThanOrEqual(0);
    expect(o.calibration.status).toBe("ready");
    expect(o.notices.map((n: { kind: string }) => n.kind)).toContain("calibration.ready");
    // M2: human controls are audited as notices too.
    expect(o.notices.map((n: { kind: string }) => n.kind)).toContain("control.start");
    expect(o.workerList[0]).toMatchObject({ threadId: "thr_w1", ideaId: 1, state: "active" });
    expect(JSON.stringify(o)).not.toContain("undefined");
  });

  it("study.candidates and study.candidate return rows, samples, verdict and the diff summary", async () => {
    await winOnce();
    const { candidates } = await call<{ candidates: any[] }>("study.candidates", { slug: "toy-size" });
    expect(candidates[0]).toMatchObject({ n: 1, verdict: "win", threadId: "thr_w1", ideaTitle: "Shrink the output" });
    expect((await call<{ candidates: any[] }>("study.candidates", { slug: "toy-size", verdict: "lose" })).candidates).toHaveLength(0);
    const { candidate } = await call<{ candidate: any }>("study.candidate", { slug: "toy-size", n: 1 });
    expect(candidate.reasons[0]).toContain("improved");
    expect(candidate.samples.length).toBeGreaterThan(0);
    expect(candidate.diff.files).toEqual([{ path: "src/a.ts", added: 3, deleted: 1 }]);
    expect(candidate.ref).toBe("refs/studies/toy-size/c/1");
    expect((await call<{ candidate: any }>("study.candidate", { slug: "toy-size", n: 99 })).candidate).toBeNull();
  });

  it("thread.badge describes study and worker threads, and nothing else", async () => {
    const study = (await call<{ badge: any }>("thread.badge", { threadId: "thr_study" })).badge;
    expect(study).toMatchObject({ kind: "study", slug: "toy-size" });
    expect(study.text).toMatch(/^no win yet · 1 worker · queue 0$/u);
    const worker = (await call<{ badge: any }>("thread.badge", { threadId: "thr_w1" })).badge;
    expect(worker.text).toBe("toy-size · idea #1 · submission 0/2 · working");
    expect((await call<{ badge: any }>("thread.badge", { threadId: "thr_other" })).badge).toBeNull();
    await winOnce();
    const after = (await call<{ badge: any }>("thread.badge", { threadId: "thr_study" })).badge;
    expect(after.text).toMatch(/^20\.0% lower size · 1 worker/u);
  });

  it("controls: pause, resume, concurrency; idea add, reorder, pin, veto", async () => {
    expect((await call<any>("study.pause", { slug: "toy-size" })).message).toContain("paused");
    expect((await call<any>("studies.list")).studies[0].state).toBe("paused");
    expect((await call<any>("study.resume", { slug: "toy-size" })).message).toContain("resumed");
    expect((await call<any>("study.concurrency", { slug: "toy-size", maxWorkers: 1 })).message).toContain("max workers set to 1");
    expect((await call<any>("studies.list")).studies[0]).toMatchObject({ maxWorkers: 1, maxWorkersOverride: 1 });
    await call("study.concurrency", { slug: "toy-size", maxWorkers: null });
    expect((await call<any>("studies.list")).studies[0].maxWorkersOverride).toBeNull();

    await call("ideas.add", { slug: "toy-size", title: "Second idea", theme: "b", pinned: false });
    await call("ideas.add", { slug: "toy-size", title: "Third idea", theme: "c", pinned: false });
    let ideas = (await call<{ ideas: any[] }>("study.ideas", { slug: "toy-size" })).ideas;
    const second = ideas.find((i) => i.title === "Second idea");
    const third = ideas.find((i) => i.title === "Third idea");
    await call("ideas.reorder", { slug: "toy-size", ids: [third.id, second.id] });
    await call("ideas.update", { slug: "toy-size", id: second.id, pinned: true });
    ideas = (await call<{ ideas: any[] }>("study.ideas", { slug: "toy-size" })).ideas;
    expect(ideas.find((i) => i.id === second.id)).toMatchObject({ pinned: true, priority: 99 });
    expect(ideas.find((i) => i.id === third.id)).toMatchObject({ priority: 100 });
    await call("ideas.veto", { slug: "toy-size", id: third.id, reason: "not worth it" });
    ideas = (await call<{ ideas: any[] }>("study.ideas", { slug: "toy-size" })).ideas;
    expect(ideas.find((i) => i.id === third.id)).toMatchObject({ status: "retired" });
    expect(ideas.find((i) => i.id === third.id).statusReason).toContain("vetoed");
  });

  it("refuses controls from other plugins and bad input", async () => {
    await expect(call("study.pause", { slug: "toy-size" }, { kind: "plugin", pluginId: "other" })).rejects.toThrow(/for humans/u);
    expect((await call<any>("studies.list", null, { kind: "plugin", pluginId: "other" })).studies).toHaveLength(1);
    await expect(call("study.overview", { slug: "nope" })).rejects.toThrow(/no study named/u);
    await expect(call("study.concurrency", { slug: "toy-size", maxWorkers: 0 })).rejects.toThrow();
    await expect(call("ideas.veto", { slug: "toy-size", id: 1 })).rejects.toThrow(/only queued ideas/u);
  });
});
