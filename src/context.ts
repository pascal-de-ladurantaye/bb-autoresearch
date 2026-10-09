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
}

export interface Ctx {
  store: Store;
  bb: BbPort;
  now: () => number;
  rng: Rng;
  benchLock: HostMutex;
  config: EngineConfig;
}

export const DEFAULT_CONFIG: EngineConfig = { workerCeiling: 64, tickMs: 10_000, retryDelayMs: 15_000, finishingTimeoutMs: 3 * 60_000, hostStatusTtlMs: 15_000 };
