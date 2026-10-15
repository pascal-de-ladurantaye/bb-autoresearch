// M1: parallel workers, bench queue, backpressure, adaptive W, rebase and
// conflict handling, promotion when best moves, diversity, and the
// finishing race.
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import type { Store } from "../src/db/store.ts";
import { utilization } from "../src/views.ts";
import { FakeHost, makeCtx, waitFor, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-noisy";

function noisySpec(maxWorkers = 3, extra = ""): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy program faster under the noisy benchmark."
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
# These M1 tests are about parallel gates outside the bench lock (single-machine mode: single-machine.test.ts).
single_machine = "off"

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
${extra}
`;
}

describe("M1 parallel study (fake host)", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;
  let base: string;

  beforeEach(() => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port, clock } = made);
    engine = new Engine(made.ctx);
    base = host.commit("T0", null, "base");
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });

  async function running(ideas: Array<{ title: string; theme?: string; priority?: number }>, maxWorkers = 3) {
    await engine.proposeStudy("thr_study", "proj_1", noisySpec(maxWorkers));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    expect(store.study(SLUG)!.calibration_status).toBe("ready");
    for (const i of ideas) engine.addIdea(SLUG, { ...i, pinned: false }, "human");
    await engine.start(SLUG, "human");
    await engine.settle();
    return store.study(SLUG)!.id;
  }

  /** Submit from a worker with a given tree (metric value set per tree). */
  async function submit(thread: string, tree: string, value: number, summary = `change ${tree} for speed`) {
    host.nextSnapshotFor.set(`/wt/${thread}`, { tree });
    host.metric.set(tree, value);
    return await engine.submit(thread, { title: summary });
  }

  it("spawns W > 1 workers in one pass, respecting the theme cap ceil(W/2)", async () => {
    const id = await running([
      { title: "Alloc idea one", theme: "alloc", priority: 9 },
      { title: "Alloc idea two", theme: "alloc", priority: 8 },
      { title: "Alloc idea three", theme: "alloc", priority: 7 },
      { title: "Parse idea", theme: "parse", priority: 1 },
    ]);
    expect(port.spawned).toHaveLength(3);
    const themes = store.threads(id, { role: "worker" }).map((w) => store.idea(w.idea_id!)!.theme);
    expect(themes.filter((t) => t === "alloc")).toHaveLength(2);
    expect(themes).toContain("parse");
    expect(store.idea(3)!.status).toBe("queued");
    expect(store.study(id)!.target_workers).toBe(3);
  });

  it("gates run in parallel outside the bench lock; measurements never overlap", async () => {
    const id = await running([
      { title: "Idea A", theme: "a" },
      { title: "Idea B", theme: "b" },
      { title: "Idea C", theme: "c" },
    ]);
    host.delays = { gate: 40, measure: 2 };
    // Three submissions land together: their gates start at once.
    await Promise.all([submit("thr_w1", "TA", 900), submit("thr_w2", "TB", 1100), submit("thr_w3", "TC", 1000)]);
    await engine.settle();
    expect(host.maxActive.gate).toBeGreaterThanOrEqual(2);
    expect(host.maxActive.measure).toBe(1);
    const verdicts = store.candidates(id).map((c) => c.verdict);
    expect(verdicts).toEqual(expect.arrayContaining(["win", "lose"]));
    // Bench intervals for measurements never overlap.
    const intervals = store.benchIntervals(id).filter((i) => i.kind === "measure");
    expect(intervals.length).toBeGreaterThanOrEqual(3);
    expect(utilization(engine, store.study(id)!).overlaps).toBe(0);
    // Each candidate's samples were recorded inside its own measurement interval.
    for (const c of store.candidates(id)) {
      const mine = intervals.filter((i) => i.candidate_id === c.id);
      for (const smp of store.samples(c.id)) expect(mine.some((i) => smp.at >= i.started_at && smp.at <= (i.ended_at ?? Infinity))).toBe(true);
    }
  });

  it("measurement and gating overlap: the bench is not blocked by gates", async () => {
    await running([
      { title: "Idea A", theme: "a" },
      { title: "Idea B", theme: "b" },
    ]);
    host.delays = { gate: 60, measure: 30 };
    let overlap = false;
    let waited = false;
    host.onMeasure = async () => {
      // A's first run waits (bounded) for B's gate: no dependence on wall-clock timing.
      if (waited) return;
      waited = true;
      if (await waitFor(() => host.active.gate > 0, 5_000)) overlap = true;
    };
    await submit("thr_w1", "TA", 950);
    // Once A is measuring, B submits and gates during A's measurement.
    await waitFor(() => host.active.measure > 0);
    await submit("thr_w2", "TB", 1050);
    await engine.settle();
    expect(overlap).toBe(true);
  });

  it("backpressure: no spawn while the bench queue is at least W deep", async () => {
    const id = await running([
      { title: "Idea A", theme: "a" },
      { title: "Idea B", theme: "b" },
      { title: "Idea C", theme: "c" },
      { title: "Idea D", theme: "d" },
    ]);
    expect(port.spawned).toHaveLength(3);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    host.onMeasure = () => gate;
    clock.advance(10 * 60_000); // workers think for a while, so adaptive W stays at max_workers
    await Promise.all([submit("thr_w1", "TA", 1100), submit("thr_w2", "TB", 1100), submit("thr_w3", "TC", 1100)]);
    // Let the gates finish; the first measurement is now blocked.
    await waitFor(() => store.candidates(id, { stages: ["gating"] }).length === 0);
    expect(engine.benchDepth(id)).toBe(3);
    // Worker 3 goes away; its candidate stays in the bench queue.
    port.threads.get("thr_w3")!.archivedAt = clock.now();
    engine.onThreadGone("thr_w3", "archived");
    await engine.tick();
    await engine.tick();
    expect(store.threads(id, { role: "worker", states: ["spawning", "active", "finishing"] })).toHaveLength(2);
    expect(port.spawned).toHaveLength(3);
    // Bench drains below W: the next worker spawns.
    release();
    host.onMeasure = null;
    await engine.settle();
    expect(port.spawned).toHaveLength(4);
    expect(store.events(id, { kinds: ["worker.spawned"], limit: 10 })).toHaveLength(4);
  });

  it("adaptive W follows think and eval times, capped by max_workers and the human override", async () => {
    const id = await running([{ title: "Idea A", theme: "a" }], 4);
    const s = () => store.study(id)!;
    expect(engine.workerTarget(s()).w).toBe(4); // nothing learned yet beyond calibration: think time unknown
    // Learn: workers think 30 s, an evaluation takes 30 s -> W = ceil(30/30)+1 = 2.
    const w1 = store.threadById("thr_w1")!;
    clock.advance(30_000);
    await submit("thr_w1", "TA", 1100);
    await engine.settle();
    const c1 = store.candidateByN(id, 1)!;
    store.updateCandidate(c1.id, { bench_seconds: 30 });
    expect((c1.submitted_at - w1.spawned_at) / 1000).toBe(30);
    const t = engine.workerTarget(s());
    expect(t).toMatchObject({ w: 2, tThink: 30, tEval: 30 });
    expect(store.events(id, { kinds: ["scheduler.target"] })[0]!.data_json).toContain('"w":2');
    // Slow thinkers (300 s) against 30 s evals want 11 workers: capped at max_workers 4, then the override.
    store.updateCandidate(c1.id, { submitted_at: w1.spawned_at + 300_000 });
    expect(engine.workerTarget(s()).w).toBe(4);
    engine.setConcurrency(SLUG, 2, "human");
    expect(engine.workerTarget(s()).w).toBe(2);
    engine.setConcurrency(SLUG, null, "human");
    expect(engine.workerTarget(s()).w).toBe(4);
  });

  it("best moved while queued: the candidate is rebased, re-gated, and measured against the new best", async () => {
    const id = await running([
      { title: "Idea A", theme: "a" },
      { title: "Idea B", theme: "b" },
    ]);
    host.delays = { gate: 0, measure: 1 };
    await Promise.all([submit("thr_w1", "TA", 900), submit("thr_w2", "TB", 950)]);
    await engine.settle();
    const [a, b] = [store.candidateByN(id, 1)!, store.candidateByN(id, 2)!];
    expect(a.verdict).toBe("win");
    expect(b.against_sha).toBe(a.promoted_sha);
    expect(b.rebases).toBe(1);
    expect(store.events(id, { kinds: ["candidate.rebased"] })).toHaveLength(1);
    expect(store.events(id, { kinds: ["candidate.requeued"] })[0]!.data_json).toContain("best moved while queued");
    // B measured 5% better than T0 but only ~5.6% better than... against A's best (900), B (950) is worse: lose.
    expect(b.verdict).toBe("lose");
    expect(host.commits.get(b.prepared_sha!)!.parent).toBe(a.promoted_sha);
  });

  it("conflict after best moved: refunded, delivered to the worker, which rebases and resubmits from the new best", async () => {
    const id = await running([
      { title: "Idea A", theme: "a" },
      { title: "Idea B", theme: "b" },
    ]);
    host.delays = { gate: 0, measure: 1 };
    let bSha = "";
    host.onMeasure = () => {
      if (bSha) host.conflicts.add(bSha);
    };
    await submit("thr_w1", "TA", 900);
    await submit("thr_w2", "TB", 850);
    bSha = store.candidateByN(id, 2)!.sha;
    await engine.settle();
    const b = store.candidateByN(id, 2)!;
    expect(b.verdict).toBe("conflict");
    const msg = port.sent.filter((m) => m.threadId === "thr_w2").at(-1)!.text;
    expect(msg).toContain("Conflict: no longer applies to best");
    expect(msg).toContain("git rebase studies/toy-noisy/best");
    expect(store.threadById("thr_w2")).toMatchObject({ submissions: 0, conflict_refunds: 1 });
    // The worker rebases onto best (its worktree head now descends from best) and resubmits.
    const best = store.study(id)!.best_sha!;
    host.worktreeHead.set("/wt/thr_w2", host.commit("TB-rebased", best, "rebased"));
    const ticket = await submit("thr_w2", "TB2", 800);
    expect(ticket).toContain("Submitted as c/3");
    await engine.settle();
    const c3 = store.candidateByN(id, 3)!;
    expect(c3.parent_sha).toBe(best); // forks from the new best, not its original fork point
    expect(store.threadById("thr_w2")!.fork_sha).toBe(best);
    expect(c3.verdict).toBe("win");
    expect(store.threadById("thr_w2")!.submissions).toBe(1);
  });

  it("conflict refunds are bounded", async () => {
    const id = await running([{ title: "Idea A", theme: "a" }], 1);
    const orig = host.snapshot.bind(host);
    host.snapshot = async (input) => {
      const r = await orig(input);
      host.conflicts.add(r.sha);
      return r;
    };
    for (let i = 0; i < 3; i++) {
      await submit("thr_w1", `TX${i}`, 900);
      await engine.settle();
    }
    expect(store.candidates(id).map((c) => c.verdict)).toEqual(["conflict", "conflict", "conflict"]);
    expect(store.threadById("thr_w1")).toMatchObject({ conflict_refunds: 2, submissions: 1 });
  });

  it("best moved during measurement: the win is re-measured against the new best before promotion", async () => {
    const id = await running([{ title: "Idea A", theme: "a" }]);
    host.delays = { gate: 0, measure: 1 };
    // Mid-measurement, another bench host (M2) promotes something: best moves.
    let moved = "";
    host.onMeasure = () => {
      if (moved) return;
      const s = store.study(id)!;
      moved = host.commit("TM", s.best_sha, "promoted elsewhere");
      host.metric.set("TM", 1000);
      host.refs.set("refs/heads/studies/toy-noisy/best", moved);
      store.updateStudy(id, { best_sha: moved });
    };
    await submit("thr_w1", "TA", 900);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    const reasons = store.events(id, { kinds: ["candidate.requeued"] }).map((e) => e.data_json);
    expect(reasons.some((r) => r.includes("best moved during measurement"))).toBe(true);
    expect(c.verdict).toBe("win");
    expect(c.against_sha).toBe(moved);
    expect(host.commits.get(c.promoted_sha!)!.parent).toBe(moved);
    expect(host.refs.get("refs/heads/studies/toy-noisy/best")).toBe(c.promoted_sha);
  });

  it("promotion CAS: if the best branch moved, the candidate is re-measured instead of promoted", async () => {
    const id = await running([{ title: "Idea A", theme: "a" }]);
    const realUpdate = host.updateRef.bind(host);
    let other = "";
    host.updateRef = async (repo, ref, newSha, oldSha) => {
      if (!other && ref === "refs/heads/studies/toy-noisy/best" && oldSha !== null) {
        other = host.commit("TO", oldSha, "someone else");
        host.metric.set("TO", 1000);
        host.refs.set(ref, other);
        store.updateStudy(id, { best_sha: other });
      }
      return await realUpdate(repo, ref, newSha, oldSha);
    };
    await submit("thr_w1", "TA", 900);
    await engine.settle();
    const c = store.candidateByN(id, 1)!;
    expect(store.events(id, { kinds: ["candidate.requeued"] }).some((e) => e.data_json.includes("during promotion"))).toBe(true);
    expect(c.verdict).toBe("win");
    expect(c.against_sha).toBe(other);
    expect(host.commits.get(c.promoted_sha!)!.parent).toBe(other);
    expect(host.refs.get("refs/heads/studies/toy-noisy/best")).toBe(c.promoted_sha);
  });

  it("best moved: workers mid-turn get it steered in, idle workers get it on their next message", async () => {
    const id = await running([
      { title: "Idea A", theme: "a" },
      { title: "Idea B", theme: "b" },
      { title: "Idea C", theme: "c" },
    ]);
    port.threads.get("thr_w3")!.status = "idle";
    const sentBefore = port.sent.length;
    await submit("thr_w1", "TA", 900);
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    // No new turns for the FYI: one steer into w2's running turn; w3 deferred.
    expect(port.steered.map((m) => m.threadId)).toEqual(["thr_w2"]);
    expect(port.sent.slice(sentBefore).filter((m) => m.threadId !== "thr_w1")).toHaveLength(0);
    expect(store.threadById("thr_w3")!.pending_notice).toContain("best moved");
    const ticket = await submit("thr_w3", "TC", 1100);
    expect(ticket).toMatch(/^\[autoresearch\] FYI: best moved/u);
    expect(store.threadById("thr_w3")!.pending_notice).toBeNull();
  });

  it("(a) a finishing worker blocks the next spawn until its turn ends, with a timeout", async () => {
    const id = await running([{ title: "Idea A", theme: "a" }, { title: "Idea B", theme: "b" }], 1);
    expect(port.spawned).toHaveLength(1);
    await submit("thr_w1", "TA", 1100);
    await engine.settle();
    await engine.recordFinding("thr_w1", { outcome: "regressed", learned: "It got slower, as expected." });
    await engine.finish("thr_w1");
    // Its turn is still running: no second worker yet.
    port.threads.get("thr_w1")!.status = "active";
    await engine.settle();
    expect(store.threadById("thr_w1")!.state).toBe("finishing");
    expect(port.spawned).toHaveLength(1);
    // The turn never ends: after the timeout the worker is stopped and the next one starts.
    clock.advance(4 * 60_000);
    await engine.settle();
    expect(store.threadById("thr_w1")!.state).toBe("finished");
    expect(port.spawned).toHaveLength(2);
    expect(store.events(id, { kinds: ["worker.spawned"] })).toHaveLength(2);
  });

  it("a worker that never submitted still has its worktree released", async () => {
    port.spawnWithoutEnvironment = true;
    const id = await running([{ title: "Idea A", theme: "a" }], 1);
    expect(store.threadById("thr_w1")!.environment_id).toBeNull();
    await engine.recordFinding("thr_w1", { outcome: "not_attempted", learned: "The idea was already done by someone." });
    await engine.finish("thr_w1");
    engine.onThreadIdle("thr_w1");
    await engine.settle();
    expect(store.threads(id, { role: "worker" })[0]!.state).toBe("finished");
    expect(port.released).toEqual(["env_w1"]);
  });

  it("no repeats: lost ideas are not re-queued unless as a variation; start_ref implies a variation", async () => {
    const id = await running([{ title: "Inline the hot loop", theme: "a" }], 1);
    await submit("thr_w1", "TA", 1100);
    await engine.settle();
    await engine.recordFinding("thr_w1", { outcome: "regressed", learned: "Inlining made it slower." });
    await engine.finish("thr_w1");
    engine.onThreadIdle("thr_w1");
    await engine.settle();
    expect(store.idea(1)!.status).toBe("lost");
    const text = await engine.queueIdeas("thr_study", {
      ideas: [
        { title: "inline the HOT loop!", rationale: "try again", theme: "a" },
        { title: "Inline the hot loop with PGO", rationale: "variation with profile data", theme: "a", variation_of: 1 },
        { title: "Combine c/1 with a cache", rationale: "near miss", theme: "b", start_ref: "c/1" },
      ],
    });
    expect(text).toContain("Skipped:");
    expect(text).toContain("repeats lost idea #1");
    const queued = store.ideas(id, ["queued", "running"]);
    expect(queued.map((i) => i.title).sort()).toEqual(["Combine c/1 with a cache", "Inline the hot loop with PGO"]);
    expect(queued.find((i) => i.start_ref === "c/1")!.variation_of).toBe(1);
    expect(queued.every((i) => i.lineage === 1)).toBe(true);
    await expect(engine.queueIdeas("thr_study", { ideas: [{ title: "Bad ref idea", rationale: "x".repeat(10), theme: "a", start_ref: "c/99" }] })).rejects.toThrow(/no such candidate/u);
  });
});
