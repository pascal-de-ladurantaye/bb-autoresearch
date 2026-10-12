// v0.2.1 fixes, backend and pure formatting: the Oracle tab's noise sentence
// per noise class (and without a noise floor), why a guardrail loss lost (in
// the Candidates list, the live cards, the feed, deltas and replay), single-run
// wording for deterministic and expensive measurements, the status line's
// counts, and lanes linked to candidates through the plugin's worker row (a
// worker row without a BB thread id).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { feedItems, liveView, replayBundle } from "../src/live.ts";
import { applyDeltas, deltaFromEvent, progressText, type LiveView } from "../src/live-model.ts";
import { ciRangeText, ciText, noiseFloorText, runningStatusText, verdictCause } from "../src/present.ts";
import { ReplayModel, replayStatusLine } from "../src/replay.ts";
import { candidatesView, oracleView, statusLine } from "../src/views.ts";
import { FakeHost, makeCtx, makeDb, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-v021";

function spec(opts: { maxWorkers?: number; single?: "auto" | "on" | "off" } = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy faster."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"

[[guardrail]]
name = "rss"
direction = "lower"
max_regression = 0.1
max_total_regression = 0.15

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
gate = ["gate run"]
measure = "measure run"
noise = "noisy"
single_machine = "${opts.single ?? "auto"}"

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 6
calibration_pairs = 4
bootstrap = 200
confirm = false

[budget]
max_workers = ${opts.maxWorkers ?? 2}
max_candidates = 20

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

// The reasons a guardrail loss records (verdict.ts + guardrails.ts), as stored for toy studies.
const GUARDRAIL_LOSS = [
  "primary metric improved 43.31% (CI 40.97%..45.28%, n=6)",
  "guardrail mem_kb: 27.6% worse than best (CI 27.1% to 28.7% worse), beyond the 10.0% limit; 26.6% worse than the segment base (CI 25.8% to 28.9% worse), beyond the 15.0% total limit",
];

describe("formatting (pure)", () => {
  it("says the noise per noise class, and 'not measured' without a floor (never 0.00% from a missing floor)", () => {
    expect(noiseFloorText("noisy", [0.0362])).toBe("Run-to-run noise is 3.62% per pair.");
    // Several bench hosts (v1): each decides with its own threshold, so the range is shown.
    expect(noiseFloorText("noisy", [0.0123, 0.0362])).toBe("Run-to-run noise is 1.23% to 3.62% per pair, depending on the bench host.");
    expect(noiseFloorText("noisy", [null])).toBe("Run-to-run noise: not measured.");
    expect(noiseFloorText("noisy", [])).toBe("Run-to-run noise: not measured.");
    expect(noiseFloorText("expensive", [0.021])).toBe("Run-to-run noise is 2.10% (σ of one run).");
    expect(noiseFloorText("expensive", [Number.NaN])).toBe("Run-to-run noise: not measured.");
    expect(noiseFloorText("deterministic", [null], 0.005)).toBe("Deterministic: single runs, no spread; a candidate wins when it beats best by more than the tolerance (0.50%).");
    expect(noiseFloorText("deterministic", [0], 0)).toBe("Deterministic: single runs, no spread; a candidate wins when it beats best by more than the tolerance (0.00%), and a repeat of the baseline differed by 0.00%.");
    for (const t of [noiseFloorText("deterministic", [0.001]), noiseFloorText("expensive", [0.01])]) expect(t).not.toMatch(/per pair/u);
  });

  it("says why a verdict isn't the primary metric's: a guardrail, the holdout, the gate, a conflict, the scope", () => {
    expect(verdictCause("lose", GUARDRAIL_LOSS)).toBe("lost on guardrail mem_kb (27.6% worse)");
    // Only the total limit broke.
    expect(verdictCause("lose", ["primary metric improved 5.00% (n=6)", "guardrail rss: 4.0% worse than best (CI 3.0% to 5.0% worse), within the 10.0% limit; 16.0% worse than the segment base (CI 15.5% to 17.0% worse), beyond the 15.0% total limit"])).toBe(
      "lost on guardrail rss (16.0% worse than the segment base)",
    );
    expect(verdictCause("lose", ["primary metric improved 5.00% (n=6)", "guardrail rss: metric missing from measure output"])).toBe("lost on guardrail rss (not measured)");
    expect(verdictCause("lose", ["primary metric improved 5.00% (n=6)", "failed the holdout check (a hidden workload on the bench host; agents see pass/fail only)"])).toBe("lost on the holdout check");
    // The primary metric decided it: its own number says why.
    expect(verdictCause("lose", ["primary metric regressed 3.00% (n=6)", GUARDRAIL_LOSS[1]])).toBeNull();
    expect(verdictCause("lose", ["initial primary metric improved 2.00%", "failed confirmation: primary metric regressed 1.00%"])).toBeNull();
    // A loss whose primary metric improved for another recorded reason says that reason.
    expect(verdictCause("lose", ["primary metric improved 1.21% (n=1)", "discarded by the agent: within its noise", "guardrail rss: 5.7% better than best, within the 10.0% limit; 2.0% better than the segment base, within the 15.0% total limit"])).toBe("discarded by the agent: within its noise");
    expect(verdictCause("lose", ["primary metric improved 1.21% (n=1)"])).toBe("lost although the primary metric improved");
    expect(verdictCause("win", GUARDRAIL_LOSS)).toBeNull();
    expect(verdictCause("inconclusive", ["effect 1.45% (CI -3.14%..6.15%, n=20) did not clear the minimum detectable effect"])).toBeNull();
    expect(verdictCause("gate_failed", ["gate failed: pytest -q exited 1"])).toBe("gate failed: pytest -q exited 1");
    expect(verdictCause("conflict", ["does not apply onto current best abc: src/a.py"])).toBe("conflicts with best");
    expect(verdictCause("rejected", ["protected paths changed: bench/measure.py"])).toBe("protected paths changed: bench/measure.py");
    expect(verdictCause("rejected", [])).toBe("outside the scope");
  });

  it("shows a single value, not a range, for a single-run (deterministic) CI", () => {
    expect(ciRangeText(0.2, 0.2)).toBe("+20.0% (single run)");
    expect(ciRangeText(0.1, 0.3)).toBe("+10.0% to +30.0%");
    expect(ciRangeText(null, 0.3)).toBe("—");
    expect(ciText(0.2, 0.2)).toBe("single run, no CI");
    expect(ciText(0.3, 0.1)).toBe("CI +10.0% to +30.0%");
  });

  it("counts runs, not pair 0, for deterministic and expensive measurements", () => {
    const at0 = { run: "measure" as const, done: 0, of: 1 };
    expect(progressText(at0, "deterministic")).toBe("run 1 of 1");
    expect(progressText({ ...at0, done: 1 }, "deterministic")).toBe("run 1 of 1 done");
    expect(progressText(at0, "deterministic", { short: true })).toBe("0/1");
    const band = { kind: "deterministic" as const, candidate: 1, n: 1, startedAt: 0, guardrails: [], final: null, tolerance: 0, best: null, value: null, effect: null };
    expect(progressText(at0, "deterministic", { band })).toBe("running best");
    expect(progressText(at0, "deterministic", { band: { ...band, best: { v: 10, at: 1 } } })).toBe("running the candidate");
    expect(progressText({ run: "measure", done: 0, of: 4 }, "expensive")).toBe("run 1 of ≤4");
    expect(progressText({ run: "measure", done: 2, of: 4 }, "expensive", { spoken: true })).toBe("run 3 of up to 4");
    expect(progressText({ run: "measure", done: 3, of: 12 }, "noisy")).toBe("pair 3 of ≤12");
    for (const noise of ["deterministic", "expensive"] as const) expect(progressText(at0, noise, { run: true })).not.toMatch(/pair/u);
  });

  it("the status line counts a candidate on the bench as measured, not queued", () => {
    expect(runningStatusText(["editing", "editing"], ["c/3"], 0, 0)).toBe("Running: 2 workers editing; measuring c/3.");
    expect(runningStatusText(["editing"], ["c/3"], 1, 2)).toBe("Running: 1 worker editing; measuring c/3, 1 queued for the bench, 2 in tests.");
    expect(replayStatusLine("running", ["editing", "measuring"], ["c/3"], { queued: 0, inTests: 0 }, null)).toBe("Running: 2 workers: 1 editing, 1 being measured; measuring c/3.");
  });

  it("the feed, deltas and replay events say a guardrail loss lost on the guardrail", () => {
    const metric = { name: "ops", unit: "ops", direction: "lower" as const };
    const ctx = { metric, ideas: new Map(), hostName: (h: string) => h, candidateN: new Map() };
    const live = { id: 1, at: 0, kind: "candidate.verdict", data: { candidate: 9, n: 3, verdict: "lose", effect: 0.4331, reasons: GUARDRAIL_LOSS } };
    expect(feedItems([live], ctx).map((f) => [f.text, f.tone])).toEqual([["c/3 lost on guardrail mem_kb (27.6% worse), despite 43.3% fewer ops", "lose"]]);
    // Replay bundles trim reasons to the first one and carry the cause instead.
    const trimmed = { ...live, data: { candidate: 9, n: 3, verdict: "lose", effect: 0.4331, reasons: [GUARDRAIL_LOSS[0]], cause: "lost on guardrail mem_kb (27.6% worse)" } };
    expect(feedItems([trimmed], ctx)[0]!.text).toBe("c/3 lost on guardrail mem_kb (27.6% worse), despite 43.3% fewer ops");
    // A loss on the primary metric keeps its number.
    expect(feedItems([{ ...live, data: { candidate: 9, n: 3, verdict: "lose", effect: -0.004, reasons: ["primary metric regressed 0.40% (n=6)"] } }], ctx)[0]!.text).toBe("c/3 lost: 0.4% more ops (worse)");
    const d = deltaFromEvent(live);
    expect(d).toMatchObject({ k: "verdict", c: 3, v: "lose", why: "lost on guardrail mem_kb (27.6% worse)" });
    const v = {
      studyId: "s1",
      lastEventId: 0,
      cards: [{ n: 3, ideaId: 1, ideaTitle: "x", workerKey: null, stage: "decided", column: "verdict", stageAt: 0, verdict: null, effect: null, effectText: null, cause: null, hostId: null, pairs: null, rebases: 0, submittedAt: 0, decidedAt: 0 }],
      workers: [],
      ideas: { next: [], total: 0 },
      bands: [],
      bench: [],
    } as unknown as LiveView;
    expect(applyDeltas(v, { s: "s1", d: [d!] }).view.cards[0]).toMatchObject({ verdict: "lose", cause: "lost on guardrail mem_kb (27.6% worse)" });
  });
});

describe("candidates.worker_id backfill (migration)", () => {
  it("links existing candidates to their worker row by BB thread id, then by the worker.phase events", () => {
    const db = makeDb();
    db.exec(`INSERT INTO threads (id, thread_id, spawn_token, study_id, role, idea_id, state, submissions, spawned_at) VALUES (7, 'thr_a', 'tok7', 's1', 'worker', 1, 'finished', 1, 0), (8, NULL, 'tok8', 's1', 'worker', 2, 'finished', 1, 0)`);
    db.exec(`INSERT INTO candidates (study_id, n, idea_id, thread_id, sha, parent_sha, summary, stage, submitted_at) VALUES ('s1', 1, 1, 'thr_a', 'a', 'b', 'x', 'decided', 0), ('s1', 2, 2, NULL, 'c', 'd', 'y', 'decided', 0), ('s1', 3, 3, NULL, 'e', 'f', 'z', 'decided', 0)`);
    db.exec(`INSERT INTO events (study_id, at, kind, actor, data_json) VALUES ('s1', 1, 'worker.phase', 'plugin', '{"worker":8,"thread":null,"idea":2,"from":"editing","to":"waiting","candidate":2}')`);
    db.exec(`UPDATE candidates SET worker_id = NULL`);
    for (const sql of MIGRATIONS.filter((m) => m.startsWith("UPDATE candidates SET worker_id"))) db.exec(sql);
    expect(db.prepare(`SELECT n, worker_id FROM candidates ORDER BY n`).all()).toEqual([
      { n: 1, worker_id: 7 },
      { n: 2, worker_id: 8 },
      { n: 3, worker_id: null },
    ]);
  });
});

describe("v0.2.1 (fake host)", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;

  beforeEach(() => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port, clock } = made);
    engine = new Engine(made.ctx);
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });
  afterEach(() => engine.live.dispose());

  async function running(ideas: string[], maxWorkers = 2, single: "auto" | "on" | "off" = "auto"): Promise<string> {
    await engine.proposeStudy("thr_study", "proj_1", spec({ maxWorkers, single }));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    ideas.forEach((title, i) => engine.addIdea(SLUG, { title, theme: `t${i}`, pinned: false }, "human"));
    await engine.start(SLUG, "human");
    await settle();
    return store.study(SLUG)!.id;
  }
  async function settle() {
    await engine.settle();
    engine.live.flushPending();
  }
  async function submit(thread: string, tree: string, value: number, rss = 100) {
    host.nextSnapshotFor.set(`/wt/${thread}`, { tree });
    host.metric.set(tree, value);
    host.rss.set(tree, rss);
    return await engine.submit(thread, `change ${tree}`);
  }

  it("Oracle tab: the noise sentence per class; a missing floor reads 'not measured' (not 0.00%), and the hosts carry null", async () => {
    const id = await running(["Idea A"]);
    const s = () => store.study(id)!;
    expect(oracleView(engine, s()).calibration.noise).toBe("noisy");
    expect(oracleView(engine, s()).calibration.noiseText).toMatch(/^Run-to-run noise is \d+\.\d\d% per pair\.$/u);
    // An imported study has no A/A noise floor.
    const cal = JSON.parse(s().calibration_json!) as { hosts: Array<{ noiseFloor: number | null }> };
    cal.hosts = cal.hosts.map((h) => ({ ...h, noiseFloor: null }));
    store.updateStudy(id, { calibration_json: JSON.stringify(cal) });
    const o = oracleView(engine, s());
    expect(o.calibration.noiseText).toBe("Run-to-run noise: not measured.");
    expect(o.calibration.hosts.every((h) => h.noiseFloor === null)).toBe(true);
  });

  it("a primary-metric win that broke a guardrail says so in the Candidates list, on its card and in the feed", async () => {
    const id = await running(["Idea A"], 1);
    await submit("thr_w1", "TA", 600, 130); // 40% lower size, 30% more rss
    await settle();
    const c = store.candidateByN(id, 1)!;
    expect(c.verdict).toBe("lose");
    expect(c.effect).toBeGreaterThan(0.3);
    const row = candidatesView(engine, store.study(id)!, {}).find((x) => x.n === 1)!;
    expect(row.cause).toMatch(/^lost on guardrail rss \(30\.\d% worse\)$/u);
    const v = liveView(engine, store.study(id)!);
    expect(v.cards.find((x) => x.n === 1)!.cause).toBe(row.cause);
    expect(v.feed.map((f) => f.text)).toContain(`c/1 ${row.cause}, despite ${v.cards.find((x) => x.n === 1)!.effectText}`);
    // Replay tells the same.
    const m = new ReplayModel(replayBundle(engine, store.study(id)!));
    const r = m.viewAt(m.end);
    expect(r.cards.find((x) => x.n === 1)!.cause).toBe(row.cause);
    expect(r.feed.map((f) => f.text)).toContain(`c/1 ${row.cause}, despite ${v.cards.find((x) => x.n === 1)!.effectText}`);
  });

  it("the status line counts the candidate on the bench as measured, and only the ones behind it as queued", async () => {
    // Parallel gates (v0.2.2's single-machine mode would hold c/2 at the gate until c/1 is measured).
    const id = await running(["Idea A", "Idea B"], 2, "off");
    const lines: string[] = [];
    host.onMeasure = () => {
      const c1 = store.candidateByN(id, 1);
      const c2 = store.candidateByN(id, 2);
      if (c1?.stage === "measuring" && c2?.stage === "queued") lines.push(statusLine(engine, store.study(id)!));
    };
    await submit("thr_w1", "TA", 900);
    await submit("thr_w2", "TB", 950);
    await settle();
    expect(lines.length).toBeGreaterThan(0);
    // Workers are described by their phases: c/1's worker is being measured, c/2's waits for the bench.
    expect(lines[0]).toBe("Running: 2 workers: 1 waiting for the bench, 1 being measured; measuring c/1, 1 queued for the bench.");
    expect(lines.join("\n")).not.toMatch(/in the bench queue/u);
  });

  it("lanes link to their candidates through the worker row, even without a BB thread id (live view and replay)", async () => {
    const id = await running(["Idea A"], 1);
    host.onMeasure = () => clock.advance(1000); // events of the measurement get their own times
    await submit("thr_w1", "TA", 900);
    await settle();
    const w = store.threadById("thr_w1")!;
    const c = store.candidateByN(id, 1)!;
    expect(c.worker_id).toBe(w.id);
    // A worker row without a BB thread id (imported studies), and a candidate without one either.
    store.updateThread(w.id, { thread_id: null });
    store.updateCandidate(c.id, { thread_id: null });
    const v = liveView(engine, store.study(id)!);
    expect(v.workers.find((x) => x.key === w.id)).toMatchObject({ threadId: null, submissions: 1, maxSubmissions: 3, candidate: 1, candidateStage: "decided" });
    expect(v.cards.find((x) => x.n === 1)!.workerKey).toBe(w.id);
    const m = new ReplayModel(replayBundle(engine, store.study(id)!));
    const r = m.viewAt(m.end);
    expect(r.workers.find((x) => x.key === w.id)).toMatchObject({ submissions: 1, candidate: 1 });
    expect(r.cards.find((x) => x.n === 1)!.workerKey).toBe(w.id);
    // While measured, the lane says which candidate: replay at the measuring moment.
    const started = m.events.find((e) => e.kind === "measure.started")!.at;
    expect(m.viewAt(started).workers.find((x) => x.key === w.id)).toMatchObject({ candidate: 1, candidateStage: "measuring" });
  });

  it("candidates without a worker row fall back to the BB thread id", async () => {
    const id = await running(["Idea A"], 1);
    await submit("thr_w1", "TA", 900);
    await settle();
    const w = store.threadById("thr_w1")!;
    store.updateCandidate(store.candidateByN(id, 1)!.id, { worker_id: null });
    expect(store.workerCandidates(id, w).map((x) => x.n)).toEqual([1]);
    expect(liveView(engine, store.study(id)!).workers.find((x) => x.key === w.id)).toMatchObject({ candidate: 1, submissions: 1 });
    clock.advance(1);
  });
});
