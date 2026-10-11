// v0.2.4 statistics, by simulation: futility stopping (A1), early losses
// (A2) and skipped confirmations (A3) against the v0.2.3 rules under the
// same noise (common random numbers: each trial replays the same noise
// stream under both rule sets). Effects are in units of the win threshold
// (MDE) calibrated from a large A/A pool. Set SIM_TRIALS for a longer run
// (the numbers in docs/design.md, "Implementation notes: v0.2.4").
import { describe, expect, it } from "vitest";
import { noisyStrategy, type Bench, type Side } from "../src/noise.ts";
import { confirmationSkip } from "../src/pipeline.ts";
import { ciRngFor } from "../src/band.ts";
import { parseSpec, type StudySpec } from "../src/spec.ts";
import { calibrateNoisy, seededRng } from "../src/stats.ts";

const TRIALS = Number(process.env.SIM_TRIALS ?? 150);
const SIGMA = 0.02; // per run; about 2.8% per pair

function specWith(protocol: string): StudySpec {
  const r = parseSpec(`
[study]
slug = "sim"
objective = "Simulated candidates."
[metric]
name = "t"
direction = "lower"
[scope]
editable = ["src/**"]
[oracle]
measure = "m"
noise = "noisy"
gate = ["g"]
[oracle.protocol]
warmup = 0
bootstrap = 400
${protocol}
`);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
}

const V023 = specWith("futility = false\nearly_lose_from = 0\nskip_confirm_factor = 0");
const V024 = specWith(process.env.SIM_PROTOCOL?.replace(/;/gu, "\n") ?? "");

