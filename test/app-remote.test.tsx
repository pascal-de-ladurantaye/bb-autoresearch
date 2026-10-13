// @vitest-environment jsdom
// Remote bench hosts on the surfaces: the Bench tab's remote section (entries,
// machines, state, expiry, rotation, per-host calibration, a refused seed),
// the bench host list, the Live bench strip, and `bb study bench` lines.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { configure, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { LiveView } from "../src/live-model.ts";
import { remoteLines, type RemoteMachineView, type RemoteView } from "../src/remote/view.ts";
import type { BenchView } from "../src/views.ts";
import { FakeHost, FakePort } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];
configure({ asyncUtilTimeout: 8000 });

const SPEC = `
[study]
slug = "toy-rb"
objective = "Make the toy program faster on remote machines."
base = "main"

[metric]
name = "size"
direction = "lower"

[scope]
editable = ["src/**"]

[oracle]
gate = ["gate run"]
measure = "measure run"
noise = "noisy"

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 4
calibration_pairs = 4
bootstrap = 200
confirm = false

[budget]
max_workers = 1
max_candidates = 5
`;
const METHODS = ["studies.list", "study.overview", "study.ideas", "study.candidates", "study.candidate", "study.findings", "study.oracle", "study.bench", "study.live", "study.notices.seen", "thread.badge", "thread.study"];

function machine(over: Partial<RemoteMachineView>): RemoteMachineView {
  const now = Date.now();
  return {
    id: 1, benchHostId: "remote-1", name: "bench-provider-local #1", provider: "bench-provider-local", slot: "0.1", state: "ready", stateText: "measuring c/2", phase: null, cores: 4, memoryGb: null,
    shape: { os: "linux", arch: "x64", cpuModel: "Test CPU", nproc: 4, quota: 4, memoryGb: 16, extra: { machineType: "test-standard-4", smt: "off" } }, machine: { machine_type: "test-standard-4", smt: false }, shapeWarning: null, createdAt: now - 600_000, readyAt: now - 500_000, expiresAt: now + 12 * 60_000, leftAt: null, leftReason: null, joinSeconds: 95,
    rotation: "replacement starts in 3 min", replaces: null, replacedBy: null, calibration: { noiseFloor: 0.0031, mde: 0.0125, sideRuns: 3, runSeconds: 2.1, sha: "a".repeat(40), at: now - 400_000 }, measuring: 2, gating: null, measured: 4, error: null,
    ...over,
  };
}

function remoteFixture(): RemoteView {
  const now = Date.now();
  return {
    entries: [
      { index: 0, provider: "bench-provider-local", hosts: 2, cores: 4, memoryGb: null, machine: { machine_type: "test-standard-4", smt: false }, lifetimeMinutes: 60, rotateLeadMinutes: 12, gates: true, setup: true, seed: { state: "ok", bytes: 2_500_000, files: 120, at: now - 900_000, detail: null }, blocked: null },
      { index: 1, provider: "other-provider", hosts: 1, cores: 8, memoryGb: 32, machine: null, lifetimeMinutes: 120, rotateLeadMinutes: 24, gates: false, setup: false, seed: { state: "refused", bytes: null, files: 40, at: now, detail: "credential scan matched: home/.netrc (file:netrc)" }, blocked: "the seed was refused: fix it or seed_allow with a spec change" },
    ],
    machines: [
      machine({}),
      machine({ id: 2, benchHostId: "remote-2", name: "bench-provider-local #2", slot: "0.2", state: "joining", stateText: "joining: uploading the seed (2.4 MiB)", phase: "uploading the seed (2.4 MiB)", calibration: null, measuring: null, rotation: "replacement for #3", replaces: 3, measured: 0, shape: { os: "linux", arch: "x64", cpuModel: null, nproc: 32, quota: 4, memoryGb: null, extra: {} }, machine: null, shapeWarning: "the machine shows 32 CPUs for a quota of 4, while 4 were asked for" }),
      machine({ id: 3, benchHostId: "remote-3", name: "bench-provider-local #3", slot: "0.2", state: "retiring", stateText: "retiring: finishing what it measures", measuring: null, rotation: "rotating out: #2 took its slot" }),
      machine({ id: 4, benchHostId: "remote-4", name: "bench-provider-local #4", state: "gone", stateText: "gone: the machine is suspended", leftReason: "the machine is suspended", leftAt: now - 60_000, measuring: null }),
    ],
    live: 3,
    baseBundle: { bytes: 190_000_000, sha: "b".repeat(40), cached: true },
  };
}

