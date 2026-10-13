// Shared dependencies for the engine, pipeline, and calibration.
import type { BenchHostRow, Store } from "./db/store.ts";
import type { HostRunner } from "./host/runner.ts";
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
  /** Harvest polling period (waiting for the bench to drain before best freezes). */
  harvestPollMs: number;
  /** Health deferrals a requested measurement (`bb study measure`) waits through before failing. */
  adhocHealthTries: number;
  /** How long a requested measurement waits for a bench host when none is online yet (remote machines joining after a freeze or a reload). */
  adhocHostWaitMs: number;
  /** How often provider usage windows are read (bb.sdk.system.usageLimits). */
  usagePollMs: number;
  /** How often a live thread's token usage is read. */
  tokenPollMs: number;
  /** Live view: minimum time a worker stays in an activity phase (reading, editing, testing) before a flip is recorded. */
  liveDwellMs?: number;
  /** Live view: minimum time between two worker.action events of one worker (the "last action" line). */
  liveActionMs?: number;
  /** Remote bench hosts (fleet timings; tests shorten them). */
  remote?: Partial<RemoteFleetConfig>;
}

export interface RemoteFleetConfig {
  /** How often each live machine's provider status is read. */
  statusPollMs: number;
  /** Polling while a new machine provisions. */
  readyPollMs: number;
  /** Longest wait for a machine to join (create → ready to calibrate). */
  joinTimeoutMs: number;
  /** Consecutive join failures of one entry before it waits `blockedMs`. */
  maxFailures: number;
  blockedMs: number;
  /** Delay before retrying after one failed join (times the failure count). */
  retryMs: number;
  /** Longest wait between two execPoll calls. */
  execPollMs: number;
  /** Local directory for bundles in transit to remote machines (default: under the OS temp dir). */
  stagingDir?: string;
}

export const DEFAULT_REMOTE_CONFIG: RemoteFleetConfig = {
  statusPollMs: 15_000,
  readyPollMs: 2_000,
  joinTimeoutMs: 30 * 60_000,
  maxFailures: 3,
  blockedMs: 10 * 60_000,
  retryMs: 30_000,
  execPollMs: 1_000,
};

export interface Ctx {
  store: Store;
  bb: BbPort;
  now: () => number;
  rng: Rng;
  benchLock: HostMutex;
  config: EngineConfig;
  /** Set when the plugin instance is disposed (reload): in-flight work stops quietly. */
  disposed?: boolean;
  /** The runner of a remote bench host (mode "remote"), set by the engine's remote fleet. */
  remoteRunner?: (host: BenchHostRow) => HostRunner;
}

export const DEFAULT_CONFIG: EngineConfig = {
  workerCeiling: 64,
  tickMs: 10_000,
  retryDelayMs: 15_000,
  finishingTimeoutMs: 3 * 60_000,
  hostStatusTtlMs: 15_000,
  harvestPollMs: 2_000,
  adhocHealthTries: 30,
  adhocHostWaitMs: 30 * 60_000,
  usagePollMs: 120_000,
  tokenPollMs: 60_000,
};
