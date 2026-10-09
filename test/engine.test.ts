import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { FakeHost, fakeHostSpec, makeCtx, type FakePort } from "./helpers.ts";
import type { Store } from "../src/db/store.ts";
import type { Clock } from "./helpers.ts";

const SLUG = "toy-size";

describe("study lifecycle and candidate pipeline (fake host)", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;
  let base: string;

  beforeEach(async () => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port, clock } = made);
    engine = new Engine(made.ctx);
    base = host.commit("T0", null, "base");
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });

  async function runningStudy() {
    const text = await engine.proposeStudy("thr_study", "proj_1", fakeHostSpec());
    expect(text).toContain("drafted with spec v1");
    expect(store.study(SLUG)!.state).toBe("draft");
    expect(port.threads.get("thr_study")!.metadata).toEqual({ study: SLUG, role: "strategist" });
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    const s = store.study(SLUG)!;
    expect(s.state).toBe("calibrating");
    expect(s.calibration_status).toBe("ready");
    expect(s.best_sha).toBe(base);
    expect(host.refs.get("refs/heads/studies/toy-size/best")).toBe(base);
    expect(host.refs.get("refs/studies/toy-size/segment/1")).toBe(base);
    expect(store.segment(s.id, 1)).toMatchObject({ baseline_sha: base, mde: 0 });
    // Notices don't start a turn: recorded, study thread marked unread.
    expect(port.sent).toHaveLength(0);
    expect(store.notices(s.id)[0]!.text).toContain("Calibration of `toy-size` is ready");
    expect(port.unread).toContain("thr_study");
    engine.addIdea(SLUG, { title: "Shrink the output" }, "human");
    await engine.start(SLUG, "human");
    await engine.settle();
    expect(store.study(SLUG)!.state).toBe("running");
  }

  it("draft → calibrating → running, spawns one worker and starts a strategist round", async () => {
    await runningStudy();
    expect(port.spawned).toHaveLength(1);
    const spawn = port.spawned[0]!;
    expect(spawn.baseBranch).toBe("studies/toy-size/best");
    expect(spawn.metadata).toMatchObject({ study: SLUG, role: "worker", idea: 1 });
    expect(spawn.prompt).toContain("Shrink the output");
    expect(spawn.prompt).toContain("study_submit_candidate");
    const worker = store.threadById("thr_w1")!;
    expect(worker).toMatchObject({ role: "worker", state: "active", fork_sha: base });
    expect(store.idea(1)!.status).toBe("running");
    const round = port.sent.find((m) => m.threadId === "thr_study" && m.text.includes("Strategist round 1"));
    expect(round?.text).toContain("trigger: study started");
    // The calibration notice rides along in the first round.
    expect(round?.text).toContain("Notices for the human");
    expect(round?.text).toContain("Calibration of `toy-size` is ready");
    expect(store.notices(store.study(SLUG)!.id, { undelivered: true })).toHaveLength(0);
    // W=1: a second idea doesn't spawn a second worker.
    engine.addIdea(SLUG, { title: "Another" }, "human");
    await engine.settle();
    expect(port.spawned).toHaveLength(1);
  });

  it("win: snapshot → gate → measure → promote (squash + fast-forward best) → verdict delivered → finding → finish → archived", async () => {
    await runningStudy();
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 900);
    const ticket = await engine.submit("thr_w1", "Remove padding from the output");
    expect(ticket).toContain("Submitted as c/1");
    expect(ticket).toContain("END YOUR TURN");
    await engine.settle();
    const c = store.candidateByN(store.study(SLUG)!.id, 1)!;
    expect(c).toMatchObject({ stage: "decided", verdict: "win", against_sha: base });
    expect(c.effect).toBeCloseTo(0.1);
    expect(c.reported_at).not.toBeNull();
    const best = store.study(SLUG)!.best_sha!;
    expect(best).not.toBe(base);
    expect(host.refs.get("refs/heads/studies/toy-size/best")).toBe(best);
    expect(host.commits.get(best)).toMatchObject({ tree: "T1", parent: base });
    expect(host.commits.get(best)!.message).toContain("Autoresearch-Candidate: c/1");
    expect(host.refs.get("refs/studies/toy-size/c/1")).toBe(c.sha);
    const verdict = port.sent.find((m) => m.threadId === "thr_w1" && m.text.includes("Verdict for c/1"));
    expect(verdict?.text).toContain("WIN: promoted to best");
    expect(verdict?.text).toContain("1 submission(s) left");

    await expect(engine.finish("thr_w1")).rejects.toThrow(/record_finding/u);
    expect(await engine.recordFinding("thr_w1", { outcome: "improved", learned: "Padding was 10% of the output." })).toContain("Finding #1");
    host.refs.set("refs/heads/bb/thr_w1", c.sha);
    expect(await engine.finish("thr_w1")).toContain("Assignment finished");
    engine.onThreadIdle("thr_w1");
    await engine.settle();
    expect(store.threadById("thr_w1")!.state).toBe("finished");
    expect(port.threads.get("thr_w1")!.archivedAt).not.toBeNull();
    expect(port.stopped).toContain("thr_w1");
    expect(port.released).toEqual(["env_w1"]);
    expect(host.refs.has("refs/heads/bb/thr_w1")).toBe(false);
    expect(store.idea(1)!.status).toBe("won");
    const kinds = store.events(store.study(SLUG)!.id, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["candidate.submitted", "candidate.queued", "best.promoted", "candidate.verdict", "verdict.delivered", "finding.recorded", "worker.finished"]));
  });

  it("lose and guardrail-free inconclusive leave best alone", async () => {
    await runningStudy();
    host.nextSnapshot = { tree: "T2" };
    host.metric.set("T2", 1100);
    await engine.submit("thr_w1", "Make it bigger by accident");
    await engine.settle();
    const s = store.study(SLUG)!;
    expect(store.candidateByN(s.id, 1)!.verdict).toBe("lose");
    expect(s.best_sha).toBe(base);
    host.nextSnapshot = { tree: "T3" };
    host.metric.set("T3", 1000);
    await engine.submit("thr_w1", "A change with no effect at all");
    await engine.settle();
    expect(store.candidateByN(s.id, 2)!.verdict).toBe("inconclusive");
    expect(await engine.submit("thr_w1", "third submission over the cap")).toContain("Submission cap reached");
  });

  it("rejects out-of-scope changes immediately without measuring", async () => {
    await runningStudy();
    host.nextSnapshot = { tree: "T4", changedPaths: ["bench/measure.sh"] };
    const text = await engine.submit("thr_w1", "Tweak the benchmark harness");
    expect(text).toContain("REJECTED (scope)");
    expect(text).toContain("protected paths changed: bench/measure.sh");
    const c = store.candidateByN(store.study(SLUG)!.id, 1)!;
    expect(c).toMatchObject({ verdict: "rejected", stage: "decided" });
    expect(c.reported_at).not.toBeNull();
    expect(host.calls).not.toContain("prepareCandidate");
  });

  it("gate failure retries once (flaky) and then fails with output", async () => {
    await runningStudy();
    host.nextSnapshot = { tree: "T5" };
    host.metric.set("T5", 900);
    host.gateFailures.set("T5", 1);
    await engine.submit("thr_w1", "Passes on the second try");
    await engine.settle();
    const s = store.study(SLUG)!;
    expect(store.candidateByN(s.id, 1)!.verdict).toBe("win");
    expect(store.events(s.id, { kinds: ["gate.flaky"] })).toHaveLength(1);
    host.nextSnapshot = { tree: "T6" };
    host.gateFailures.set("T6", 2);
    await engine.submit("thr_w1", "Breaks the tests for real");
    await engine.settle();
    const c2 = store.candidateByN(s.id, 2)!;
    expect(c2.verdict).toBe("gate_failed");
    expect(c2.gate_output).toContain("FAIL test_x");
    expect(port.sent.at(-1)!.text).toContain("GATE FAILED");
  });

  it("conflict when the candidate no longer applies onto best", async () => {
    await runningStudy();
    host.nextSnapshot = { tree: "T7" };
    const orig = host.snapshot.bind(host);
    host.snapshot = async (input) => {
      const r = await orig(input);
      host.conflicts.add(r.sha);
      return r;
    };
    await engine.submit("thr_w1", "Conflicting change here");
    await engine.settle();
    const c = store.candidateByN(store.study(SLUG)!.id, 1)!;
    expect(c.verdict).toBe("conflict");
    expect(port.sent.at(-1)!.text).toContain("git rebase studies/toy-size/best");
    expect(port.sent.at(-1)!.text).toContain("does not count against your submission limit");
    expect(store.threadById("thr_w1")).toMatchObject({ submissions: 0, conflict_refunds: 1 });
  });

  it("host errors are retried, then the study pauses and the human is told", async () => {
    await runningStudy();
    host.nextSnapshot = { tree: "T8" };
    host.metric.set("T8", 900);
    const realPrepare = host.prepareCandidate.bind(host);
    host.prepareCandidate = async () => {
      throw new Error("host offline");
    };
    await engine.submit("thr_w1", "Will hit host errors");
    await engine.settle(4);
    expect(store.candidateByN(store.study(SLUG)!.id, 1)!.attempts).toBe(3);
    const s = store.study(SLUG)!;
    expect(s.state).toBe("paused");
    expect(s.pause_reason).toContain("host offline");
    expect(store.notices(s.id)[0]!.text).toContain("paused itself");
    expect(store.notices(s.id)[0]!.text).toContain("Next: resume");
    expect(port.sent.filter((m) => m.threadId === "thr_study" && m.text.includes("paused itself"))).toHaveLength(0);
    // Resume after the host is back: the same candidate completes.
    host.prepareCandidate = realPrepare;
    engine.resume(SLUG, "human");
    await engine.settle();
    expect(store.candidateByN(s.id, 1)!.verdict).toBe("win");
  });

  it("idle worker: one nudge, then abandoned and archived", async () => {
    await runningStudy();
    engine.onThreadIdle("thr_w1");
    clock.advance(11 * 60_000);
    await engine.settle(1);
    expect(port.sent.filter((m) => m.threadId === "thr_w1" && m.text.includes("idle"))).toHaveLength(1);
    clock.advance(5 * 60_000);
    await engine.settle(1);
    expect(store.threadById("thr_w1")!.state).toBe("active");
    clock.advance(6 * 60_000);
    await engine.settle(1);
    expect(store.threadById("thr_w1")!.state).toBe("abandoned");
    expect(store.idea(1)!.status).toBe("abandoned");
    expect(port.threads.get("thr_w1")!.archivedAt).not.toBeNull();
  });

  it("pauses when the candidate budget is exhausted", async () => {
    await runningStudy();
    for (const [i, tree] of ["Ta", "Tb"].entries()) {
      host.nextSnapshot = { tree };
      host.metric.set(tree, 1100);
      await engine.submit("thr_w1", `attempt number ${i}`);
      await engine.settle();
    }
    await engine.recordFinding("thr_w1", { outcome: "regressed", learned: "Both attempts made it bigger." });
    await engine.finish("thr_w1");
    engine.onThreadIdle("thr_w1");
    engine.addIdea(SLUG, { title: "Third idea" }, "human");
    await engine.settle();
    // Third worker spawns (2 candidates < 3), submits once, then budget is hit.
    expect(port.spawned).toHaveLength(2);
    host.nextSnapshot = { tree: "Tc" };
    host.metric.set("Tc", 1100);
    await engine.submit("thr_w2", "attempt number 3");
    await engine.settle();
    await engine.recordFinding("thr_w2", { outcome: "regressed", learned: "Bigger again." });
    await engine.finish("thr_w2");
    engine.onThreadIdle("thr_w2");
    await engine.settle();
    const s = store.study(SLUG)!;
    expect(s.state).toBe("paused");
    expect(s.pause_reason).toContain("max_candidates");
  });

  it("archive stops workers and removes checkouts", async () => {
    await runningStudy();
    const text = await engine.archiveStudy(SLUG, "human");
    expect(text).toContain("1 worker(s) stopped");
    expect(store.study(SLUG)!.state).toBe("archived");
    expect(store.threadById("thr_w1")!.state).toBe("abandoned");
    expect([...host.checkouts.keys()].filter((k) => k.startsWith("/co/toy-size-"))).toHaveLength(0);
  });

  it("calibration fails back to draft when the gate is red on base", async () => {
    await engine.proposeStudy("thr_study", "proj_1", fakeHostSpec());
    host.gateFailures.set("T0", 5);
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    const s = store.study(SLUG)!;
    expect(s.state).toBe("draft");
    expect(s.calibration_status).toBe("failed");
    expect(store.notices(s.id)[0]!.text).toContain("gate is red on the baseline");
    expect(port.sent).toHaveLength(0);
    await expect(engine.start(SLUG, "human")).rejects.toThrow(/calibration/u);
  });
});
