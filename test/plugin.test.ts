import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import { CREATOR_TOOLS, STRATEGIST_TOOLS, WORKER_TOOLS } from "../src/tools.ts";
import { FakeHost, FakePort, fakeHostSpec, waitFor } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ text?: string }> };
  return r.content?.map((c) => c.text ?? "").join("") ?? "";
}
function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

describe("plugin wiring: role-gated tools, CLI, reconciliation service", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;

  async function config(threadId: string, pluginMetadata: Record<string, string | number> = {}, origin?: { kind: "fork"; pluginId: string }) {
    const r = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: threadId }, pluginMetadata, ...(origin ? { origin } : {}) }),
    );
    return { tools: r.tools.map((t) => t.name).sort(), skills: [...r.skills].sort(), instructions: r.instructions };
  }

  beforeEach(async () => {
    host = new FakeHost();
    port = new FakePort(host);
    const base = host.commit("T0", null);
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch", "study-harvest"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1 })(fake.bb);
    harness = fake.harness;
  });
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });

  async function proposeAndRun() {
    const r = await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec() }, { threadId: "thr_study", projectId: "proj_1" });
    expect(text(r)).toContain("Draft ready: `toy-size` · spec v1.");
    expect((await harness.behavior.runCli(["calibrate", "toy-size", "--wait"])).stdout).toContain("Calibration ready");
    expect((await harness.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output", "--theme", "size"])).stdout).toContain("Idea #1 queued (pinned)");
    expect((await harness.behavior.runCli(["start", "toy-size"])).stdout).toContain("is running");
    // Spawning runs in the background control loop: wait for it instead of relying on timing.
    await waitFor(() => port.threads.has("thr_w1") && port.spawned.length >= 1);
  }

  it("ordinary threads get only study_propose and the creation skills; side chats get nothing", async () => {
    const plain = await config("thr_plain");
    expect(plain.tools).toEqual([...CREATOR_TOOLS]);
    expect(plain.skills).toEqual(["autoresearch", "study-create", "study-harvest"]);
    expect((await config("thr_side", {}, { kind: "fork", pluginId: "side-chat" })).tools).toEqual([]);
  });

  it("forged worker metadata selects no tools, and tool calls re-check the threads table", async () => {
    const forged = await config("thr_evil", { study: "toy-size", role: "worker", idea: 1, spawnToken: "nope" });
    expect(forged.tools).toEqual([]);
    const r = await harness.behavior.callAgentTool("study_submit_candidate", { title: "sneaky submission here" }, { threadId: "thr_evil" });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("only available to autoresearch worker threads");
    const q = await harness.behavior.callAgentTool("study_queue_ideas", { ideas: [{ title: "an idea", rationale: "because reasons", theme: "x" }] }, { threadId: "thr_evil" });
    expect(isError(q)).toBe(true);
  });

  it("the proposing thread becomes the strategist; spawned workers get worker tools only", async () => {
    await proposeAndRun();
    const strategist = await config("thr_study", { study: "toy-size", role: "strategist" });
    expect(strategist.tools).toEqual([...STRATEGIST_TOOLS, ...CREATOR_TOOLS].sort());
    expect(strategist.instructions).toContain("study thread for autoresearch study");
    // The study thread is where a harvest is usually asked for: it gets the study-harvest skill.
    expect(strategist.skills).toEqual(["autoresearch", "study-harvest"]);
    // Strategist role comes from the threads table, not metadata.
    expect((await config("thr_other", { study: "toy-size", role: "strategist" })).tools).toEqual([...CREATOR_TOOLS]);

    expect(port.spawned).toHaveLength(1);
    const meta = port.spawned[0]!.metadata;
    const worker = await config("thr_w1", meta);
    expect(worker.tools).toEqual([...WORKER_TOOLS].sort());
    expect(worker.skills).toEqual([]);
    // A worker cannot use strategist or creator tools even if it asks.
    expect(isError(await harness.behavior.callAgentTool("study_update_dossier", { text: "x".repeat(30) }, { threadId: "thr_w1" }))).toBe(true);
    expect(text(await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec() }, { threadId: "thr_w1", projectId: "proj_1" }))).toContain("not available to worker threads");
    // Another thread copying the worker's metadata is refused.
    expect((await config("thr_copycat", meta)).tools).toEqual([]);
    // Strategist tools work for the study thread.
    const queued = await harness.behavior.callAgentTool("study_queue_ideas", { ideas: [{ title: "Try a trie", rationale: "fewer comparisons", theme: "algo" }] }, { threadId: "thr_study" });
    expect(text(queued)).toContain("Queued 1 idea(s)");
  });

  it("worker tools: submit → verdict, finish refuses before a finding, then finishes", async () => {
    await proposeAndRun();
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    const ticket = await harness.behavior.callAgentTool("study_submit_candidate", { title: "drop trailing whitespace" }, { threadId: "thr_w1" });
    expect(text(ticket)).toContain("Submitted as c/1");
    await waitFor(() => port.sent.some((m) => m.threadId === "thr_w1"));
    expect(port.sent.find((m) => m.threadId === "thr_w1")?.text).toContain("Win: promoted to best");
    const early = await harness.behavior.callAgentTool("study_finish", {}, { threadId: "thr_w1" });
    expect(isError(early)).toBe(true);
    await harness.behavior.callAgentTool("study_record_finding", { outcome: "improved", learned: "Whitespace was 20% of output." }, { threadId: "thr_w1" });
    expect(text(await harness.behavior.callAgentTool("study_finish", {}, { threadId: "thr_w1" }))).toContain("Assignment finished");
    const show = await harness.behavior.runCli(["show", "toy-size"]);
    expect(show.stdout).toContain("c/1 win +20.0% · idea #1");
    expect(show.stdout).toMatch(/Best vs base:\s+20\.0% lower size · 1,000 → 800 bytes/u);
  });

  it("CLI: list/show, human controls refused from study threads, bounded output", async () => {
    expect((await harness.behavior.runCli(["list"])).stdout).toContain("No studies");
    await proposeAndRun();
    expect((await harness.behavior.runCli(["list"])).stdout).toMatch(/toy-size\s+running/u);
    const refused = await harness.behavior.runCli(["pause", "toy-size"], { threadId: "thr_w1" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("human control");
    expect((await harness.behavior.runCli(["pause", "toy-size"], { threadId: "thr_study" })).exitCode).not.toBe(0);
    expect((await harness.behavior.runCli(["pause", "toy-size"])).stdout).toContain("paused");
    expect((await harness.behavior.runCli(["resume", "toy-size"])).stdout).toContain("resumed");
    const unknown = await harness.behavior.runCli(["show", "nope"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("no study named");
    expect(unknown.stderr).toContain("Run `bb study list`");
    expect((await harness.behavior.runCli(["show", "toy-size"])).stdout.length).toBeLessThan(60_100);
  });

  it("the engine service reconciles on start and stops on abort", async () => {
    const svc = harness.behavior.runService("engine");
    await new Promise((r) => setTimeout(r, 20));
    svc.controller.abort();
    await svc.done;
    expect(harness.inspection.logEntries.map((e) => e.message).join("\n")).toContain("reconciled:");
  });
});
