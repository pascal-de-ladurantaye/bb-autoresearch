// Background jobs on a host: a long command (build, gate, one measure run)
// runs detached from any single host RPC call. The server starts it, polls it
// with short `jobWait` calls, and cancels it, so no host call comes near the
// 30-minute cap however long the command runs. The registry lives in the host
// worker's memory: a worker restart loses it, `jobWait` then answers
// `unknown`, and the server restarts the measurement from scratch.
import { randomBytes } from "node:crypto";
import type { ExecResult, JobInput, JobStatus } from "./contract.ts";
import { spawnCommand } from "./ops.ts";

interface Job {
  id: string;
  label: string;
  started: number;
  controller: AbortController;
  tail: string;
  result: ExecResult | null;
  error: string | null;
  done: Promise<void>;
  finishedAt: number | null;
}

/** Finished jobs are kept this long for a late `jobWait`. */
const KEEP_MS = 15 * 60_000;

export interface JobHooks {
  /** Progress line for a running job (throttled by the caller). */
  onProgress?: (jobId: string, label: string, line: string) => void;
  /** The job ended (release worker leases here). */
  onEnd?: (jobId: string) => void;
}

export class JobRegistry {
  private jobs = new Map<string, Job>();

  constructor(private readonly progressMs = 5_000) {}

  start(input: JobInput, hooks: JobHooks = {}): string {
    this.prune();
    const id = `job_${randomBytes(8).toString("hex")}`;
    const controller = new AbortController();
    const job: Job = {
      id,
      label: input.label ?? "",
      started: Date.now(),
      controller,
      tail: "",
      result: null,
      error: null,
      done: Promise.resolve(),
      finishedAt: null,
    };
    job.done = spawnCommand({
      cwd: input.cwd,
      command: input.command,
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
      ...(input.tailBytes ? { tailBytes: input.tailBytes } : {}),
      signal: controller.signal,
      progressMs: this.progressMs,
      onLine: (line) => {
        job.tail = line;
        hooks.onProgress?.(id, job.label, line);
      },
    })
      .then((r) => {
        job.result = r;
      })
      .catch((e: unknown) => {
        job.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        hooks.onEnd?.(id);
      });
    this.jobs.set(id, job);
    return id;
  }

  async wait(jobId: string, waitMs: number): Promise<JobStatus> {
    const job = this.jobs.get(jobId);
    if (!job) return { state: "unknown", result: null, tail: "", elapsedMs: 0 };
    if (job.finishedAt === null && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
      if (timer) clearTimeout(timer);
      if (!this.jobs.has(jobId)) return { state: "unknown", result: null, tail: "", elapsedMs: 0 };
    }
    const elapsedMs = (job.finishedAt ?? Date.now()) - job.started;
    if (job.finishedAt === null) return { state: "running", result: null, tail: job.tail, elapsedMs };
    const result: ExecResult = job.result ?? { exitCode: null, timedOut: false, durationMs: elapsedMs, stdout: "", stderr: job.error ?? "job failed to start" };
    return { state: "done", result, tail: job.tail, elapsedMs };
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.finishedAt !== null) return false;
    job.controller.abort();
    return true;
  }

  /** Forget every job and kill it, as a crashed worker would (tests). */
  forgetAll(): void {
    const all = [...this.jobs.values()];
    this.jobs.clear();
    for (const j of all) if (j.finishedAt === null) j.controller.abort();
  }

  /** Kill everything (worker lifecycle end). */
  cancelAll(): void {
    for (const j of this.jobs.values()) if (j.finishedAt === null) j.controller.abort();
  }

  running(): number {
    return [...this.jobs.values()].filter((j) => j.finishedAt === null).length;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.finishedAt !== null && now - j.finishedAt > KEEP_MS) this.jobs.delete(id);
  }
}
