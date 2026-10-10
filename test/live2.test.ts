// Live view (part 2), backend: the live CI band (and its consistency with
// the real decision), "last action" labels and their rate-limited events,
// the best-moved data, "Up next" in the scheduler's order, replay at any
// time t against database snapshots taken at those times, replay
// performance on a 10k-event study, and a reload that stops touching the
// database after dispose.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionLabel, commandLabel, itemLabel, redact, sanitizeLabel, ACTION_MAX } from "../src/action.ts";
import { bandAt, bandGuardrails, buildBand, ciRngFor, expensiveThresholds, pointDecision, runDecision, type MeasureBand, type NoisyBand, type SampleLike } from "../src/band.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { liveView, replayBundle } from "../src/live.ts";
import { applyDeltas, deltaFromEvent, mergeProgress, type LiveView } from "../src/live-model.ts";
import { deterministicStrategy, expensiveStrategy, noisyStrategy, type Bench, type Side } from "../src/noise.ts";
import { safeJson } from "../src/prompts.ts";
import { nextMilestone, ReplayModel, type ReplayBundle } from "../src/replay.ts";
import { pickIdea, upNext } from "../src/scheduler.ts";
import { parseSpec } from "../src/spec.ts";
import { bootstrapMedianCI, improvement, seededRng, sequentialDecision } from "../src/stats.ts";
import type { IdeaRow } from "../src/db/store.ts";
import { FakeHost, makeCtx, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-live2";

function spec(opts: { maxWorkers?: number; guardrail?: boolean; nMin?: number; nMax?: number; confirm?: boolean } = {}): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the toy faster."
base = "main"

[metric]
name = "size"
unit = "ms"
direction = "lower"
${
  opts.guardrail
    ? `
[[guardrail]]
name = "rss"
direction = "lower"
max_regression = 0.2
`
    : ""
}
[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
gate = ["gate run"]
measure = "measure run"
noise = "noisy"

[oracle.protocol]
warmup = 0
n_min = ${opts.nMin ?? 4}
n_max = ${opts.nMax ?? 12}
calibration_pairs = 6
bootstrap = 300
min_effect = 0.01
confirm = ${opts.confirm ?? true}

[budget]
max_workers = ${opts.maxWorkers ?? 3}
max_candidates = 30

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

// ------------------------------------------------------------- CI band

/** A bench whose runs come from a seeded generator: `effect` better on the candidate, `sd` relative noise. */
function fakeBench(effect: number, sd: number, seed: number): Bench {
  const rng = seededRng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  return {
    async run(side: Side) {
      const base = 1000 * (1 + sd * gauss());
      return { metrics: { size: side === "best" ? base : base * (1 - effect), rss: 100 * (1 + 0.01 * gauss()) }, diag: [], durationMs: 1 };
    },
  };
}

function protocolOf(toml: string) {
  const p = parseSpec(toml);
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.spec;
}

describe("live CI band", () => {
  it("recomputes from the samples exactly the CI the sequential decision saw, at every judged pair, and marks where it stopped", async () => {
    const sp = protocolOf(spec({ nMin: 4, nMax: 20, guardrail: true }));
    for (const [i, effect] of [0.05, -0.04, 0.0, 0.012].entries()) {
      const samples: SampleLike[] = [];
      let at = 1000;
      const out = await noisyStrategy.measure({ bench: fakeBench(effect, 0.01, 100 + i), spec: sp, mde: 0.01, rng: seededRng(7 + i), ciRng: ciRngFor(50 + i, "measure"), record: (s) => { for (const [metric, value] of Object.entries(s.metrics)) samples.push({ run: "measure", pair: s.pair, side: s.side, metric, value, at: at++ }); } });
      const band = buildBand(samples, { kind: "noisy", candidate: 50 + i, n: i + 1, metric: { name: "size", direction: "lower" }, protocol: sp.oracle.protocol, guardrails: [], mde: 0.01, noiseFloor: null }) as NoisyBand;
      const run = band.runs[0]!;
      expect(run.points).toHaveLength(out.n);
      // The last point is the verdict's CI, to the bit.
      expect(run.points.at(-1)).toMatchObject({ n: out.n, lo: out.ciLo, hi: out.ciHi, m: out.effect });
      // Every judged point equals the decision recomputed at that pair, and only the last one decides.
      const imps: number[] = [];
      for (const p of run.points) {
        const pair = samples.filter((s) => s.pair === p.n - 1 && s.metric === "size");
        imps.push(improvement(pair.find((s) => s.side === "best")!.value, pair.find((s) => s.side === "candidate")!.value, "lower"));
        if (p.n < sp.oracle.protocol.n_min) {
          expect(pointDecision(band, p)).toBe("continue");
          continue;
        }
        const d = sequentialDecision({ improvements: imps, nMin: 4, nMax: 20, mde: 0.01, confidence: 0.95, iterations: 300, rng: ciRngFor(50 + i, "measure")(p.n) });
        expect([p.lo, p.hi]).toEqual([d.ci.lo, d.ci.hi]);
        expect(pointDecision(band, p)).toBe(p.n === out.n ? out.decision : "continue");
      }
      const stop = runDecision(band, run)!;
      expect(stop).toMatchObject({ n: out.n, decision: out.decision });
      if (effect === 0.05) expect(stop.n).toBeLessThan(20); // a clear win stops early
    }
  });

  it("extends incrementally (points already computed are reused) and cuts at a time t for replay", async () => {
    const sp = protocolOf(spec({ nMin: 3, nMax: 8 }));
    const samples: SampleLike[] = [];
    let at = 0;
    await noisyStrategy.measure({ bench: fakeBench(0.0, 0.02, 3), spec: sp, mde: 0.01, rng: seededRng(1), ciRng: ciRngFor(9, "measure"), record: (s) => samples.push({ run: "measure", pair: s.pair, side: s.side, metric: "size", value: s.metrics.size!, at: (at += 10) }) });
    const input = { kind: "noisy" as const, candidate: 9, n: 1, metric: { name: "size", direction: "lower" as const }, protocol: sp.oracle.protocol, guardrails: [], mde: 0.01, noiseFloor: null };
    const half = buildBand(samples.slice(0, 8), input) as NoisyBand;
    const full = buildBand(samples, input, half) as NoisyBand;
    expect(full.runs[0]!.points.slice(0, 4)).toEqual(half.runs[0]!.points);
    expect(full.runs[0]!.points[0]).toBe(half.runs[0]!.points[0]); // reused, not recomputed
    expect(full).toEqual(buildBand(samples, input));
    const cut = bandAt(full, samples[5]!.at) as NoisyBand;
    expect(cut.runs[0]!.points.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(bandAt(full, -1)).toBeNull();
  });

  it("deterministic: the run against the tolerance; expensive: runs against the calibrated σ band, with the confirmation as a second phase", async () => {
    const det = protocolOf(spec().replace('noise = "noisy"', 'noise = "deterministic"').replace("min_effect = 0.01", "min_effect = 0.01\ntolerance = 0.005"));
    const dSamples: SampleLike[] = [];
    const dOut = await deterministicStrategy.measure({ bench: fakeBench(0.02, 0, 1), spec: det, mde: 0.005, rng: seededRng(1), record: (s) => dSamples.push({ run: "measure", pair: s.pair, side: s.side, metric: "size", value: s.metrics.size!, at: 5 }) });
    const db = buildBand(dSamples, { kind: "deterministic", candidate: 1, n: 1, metric: { name: "size", direction: "lower" }, protocol: det.oracle.protocol, guardrails: [], mde: 0.005, noiseFloor: null });
    expect(db).toMatchObject({ kind: "deterministic", tolerance: 0.005 });
    expect(db.kind === "deterministic" && db.effect).toBeCloseTo(dOut.effect, 12);

    const exp = protocolOf(spec().replace('noise = "noisy"', 'noise = "expensive"').replace("calibration_pairs = 6", "calibration_runs = 5\nconfirm_runs = 3"));
    const baseline = await Promise.all([0, 1, 2, 3, 4].map(async (i) => ({ metrics: { size: 1000 * (1 + 0.01 * Math.sin(i * 2.1)) }, diag: [], durationMs: 1 })));
    const eSamples: SampleLike[] = [];
    let at = 0;
    const eOut = await expensiveStrategy.measure({ bench: fakeBench(0.08, 0.005, 4), spec: exp, mde: 0.02, rng: seededRng(1), baseline, noiseFloor: 0.01, record: (s) => eSamples.push({ run: "measure", pair: s.pair, side: s.side, metric: "size", value: s.metrics.size!, at: at++ }) });
    const eb = buildBand(eSamples, { kind: "expensive", candidate: 2, n: 2, metric: { name: "size", direction: "lower" }, protocol: exp.oracle.protocol, guardrails: [], mde: 0.02, noiseFloor: 0.01 });
    if (eb.kind !== "expensive") throw new Error("kind");
    expect(eb.baseline).toHaveLength(5);
    expect(eb.screen).not.toBeNull();
    expect(eb.confirm).toHaveLength(3);
    // The confirmation phase's last point is the verdict's effect and CI.
    expect(eb.confirm.at(-1)!.m).toBeCloseTo(eOut.effect, 12);
    expect(eb.confirm.at(-1)!.lo).toBeCloseTo(eOut.ciLo!, 12);
    expect(eb.confirm.at(-1)!.m > expensiveThresholds(eb).confirm).toBe(eOut.decision === "win");
    expect(eb.screen!.m > expensiveThresholds(eb).screen).toBe(true);
  });
});

// --------------------------------------------------------- last action

describe("last action labels", () => {
  const wt = "/home/me/worktrees/w1";
  it("says what the agent did in a few words, with paths relative to the worktree", () => {
    expect(itemLabel({ kind: "fileChange", paths: [`${wt}/src/toy.py`] }, wt)).toBe("editing src/toy.py");
    expect(itemLabel({ kind: "fileChange", paths: [`${wt}/src/a.py`, `${wt}/src/b.py`] }, wt)).toBe("editing 2 files");
    expect(commandLabel("python -m pytest -q", wt)).toBe("running python -m pytest -q");
    expect(commandLabel(`bash -lc 'cd ${wt} && pytest -q'`, wt)).toBe("running pytest -q");
    expect(commandLabel("sed -i 's/a/b/' src/toy.py", wt)).toBe("editing src/toy.py");
    expect(commandLabel("cat > src/toy.py <<'EOF'\nsecret body\nEOF", wt)).toBe("editing src/toy.py");
    expect(commandLabel("rg -n fib src", wt)).toBe("searching the code");
    expect(commandLabel("cat src/a.py; sed -n 1,40p src/b.py", wt)).toBe("reading 2 files");
    expect(actionLabel([{ kind: "fileRead", paths: [`${wt}/a.py`] }, { kind: "fileRead", paths: [`${wt}/b.py`] }, { kind: "agentMessage" }, { kind: "fileRead", paths: [`${wt}/c.py`] }], wt)).toBe("reading 3 files");
    expect(actionLabel([{ kind: "toolCall", tool: "study_submit_candidate" }], wt)).toBe("submitting a candidate");
    // Messages and reasoning say nothing: the label stays what it was.
    expect(actionLabel([{ kind: "agentMessage" }, { kind: "reasoning" }], wt)).toBeNull();
    // Other absolute paths keep their last two segments.
    expect(itemLabel({ kind: "fileRead", paths: ["/etc/ssh/sshd_config"] }, wt)).toBe("reading …/ssh/sshd_config");
  });

  it("never shows secrets, URL credentials, heredoc bodies or more than 80 characters", () => {
    const cases = [
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh api repos/x",
      "curl -H 'Authorization: Bearer abcdefghijklmnop1234567890' https://alice:hunter2@example.com/x?token=s3cr3t",
      "export API_KEY=sk-12345678901234567890abcd && npm test",
      "mysql -u root -pSuperSecret123 db",
      "python3 deploy.py --password=hunter2 --token abcdef0123456789abcdef0123456789",
      `node ${"x".repeat(200)}.js`,
      "aws s3 cp s3://bucket/key . --profile prod AKIAABCDEFGHIJKLMNOP",
      "cat > notes.txt <<'EOF'\nmy password is hunter2\nEOF",
    ];
    for (const c of cases) {
      const label = actionLabel([{ kind: "commandExecution", command: c }], wt)!;
      expect(label.length).toBeLessThanOrEqual(ACTION_MAX);
      for (const bad of ["ghp_", "hunter2", "s3cr3t", "sk-1234", "SuperSecret", "alice", "AKIA", "abcdef0123456789abcdef", "Bearer abcdef"]) expect(label).not.toContain(bad);
    }
    expect(redact("see https://bob:pw@git.example.com/repo.git?x=1")).toBe("see git.example.com");
    expect(sanitizeLabel(`running ${"a ".repeat(80)}`).length).toBeLessThanOrEqual(ACTION_MAX);
  });
});

// ------------------------------------------------- engine-level checks

describe("live view part 2 (fake host)", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;

  beforeEach(() => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port, clock } = made);
    engine = new Engine({ ...made.ctx, config: { ...made.ctx.config, liveActionMs: 3000 } });
    const base = host.commit("T0", null, "base");
    host.refs.set("main", base);
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });
  afterEach(() => engine.live.dispose());

  async function running(ideas: Array<string | { title: string; theme?: string; pinned?: boolean }>, toml = spec({ guardrail: true })): Promise<string> {
    await engine.proposeStudy("thr_study", "proj_1", toml);
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    ideas.forEach((x, i) => engine.addIdea(SLUG, typeof x === "string" ? { title: x, theme: `t${i}`, pinned: false } : { title: x.title, theme: x.theme ?? "", pinned: x.pinned ?? false }, "human"));
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
  const actions = (id: string) => store.eventsAsc(id, { kinds: ["worker.action"] }).map((e) => ({ at: e.at, ...safeJson<{ worker: number; label: string }>(e.data_json)! }));

  it("records the last action as worker.action events, at most one per 3 s per worker, the latest label winning", async () => {
    const id = await running(["Idea A"]);
    const w = store.threadById("thr_w1")!;
    clock.advance(10);
    port.addActivity("thr_w1", "fileRead", { at: clock.t, paths: ["/wt/thr_w1/src/toy.py"] });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    expect(actions(id).map((a) => a.label)).toEqual(["reading src/toy.py"]);
    // Within 3 s: stored on the row, not yet an event.
    clock.advance(1000);
    port.addActivity("thr_w1", "fileChange", { at: clock.t, paths: ["/wt/thr_w1/src/toy.py"] });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    clock.advance(500);
    port.addActivity("thr_w1", "commandExecution", { at: clock.t, command: "python -m pytest -q" });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    expect(store.threadById("thr_w1")).toMatchObject({ last_action: "running python -m pytest -q", action_recorded: "reading src/toy.py" });
    expect(actions(id)).toHaveLength(1);
    clock.advance(1600);
    engine.live.sync(id);
    const a = actions(id);
    expect(a.map((x) => x.label)).toEqual(["reading src/toy.py", "running python -m pytest -q"]);
    expect(a[1]!.at - a[0]!.at).toBeGreaterThanOrEqual(3000);
    // The live view shows the recorded label; the delta carries it.
    expect(liveView(engine, store.study(id)!).workers[0]!.action).toMatchObject({ label: "running python -m pytest -q" });
    const ev = store.eventsAsc(id, { kinds: ["worker.action"] }).at(-1)!;
    expect(deltaFromEvent({ id: ev.id, at: ev.at, kind: ev.kind, data: safeJson(ev.data_json)! })).toEqual({ k: "action", id: ev.id, t: ev.at, w: w.id, a: "running python -m pytest -q" });
    // Unchanged labels record nothing.
    clock.advance(5000);
    port.addActivity("thr_w1", "commandExecution", { at: clock.t, command: "python -m pytest -q" });
    await engine.readActivity(w.id);
    engine.live.flushPending();
    expect(actions(id)).toHaveLength(2);
  });

  it("keeps the band with the candidate when the measurement ends: its last point is the stored CI, and the live view shows it while it lingers", async () => {
    host.noise = (() => {
      const r = seededRng(5);
      return () => (r() - 0.5) * 0.01;
    })();
    const id = await running(["Idea A"]);
    let mid: LiveView | null = null;
    host.onMeasure = () => {
      const c = store.candidateByN(id, 1);
      if (!mid && c?.stage === "measuring" && store.samples(c.id).length >= 4 * 3) mid = liveView(engine, store.study(id)!);
    };
    await submit("thr_w1", "TA", 900);
    await settle();
    const c = store.candidateByN(id, 1)!;
    const band = safeJson<MeasureBand>(c.band_json)!;
    expect(band.kind).toBe("noisy");
    const nb = band as NoisyBand;
    const measure = nb.runs.find((r) => r.run === "measure")!;
    expect([measure.points.at(-1)!.lo, measure.points.at(-1)!.hi]).toEqual([c.ci_lo, c.ci_hi]);
    expect(runDecision(nb, measure)!.decision).toBe("win");
    expect(nb.runs.map((r) => r.run)).toEqual(["measure", "confirm"]);
    expect(nb.final?.guardrails.map((g) => g.name)).toEqual(["rss"]);
    // Mid-measurement the view had a band growing pair by pair, with a running guardrail estimate.
    const m = mid! as LiveView;
    expect(m.bands).toHaveLength(1);
    expect(m.bands[0]!.kind === "noisy" && m.bands[0]!.runs[0]!.points.length).toBeGreaterThanOrEqual(3);
    expect(bandGuardrails(m.bands[0]!)[0]).toMatchObject({ name: "rss", final: false });
    // Right after: the band lingers with its decision; later it is gone.
    expect(liveView(engine, store.study(id)!).bands.map((b) => b.n)).toEqual([1]);
    clock.advance(31_000);
    expect(liveView(engine, store.study(id)!).bands).toEqual([]);
  });

  it("pushes band points as deltas that move the card's pair count pair by pair", async () => {
    const id = await running(["Idea A"]);
    port.published.length = 0;
    await submit("thr_w1", "TA", 900);
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    const deltas = port.published.filter((p) => p.channel === "study-live").flatMap((p) => (p.payload as { d: Array<{ k: string }> }).d);
    const band = deltas.filter((d) => d.k === "band") as Array<{ k: "band"; c: number; run: string; p: { n: number } }>;
    expect(band.length).toBeGreaterThan(0);
    expect(band.every((d) => d.c === 1)).toBe(true);
    // A band delta applied to a view with that band appends the point and advances pairs.
    const c = store.candidateByN(id, 1)!;
    const b = safeJson<NoisyBand>(c.band_json)!;
    const short: NoisyBand = { ...b, runs: [{ ...b.runs[0]!, points: b.runs[0]!.points.slice(0, 2) }] };
    const v: LiveView = { ...liveView(engine, store.study(id)!), bands: [short] };
    v.cards = v.cards.map((x) => (x.n === 1 ? { ...x, stage: "measuring", pairs: { run: "measure", done: 1, of: 12 } } : x));
    const r = applyDeltas(v, { s: id, d: [{ k: "band", id: 0, t: 1, c: 1, run: "measure", p: b.runs[0]!.points[2]! }] });
    expect(r.refetch).toBe(false);
    expect((r.view.bands[0] as NoisyBand).runs[0]!.points).toHaveLength(3);
    expect(r.view.cards.find((x) => x.n === 1)!.pairs).toEqual({ run: "measure", done: 3, of: 12 });
    expect(mergeProgress({ run: "measure", done: 5, of: 12 }, short)).toEqual({ run: "measure", done: 5, of: 12 });
  });

  it("best moved: value, trajectory, when, and which lanes rebase on their next submission", async () => {
    const id = await running(["Idea A", "Idea B", "Idea C"]);
    const before = liveView(engine, store.study(id)!);
    expect(before.best).toMatchObject({ value: null, n: null, history: [], rebases: [] });
    clock.advance(100);
    await submit("thr_w1", "TA", 800);
    await settle();
    const v = liveView(engine, store.study(id)!);
    expect(v.best.n).toBe(1);
    expect(v.best.value).toBeCloseTo(0.2, 6);
    expect(v.best.history).toEqual([{ at: v.best.at, n: 1, value: v.best.value }]);
    const promoted = store.eventsAsc(id, { kinds: ["best.promoted"] })[0]!;
    expect(v.best.movedAt).toBe(promoted.at);
    const w1 = store.threadById("thr_w1")!.id;
    expect(v.best.rebases.sort()).toEqual([store.threadById("thr_w2")!.id, store.threadById("thr_w3")!.id].sort());
    expect(v.best.rebases).not.toContain(w1);
    clock.advance(100);
    await submit("thr_w2", "TB", 700);
    await settle();
    const v2 = liveView(engine, store.study(id)!);
    expect(v2.best.history.map((h) => h.n)).toEqual([1, 2]);
    expect(v2.best.history[1]!.value).toBeGreaterThan(v2.best.history[0]!.value);
  });

  it("orders Up next as the scheduler will pick: the theme cap can put a later idea first", async () => {
    // W = 2: at most one running worker per theme. The two pinned ideas start first.
    const id = await running(
      [
        { title: "First algo", theme: "algo", pinned: true },
        { title: "First data", theme: "data", pinned: true },
        { title: "Second algo", theme: "algo" },
        { title: "Plain", theme: "" },
        { title: "Second data", theme: "data" },
      ],
      spec({ maxWorkers: 2 }),
    );
    expect(store.ideas(id, ["running"]).map((i) => i.title).sort()).toEqual(["First algo", "First data"]);
    const v = liveView(engine, store.study(id)!);
    // Board order is Second algo, Plain, Second data; the scheduler skips both capped themes.
    expect(v.ideas.next.map((i) => [i.title, i.blocked])).toEqual([
      ["Plain", null],
      ["Second algo", "waits: 1 running on algo"],
      ["Second data", "waits: 1 running on data"],
    ]);
    // And it matches the scheduler's actual next pick.
    const pick = pickIdea(store.ideas(id, ["queued"]), store.ideas(id, ["running"]), 2);
    expect(pick?.title).toBe("Plain");
  });
});

