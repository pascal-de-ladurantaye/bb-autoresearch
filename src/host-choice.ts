// Which bench hosts measure, and in what order (v1, measurement quality).
//
// - Every host decides with its own calibrated win threshold (never below
//   `min_effect`): `measurementMde` in pipeline.ts.
// - A free candidate goes to the quietest free host first: the lowest
//   effective threshold, then the lowest noise floor, then spec order.
// - A host much noisier than its peers (more than `max_host_noise_ratio`
//   times the median noise floor of the other hosts) is not used: a BB
//   machine or the edit host leaves the dispatch set, a remote machine is
//   replaced.
//
// Pure functions, shared by calibration, the pipeline, the fleet and views.
import { median } from "./stats.ts";

export interface HostNoise {
  hostId: string;
  name: string;
  noiseFloor: number | null;
}

export interface NoisyHost {
  hostId: string;
  name: string;
  /** The host's calibrated noise floor. */
  noise: number;
  /** Median noise floor of its peers (the other hosts). */
  peers: number;
  /** noise / peers. */
  ratio: number;
  /**
   * Whether the ratio is beyond what chance gives two equal hosts with this
   * many calibration samples (`chanceRatio`). Only such hosts are taken out;
   * the others get a calibration warning.
   */
  significant: boolean;
  /** The ratio it had to exceed: max(max_host_noise_ratio, chanceRatio). */
  needed: number;
}

/**
 * The noise-floor ratio two hosts of the same true noise exceed by chance
 * about 1% of the time, given the calibration samples behind each estimate:
 * exp(z·√2·se) with z the 99% normal quantile and se the standard error of
 * log σ̂. noisy: the robust SD of n A/A pairs, se ≈ 1.3/√n (the MAD's
 * asymptotic 1.17/√n is optimistic at a dozen pairs; 1.3 holds the rate at
 * or below 1% from 12 pairs, by simulation); expensive: the sample SD of n
 * runs, se ≈ 1.3/√(2(n − 1)). With the default 12 pairs that is 3.4×, with
 * 40 pairs 2.0×: a 2× limit then binds.
 */
export function chanceRatio(noise: "noisy" | "expensive" | "deterministic", samples: number): number {
  if (noise === "deterministic" || !(samples > 1)) return 1;
  const se = noise === "expensive" ? 1.3 / Math.sqrt(2 * (samples - 1)) : 1.3 / Math.sqrt(samples);
  return Math.exp(2.326 * Math.SQRT2 * se);
}

const finitePositive = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/**
 * Whether `noise` is more than `ratio` times the median of `peers` (the
 * other hosts' noise floors). With two hosts the peer is the other one; a
 * host is never compared with itself, so the quietest host always stays.
 * `ratio` 0 (off), no peers, or peers without noise: never.
 */
export function noisyAgainstPeers(noise: number | null, peers: ReadonlyArray<number | null>, ratio: number, chance = 1): { peers: number; ratio: number; significant: boolean; needed: number } | null {
  if (!(ratio > 0) || !finitePositive(noise)) return null;
  const values = peers.filter(finitePositive);
  if (!values.length) return null;
  const m = median(values);
  if (!(m > 0) || noise <= ratio * m) return null;
  const needed = Math.max(ratio, chance);
  return { peers: m, ratio: noise / m, significant: noise > needed * m, needed };
}

/**
 * The hosts noisier than `ratio` times their peers' median, each judged
 * against the others; `significant` marks those beyond `chance` too (the
 * ones to take out).
 */
export function noisyOutliers(hosts: readonly HostNoise[], ratio: number, chance = 1): NoisyHost[] {
  const out: NoisyHost[] = [];
  for (const h of hosts) {
    const r = noisyAgainstPeers(h.noiseFloor, hosts.filter((x) => x.hostId !== h.hostId).map((x) => x.noiseFloor), ratio, chance);
    if (r) out.push({ hostId: h.hostId, name: h.name, noise: h.noiseFloor!, ...r });
  }
  return out;
}

/**
 * Dispatch order: the lowest effective win threshold first, then the lowest
 * noise floor, then the given (spec) order. Hosts without a calibration go last.
 */
export function quietestFirst<T extends { noise_floor: number | null }>(hosts: readonly T[], threshold: (h: T) => number | null): T[] {
  const key = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);
  return hosts
    .map((h, i) => ({ h, i, t: key(threshold(h)), n: key(h.noise_floor) }))
    .sort((a, b) => a.t - b.t || a.n - b.n || a.i - b.i)
    .map((x) => x.h);
}

const pct = (f: number) => `${(f * 100).toFixed(2)}%`;

/**
 * Per-host win thresholds in words, quietest first: "1.42% on gcp-a, 3.33%
 * on gcp-b"; one host or all equal: "1.42%" (plus "on every host" for several).
 */
export function hostThresholdsText(hosts: ReadonlyArray<{ name: string; mde: number | null }>): string {
  const known = hosts.filter((h): h is { name: string; mde: number } => h.mde !== null && Number.isFinite(h.mde)).sort((a, b) => a.mde - b.mde);
  if (!known.length) return "";
  if (known.length === 1) return pct(known[0]!.mde);
  if (known.every((h) => Math.abs(h.mde - known[0]!.mde) < 5e-5)) return `${pct(known[0]!.mde)} on every host`;
  return known.map((h) => `${pct(h.mde)} on ${h.name}`).join(", ");
}

/** Why a host was taken out or replaced, in words. */
export function noisyHostText(h: NoisyHost, limit: number, unit: string): string {
  return `noise floor ${pct(h.noise)} ${unit}, ${h.ratio.toFixed(1)}× the ${pct(h.peers)} median of the other bench hosts, above max_host_noise_ratio ${limit}`;
}

/** A host above the ratio that chance could explain: it keeps measuring, and calibration says so. */
export function unclearNoisyHostText(h: NoisyHost, limit: number, unit: string, samples: number, sampleWord: string): string {
  return `${h.name}'s noise floor (${pct(h.noise)} ${unit}) is ${h.ratio.toFixed(1)}× the ${pct(h.peers)} median of the other bench hosts, above max_host_noise_ratio ${limit}, but with ${samples} calibration ${sampleWord} two equal hosts differ that much by chance (it would take more than ${h.needed.toFixed(1)}×): it keeps measuring, with its own win threshold. More calibration ${sampleWord} would tell them apart`;
}

/**
 * How many machines in a row an entry replaces for being much noisier than
 * the other bench hosts; the next one is kept (it measures with its own win
 * threshold, and dispatch prefers quieter hosts), so a provider whose
 * machines are all noisier than the edit host doesn't churn forever.
 */
export const NOISY_REPLACEMENTS = 2;

/** What `excluded_json` holds. */
export interface ExcludedHost {
  reason: string;
  noise: number;
  peers: number;
  segment: number | null;
  at: number;
}
