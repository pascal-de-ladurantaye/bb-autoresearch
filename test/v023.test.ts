// v0.2.3 fixes, backend and pure formatting: the status line and the
// header's worker count per phase mix, one source of truth for queue
// positions, notices that don't count the human's own controls, chart label
// layout and ticks, guardrail wording, state-aware notice actions, clipping
// on word and code-span boundaries, signs, dependency wording, health
// checks recorded as events and read by replay, and the candidate detail's
// band and sample rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutLabels, niceTicks, pctTickDigits, trendDomain } from "../src/chart.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { limitCheckWords } from "../src/guardrails.ts";
import { liveView, replayBundle } from "../src/live.ts";
import { benchHealthText, benchQueueOrder, progressText, queuePosition, workerCountText } from "../src/live-model.ts";
import { clipWords, effectStatisticText, runningStatusText, workersDoingText } from "../src/present.ts";
import { strategistDigest } from "../src/prompts.ts";
import { revertedWords } from "../src/report.ts";
import { ReplayModel } from "../src/replay.ts";
import { sampleTableRows } from "../src/sample-rows.ts";
import { candidateDetail, noticeAction, noticesView, overview, statusLine } from "../src/views.ts";
import { FakeHost, makeCtx, type Clock, type FakePort } from "./helpers.ts";

const SLUG = "toy-v023";

