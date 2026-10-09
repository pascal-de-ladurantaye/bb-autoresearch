import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { FakeHost, fakeHostSpec, makeCtx } from "./helpers.ts";

const SLUG = "toy-size";

async function runningStudy() {
  const host = new FakeHost();
  const made = makeCtx(host);
  const engine = new Engine(made.ctx);
  const base = host.commit("T0", null);
  host.refs.set("main", base);
  host.metric.set("T0", 1000);
  made.port.addThread("thr_study");
  await engine.proposeStudy("thr_study", "proj_1", fakeHostSpec());
  await engine.calibrate(SLUG, "human");
  await engine.waitForCalibration(SLUG, 5_000);
  engine.onThreadIdle("thr_study");
  engine.addIdea(SLUG, { title: "Shrink" }, "human");
  await engine.start(SLUG, "human");
  await engine.settle();
  return { ...made, host, engine, base, studyId: made.store.study(SLUG)!.id };
}

describe("reconciliation on load", () => {
  it("restarts in-flight measurements from scratch, discarding partial samples", async () => {
    const { store, ctx, studyId, host } = await runningStudy();
    host.metric.set("T1", 900);
    const c = store.insertCandidate({ study_id: studyId, n: 1, idea_id: 1, thread_id: "thr_w1", sha: host.commit("T1", null), parent_sha: store.study(SLUG)!.best_sha!, summary: "x", stage: "measuring", changed_paths_json: '["src/a.ts"]' });
    store.updateCandidate(c.id, { against_sha: store.study(SLUG)!.best_sha, prepared_sha: host.commit("T1", store.study(SLUG)!.best_sha) });
    store.addSample({ study_id: studyId, candidate_id: c.id, run: "measure", pair: 0, side: "best", metric: "size", value: 1, host_id: "h" });
    // "Reload": a fresh engine over the same database.
    const engine2 = new Engine(ctx);
    const r = await engine2.reconcile();
    expect(r.requeued).toBe(1);
    expect(store.events(studyId, { kinds: ["candidate.requeued"] })).toHaveLength(1);
    await engine2.settle();
    const done = store.candidate(c.id)!;
    expect(done.verdict).toBe("win");
    // Fresh samples only: best+candidate from the new run, none of the stale one.
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM samples WHERE candidate_id = ? AND value = 1").get(c.id)).toEqual({ n: 0 });
  });

  it("is idempotent: a second reconcile changes nothing", async () => {
    const { ctx, store, studyId } = await runningStudy();
    const engine2 = new Engine(ctx);
    await engine2.reconcile();
    const before = JSON.stringify([store.threads(studyId), store.candidates(studyId), store.ideas(studyId)]);
    await engine2.reconcile();
    expect(JSON.stringify([store.threads(studyId), store.candidates(studyId), store.ideas(studyId)])).toBe(before);
  });

  it("binds a worker whose spawn was interrupted, or requeues its idea when no thread exists", async () => {
    const { ctx, store, port, studyId } = await runningStudy();
    // Interrupted spawn #1: the thread exists with our token.
    store.insertThread({ study_id: studyId, role: "worker", spawn_token: "tok-a", idea_id: null, state: "spawning" });
    port.addThread("thr_late", "active", { study: SLUG, role: "worker", spawnToken: "tok-a" });
    // Interrupted spawn #2: no thread was created.
    const idea = store.addIdea(studyId, { title: "lost", source: "human" }, "human");
    store.setIdeaStatus(idea.id, "running", "plugin");
    store.insertThread({ study_id: studyId, role: "worker", spawn_token: "tok-b", idea_id: idea.id, state: "spawning" });
    await new Engine(ctx).reconcile();
    expect(store.threadByToken("tok-a")).toMatchObject({ thread_id: "thr_late", state: "active" });
    expect(store.threadByToken("tok-b")).toMatchObject({ state: "failed" });
    expect(store.idea(idea.id)!.status).toBe("queued");
  });

  it("closes out workers whose threads disappeared or finished while unloaded", async () => {
    const { ctx, store, port } = await runningStudy();
    // thr_w1 was archived by the user while the plugin was disabled.
    port.threads.get("thr_w1")!.archivedAt = 1;
    await new Engine(ctx).reconcile();
    expect(store.threadById("thr_w1")!.state).toBe("abandoned");
    expect(store.idea(1)!.status).toBe("abandoned");
  });

  it("archives a finishing worker whose turn ended while unloaded", async () => {
    const { ctx, store, port, studyId } = await runningStudy();
    const w = store.threadById("thr_w1")!;
    store.updateThread(w.id, { state: "finishing" });
    port.threads.get("thr_w1")!.status = "idle";
    await new Engine(ctx).reconcile();
    expect(store.threadById("thr_w1")!.state).toBe("finished");
    expect(port.threads.get("thr_w1")!.archivedAt).not.toBeNull();
    expect(store.events(studyId, { kinds: ["worker.finished"] }).length).toBeGreaterThan(0);
  });

  it("finishes a promotion interrupted after the ref moved, without promoting twice", async () => {
    const { ctx, store, studyId, host } = await runningStudy();
    const best = store.study(SLUG)!.best_sha!;
    const prepared = host.commit("T9", best);
    const promoted = host.commit("T9", best, "final");
    const c = store.insertCandidate({ study_id: studyId, n: 1, idea_id: 1, thread_id: "thr_w1", sha: prepared, parent_sha: best, summary: "x", stage: "promoting", changed_paths_json: "[]" });
    store.updateCandidate(c.id, { against_sha: best, prepared_sha: prepared, promoted_sha: promoted, effect: 0.1, reasons_json: '["improved"]' });
    host.refs.set("refs/heads/studies/toy-size/best", promoted);
    const engine2 = new Engine(ctx);
    await engine2.reconcile();
    await engine2.settle();
    expect(store.candidate(c.id)).toMatchObject({ stage: "decided", verdict: "win" });
    expect(store.study(SLUG)!.best_sha).toBe(promoted);
    expect(host.calls.filter((x) => x === "rewordCommit")).toHaveLength(0);
  });

  it("restarts a calibration that was running when the plugin unloaded", async () => {
    const host = new FakeHost();
    const made = makeCtx(host);
    const base = host.commit("T0", null);
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    made.port.addThread("thr_study");
    const e1 = new Engine(made.ctx);
    await e1.proposeStudy("thr_study", "proj_1", fakeHostSpec());
    const s = made.store.study(SLUG)!;
    made.store.updateStudy(s.id, { state: "calibrating", calibration_status: "running" });
    const e2 = new Engine(made.ctx);
    expect((await e2.reconcile()).calibrations).toBe(1);
    await e2.waitForCalibration(SLUG, 5_000);
    expect(made.store.study(SLUG)!.calibration_status).toBe("ready");
  });
});