describe("Up next: repeated picks", () => {
  const idea = (id: number, theme: string, over: Partial<IdeaRow> = {}): IdeaRow => ({ id, theme, title: `idea ${id}`, status: "queued", pinned: 0, priority: 0, source: "strategist", variation_of: null, ...over }) as IdeaRow;
  it("is the sequence pickIdea gives as workers spawn one by one", () => {
    const queued = [idea(1, "a", { priority: 5 }), idea(2, "a", { priority: 4 }), idea(3, "b"), idea(4, "a", { pinned: 1 }), idea(5, ""), idea(6, "b", { title: "lost one" })];
    const running = [idea(9, "a", { status: "running" })];
    const order = upNext(queued, running, 4, { lostTitles: new Set(["lost one"]) });
    // Simulate spawns with the real policy.
    const pool = [...queued];
    const run = [...running];
    const picks: number[] = [];
    for (;;) {
      const p = pickIdea(pool, run, 4, { lostTitles: new Set(["lost one"]) });
      if (!p) break;
      picks.push(p.id);
      pool.splice(pool.indexOf(p), 1);
      run.push(p);
    }
    expect(order.filter((o) => !o.blocked).map((o) => o.idea.id)).toEqual(picks);
    expect(order.find((o) => o.idea.id === 6)!.blocked).toBe("repeats an idea that lost");
    expect(order.filter((o) => o.blocked && o.idea.theme === "a").length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------- replay

/** The parts of a view replay must reproduce (times, ids, states, numbers, texts). */
function norm(v: LiveView) {
  const r6 = (x: number | null) => (x === null ? null : Math.round(x * 1e6) / 1e6);
  return {
    state: v.state,
    best: { n: v.best.n, at: v.best.at, movedAt: v.best.movedAt, text: v.best.text, value: r6(v.best.value), history: v.best.history.map((h) => [h.n, h.at, r6(h.value)]), rebases: [...v.best.rebases].sort() },
    counts: v.counts,
    workers: v.workers.map((w) => ({ ...w, action: w.action?.label ?? null })),
    cards: v.cards.map((c) => ({ ...c, effect: c.stage === "decided" ? c.effect : null, effectText: c.stage === "decided" ? c.effectText : null })),
    queue: v.queue,
    bench: v.bench.map((h) => ({ hostId: h.hostId, current: h.current, utilization: r6(h.utilization), windowSeconds: h.windowSeconds })),
    ideas: { next: v.ideas.next.map((i) => [i.id, i.title, i.blocked]), total: v.ideas.total },
    feed: v.feed.map((f) => [f.id, f.text, f.tone]),
    bands: v.bands.map((b) => ({ n: b.n, kind: b.kind, runs: b.kind === "noisy" ? b.runs.map((r) => [r.run, r.points.map((p) => [p.n, p.at, p.m, p.lo, p.hi])]) : [], final: b.final !== null })),
  };
}

describe("replay at time t equals the live view at t", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;

  beforeEach(() => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port, clock } = made);
    engine = new Engine({ ...made.ctx, config: { ...made.ctx.config, liveActionMs: 3000 } });
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
  });
  afterEach(() => engine.live.dispose());

  it("rebuilds lanes, cards, bench, CI bands, Up next, feed, last actions and best at many snapshot times of a recorded run", async () => {
    const r = seededRng(11);
    host.noise = () => (r() - 0.5) * 0.012;
    await engine.proposeStudy("thr_study", "proj_1", spec({ guardrail: true, maxWorkers: 3 }));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    const themes = ["algo", "algo", "data", "io", "", "data", "algo"];
    themes.forEach((theme, i) => engine.addIdea(SLUG, { title: `Idea ${i + 1}`, theme, pinned: i === 5 }, "human"));
    const id = store.study(SLUG)!.id;
    const snaps: LiveView[] = [];
    const snap = () => {
      engine.live.flushPending();
      snaps.push(structuredClone(liveView(engine, store.study(id)!)));
      clock.advance(1); // nothing else happens at a snapshot's millisecond
    };
    let ticks = 0;
    host.onMeasure = () => {
      clock.advance(400);
      if (++ticks % 3 === 0) snap();
    };
    await engine.start(SLUG, "human");
    await engine.settle();
    snap();
    const act = async (thread: string, kind: string, opts: { command?: string; paths?: string[] }) => {
      clock.advance(1500);
      port.addActivity(thread, kind, { ...opts, at: clock.t });
      await engine.readActivity(store.threadById(thread)!.id);
      snap();
    };
    await act("thr_w1", "fileRead", { paths: ["/wt/thr_w1/src/toy.py"] });
    await act("thr_w2", "commandExecution", { command: "python -m pytest -q" });
    await act("thr_w1", "fileChange", { paths: ["/wt/thr_w1/src/toy.py"] });
    clock.advance(4000);
    snap();
    const sub = async (thread: string, tree: string, value: number) => {
      clock.advance(700);
      host.nextSnapshotFor.set(`/wt/${thread}`, { tree });
      host.metric.set(tree, value);
      await engine.submit(thread, `change ${tree}`);
      snap();
      await engine.settle();
      snap();
    };
    await sub("thr_w1", "TA", 900); // win
    await sub("thr_w2", "TB", 1003); // no win
    await act("thr_w3", "fileChange", { paths: ["/wt/thr_w3/src/x.py"] });
    await sub("thr_w3", "TC", 850); // win: best moves again
    await sub("thr_w1", "TA2", 990);
    engine.pause(SLUG, "human");
    await engine.settle();
    snap();
    expect(snaps.length).toBeGreaterThan(12);
    // The recorded run went through the interesting states.
    expect(snaps.some((s) => s.bands.some((b) => b.kind === "noisy" && b.final === null))).toBe(true);
    expect(snaps.some((s) => s.workers.some((w) => w.action))).toBe(true);
    expect(snaps.some((s) => s.best.n === 3)).toBe(true);

    const bundle = structuredClone(replayBundle(engine, store.study(id)!)) as ReplayBundle;
    const model = new ReplayModel(bundle, { keyframeEvery: 16 });
    // Forward, then in a scrambled order (keyframes and backward seeks).
    for (const s of snaps) expect(norm(model.viewAt(s.now))).toEqual(norm(s));
    const order = snaps.map((_, i) => i).sort((a, b) => ((a * 7919) % 13) - ((b * 7919) % 13));
    for (const i of order) expect(norm(model.viewAt(snaps[i]!.now))).toEqual(norm(snaps[i]!));
    // Milestones: both wins, both best moves, the pause.
    const ms = model.milestones();
    expect(ms.filter((m) => m.kind === "win").map((m) => m.label)).toEqual(["c/1 won", "c/3 won"]);
    expect(ms.filter((m) => m.kind === "best")).toHaveLength(2);
    expect(ms.some((m) => m.kind === "pause")).toBe(true);
    const firstWin = nextMilestone(ms, model.start, "win")!;
    expect(nextMilestone(ms, firstWin, "win")).toBe(ms.filter((m) => m.kind === "win")[1]!.at);
    expect(model.density(50).reduce((a, b) => a + b, 0)).toBe(bundle.events.length);
  });
});

// ---------------------------------------------------------- performance

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

describe("replay performance (synthetic 10k-event study)", () => {
  it("builds keyframes once and serves any time t, and 600× playback frames, within budget", () => {
    const bundle = syntheticBundle(10_000);
    expect(bundle.events.length).toBeGreaterThanOrEqual(10_000);
    const t0 = performance.now();
    const model = new ReplayModel(bundle);
    const build = performance.now() - t0;
    // Random seeks (scrubbing).
    const r = seededRng(3);
    const seeks: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = model.start + r() * (model.end - model.start);
      const a = performance.now();
      model.viewAt(t);
      seeks.push(performance.now() - a);
    }
    // Playback at 600×: 60 frames per second of wall time → 10 s of study per frame.
    const frames: number[] = [];
    for (let t = model.start; t <= model.end; t += 10_000) {
      const a = performance.now();
      model.viewAt(t);
      frames.push(performance.now() - a);
    }
    seeks.sort((a, b) => a - b);
    frames.sort((a, b) => a - b);
    const p95 = (xs: number[]) => xs[Math.floor(xs.length * 0.95)]!;
    console.log(`replay 10k: ${bundle.events.length} events, build ${build.toFixed(1)} ms, seek p95 ${p95(seeks).toFixed(2)} ms, 600× frame p95 ${p95(frames).toFixed(2)} ms over ${frames.length} frames`);
    expect(build).toBeLessThan(1500);
    expect(p95(seeks)).toBeLessThan(16);
    expect(p95(frames)).toBeLessThan(8);
    // The end state is right.
    const end = model.viewAt(model.end);
    expect(end.workers).toEqual([]);
    expect(end.best.history.length).toBe(Math.floor(bundle.candidates.length / 5));
  });
});