function spec(opts: { maxWorkers?: number; health?: boolean } = {}): string {
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
single_machine = "off"

[oracle.health]
enabled = ${opts.health ?? true}

[oracle.protocol]
warmup = 0
n_min = 3
n_max = 6
calibration_pairs = 4
bootstrap = 200
confirm = false

[budget]
max_workers = ${opts.maxWorkers ?? 3}
max_candidates = 20

[agents]
max_submissions_per_worker = 3
idle_nudge_minutes = 30
idle_abandon_minutes = 60
`;
}

describe("status line and header (pure)", () => {
  it("says what the workers are doing, not 'N workers editing' whatever they do", () => {
    expect(workersDoingText([])).toBe("no live workers");
    expect(workersDoingText(["editing", "editing"])).toBe("2 workers editing");
    expect(workersDoingText(["measuring"])).toBe("1 worker being measured");
    expect(workersDoingText(["measuring", "editing", "finishing", "waiting"])).toBe("4 workers: 1 editing, 1 waiting for the bench, 1 being measured, 1 finishing");
    expect(workersDoingText(["testing", "reading", "mystery"])).toBe("3 workers: 1 reading the code, 1 testing locally, 1 working");
    expect(runningStatusText(["editing", "measuring"], ["c/9"], 0, 0)).toBe("Running: 2 workers: 1 editing, 1 being measured; measuring c/9.");
    expect(runningStatusText([], [], 2, 1)).toBe("Running: no live workers; 2 queued for the bench, 1 in tests.");
    expect(runningStatusText(["waiting"], [], 0, 1, ["c/4"])).toBe("Running: 1 worker waiting for the bench; testing c/4 on the bench.");
  });

  it("counts live workers against the target W without '3 workers (up to 2)'", () => {
    expect(workerCountText(["editing", "measuring"], 2)).toBe("2 workers · target 2");
    expect(workerCountText(["editing", "measuring", "finishing"], 3)).toBe("2 workers + 1 finishing · target 3");
    expect(workerCountText(["editing", "waiting", "finishing"], 2)).toBe("2 workers + 1 finishing · target now 2 (no new worker until fewer)");
    expect(workerCountText(["editing", "waiting", "measuring"], 2)).toBe("3 workers · target now 2 (no new worker until fewer)");
    for (const t of [workerCountText(["editing", "waiting", "finishing"], 2)]) expect(t).not.toMatch(/up to/u);
  });

  it("orders the bench queue in one place and numbers positions from it", () => {
    const rows = [
      { id: 3, n: 3, queuedAt: 300, submittedAt: 100 },
      { id: 2, n: 2, queuedAt: null, submittedAt: 200 },
      { id: 1, n: 1, queuedAt: 250, submittedAt: 50 },
    ];
    const q = benchQueueOrder(rows).map((r) => r.n);
    expect(q).toEqual([2, 1, 3]);
    expect(queuePosition(q, 2)).toBe(1);
    expect(queuePosition(q, 3)).toBe(3);
    expect(queuePosition(q, 9)).toBeNull();
    expect(queuePosition(q, null)).toBeNull();
  });

  it("never says 'pair 0': before the first pair it says what runs", () => {
    expect(progressText({ run: "measure", done: 0, of: 20 }, "noisy")).toBe("first pair of ≤20 running");
    expect(progressText({ run: "confirm", done: 0, of: 20 }, "noisy", { run: true })).toBe("confirmation: first pair of ≤20 running");
    expect(progressText({ run: "measure", done: 3, of: 20 }, "noisy")).toBe("pair 3 of ≤20");
    expect(progressText({ run: "measure", done: 0, of: 20 }, "noisy", { short: true })).toBe("0/20");
  });
});

describe("charts (pure)", () => {
  it("nice ticks: round values covering the range, never −7.9% or +19.1%", () => {
    const a = niceTicks(-0.079, 0.191, 5);
    expect(a.ticks).toEqual([-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2]);
    expect(a.lo).toBe(-0.1);
    expect(a.hi).toBe(0.2);
    expect(pctTickDigits(a.step)).toBe(0);
    expect(niceTicks(0, 0.9873, 5).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const small = niceTicks(-0.004, 0.021, 5);
    expect(small.step).toBe(0.005);
    expect(pctTickDigits(small.step)).toBe(1);
    expect(pctTickDigits(0.025)).toBe(1);
    // Candidate numbers: whole numbers only.
    expect(niceTicks(0, 7, 5, { integer: true }).ticks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(niceTicks(0, 37, 5, { integer: true }).ticks).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40]);
    expect(niceTicks(0, 120, 5, { integer: true }).ticks).toEqual([0, 25, 50, 75, 100, 125]);
    expect(niceTicks(0, 3, 10, { integer: true }).ticks.every(Number.isInteger)).toBe(true);
  });

  it("places labels without overlaps, dropping the least important when they can't fit", () => {
    const placed = layoutLabels(
      [
        { key: "zero", at: 100, priority: 3, maxShift: 0 },
        { key: "mde", at: 96, priority: 2, maxShift: 11 },
        { key: "max", at: 98, priority: 1, maxShift: 0 },
      ],
      { gap: 11, min: 0, max: 200 },
    );
    expect(placed.map((p) => p.key).sort()).toEqual(["mde", "zero"]);
    const zero = placed.find((p) => p.key === "zero")!;
    const mde = placed.find((p) => p.key === "mde")!;
    expect(zero.at).toBe(100);
    expect(Math.abs(zero.at - mde.at)).toBeGreaterThanOrEqual(11);
    // Plenty of room: everything stays where it wants to be.
    expect(layoutLabels([{ key: "a", at: 10, priority: 1 }, { key: "b", at: 50, priority: 1 }], { gap: 11, min: 0, max: 100 })).toEqual([
      { key: "a", at: 10 },
      { key: "b", at: 50 },
    ]);
  });

  it("a trend of near-equal values stays flat instead of 'dropping' across the whole height", () => {
    const [lo, hi] = trendDomain([1000, 1000, 999.8]);
    // 0.02% of change uses well under a tenth of the height.
    expect((1000 - 999.8) / (hi - lo)).toBeLessThan(0.01);
    expect(trendDomain([100, 150])).toEqual([100, 150]);
  });
});

describe("wording (pure)", () => {
  it("guardrail checks read as sentences, not 'no change than best vs the 10.0% limit'", () => {
    expect(limitCheckWords({ regression: 0, lo: -0.003, hi: 0.004, limit: 0.1, state: "ok" }, "best")).toBe("no change from best (CI 0.3% better to 0.4% worse), within the 10.0% limit");
    expect(limitCheckWords({ regression: 0.049, lo: null, hi: null, limit: 0.05, state: "ok" }, "best")).toBe("4.9% worse than best, within the 5.0% limit");
    expect(limitCheckWords({ regression: 0.121, lo: 0.106, hi: 0.129, limit: 0.1, state: "broken" }, "the segment base", "total limit")).toBe(
      "12.1% worse than the segment base (CI 10.6% to 12.9% worse), beyond the 10.0% total limit",
    );
    expect(limitCheckWords({ regression: -0.02, lo: null, hi: null, limit: 0.1, state: "ok" }, "best")).toBe("2.0% better than best, within the 10.0% limit");
    expect(limitCheckWords({ regression: 0.098, lo: 0.084, hi: 0.109, limit: 0.1, state: "inconclusive" }, "best", "limit", true)).toBe("9.8% worse than best (CI 8.4% to 10.9% worse), straddling the 10.0% limit so far");
  });

  it("clips on word boundaries and never inside a code span", () => {
    expect(clipWords("Byte-indexed lookup table for the parser", 16)).toBe("Byte-indexed…");
    expect(clipWords("Byte-indexed lookup table for the parser", 22)).toBe("Byte-indexed lookup…");
    const code = clipWords("Replace the scan with a cheap `lineStartIndex` table built once", 40);
    expect(code).toBe("Replace the scan with a cheap…");
    expect((code.match(/`/gu) ?? []).length % 2).toBe(0);
    expect(clipWords("Use `a` and `bb` then more words", 20)).toBe("Use `a` and `bb`…");
    expect(clipWords("short", 80)).toBe("short");
    // One word longer than the limit: cut it, but drop backticks rather than leave one open.
    expect(clipWords("`averyveryverylongidentifier`", 10)).toBe("averyver…");
    expect(clipWords("first, second", 8)).toBe("first…");
  });

  it("ablation and dependency text: no '+22.00% worse', no ambiguous 'it'", () => {
    expect(revertedWords(0.22)).toBe("best with this change reverted is 22.00% worse than best");
    expect(revertedWords(-0.01)).toBe("best with this change reverted is 1.00% better than best");
    expect(revertedWords(0)).toBe("best with this change reverted measures the same as best");
  });

  it("names the statistic of a candidate's headline per noise class", () => {
    expect(effectStatisticText("noisy")).toMatch(/median of the per-pair changes/u);
    expect(effectStatisticText("deterministic")).toBe("single run of each side");
    expect(effectStatisticText("expensive")).toMatch(/median of best's runs/u);
  });

  it("bench health in words, including off and not recorded", () => {
    const h = { status: "online" as const, deferredUntil: null };
    expect(benchHealthText({ ...h, healthOk: true })).toBe("healthy");
    expect(benchHealthText({ ...h, healthOk: false })).toBe("unhealthy");
    expect(benchHealthText({ ...h, healthOk: null })).toBe("not checked yet");
    expect(benchHealthText({ ...h, healthOk: null, healthRecord: "off" })).toBe("health checks off");
    expect(benchHealthText({ ...h, healthOk: null, healthRecord: "missing" })).toBe("health not recorded");
    expect(benchHealthText({ ...h, status: "offline", healthOk: true })).toBe("offline");
  });
});

