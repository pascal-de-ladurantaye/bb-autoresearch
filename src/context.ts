// Shared dependencies for the engine, pipeline, and calibration.
import type { Store } from "./db/store.ts";
import type { BbPort } from "./ports.ts";
import type { Rng } from "./stats.ts";

/** One measurement at a time per bench host. */
export class HostMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(hostId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(hostId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(hostId) === tail) this.tails.delete(hostId);
    }
  }
}

export interface EngineConfig {
  /** M0 runs one worker at a time regardless of max_workers. */
  workerCeiling: number;
  /** Background control-loop period. */
  tickMs: number;
}

export interface Ctx {
  store: Store;
  bb: BbPort;
  now: () => number;
  rng: Rng;
  benchLock: HostMutex;
  config: EngineConfig;
}

export const DEFAULT_CONFIG: EngineConfig = { workerCeiling: 1, tickMs: 10_000 };