function gaussian(rng: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

function bench(effect: number, seed: number): Bench & { pairs: number } {
  const g = gaussian(seededRng(seed));
  const b = {
    pairs: 0,
    async run(side: Side) {
      if (side === "best") b.pairs += 0.5;
      else b.pairs += 0.5;
      const v = 1000 * (side === "candidate" ? 1 - effect : 1) * (1 + SIGMA * g());
      return { metrics: { t: v }, diag: [], durationMs: 1 };
    },
  };
  return b;
}

const MDE = (() => {
  const g = gaussian(seededRng(99));
  const aa = Array.from({ length: 400 }, () => {
    const a = 1 + SIGMA * g();
    const b = 1 + SIGMA * g();
    return (a - b) / a;
  });
  return calibrateNoisy(aa, { nMax: 20, confidence: 0.95, iterations: 2000, minEffect: 0.001, rng: seededRng(5) }).mde;
})();

/** One candidate through the pipeline's noisy protocol: measure, then confirm unless skipped. */
async function candidate(spec: StudySpec, effect: number, seed: number): Promise<{ verdict: "win" | "lose" | "inconclusive"; pairs: number; confirmed: boolean; skipped: boolean; stop: string | undefined }> {
  const b = bench(effect, seed);
  // The pipeline's seeded bootstrap per pair (band.ts): the rules differ, the noise and pair order don't.
  const first = await noisyStrategy.measure({ bench: b, spec, mde: MDE, rng: seededRng(seed + 1), ciRng: ciRngFor(seed, "measure"), record: () => undefined });
  if (first.decision !== "win") return { verdict: first.decision, pairs: b.pairs, confirmed: false, skipped: false, stop: first.stop };
  if (confirmationSkip(spec, MDE, first.ciLo)) return { verdict: "win", pairs: b.pairs, confirmed: false, skipped: true, stop: first.stop };
  const second = await noisyStrategy.measure({ bench: b, spec, mde: MDE, rng: seededRng(seed + 2), ciRng: ciRngFor(seed, "confirm"), record: () => undefined });
  return { verdict: second.decision === "win" ? "win" : second.decision === "lose" ? "lose" : "inconclusive", pairs: b.pairs, confirmed: true, skipped: false, stop: second.stop };
}

interface Cell {
  effect: number;
  win: number;
  lose: number;
  pairs: number;
  skipped: number;
  futility: number;
  early: number;
}

async function run(spec: StudySpec, k: number): Promise<Cell> {
  const cell: Cell = { effect: k, win: 0, lose: 0, pairs: 0, skipped: 0, futility: 0, early: 0 };
  for (let t = 0; t < TRIALS; t++) {
    const r = await candidate(spec, k * MDE, 10_000 * (k + 10) + t * 7);
    if (r.verdict === "win") cell.win += 1;
    if (r.verdict === "lose") cell.lose += 1;
    if (r.skipped) cell.skipped += 1;
    if (r.stop === "futility") cell.futility += 1;
    if (r.stop === "early") cell.early += 1;
    cell.pairs += r.pairs;
  }
  return cell;
}

const EFFECTS = [-8, -4, -2, -1, 0, 1, 1.5, 2, 4, 10];
const pct = (x: number) => `${((x / TRIALS) * 100).toFixed(1)}%`;

describe("v0.2.4 sequential rules vs v0.2.3, simulated", () => {
  it(
    "keeps the false-win rate, barely loses true wins, and saves bench pairs",
    async () => {
      const rows: Array<{ k: number; old: Cell; now: Cell }> = [];
      for (const k of EFFECTS) rows.push({ k, old: await run(V023, k), now: await run(V024, k) });
      const table = [
        `MDE ${(MDE * 100).toFixed(2)}% (per-run noise ${(SIGMA * 100).toFixed(1)}%), ${TRIALS} candidates per cell, n_min 6, n_max 20`,
        "effect (×MDE) | win v0.2.3 → v0.2.4 | lose v0.2.3 → v0.2.4 | pairs/candidate v0.2.3 → v0.2.4 | futility stops | early losses | confirmations skipped",
        ...rows.map(
          ({ k, old, now }) =>
            `${k} | ${pct(old.win)} → ${pct(now.win)} | ${pct(old.lose)} → ${pct(now.lose)} | ${(old.pairs / TRIALS).toFixed(1)} → ${(now.pairs / TRIALS).toFixed(1)} | ${pct(now.futility)} | ${pct(now.early)} | ${pct(now.skipped)}`,
        ),
      ];
      console.log(table.join("\n"));
      const at = (k: number) => rows.find((r) => r.k === k)!;
      // False wins (no true effect): no worse than v0.2.3 (allow one trial of chance).
      expect(at(0).now.win).toBeLessThanOrEqual(at(0).old.win + 1);
      expect(at(0).now.win / TRIALS).toBeLessThan(0.05);
      // False losses on true +MDE effects: rare.
      expect(at(1).now.lose / TRIALS).toBeLessThan(0.04);
      // Missed wins: at 2× and 4× the threshold, at most a few points fewer wins than v0.2.3.
      expect(at(2).now.win).toBeGreaterThanOrEqual(at(2).old.win - Math.ceil(0.06 * TRIALS));
      expect(at(4).now.win).toBeGreaterThanOrEqual(at(4).old.win - Math.ceil(0.02 * TRIALS));
      // Bench pairs saved on non-wins (futility, early losses) and on big wins (skipped confirmations).
      for (const k of [-8, -4, -2, -1, 0]) expect(at(k).now.pairs).toBeLessThan(at(k).old.pairs);
      const total = (key: "old" | "now") => rows.reduce((a, r) => a + r[key].pairs, 0);
      expect(total("now")).toBeLessThan(0.85 * total("old"));
      // Clear losses stop before n_min; big wins skip their confirmation.
      expect(at(-8).now.early / TRIALS).toBeGreaterThan(0.9);
      expect(at(-8).now.pairs / TRIALS).toBeLessThan(4);
      expect(at(10).now.skipped / TRIALS).toBeGreaterThan(0.9);
      expect(at(10).now.pairs).toBeLessThan(0.6 * at(10).old.pairs);
      // Every non-win of v0.2.3 stays a non-win, and the early rule almost never calls a true +MDE effect a loss.
      expect(at(1).now.early / TRIALS).toBeLessThan(0.02);
    },
    300_000,
  );

  it("an early lose needs the whole CI below 0 at the stricter confidence (a t interval of the mean)", async () => {
    const seq = (imps: number[]): Bench => {
      let pair = 0;
      return {
        async run(side) {
          const v = side === "best" ? 1000 : 1000 * (1 - imps[Math.min(pair++, imps.length - 1)]!);
          return { metrics: { t: v }, diag: [], durationMs: 1 };
        },
      };
    };
    const sp = specWith("n_min = 6\nn_max = 6");
    // A clear regression (about 10% worse, 1% apart): the 99% t interval of 3 pairs is entirely below 0.
    const clear = await noisyStrategy.measure({ bench: seq([-0.1, -0.11, -0.09, -0.1, -0.1, -0.1]), spec: sp, mde: 0.01, rng: seededRng(3), record: () => undefined });
    expect(clear).toMatchObject({ decision: "lose", stop: "early", n: 3 });
    expect(clear.ciHi!).toBeLessThan(0);
    // Three worse pairs of a noisy, modest regression: worse on average but not clearly, so it waits for n_min.
    const modest = await noisyStrategy.measure({ bench: seq([-0.03, -0.005, -0.02, 0.01, -0.01, 0.0]), spec: sp, mde: 0.01, rng: seededRng(3), record: () => undefined });
    expect(modest.stop).not.toBe("early");
    expect(modest.n).toBe(6);
  });
});
