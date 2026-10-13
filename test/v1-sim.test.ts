// v1, per-host win thresholds, by simulation: two bench hosts with the noise
// of a real study (5.44% and 2.42% per pair), each threshold calibrated from
// its own A/A pool. v0.3 judged every candidate against the segment's
// threshold (the noisier host's); v1 judges each against the threshold of the
// host that measured it. Common random numbers: each trial replays the same
// noise stream and pair order under both rules. Set SIM_TRIALS for a longer
// run (the numbers in docs/release-notes.md, 1.0).
import { describe, expect, it } from "vitest";
import { ciRngFor } from "../src/band.ts";
import { noisyStrategy, type Bench, type Side } from "../src/noise.ts";
import { confirmationSkip } from "../src/pipeline.ts";
import { parseSpec, type StudySpec } from "../src/spec.ts";
import { calibrateNoisy, seededRng } from "../src/stats.ts";

const TRIALS = Number(process.env.SIM_TRIALS ?? 150);
/** Per-pair noise of the two hosts (relative SD of a pair's difference); per run it is this / √2. */
const HOSTS = [
  { name: "quiet", pair: 0.0242 },
  { name: "noisy", pair: 0.0544 },
] as const;

const SPEC: StudySpec = (() => {
  const r = parseSpec(`
[study]
slug = "sim"
objective = "Simulated candidates on two hosts."
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
n_min = 6
n_max = 20
`);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
})();

