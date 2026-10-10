// Live view (part 1), backend: worker phases and candidate stages derived
// from plugin state, every visible transition recorded as an event (so
// replay rebuilds the view), throttled realtime deltas and their local
// application.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { DeltaBus, feedItems, liveView, skeletonFromDb, threadStudy } from "../src/live.ts";
import {
  applyDeltas,
  classifyItem,
  columnOf,
  deltaFromEvent,
  deriveWorkerPhase,
  LIVE_CHANNEL,
  replaySkeleton,
  REPLAY_KINDS,
  type LiveDelta,
  type LiveDeltaMessage,
  type LiveView,
} from "../src/live-model.ts";
import { safeJson } from "../src/prompts.ts";
import { FakeHost, makeCtx, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-live";

function noisySpec(maxWorkers = 3): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy faster."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
gate = ["gate run"]
measure = "measure run"
noise = "noisy"

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 6
calibration_pairs = 4
bootstrap = 200

[budget]
max_workers = ${maxWorkers}
max_candidates = 20

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

describe("live model: derivation", () => {
  const base = { activity: null, activityAt: null, latest: null } as const;
  it("derives worker phases from plugin state, never from transcripts", () => {
    expect(deriveWorkerPhase({ ...base, state: "spawning" })).toBe("starting");
    expect(deriveWorkerPhase({ ...base, state: "active" })).toBe("reading");
    expect(deriveWorkerPhase({ ...base, state: "active", activity: "editing", activityAt: 5 })).toBe("editing");
    expect(deriveWorkerPhase({ ...base, state: "active", activity: "testing", activityAt: 5 })).toBe("testing");
    for (const stage of ["submitted", "gating", "queued"] as const) expect(deriveWorkerPhase({ ...base, state: "active", latest: { stage, reportedAt: null } })).toBe("waiting");
    for (const stage of ["measuring", "confirming", "promoting"] as const) expect(deriveWorkerPhase({ ...base, state: "active", latest: { stage, reportedAt: null } })).toBe("measuring");
    // Decided: the verdict is in (delivered or not) until the worker acts after delivery.
    expect(deriveWorkerPhase({ ...base, state: "active", latest: { stage: "decided", reportedAt: null } })).toBe("verdict");
    expect(deriveWorkerPhase({ ...base, state: "active", activity: "editing", activityAt: 10, latest: { stage: "decided", reportedAt: 20 } })).toBe("verdict");
    expect(deriveWorkerPhase({ ...base, state: "active", activity: "reading", activityAt: 30, latest: { stage: "decided", reportedAt: 20 } })).toBe("refining");
    expect(deriveWorkerPhase({ ...base, state: "finishing", latest: { stage: "decided", reportedAt: 20 } })).toBe("finishing");
    for (const state of ["finished", "abandoned", "failed"] as const) expect(deriveWorkerPhase({ ...base, state })).toBe("done");
  });

  it("classifies tool items into reading, editing and testing", () => {
    expect(classifyItem({ kind: "fileChange" })).toBe("editing");
    expect(classifyItem({ kind: "fileRead" })).toBe("reading");
    expect(classifyItem({ kind: "search" })).toBe("reading");
    expect(classifyItem({ kind: "commandExecution", command: "rg -n fib src" })).toBe("reading");
    expect(classifyItem({ kind: "commandExecution", command: "bash -lc 'cd src && sed -n 1,40p toy.py'" })).toBe("reading");
    expect(classifyItem({ kind: "commandExecution", command: "/bin/zsh -lc \"python -m pytest -q\"" })).toBe("testing");
    expect(classifyItem({ kind: "commandExecution", command: "cd /wt && python bench/measure.py" })).toBe("testing");
    // Edits through the shell, and compound commands judged by their strongest part.
    expect(classifyItem({ kind: "commandExecution", command: "sed -i 's/a/b/' src/toy.py" })).toBe("editing");
    expect(classifyItem({ kind: "commandExecution", command: "cat bench/test_toy.py | head -30; python3 - <<'E'\nimport re\np='src/toy.py'; s=open(p).read()\nopen(p,'w').write(s)\nE" })).toBe("editing");
    expect(classifyItem({ kind: "commandExecution", command: "cat > src/toy.py <<'EOF'\nx = 1\nEOF" })).toBe("editing");
    expect(classifyItem({ kind: "commandExecution", command: "cat src/toy.py; python3 bench/test_toy.py 2>&1 | tail -3" })).toBe("testing");
    expect(classifyItem({ kind: "commandExecution", command: "find . -type f -print | head; cat src/*.py" })).toBe("reading");
    expect(classifyItem({ kind: "commandExecution", command: "python3 bench/measure.py > /dev/null 2>&1" })).toBe("testing");
    expect(classifyItem({ kind: "toolCall", tool: "edit" })).toBe("editing");
    expect(classifyItem({ kind: "toolCall", tool: "read" })).toBe("reading");
    expect(classifyItem({ kind: "toolCall", tool: "bash" })).toBe("testing");
    // Plugin tools, messages and reasoning say nothing about the activity.
    expect(classifyItem({ kind: "toolCall", tool: "study_submit_candidate" })).toBeNull();
    expect(classifyItem({ kind: "agentMessage" })).toBeNull();
    expect(classifyItem({ kind: "reasoning" })).toBeNull();
  });

  it("maps stages to pipeline columns; a win is promoted", () => {
    expect(["submitted", "gating", "queued", "measuring", "confirming", "promoting"].map((s) => columnOf(s as never, null))).toEqual(["submitted", "gates", "queue", "bench", "bench", "bench"]);
    expect(columnOf("decided", "win")).toBe("promoted");
    for (const v of ["lose", "inconclusive", "gate_failed", "conflict", "rejected"]) expect(columnOf("decided", v)).toBe("verdict");
  });

  it("projects only the events the Live view shows into deltas (ids and small numbers)", () => {
    const e = (kind: string, data: Record<string, unknown>) => ({ id: 7, at: 100, kind, data });
    expect(deltaFromEvent(e("candidate.stage", { candidate: 3, n: 2, from: "gating", to: "queued" }))).toEqual({ k: "stage", id: 7, t: 100, c: 2, to: "queued" });
    expect(deltaFromEvent(e("worker.phase", { worker: 4, to: "editing", candidate: null }))).toEqual({ k: "phase", id: 7, t: 100, w: 4, to: "editing", c: null });
    expect(deltaFromEvent(e("measure.progress", { candidate: 3, n: 2, run: "measure", pairs: 4, of: 20 }))).toEqual({ k: "pair", id: 7, t: 100, c: 2, run: "measure", i: 4, of: 20 });
    expect(deltaFromEvent(e("candidate.verdict", { candidate: 3, n: 2, verdict: "lose", effect: -0.004, reasons: ["long text"] }))).toEqual({ k: "verdict", id: 7, t: 100, c: 2, v: "lose", e: -0.004 });
    expect(deltaFromEvent(e("best.promoted", { n: 2, to: "abc" }))).toEqual({ k: "best", id: 7, t: 100, c: 2 });
    expect(deltaFromEvent(e("idea.status", { idea: 5, to: "running" }))).toEqual({ k: "idea", id: 7, t: 100, i: 5, to: "running" });
    expect(deltaFromEvent(e("notice.added", { notice: 1 }))).toBeNull();
  });
});

function view(over: Partial<LiveView> = {}): LiveView {
  return {
    studyId: "s1",
    slug: SLUG,
    state: "running",
    statusLine: "",
    metric: { name: "ops", unit: "ops", direction: "lower" },
    noise: "noisy",
    now: 0,
    lastEventId: 10,
    studyThreadId: "thr_study",
    best: { text: null, n: null, at: null, value: null, movedAt: null, history: [], rebases: [] },
    counts: { candidates: 1, maxCandidates: 6, workers: 1, targetWorkers: 3, queue: 0 },
    workers: [{ key: 1, threadId: "thr_w1", ideaId: 1, ideaTitle: "Idea", theme: "", phase: "testing", phaseAt: 0, spawnedAt: 0, submissions: 1, maxSubmissions: 3, candidate: 1, candidateStage: "gating", queuePosition: null, action: null }],
    cards: [{ n: 1, ideaId: 1, ideaTitle: "Idea", workerKey: 1, stage: "gating", column: "gates", stageAt: 0, verdict: null, effect: null, effectText: null, cause: null, hostId: null, pairs: null, rebases: 0, submittedAt: 0, decidedAt: null }],
    queue: [],
    bench: [],
    ideas: { next: [{ id: 2, title: "Next", theme: "", pinned: false, source: "human", blocked: null }], total: 1 },
    feed: [],
    bands: [],
    ...over,
  };
}

describe("live model: applying deltas locally", () => {
  it("moves cards, counts pairs, records verdicts and phases; asks for a refetch only when it must", () => {
    const v0 = view();
    const step = (d: LiveDelta[], v = v0) => applyDeltas(v, { s: "s1", d }, (e) => (e === null ? null : `${(e * 100).toFixed(1)}%`));
    let r = step([{ k: "stage", id: 11, t: 50, c: 1, to: "measuring" }]);
    expect(r.view.cards[0]).toMatchObject({ stage: "measuring", column: "bench", stageAt: 50 });
    expect(r.refetch).toBe(false);
    expect(v0.cards[0]!.stage).toBe("gating"); // pure
    r = step([{ k: "pair", id: 12, t: 60, c: 1, run: "measure", i: 3, of: 6 }], r.view);
    expect(r.view.cards[0]!.pairs).toEqual({ run: "measure", done: 3, of: 6 });
    r = step([{ k: "phase", id: 13, t: 61, w: 1, to: "measuring", c: 1 }], r.view);
    expect(r.view.workers[0]).toMatchObject({ phase: "measuring", phaseAt: 61 });
    r = step(
      [
        { k: "verdict", id: 15, t: 70, c: 1, v: "lose", e: -0.004 },
        { k: "stage", id: 14, t: 70, c: 1, to: "decided", v: "lose" },
      ],
      r.view,
    );
    expect(r.view.cards[0]).toMatchObject({ stage: "decided", column: "verdict", verdict: "lose", effect: -0.004, effectText: "-0.4%" });
    expect(r.view.lastEventId).toBe(15);
    // A decided card's effect text and the queue come from the server: refetch.
    expect(r.refetch).toBe(true);
    // Done workers leave; idea picked leaves the queue.
    r = step(
      [
        { k: "phase", id: 16, t: 80, w: 1, to: "done" },
        { k: "idea", id: 17, t: 80, i: 2, to: "running" },
      ],
      r.view,
    );
    expect(r.view.workers).toHaveLength(0);
    expect(r.view.ideas).toEqual({ next: [], total: 0 });
  });

  it("ignores deltas already in the snapshot and other studies; unknown items ask for a refetch", () => {
    const v0 = view();
    expect(applyDeltas(v0, { s: "s1", d: [{ k: "stage", id: 9, t: 1, c: 1, to: "queued" }] }).view.cards[0]!.stage).toBe("gating");
    expect(applyDeltas(v0, { s: "other", d: [{ k: "stage", id: 99, t: 1, c: 1, to: "queued" }] }).view).toBe(v0);
    expect(applyDeltas(v0, { s: "s1", d: [{ k: "stage", id: 11, t: 1, c: 2, to: "submitted" }] }).refetch).toBe(true);
    expect(applyDeltas(v0, { s: "s1", d: [{ k: "phase", id: 11, t: 1, w: 9, to: "starting" }] }).refetch).toBe(true);
    expect(applyDeltas(v0, { s: "s1", d: [{ k: "best", id: 11, t: 1, c: 1 }] }).refetch).toBe(true);
    expect(applyDeltas(v0, { s: "s1", d: [], refetch: true }).refetch).toBe(true);
  });
});

describe("delta bus: throttled per study", () => {
  afterEach(() => vi.useRealTimers());

  it("sends at most one message per interval per study, coalescing by key, oldest event first", () => {
    vi.useFakeTimers();
    const sent: Array<{ at: number; msg: LiveDeltaMessage }> = [];
    const bus = new DeltaBus((msg) => sent.push({ at: Date.now(), msg }), 250, () => Date.now());
    const t0 = Date.now();
    // 40 deltas over one second: 4 stage changes of c/1 per 100 ms plus pair ticks of c/2.
    for (let i = 0; i < 40; i++) {
      bus.push("s1", i % 2 ? { k: "stage", id: i + 1, t: i, c: 1, to: i % 4 === 1 ? "queued" : "measuring" } : { k: "pair", id: i + 1, t: i, c: 2, run: "measure", i, of: 40 });
      bus.push("s2", { k: "phase", id: 1000 + i, t: i, w: 1, to: "reading" });
      vi.advanceTimersByTime(25);
    }
    vi.advanceTimersByTime(1000);
    const s1 = sent.filter((x) => x.msg.s === "s1");
    expect(s1.length).toBeGreaterThanOrEqual(4);
    expect(s1.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < s1.length; i++) expect(s1[i]!.at - s1[i - 1]!.at).toBeGreaterThanOrEqual(250);
    // At most one delta per key per message, in event order.
    for (const { msg } of s1) {
      expect(msg.d.length).toBeLessThanOrEqual(2);
      expect(msg.d.map((d) => d.id)).toEqual([...msg.d.map((d) => d.id)].sort((a, b) => a - b));
    }
    // The last message carries the latest state of each key.
    const last = s1.at(-1)!.msg.d;
    expect(last.find((d) => d.k === "pair")).toMatchObject({ i: 38 });
    // Studies are throttled independently.
    expect(sent.filter((x) => x.msg.s === "s2").length).toBeGreaterThanOrEqual(4);
    expect(sent[0]!.at - t0).toBeLessThan(250);
  });

  it("turns a burst into a refetch", () => {
    vi.useFakeTimers();
    const sent: LiveDeltaMessage[] = [];
    const bus = new DeltaBus((m) => sent.push(m), 250, () => Date.now(), 5);
    for (let i = 0; i < 10; i++) bus.push("s1", { k: "stage", id: i + 1, t: 0, c: i, to: "queued" });
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([{ s: "s1", d: [], refetch: true }]);
  });
});

describe("live recorder and view (fake host)", () => {
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
    const base = host.commit("T0", null, "base");
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });
  afterEach(() => engine.live.dispose());

  async function running(ideas: string[]): Promise<string> {
    await engine.proposeStudy("thr_study", "proj_1", noisySpec(3));
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

  async function submit(thread: string, tree: string, value: number) {
    host.nextSnapshotFor.set(`/wt/${thread}`, { tree });
    host.metric.set(tree, value);
    return await engine.submit(thread, `change ${tree}`);
  }

  function events(studyId: string) {
    return store.eventsAsc(studyId, { kinds: REPLAY_KINDS }).map((r) => ({ id: r.id, at: r.at, kind: r.kind, data: safeJson<Record<string, unknown>>(r.data_json) ?? {} }));
  }

  /** Every visible state is in the events: replaying them gives the database's state. */
  function expectReplayMatches(studyId: string) {
    engine.live.flushPending();
    expect(replaySkeleton(events(studyId))).toEqual(skeletonFromDb(store, store.study(studyId)!));
  }

  it("records each worker's phases as events: starting → reading → editing → testing → waiting → measuring → verdict → refining → finishing → done", async () => {
    const id = await running(["Idea A"]);
    expectReplayMatches(id);
    const w = store.threadById("thr_w1")!;
    expect(w.phase).toBe("reading");
    clock.advance(1000);
    port.addActivity("thr_w1", "fileRead", { at: clock.t });
    port.addActivity("thr_w1", "fileChange", { at: clock.t });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    expect(store.threadById("thr_w1")!.phase).toBe("editing");
    clock.advance(1000);
    port.addActivity("thr_w1", "commandExecution", { command: "python -m pytest -q", at: clock.t });
    port.addActivity("thr_w1", "agentMessage", { at: clock.t });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    expect(store.threadById("thr_w1")!.phase).toBe("testing");
    expectReplayMatches(id);
    clock.advance(1000);
    await submit("thr_w1", "TA", 800);
    await settle();
    expectReplayMatches(id);
    clock.advance(1000);
    port.addActivity("thr_w1", "fileRead", { at: clock.t });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    expect(store.threadById("thr_w1")!.phase).toBe("refining");
    await engine.recordFinding("thr_w1", { outcome: "win", learned: "it helped" });
    await engine.finish("thr_w1");
    await settle();
    engine.onThreadIdle("thr_w1");
    await settle();
    const phases = store.eventsAsc(id, { kinds: ["worker.phase"] }).map((e) => safeJson<{ worker: number; to: string }>(e.data_json)!).filter((d) => d.worker === w.id).map((d) => d.to);
    expect(phases).toEqual(["starting", "reading", "editing", "testing", "waiting", "measuring", "verdict", "refining", "finishing", "done"]);
    expectReplayMatches(id);
  });

  it("records every candidate stage change and pair progress, so replay rebuilds the view at any time t", async () => {
    const id = await running(["Idea A", "Idea B", "Idea C"]);
    const checkpoints: number[] = [];
    clock.advance(500);
    await Promise.all([submit("thr_w1", "TA", 900), submit("thr_w2", "TB", 1100), submit("thr_w3", "TC", 1000)]);
    await settle();
    expectReplayMatches(id);
    checkpoints.push(clock.t);
    const snapshot1 = skeletonFromDb(store, store.study(id)!);
    clock.advance(500);
    await submit("thr_w1", "TA2", 850);
    await settle();
    expectReplayMatches(id);
    // Replay up to an earlier time gives the earlier state.
    expect(replaySkeleton(events(id), checkpoints[0])).toEqual(snapshot1);
    // Every candidate's stage chain is contiguous: each change is one event from the previous stage.
    for (const c of store.candidates(id)) {
      const chain = store.eventsAsc(id, { kinds: ["candidate.stage"] }).map((e) => safeJson<{ candidate: number; from: string | null; to: string }>(e.data_json)!).filter((d) => d.candidate === c.id);
      expect(chain[0]).toMatchObject({ from: null, to: "submitted" });
      for (let i = 1; i < chain.length; i++) expect(chain[i]!.from).toBe(chain[i - 1]!.to);
      expect(chain.at(-1)!.to).toBe("decided");
      expect(chain.map((x) => x.to)).toEqual(expect.arrayContaining(["gating", "queued", "measuring"]));
    }
    // Pair progress: coarse (first and last per run at a frozen clock), the last equals the pairs measured.
    const c1 = store.candidateByN(id, 1)!;
    const progress = store.eventsAsc(id, { kinds: ["measure.progress"] }).map((e) => safeJson<{ candidate: number; pairs: number; of: number; run: string }>(e.data_json)!).filter((d) => d.candidate === c1.id);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.length).toBeLessThan(store.samples(c1.id).length);
    const finished = store.eventsAsc(id, { kinds: ["measure.finished"] }).map((e) => safeJson<{ candidate: number; pairs: number; run: string }>(e.data_json)!).find((d) => d.candidate === c1.id)!;
    expect(progress.filter((p) => p.run === finished.run).at(-1)!.pairs).toBe(finished.pairs);
    expect(progress[0]).toMatchObject({ run: "measure", of: 6 });
  });

  it("publishes throttled deltas on the live channel that mirror the recorded events", async () => {
    const id = await running(["Idea A"]);
    port.published.length = 0;
    await submit("thr_w1", "TA", 800);
    await settle();
    await new Promise((r) => setTimeout(r, 600));
    const msgs = port.published.filter((p) => p.channel === LIVE_CHANNEL).map((p) => p.payload as LiveDeltaMessage);
    expect(msgs.length).toBeGreaterThan(0);
    const ids = new Set(store.eventsAsc(id).map((e) => e.id));
    for (const m of msgs) {
      expect(m.s).toBe(id);
      for (const d of m.d) expect(ids.has(d.id)).toBe(true);
      // Small payloads: ids and numbers, no text.
      expect(JSON.stringify(m).length).toBeLessThan(2000);
    }
    const deltas = msgs.flatMap((m) => m.d);
    expect(deltas.some((d) => d.k === "verdict" && d.c === 1 && d.v === "win")).toBe(true);
    expect(deltas.some((d) => d.k === "best" && d.c === 1)).toBe(true);
    expect(deltas.some((d) => d.k === "phase")).toBe(true);
    const at = port.published.filter((p) => p.channel === LIVE_CHANNEL).map((p) => p.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(240);
    // The pages' refetch signal still goes out.
    expect(port.published.some((p) => p.channel === "study-changed")).toBe(true);
  });

  it("reads tool items when BB announces new thread events, once per new sequence, at most 100 per page", async () => {
    await running(["Idea A"]);
    for (let i = 0; i < 130; i++) port.addActivity("thr_w1", i < 129 ? "fileRead" : "fileChange", { at: clock.t + i });
    engine.onThreadEvents("thr_w1", 500);
    engine.onThreadEvents("thr_w1", 500); // coalesced: already reading
    await new Promise((r) => setTimeout(r, 20));
    engine.live.flushPending();
    const w = store.threadById("thr_w1")!;
    expect(w).toMatchObject({ activity: "editing", activity_seq: 130, phase: "editing" });
    const calls = port.activityCalls;
    engine.onThreadEvents("thr_w1", 500); // nothing new since that sequence
    await new Promise((r) => setTimeout(r, 20));
    expect(port.activityCalls).toBe(calls);
    // Strategist and unknown threads are ignored.
    engine.onThreadEvents("thr_study", 900);
    engine.onThreadEvents("thr_nope", 900);
    await new Promise((r) => setTimeout(r, 20));
    expect(port.activityCalls).toBe(calls);
  });

  it("rate-limits flips between reading, editing and testing", async () => {
    engine.live.dispose();
    engine = new Engine({ ...engine.ctx, config: { ...engine.ctx.config, liveDwellMs: 3000 } });
    await running(["Idea A"]);
    const w = store.threadById("thr_w1")!;
    const phases = () => store.eventsAsc(store.study(SLUG)!.id, { kinds: ["worker.phase"] }).length;
    const before = phases();
    clock.advance(10);
    port.addActivity("thr_w1", "fileChange", { at: clock.t });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    // Within the dwell after "reading": not recorded yet.
    expect(store.threadById("thr_w1")!.phase).toBe("reading");
    expect(phases()).toBe(before);
    clock.advance(3000);
    engine.live.sync(store.study(SLUG)!.id);
    expect(store.threadById("thr_w1")!.phase).toBe("editing");
    expect(phases()).toBe(before + 1);
  });

  it("builds the live view: lanes, cards in columns, bench, idea queue, feed in plain words", async () => {
    const id = await running(["Idea A", "Idea B", "Idea C", "Idea D"]);
    clock.advance(41_000);
    await submit("thr_w1", "TA", 900);
    await submit("thr_w2", "TB", 1004);
    await settle();
    const v = liveView(engine, store.study(id)!);
    expect(v).toMatchObject({ studyId: id, slug: SLUG, state: "running", studyThreadId: "thr_study" });
    expect(v.workers.map((w) => w.ideaTitle).sort()).toEqual(["Idea A", "Idea B", "Idea C"]);
    expect(v.workers.find((w) => w.threadId === "thr_w3")!.phase).toBe("reading");
    expect(v.workers.find((w) => w.threadId === "thr_w1")).toMatchObject({ phase: "verdict", candidate: 1, submissions: 1, maxSubmissions: 3 });
    expect(v.cards.map((c) => [c.n, c.column])).toEqual([
      [1, "promoted"],
      [2, "verdict"],
    ]);
    expect(v.cards[0]).toMatchObject({ verdict: "win", effectText: "10.0% lower size", pairs: { run: "confirm" } });
    expect(v.best).toMatchObject({ text: "10.0% lower size", n: 1 });
    expect(v.ideas.next.map((i) => i.title)).toEqual(["Idea D"]);
    expect(v.bench).toHaveLength(1);
    expect(v.bench[0]!.current).toBeNull();
    const texts = v.feed.map((f) => f.text);
    // A local noisy bench is single-machine mode (auto): tests wait for the bench, then hold it.
    expect(texts).toEqual(expect.arrayContaining(["c/1 waits to run its tests on the bench", "c/1 tests started on edit-machine (local), holding the bench (single-machine mode)", "c/1 won: 10.0% lower size", "Best moved: c/1 promoted, workers notified"]));
    expect(texts.some((t) => /^c\/1 tests passed in [\d.]+ s, queued for the bench$/u.test(t))).toBe(true);
    // Promotion is recorded before the verdict, but the feed tells the win first.
    expect(texts.indexOf("c/1 won: 10.0% lower size")).toBeLessThan(texts.indexOf("Best moved: c/1 promoted, workers notified"));
    expect(texts.some((t) => /^c\/1 measured: \d+ pairs, then \d+ confirmation pairs? in /u.test(t))).toBe(true);
    expect(texts.some((t) => /^c\/2 (lost|inconclusive): /u.test(t))).toBe(true);
    expect(v.feed.find((f) => f.text.startsWith("c/1 won"))).toMatchObject({ candidate: 1, tone: "win" });
    expect(texts.some((t) => t.startsWith("A worker picked idea #1 (Idea A)"))).toBe(true);
    expect(v.lastEventId).toBe(store.lastStudyEventId(id));
  });

  it("shows a measurement in progress on the bench strip", async () => {
    const id = await running(["Idea A"]);
    let seen: LiveView | null = null;
    host.onMeasure = () => {
      const c = store.candidateByN(id, 1);
      if (!seen && c?.stage === "measuring" && store.samples(c.id).length >= 4) seen = liveView(engine, store.study(id)!);
    };
    await submit("thr_w1", "TA", 900);
    await settle();
    expect(seen).not.toBeNull();
    const v = seen! as LiveView;
    expect(v.bench[0]!.current).toMatchObject({ kind: "measure", n: 1, stage: "measuring", pairs: { run: "measure", of: 6 } });
    expect(v.cards.find((c) => c.n === 1)).toMatchObject({ column: "bench" });
    expect(v.workers[0]).toMatchObject({ phase: "measuring", candidate: 1 });
  });

  it("resolves a thread to its study (the Live panel)", async () => {
    await running(["Idea A"]);
    expect(threadStudy(engine, "thr_study")).toMatchObject({ slug: SLUG, role: "study", studyThreadId: "thr_study" });
    expect(threadStudy(engine, "thr_w1")).toMatchObject({ slug: SLUG, role: "worker", workerKey: store.threadById("thr_w1")!.id });
    expect(threadStudy(engine, "thr_other")).toBeNull();
  });

  it("feed sentences for losses and rejections use the improvement convention", () => {
    const metric = { name: "ops", unit: "ops", direction: "lower" as const };
    const items = feedItems(
      [
        { id: 1, at: 0, kind: "candidate.verdict", data: { candidate: 9, n: 13, verdict: "lose", effect: -0.004 } },
        { id: 2, at: 0, kind: "candidate.verdict", data: { candidate: 10, n: 14, verdict: "rejected", effect: null, reasons: ["outside the editable scope: bench/x.py"] } },
        { id: 3, at: 0, kind: "candidate.verdict", data: { candidate: 11, n: 15, verdict: "gate_failed", effect: null } },
      ],
      { metric, ideas: new Map(), hostName: (h) => h, candidateN: new Map() },
    );
    expect(items.map((i) => [i.text, i.tone])).toEqual([
      ["c/13 lost: 0.4% more ops (worse)", "lose"],
      ["c/14 rejected: outside the editable scope: bench/x.py", "lose"],
      ["c/15 failed the tests", "lose"],
    ]);
  });
});