describe("frontend: remote bench hosts", () => {
  let harness: Harness;
  const pages: Array<ReturnType<typeof renderSlot>> = [];

  beforeEach(async () => {
    const host = new FakeHost();
    const port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch", "study-harvest"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0 } })(fake.bb);
    harness = fake.harness;
    await harness.behavior.callAgentTool("study_propose", { spec_toml: SPEC }, { threadId: "thr_study", projectId: "proj_1" });
    await harness.behavior.runCli(["calibrate", "toy-rb", "--wait"]);
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

  it("the Bench tab shows entries, machines with state, expiry, rotation and their own calibration, and a refused seed", async () => {
    const base = (await harness.behavior.callRpc("study.bench", { slug: "toy-rb" })) as BenchView;
    expect(base.remote).toEqual({ entries: [], machines: [], live: 0, baseBundle: null });
    const fixture: BenchView = {
      ...base,
      remote: remoteFixture(),
      hosts: [...base.hosts, { ...base.hosts[0]!, hostId: "remote-1", name: "bench-provider-local #1", mode: "remote", measuring: 2, remote: { provider: "bench-provider-local", slot: "0.1", state: "ready", stateText: "measuring c/2", cores: 4, expiresAt: Date.now() + 12 * 60_000, rotation: "replacement starts in 3 min" } }],
    };
    const page = await open("toy-rb/bench", { "study.bench": async () => fixture });
    const entries = await page.findByLabelText("Remote bench entries");
    expect(entries.textContent).toMatch(/bench-provider-local.*2 machines × 4 cores · 60 min each, replaced 12 min before the end · gates run there/u);
    expect(entries.textContent).toMatch(/seed ready \(2\.4 MiB, 120 files/u);
    expect(entries.textContent).toMatch(/repository 181\.2 MiB \(shallow at the study base\)/u);
    expect(entries.textContent).toMatch(/seed refused: credential scan matched: home\/\.netrc \(file:netrc\)/u);
    expect(entries.textContent).toMatch(/no new machine: the seed was refused/u);
    expect(entries.textContent).toMatch(/machine: machine_type=test-standard-4, smt=false/u);
    const machines = page.getByLabelText("Remote machines");
    expect(machines.textContent).toMatch(/bench-provider-local #1.*slot 0\.1 · 4 cores \(4 CPUs visible\).*measuring c\/2.*ends in 1[12](\.\d)? min.*replacement starts in 3 min/u);
    expect(machines.textContent).toMatch(/own calibration: noise 0\.31% per pair, win threshold 1\.25%, 3 runs a side/u);
    expect(machines.textContent).toMatch(/#2.*joining: uploading the seed.*replacement for #3/u);
    expect(machines.textContent).toMatch(/shows 32 CPUs for a quota of 4/u);
    expect(machines.textContent).toMatch(/asked for: machine_type=test-standard-4, smt=false · reports: machineType=test-standard-4, smt=off/u);
    expect(machines.textContent).toMatch(/#3.*retiring.*rotating out: #2 took its slot/u);
    expect(machines.textContent).not.toMatch(/#4/u);
    expect(page.container.textContent).toMatch(/Recently gone: bench-provider-local #4 \(the machine is suspended/u);
    expect(page.getByLabelText("Bench hosts").textContent).toMatch(/remote · bench-provider-local · 4 cores · ends in .* · replacement starts in 3 min/u);
  });

  it("the Live bench strip shows remote machines, joining ones included", async () => {
    const base = (await harness.behavior.callRpc("study.live", { slug: "toy-rb" })) as LiveView;
    const now = base.now;
    const fixture: LiveView = {
      ...base,
      state: "running",
      bench: [
        { hostId: "remote-1", name: "bench-provider-local #1", status: "online", healthOk: true, deferredUntil: null, current: { kind: "gate", n: 2, startedAt: now - 5000 }, utilization: 0.4, windowSeconds: 600, remote: { provider: "bench-provider-local", slot: "0.1", cores: 4, state: "ready", stateText: "testing c/2", expiresAt: now + 9 * 60_000, rotation: "replacement starts in 1 min", noiseFloor: 0.0031, mde: 0.0125 } },
        { hostId: "remote-2", name: "bench-provider-local #2", status: "unknown", healthOk: null, deferredUntil: null, current: null, utilization: null, windowSeconds: 600, remote: { provider: "bench-provider-local", slot: "0.1", cores: 4, state: "calibrating", stateText: "calibrating: calibrating (A/A on best)", expiresAt: now + 59 * 60_000, rotation: "replacement for #1", noiseFloor: null, mde: null } },
      ],
    };
    const live = await open("toy-rb/live", { "study.live": async () => fixture });
    const strip = await live.findByRole("region", { name: "Bench" });
    await waitFor(() => expect(strip.textContent).toMatch(/c\/2.*testing \(gates on this machine\)/u));
    expect(strip.textContent).toMatch(/remote · bench-provider-local · 4 cores · ends in [89]:\d\d · noise 0\.31% · replacement starts in 1 min/u);
    expect(strip.textContent).toMatch(/bench-provider-local #2calibrating.*calibrating: calibrating \(A\/A on best\)/u);
    expect(strip.textContent).toMatch(/replacement for #1/u);
  });

  it("bb study bench lines name each machine's state, expiry, calibration and rotation", () => {
    const lines = remoteLines(remoteFixture(), Date.now()).join("\n");
    expect(lines).toMatch(/Remote bench 1: bench-provider-local · 2 machine\(s\) × 4 cores · 60 min each, replaced 12 min before the end · gates run there · seed ok/u);
    expect(lines).toMatch(/seed: credential scan matched: home\/\.netrc/u);
    expect(lines).toMatch(/bench-provider-local #1 \(slot 0\.1, 4 cores, 4 CPUs visible\): measuring c\/2 · ends in 1[12] min · noise 0\.31%, win threshold 1\.25% · replacement starts in 3 min · measured 4/u);
    expect(lines).toMatch(/note: the machine shows 32 CPUs/u);
    expect(lines).toMatch(/^  machine: machine_type=test-standard-4, smt=false$/mu);
    expect(lines).toMatch(/^    reports: linux\/x64, Test CPU, 4 CPUs, quota 4, 16 GB, machineType=test-standard-4, smt=off$/mu);
    expect(lines).toMatch(/recently gone: #4 \(the machine is suspended\)/u);
  });
});