function gaussian(rng: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

function bench(effect: number, sigmaRun: number, seed: number): Bench {
  const g = gaussian(seededRng(seed));
  return {
    async run(side: Side) {
      const v = 1000 * (side === "candidate" ? 1 - effect : 1) * (1 + sigmaRun * g());
      return { metrics: { t: v }, diag: [], durationMs: 1 };
    },
  };
}

/** A host's win threshold, calibrated from 400 A/A pairs of its own noise (min_effect 1%, the default). */
function calibrated(sigmaRun: number, seed: number): number {
  const g = gaussian(seededRng(seed));
  const aa = Array.from({ length: 400 }, () => {
    const a = 1 + sigmaRun * g();
    const b = 1 + sigmaRun * g();
    return (a - b) / a;
  });
  return calibrateNoisy(aa, { nMax: 20, confidence: 0.95, iterations: 2000, minEffect: SPEC.oracle.protocol.min_effect, rng: seededRng(seed + 1) }).mde;
}

/** One candidate through the pipeline's protocol at threshold `mde`: measure, then confirm unless skipped. */
async function candidate(effect: number, sigmaRun: number, mde: number, seed: number): Promise<{ verdict: "win" | "lose" | "inconclusive"; first: boolean }> {
  const b = bench(effect, sigmaRun, seed);
  const first = await noisyStrategy.measure({ bench: b, spec: SPEC, mde, rng: seededRng(seed + 1), ciRng: ciRngFor(seed, "measure"), record: () => undefined });
  if (first.decision !== "win") return { verdict: first.decision, first: false };
  if (confirmationSkip(SPEC, mde, first.ciLo)) return { verdict: "win", first: true };
  const second = await noisyStrategy.measure({ bench: b, spec: SPEC, mde, rng: seededRng(seed + 2), ciRng: ciRngFor(seed, "confirm"), record: () => undefined });
  return { verdict: second.decision, first: true };
}

/** Verdicts over TRIALS candidates; `first`: the first measurement called it a win (before the confirmation). */
async function wins(effect: number, sigmaRun: number, mde: number, salt: number): Promise<{ win: number; lose: number; first: number }> {
  let win = 0;
  let lose = 0;
  let first = 0;
  for (let t = 0; t < TRIALS; t++) {
    const v = await candidate(effect, sigmaRun, mde, 1_000_000 * salt + Math.round(effect * 1e5) * 101 + t * 7);
    if (v.verdict === "win") win += 1;
    if (v.verdict === "lose") lose += 1;
    if (v.first) first += 1;
  }
  return { win, lose, first };
}

const EFFECTS = [-0.02, 0, 0.01, 0.02, 0.03, 0.045, 0.06];
const pct = (n: number) => `${((n / TRIALS) * 100).toFixed(1)}%`;

describe("v1 per-host win thresholds, simulated", () => {
  it(
    "keeps each host's false-win rate and finds more of the quiet host's real wins",
    async () => {
      const quiet = { sigma: HOSTS[0].pair / Math.SQRT2, mde: calibrated(HOSTS[0].pair / Math.SQRT2, 11) };
      const noisy = { sigma: HOSTS[1].pair / Math.SQRT2, mde: calibrated(HOSTS[1].pair / Math.SQRT2, 23) };
      // v0.3: the segment's threshold is the noisier host's, on both hosts.
      const segment = Math.max(quiet.mde, noisy.mde);
      type Cell = { win: number; lose: number; first: number };
      const rows: Array<{ effect: number; quietOld: Cell; quietNew: Cell; noisy: Cell }> = [];
      for (const e of EFFECTS) {
        rows.push({
          effect: e,
          quietOld: await wins(e, quiet.sigma, segment, 1),
          quietNew: await wins(e, quiet.sigma, quiet.mde, 1),
          // The noisy host's threshold is the segment's under both rules: same verdicts.
          noisy: await wins(e, noisy.sigma, noisy.mde, 2),
        });
      }
      const table = [
        `thresholds: quiet host ${(quiet.mde * 100).toFixed(2)}%, noisy host ${(noisy.mde * 100).toFixed(2)}% (per-pair noise ${(HOSTS[0].pair * 100).toFixed(2)}% and ${(HOSTS[1].pair * 100).toFixed(2)}%), ${TRIALS} candidates per cell, n_min 6, n_max 20, confirmation on`,
        "true effect | quiet host wins v0.3 → v1 | quiet host losses v0.3 → v1 | quiet host first-measurement wins v0.3 → v1 | noisy host wins (both) | noisy host losses (both) | noisy host first-measurement wins",
        ...rows.map((r) => `${(r.effect * 100).toFixed(1)}% | ${pct(r.quietOld.win)} → ${pct(r.quietNew.win)} | ${pct(r.quietOld.lose)} → ${pct(r.quietNew.lose)} | ${pct(r.quietOld.first)} → ${pct(r.quietNew.first)} | ${pct(r.noisy.win)} | ${pct(r.noisy.lose)} | ${pct(r.noisy.first)}`),
      ];
      console.log(table.join("\n"));
      if (process.env.SIM_OUT) (await import("node:fs")).writeFileSync(process.env.SIM_OUT, `${table.join("\n")}\n`);
      const at = (e: number) => rows.find((r) => r.effect === e)!;
      // The calibrated thresholds look like the study's (3.33% and 1.42%).
      expect(noisy.mde).toBeGreaterThan(0.028);
      expect(noisy.mde).toBeLessThan(0.038);
      expect(quiet.mde).toBeGreaterThan(0.011);
      expect(quiet.mde).toBeLessThan(0.017);
      // False wins (no true effect, or a regression): per host, as rare under its own threshold as the noisy host's under its own.
      for (const e of [-0.02, 0]) {
        expect(at(e).quietNew.win / TRIALS).toBeLessThan(0.03);
        expect(at(e).quietNew.win).toBeLessThanOrEqual(at(e).noisy.win + Math.ceil(0.02 * TRIALS));
        expect(at(e).noisy.win / TRIALS).toBeLessThan(0.03);
      }
      // Before the confirmation, the quiet host's own threshold gives chance wins at about the noisy host's rate (the
      // nominal per-host rate the threshold is calibrated for), not the near-zero rate of a threshold too high for it.
      expect(at(0).quietNew.first).toBeLessThanOrEqual(at(0).noisy.first + Math.ceil(0.03 * TRIALS));
      // False losses on real gains stay rare.
      for (const e of [0.01, 0.02, 0.03]) expect(at(e).quietNew.lose / TRIALS).toBeLessThan(0.03);
      // Detection on the quiet host: real 2-4.5% gains, often inconclusive under the noisy host's threshold, are found.
      expect(at(0.02).quietNew.win).toBeGreaterThan(at(0.02).quietOld.win + 0.1 * TRIALS);
      expect(at(0.03).quietNew.win).toBeGreaterThan(at(0.03).quietOld.win + 0.5 * TRIALS);
      expect(at(0.03).quietNew.win / TRIALS).toBeGreaterThan(0.6);
      expect(at(0.045).quietNew.win).toBeGreaterThanOrEqual(at(0.045).quietOld.win);
      // Every effect: the own threshold finds at least as many wins (common random numbers, lower threshold).
      for (const r of rows) expect(r.quietNew.win).toBeGreaterThanOrEqual(r.quietOld.win);
    },
    600_000,
  );
});
