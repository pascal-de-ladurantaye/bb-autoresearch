import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Engine } from "../src/engine.ts";
import { DETERMINISTIC_SPEC, FakeHost, FakePort, fakeHostSpec, waitFor } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ text?: string }> };
  return r.content?.map((c) => c.text ?? "").join("") ?? "";
}

describe("bb study CLI: --json everywhere, needs, wording, hints", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  let engine!: Engine;

  async function setup(spec = DETERMINISTIC_SPEC) {
    host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0, harvestPollMs: 5, harvestGroupGraceMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    const r = await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec(spec) }, { threadId: "thr_study", projectId: "proj_1" });
    expect(text(r)).toContain("drafted with spec v1");
  }

  const cli = (args: string[]) => harness.behavior.runCli(args);
  const json = async (args: string[]) => {
    const r = await cli([...args, "--json"]);
    expect(r.exitCode, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout) as Record<string, any>;
  };

  /** Calibrate, start, and get one win of the given metric value (base is 1000). */
  async function win(value: number) {
    await cli(["calibrate", "toy-size", "--wait"]);
    await cli(["ideas", "add", "toy-size", "Shrink the output"]);
    await cli(["start", "toy-size"]);
    await waitFor(() => port.threads.has("thr_w1") && port.spawned.length >= 1);
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", value);
    expect(text(await harness.behavior.callAgentTool("study_submit_candidate", { summary: "drop trailing whitespace" }, { threadId: "thr_w1" }))).toContain("Submitted as c/1");
    await waitFor(() => port.sent.some((m) => m.threadId === "thr_w1"));
  }

  afterEach(async () => {
    await harness?.lifecycle.dispose();
  });

  it("every command accepts --json and prints one JSON document with the expected keys", async () => {
    await setup();
    expect(Object.keys(await json(["list"]))).toEqual(["studies"]);
    const needs0 = await json(["needs"]);
    expect(needs0.total).toBe(1);
    expect(needs0.studies[0].needs[0]).toMatchObject({ kind: "approve_spec", command: "bb study calibrate toy-size" });
    const cal = await json(["calibrate", "toy-size", "--wait"]);
    expect(cal).toMatchObject({ ok: true, study: { slug: "toy-size" }, calibration: { status: "ready" } });
    expect(cal.message).toContain("Calibration ready");
    const added = await json(["ideas", "add", "toy-size", "Shrink the output"]);
    expect(added).toMatchObject({ ok: true, idea: { id: 1, pinned: true } });
    const started = await json(["start", "toy-size"]);
    expect(started).toMatchObject({ ok: true, study: { state: "running" } });
    await waitFor(() => port.threads.has("thr_w1"));

    const list = await json(["list"]);
    expect(list.studies[0]).toMatchObject({ slug: "toy-size", state: "running", needsYou: 0 });
    const show = await json(["show", "toy-size"]);
    for (const k of ["slug", "state", "headline", "best", "needs", "status", "secondary", "notices", "calibration", "workerList"]) expect(show).toHaveProperty(k);
    const bench = await json(["bench", "toy-size"]);
    for (const k of ["hosts", "queue", "health", "drift", "transfers", "segments", "segment"]) expect(bench).toHaveProperty(k);
    expect(Object.keys(await json(["ideas", "list", "toy-size"]))).toEqual(["ideas"]);
    expect((await json(["workers", "toy-size"])).workers[0]).toMatchObject({ threadId: "thr_w1", state: "active" });
    expect(Object.keys(await json(["report", "toy-size"]))).toEqual(["markdown"]);
    expect(await json(["concurrency", "toy-size", "1"])).toMatchObject({ ok: true, study: { maxWorkers: 1 } });
    // Refusals still print one JSON document: the SDK envelope with a hint.
    const envelope = async (args: string[]) => {
      const r = await cli([...args, "--json"]);
      expect(r.exitCode).not.toBe(0);
      return JSON.parse(r.stdout).error as { code: string; message: string; hint: string };
    };
    expect(await envelope(["drift", "toy-size"])).toMatchObject({ code: "study_error", message: "deterministic oracles have no drift check", hint: expect.stringContaining("bb study show toy-size") });
    expect(await json(["pause", "toy-size"])).toMatchObject({ ok: true, study: { state: "paused" } });
    expect(await json(["resume", "toy-size"])).toMatchObject({ ok: true, study: { state: "running" } });
    expect(await envelope(["approve", "toy-size"])).toMatchObject({ message: "toy-size has no pending spec to approve", hint: expect.stringContaining("bb study show toy-size") });
    expect((await envelope(["harvest", "toy-size", "--publish"])).message).toContain("no ready harvest");
    const needs = await json(["needs", "toy-size"]);
    expect(needs).toEqual({ total: 0, studies: [{ slug: "toy-size", needs: [] }] });
    const harvest = await json(["harvest", "toy-size"]);
    expect(harvest.message).toContain("harvesting (h1, dry run)");
    for (const k of ["slug", "state", "promotions", "canStart", "harvest", "history"]) expect(harvest).toHaveProperty(k);
    await engine.waitForHarvest("toy-size", 10_000);
    expect(await json(["harvest", "toy-size"])).not.toHaveProperty("message");
    const archived = await json(["archive", "toy-size"]);
    expect(archived).toMatchObject({ ok: true, study: { state: "archived" } });
    expect(port.threads.get("thr_study")!.archivedAt).toBeNull();
    const withThread = await json(["archive", "toy-size", "--archive-thread"]);
    expect(withThread.message).toContain("its study thread is archived now");
    expect(port.threads.get("thr_study")!.archivedAt).not.toBeNull();
  });

  it("errors: the SDK envelope with --json, and a hint that says what to run next", async () => {
    await setup();
    const r = await cli(["start", "toy-size", "--json"]);
    expect(r.exitCode).not.toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.hint).toContain("bb study calibrate toy-size");
    const unknown = await cli(["show", "nope", "--json"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(JSON.parse(unknown.stdout).error).toMatchObject({ code: "not_found", hint: expect.stringContaining("bb study list") });
    const plain = await cli(["show", "nope"]);
    expect(plain.stderr).toContain("no study named");
    expect(plain.stderr).toContain("bb study list");
    // A wrong-state control points at what the study waits for.
    const pause = await cli(["pause", "toy-size"]);
    expect(pause.exitCode).not.toBe(0);
    expect(pause.stderr).toContain("bb study calibrate toy-size");
  });

  it("needs: text lines with the command; nothing when nothing waits", async () => {
    await setup();
    const needs = (await cli(["needs"])).stdout;
    expect(needs).toContain("toy-size: Approve spec v1 and calibrate → `bb study calibrate toy-size`");
    expect((await cli(["list"])).stdout).toMatch(/toy-size\s+draft\s+1: approve spec/u);
    expect((await cli(["show", "toy-size"])).stdout).toMatch(/Needs you\n {2}- Approve spec v1 and calibrate → `bb study calibrate toy-size`/u);
    await cli(["calibrate", "toy-size", "--wait"]);
    expect((await cli(["needs", "toy-size"])).stdout).toContain("toy-size: Calibration is ready: review it and start → `bb study start toy-size`");
    await cli(["start", "toy-size"]);
    expect((await cli(["needs"])).stdout.trim()).toBe("Nothing needs you.");
    expect((await cli(["show", "toy-size"])).stdout).toMatch(/Needs you:\s+nothing/u);
  });

  it("lower is better: best vs base in words with raw values; candidates signed; list has a header row", async () => {
    await setup();
    await win(800);
    const show = (await cli(["show", "toy-size"])).stdout;
    expect(show).toMatch(/Best vs base:\s+20\.0% lower size · 1,000 → 800 bytes/u);
    expect(show).toContain("c/1 win +20.0% · idea #1");
    expect(show).toContain("rss (limit 5.0% worse per step, 5.0% in total)");
    expect(show).toContain("rss: all of the 5.0% total limit left");
    expect(show).not.toContain("+20.00%");
    const list = (await cli(["list"])).stdout.split("\n");
    expect(list[0]).toMatch(/^SLUG\s+STATE\s+NEEDS YOU\s+BEST VS BASE\s+CANDIDATES\s+BENCH$/u);
    expect(list[1]).toMatch(/^toy-size\s+running\s+—\s+20\.0% lower size\s+1\/3\s+/u);
    expect((await json(["show", "toy-size"])).best).toMatchObject({ text: "20.0% lower size", raw: "1,000 → 800 bytes" });
    expect((await json(["show", "toy-size"])).best.value).toBeCloseTo(0.2, 9);
  });

  it("higher is better: a larger value is a positive improvement", async () => {
    await setup(DETERMINISTIC_SPEC.replace('direction = "lower"', 'direction = "higher"'));
    await win(1200);
    const show = (await cli(["show", "toy-size"])).stdout;
    expect(show).toMatch(/Best vs base:\s+20\.0% higher size · 1,000 → 1,200 bytes/u);
    expect(show).toContain("c/1 win +20.0%");
  });

  it("harvest --json: the harvest view plus the message when one was started", async () => {
    await setup();
    await win(800);
    const started = await json(["harvest", "toy-size", "--one-per-promotion"]);
    expect(started.message).toContain("harvesting (h1, dry run)");
    for (const k of ["slug", "state", "promotions", "canStart", "harvest", "history"]) expect(started).toHaveProperty(k);
    expect(started.harvest.id).toBe(1);
    await engine.waitForHarvest("toy-size", 10_000).catch(() => undefined);
    // The fake host has no real git, so this harvest fails; text and JSON still say what to run next.
    const again = await json(["harvest", "toy-size"]).catch(() => null);
    if (again) expect(again).not.toHaveProperty("message");
    expect((await cli(["needs", "toy-size"])).stdout).toContain("`bb study harvest toy-size --restart`");
  });

  it("JSON stays one bounded document: long arrays are trimmed, not the string", async () => {
    const { jsonOut } = await import("../src/cli.ts");
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, s: "x".repeat(100) })) };
    const r = jsonOut(big);
    expect(r.stdout.length).toBeLessThanOrEqual(200_001);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.length).toBeLessThan(5000);
  });
});