// --------------------------------------------------------------- reload

describe("plugin reload during a measurement", () => {
  it("the old instance stops: no database access or log after dispose, and the new one restarts the measurement", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { createAutoresearchPlugin } = await import("../server.ts");
    const { FakePort: Port, fakeHostSpec, waitFor } = await import("./helpers.ts");
    const host = new FakeHost();
    const port = new Port(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    let first: Engine | null = null;
    await createAutoresearchPlugin({ port: () => port, seed: 1, onEngine: (e) => (first = e) })(fake.bb);
    const h = fake.harness;
    await h.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec() }, { threadId: "thr_study", projectId: "proj_1" });
    await h.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await h.behavior.runCli(["ideas", "add", "toy-size", "Shrink the output"]);
    await h.behavior.runCli(["start", "toy-size"]);
    expect(await waitFor(() => port.threads.has("thr_w1"))).toBe(true);
    // The measurement blocks on the bench until released.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let measuring = false;
    host.onMeasure = async () => {
      if (measuring) return;
      measuring = true;
      await gate;
    };
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await h.behavior.callAgentTool("study_submit_candidate", { summary: "smaller output" }, { threadId: "thr_w1" });
    expect(await waitFor(() => measuring)).toBe(true);
    const old = first! as Engine;
    const logsAt = port.logs.length;
    let second: Engine | null = null;
    await h.lifecycle.reload(createAutoresearchPlugin({ port: () => port, seed: 2, onEngine: (e) => (second = e) }));
    expect(old.ctx.disposed).toBe(true);
    expect(old.ctx.store.closed).toBe(true);
    // The old bench run returns after the dispose: its measurement must not write, log or kick anything.
    host.onMeasure = null;
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(old.pipeline.activeJobs()).toEqual([]);
    expect(port.logs.slice(logsAt).filter((l) => /database|not open|closed|disposed|stale/iu.test(l))).toEqual([]);
    // The new instance reconciles: the measurement restarts and finishes.
    const next = second! as Engine;
    await next.reconcile();
    await next.settle();
    const c = next.ctx.store.candidateByN(next.ctx.store.study("toy-size")!.id, 1)!;
    expect(c).toMatchObject({ stage: "decided", verdict: "win" });
    await h.lifecycle.dispose();
  });
});