describe("sample rows (pure)", () => {
  const m = { name: "size", direction: "lower" as const };
  it("numbers noisy pairs from 1 and pairs the two sides", () => {
    const rows = sampleTableRows(
      [
        { run: "measure", pair: 0, side: "best", metric: "size", value: 100 },
        { run: "measure", pair: 0, side: "candidate", metric: "size", value: 90 },
        { run: "measure", pair: 1, side: "best", metric: "size", value: 100 },
        { run: "measure", pair: 1, side: "candidate", metric: "size", value: 95 },
        { run: "measure", pair: 1, side: "best", metric: "rss", value: 5 },
      ],
      m,
      "noisy",
    );
    expect(rows.map((r) => [r.run, r.label, r.change])).toEqual([
      ["measurement", "pair 1", 0.1],
      ["measurement", "pair 2", 0.05],
    ]);
  });
  it("a deterministic measurement is a single run, never 'pair 0'", () => {
    const rows = sampleTableRows(
      [
        { run: "measure", pair: 0, side: "best", metric: "size", value: 100 },
        { run: "measure", pair: 0, side: "candidate", metric: "size", value: 80 },
      ],
      m,
      "deterministic",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("single run");
    expect(rows[0]!.change).toBeCloseTo(0.2);
  });
  it("an expensive measurement lists baseline, screening and confirmation runs", () => {
    const rows = sampleTableRows(
      [
        { run: "measure", pair: 0, side: "best", metric: "size", value: 100 },
        { run: "measure", pair: 1, side: "best", metric: "size", value: 101 },
        { run: "measure", pair: 0, side: "candidate", metric: "size", value: 80 },
        { run: "measure", pair: 1, side: "candidate", metric: "size", value: 81 },
        { run: "measure", pair: 2, side: "candidate", metric: "size", value: 79 },
      ],
      m,
      "expensive",
    );
    expect(rows.map((r) => r.label)).toEqual(["baseline run 1", "baseline run 2", "screening run", "confirmation run 1", "confirmation run 2"]);
    expect(rows.every((r) => !/pair 0/u.test(r.label))).toBe(true);
  });
});

describe("noticeAction follows the state", () => {
  const s = (over: Record<string, unknown>) => ({ slug: "x", state: "paused", calibration_status: "ready", calibration_approved_at: 1, pending_spec_version: null, ...over }) as never;
  it("offers 'Start harvest' only while a harvest can start", () => {
    expect(noticeAction("budget.exhausted", s({ state: "paused" }))).toMatchObject({ label: "Start harvest", tab: "harvest" });
    expect(noticeAction("budget.exhausted", s({ state: "harvesting" }), { state: "ablating" })).toMatchObject({ label: "Open Harvest", tab: "harvest" });
    expect(noticeAction("budget.exhausted", s({ state: "harvesting" }), { state: "ready" })).toMatchObject({ label: "Review harvest", tab: "harvest" });
    expect(noticeAction("budget.exhausted", s({ state: "running" }))).toMatchObject({ label: "See budget", tab: "overview" });
    expect(noticeAction("budget.exhausted", s({ state: "archived" }))).toBeNull();
    // Without the state (old callers): the original action.
    expect(noticeAction("budget.exhausted", { slug: "x" })).toMatchObject({ label: "Start harvest" });
  });
  it("doesn't offer to start or approve what is done", () => {
    expect(noticeAction("calibration.ready", s({ state: "running" }))).toMatchObject({ label: "See calibration" });
    expect(noticeAction("calibration.ready", s({ state: "calibrating", calibration_approved_at: null }))).toMatchObject({ label: "Review calibration and start" });
    expect(noticeAction("spec.proposed", s({ pending_spec_version: null }))).toMatchObject({ label: "See the spec" });
    expect(noticeAction("spec.proposed", s({ pending_spec_version: 3 }))).toMatchObject({ label: "Review the pending spec" });
  });
});

describe("v0.2.3 (fake host)", () => {
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

  async function calibrated(opts: { maxWorkers?: number; health?: boolean } = {}): Promise<string> {
    await engine.proposeStudy("thr_study", "proj_1", spec(opts));
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 5_000);
    return store.study(SLUG)!.id;
  }
  async function running(ideas: string[], opts: { maxWorkers?: number; health?: boolean } = {}): Promise<string> {
    const id = await calibrated(opts);
    ideas.forEach((title, i) => engine.addIdea(SLUG, { title, theme: `t${i}`, pinned: false }, "human"));
    await engine.start(SLUG, "human");
    await settle();
    return id;
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

  it("lanes, cards, the Overview and the bench queue agree on queue positions", async () => {
    const id = await running(["Idea A", "Idea B", "Idea C"]);
    const seen: Array<{ lane: Record<number, number | null>; queue: number[]; overview: Record<number, number | null> }> = [];
    host.onMeasure = () => {
      const s = store.study(id)!;
      const v = liveView(engine, s);
      if (v.queue.length < 2) return;
      const o = overview(engine, s);
      seen.push({
        lane: Object.fromEntries(v.workers.filter((w) => w.candidateStage === "queued").map((w) => [w.candidate!, w.queuePosition])),
        queue: v.queue,
        overview: Object.fromEntries(o.workerList.filter((w) => w.candidate !== null && w.queuePosition !== null).map((w) => [w.candidate!, w.queuePosition])),
      });
    };
    await submit("thr_w1", "TA", 900);
    await submit("thr_w2", "TB", 950);
    await submit("thr_w3", "TC", 960);
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0]!;
    // c/1 is on the bench; c/2 and c/3 wait: 1st and 2nd in line everywhere (the card reads the same queue).
    expect(first.queue).toEqual([2, 3]);
    expect(first.lane).toEqual({ 2: 1, 3: 2 });
    expect(first.overview).toEqual({ 2: 1, 3: 2 });
  });

  it("the status line describes what the live workers do", async () => {
    const id = await running(["Idea A", "Idea B"]);
    const lines: string[] = [];
    host.onMeasure = () => {
      lines.push(statusLine(engine, store.study(id)!));
    };
    await submit("thr_w1", "TA", 900);
    await settle();
    expect(lines[0]).toMatch(/^Running: 2 workers: 1 (reading the code|editing|starting|working), 1 being measured; measuring c\/1\.$/u);
    expect(lines[0]).not.toMatch(/2 workers editing/u);
  });

  it("the strategist's round counts only notices that need the human, not their own controls", async () => {
    const id = await calibrated();
    for (let i = 0; i < 3; i++) await engine.notify(id, "control.idea_added", `You added idea #${i + 1} from the CLI.`, { quiet: true });
    await engine.notify(id, "budget.threshold", "Half of the candidate budget is used.", { quiet: true });
    const s = store.study(id)!;
    const digest = strategistDigest({
      study: s,
      spec: store.spec(s),
      trigger: "start",
      round: 1,
      w: 2,
      verdicts: [],
      findings: [],
      ideas: [],
      workers: [],
      dossier: null,
      bestDiag: [],
      cumulative: null,
      budgetLine: "",
      ideaTitles: new Map(),
      notices: store.notices(id, { undelivered: true, limit: 20 }).reverse(),
    });
    // Calibration raised its own notice: that one, and the budget one, need the human; the three controls don't.
    const needs = store.notices(id, { undelivered: true, limit: 20 }).filter((n) => !n.kind.startsWith("control.")).length;
    expect(needs).toBe(2);
    expect(digest.summary).toMatch(/· 2 notices for you on the Studies page/u);
    expect(digest.summary).not.toMatch(/5 notices/u);
    expect(digest.detail).toMatch(/## Notices for the human \(2\)/u);
    expect(digest.detail).toMatch(/## The human's own controls \(3, audit trail\)/u);
    // With only controls, the summary mentions no notices at all.
    const only = strategistDigest({ study: s, spec: store.spec(s), trigger: "start", round: 1, w: 2, verdicts: [], findings: [], ideas: [], workers: [], dossier: null, bestDiag: [], cumulative: null, budgetLine: "", ideaTitles: new Map(), notices: [{ at: 1, kind: "control.idea_added", text: "x" }] });
    expect(only.summary).not.toMatch(/notice/u);
  });

  it("notices on the page offer the action that fits the state now", async () => {
    const id = await running(["Idea A"]);
    await engine.notify(id, "budget.exhausted", "Budget used up. Next: harvest.", { quiet: true });
    await engine.pause(SLUG, "human");
    store.updateStudy(id, { state: "harvesting" });
    const n = noticesView(engine, store.study(id)!).find((x) => x.kind === "budget.exhausted")!;
    expect(n.action?.label).not.toBe("Start harvest");
  });

  it("every health check is an event; replay shows the health it recorded, live and replay agree", async () => {
    const id = await running(["Idea A"]);
    await submit("thr_w1", "TA", 900);
    await settle();
    const events = store.eventsAsc(id, { kinds: ["bench.health"] });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.parse(events[0]!.data_json)).toMatchObject({ ok: true, context: expect.any(String) });
    const m = new ReplayModel(replayBundle(engine, store.study(id)!));
    const at = m.viewAt(m.end);
    expect(at.bench[0]!.healthOk).toBe(true);
    expect(benchHealthText(at.bench[0]!)).toBe("healthy");
    expect(liveView(engine, store.study(id)!).bench[0]!.healthOk).toBe(true);
  });

  it("an older study without health events replays as 'health not recorded', not 'not checked yet'", async () => {
    const id = await running(["Idea A"]);
    const b = replayBundle(engine, store.study(id)!);
    const old = { ...b, events: b.events.filter((e) => e.kind !== "bench.health") };
    const v = new ReplayModel(old).viewAt(old.end);
    expect(benchHealthText(v.bench[0]!)).toBe("health not recorded");
    // Health checks off in the spec: say so.
    const off = { ...old, spec: { ...old.spec, healthChecks: false } };
    expect(benchHealthText(new ReplayModel(off).viewAt(off.end).bench[0]!)).toBe("health checks off");
  });

  it("with health checks off, the live bench strip says so", async () => {
    const id = await running(["Idea A"], { health: false });
    expect(benchHealthText(liveView(engine, store.study(id)!).bench[0]!)).toBe("health checks off");
  });

  it("the candidate detail carries its band, the noise class and which statistic the headline is", async () => {
    const id = await running(["Idea A"]);
    await submit("thr_w1", "TA", 900);
    await settle();
    const d = (await candidateDetail(engine, store.study(id)!, 1))!;
    expect(d.band?.kind).toBe("noisy");
    expect(d.band?.n).toBe(1);
    expect(d.noise).toBe("noisy");
    expect(d.effectStatistic).toMatch(/median of the per-pair changes/u);
    const rows = sampleTableRows(d.samples, { name: "size", direction: "lower" }, d.noise);
    expect(rows[0]!.label).toBe("pair 1");
    void clock;
  });
});
