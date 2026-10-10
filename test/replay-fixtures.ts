// A synthetic replay bundle (performance tests and the replay UI tests).
import type { MeasureBand } from "../src/band.ts";
import type { ReplayBundle } from "../src/replay.ts";

/** A synthetic study with about `target` events: workers, candidates through every stage, pairs, bands, actions, wins. */
export function syntheticBundle(target = 10_000): ReplayBundle {
  const events: ReplayBundle["events"] = [];
  let id = 0;
  let t = 1_700_000_000_000;
  const ev = (kind: string, data: Record<string, unknown>) => events.push({ id: ++id, at: (t += 250), kind, data });
  const ideas: ReplayBundle["ideas"] = [];
  const workers: ReplayBundle["workers"] = [];
  const candidates: ReplayBundle["candidates"] = [];
  const bands: MeasureBand[] = [];
  const intervals: ReplayBundle["intervals"] = [];
  ev("study.state", { from: "calibrating", to: "running" });
  let n = 0;
  let wk = 0;
  while (id < target) {
    const idea = ideas.length + 1;
    ideas.push({ id: idea, title: `Idea ${idea}`, theme: ["algo", "data", "io", ""][idea % 4]!, source: "strategist", variationOf: null });
    ev("idea.added", { idea, theme: ideas.at(-1)!.theme, priority: idea % 3, pinned: false });
    const key = ++wk;
    const thread = `thr_s${key}`;
    workers.push({ key, threadId: thread, ideaId: idea, spawnedAt: t });
    ev("idea.status", { idea, from: "queued", to: "running" });
    ev("worker.phase", { worker: key, thread, idea, from: null, to: "starting" });
    ev("worker.spawned", { thread, idea });
    for (const phase of ["reading", "editing", "testing"]) {
      ev("worker.phase", { worker: key, thread, idea, to: phase });
      ev("worker.action", { worker: key, thread, label: `${phase} src/file${key}.py` });
    }
    for (let sub = 0; sub < 2 && id < target; sub++) {
      const cn = ++n;
      const cid = 1000 + cn;
      candidates.push({ id: cid, n: cn, ideaId: idea, threadId: thread, title: `Idea ${idea}` });
      ev("candidate.stage", { candidate: cid, n: cn, from: null, to: "submitted", worker: thread });
      ev("candidate.submitted", { candidate: cid, n: cn, files: 2 });
      ev("worker.phase", { worker: key, thread, idea, to: "waiting", candidate: cn });
      ev("candidate.stage", { candidate: cid, n: cn, from: "submitted", to: "gating" });
      ev("candidate.stage", { candidate: cid, n: cn, from: "gating", to: "queued" });
      ev("candidate.queued", { candidate: cid });
      ev("candidate.stage", { candidate: cid, n: cn, from: "queued", to: "measuring" });
      ev("measure.started", { candidate: cid, n: cn, host: "host_a", of: 20 });
      const start = t;
      ev("worker.phase", { worker: key, thread, idea, to: "measuring", candidate: cn });
      const points = [];
      for (let p = 1; p <= 12; p++) {
        t += 300;
        points.push({ n: p, at: t, m: 0.02, lo: p > 1 ? 0.02 - 0.1 / p : null, hi: p > 1 ? 0.02 + 0.1 / p : null });
        if (p % 3 === 0) ev("measure.progress", { candidate: cid, n: cn, run: "measure", pairs: p, of: 20, host: "host_a" });
      }
      bands.push({ kind: "noisy", candidate: cid, n: cn, startedAt: start + 300, guardrails: [], final: { at: t + 100, guardrails: [] }, nMin: 6, nMax: 20, mde: 0.01, confidence: 0.95, bootstrap: 2000, exact: true, runs: [{ run: "measure", points, gr: {} }] });
      const win = cn % 5 === 0;
      ev("measure.finished", { candidate: cid, n: cn, pairs: 12, run: "measure", measure_pairs: 12, confirm_pairs: 0, effect: win ? 0.05 : -0.01, seconds: 4 });
      intervals.push({ hostId: "host_a", start, end: t });
      if (win) ev("best.promoted", { candidate: cid, n: cn });
      ev("candidate.stage", { candidate: cid, n: cn, from: "measuring", to: "decided", verdict: win ? "win" : "lose" });
      ev("candidate.verdict", { candidate: cid, n: cn, verdict: win ? "win" : "lose", effect: win ? 0.05 : -0.01, reasons: [] });
      ev("worker.phase", { worker: key, thread, idea, to: "verdict", candidate: cn });
    }
    ev("worker.phase", { worker: key, thread, idea, to: "finishing" });
    ev("worker.finished", { thread, idea });
    ev("idea.status", { idea, from: "running", to: n % 5 === 0 ? "won" : "lost" });
    ev("worker.phase", { worker: key, thread, idea, to: "done" });
  }
  return {
    studyId: "s_syn",
    slug: "synthetic",
    metric: { name: "ms", unit: "ms", direction: "lower" },
    state: "archived",
    studyThreadId: null,
    start: events[0]!.at,
    end: events.at(-1)!.at,
    now: events.at(-1)!.at,
    spec: { maxCandidates: 10_000, maxSubmissions: 2, maxWorkers: 3 },
    hosts: [{ hostId: "host_a", name: "bench-a" }],
    ideas,
    workers,
    candidates,
    intervals,
    events,
    bands,
  };
}

