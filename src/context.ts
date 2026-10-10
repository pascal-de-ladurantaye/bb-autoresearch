// Shared dependencies for the engine, pipeline, and calibration.
import type { Store } from "./db/store.ts";
import type { BbPort } from "./ports.ts";
import type { Rng } from "./stats.ts";

/** Exclusive sections per key: one measurement at a time per bench host. */
export class HostMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
  /** True while someone holds or waits for `key`. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}

export interface EngineConfig {
  /** Hard ceiling on W regardless of max_workers (tests, emergencies). */
  workerCeiling: number;
  /** Background control-loop period. */
  tickMs: number;
  /** Delay before a stage that hit a host error is retried (times the attempt count). */
  retryDelayMs: number;
  /** A worker that called study_finish but whose turn never ends is stopped after this. */
  finishingTimeoutMs: number;
  /** Bundle chunk size override (tests); defaults to BUNDLE_CHUNK_BYTES. */
  bundleChunkBytes?: number;
  /** How long a bench host's connection status is trusted before asking BB again. */
  hostStatusTtlMs: number;
  /** Harvest polling period (waiting for the bench to drain, for the strategist's grouping). */
  harvestPollMs: number;
  /** After the grouping round's turn ends without a valid proposal, wait this long before the fallback grouping. */
  harvestGroupGraceMs: number;
  /** Health deferrals a harvest measurement waits through before failing. */
  harvestHealthTries: number;
  /** How often provider usage windows are read (bb.sdk.system.usageLimits). */
  usagePollMs: number;
  /** How often a live thread's token usage is read. */
  tokenPollMs: number;
  /** Live view: minimum time a worker stays in an activity phase (reading, editing, testing) before a flip is recorded. */
  liveDwellMs?: number;
  /** Live view: minimum time between two worker.action events of one worker (the "last action" line). */
  liveActionMs?: number;
}

export interface Ctx {
  store: Store;
  bb: BbPort;
  now: () => number;
  rng: Rng;
  benchLock: HostMutex;
  config: EngineConfig;
  /** Set when the plugin instance is disposed (reload): in-flight work stops quietly. */
  disposed?: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  workerCeiling: 64,
  tickMs: 10_000,
  retryDelayMs: 15_000,
  finishingTimeoutMs: 3 * 60_000,
  hostStatusTtlMs: 15_000,
  harvestPollMs: 2_000,
  harvestGroupGraceMs: 60_000,
  harvestHealthTries: 30,
  usagePollMs: 120_000,
  tokenPollMs: 60_000,
};
