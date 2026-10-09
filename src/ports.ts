// The engine's view of BB. server.ts adapts bb.sdk to this; tests fake it.
import type { HostRunner } from "./host/runner.ts";

export interface ThreadInfo {
  id: string;
  status: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  archivedAt: number | null;
  deletedAt: number | null;
  environmentId: string | null;
}

export interface EnvironmentInfo {
  id: string;
  hostId: string;
  path: string | null;
  branchName: string | null;
}

export interface SpawnWorkerArgs {
  projectId: string;
  hostId: string;
  baseBranch: string;
  title: string;
  prompt: string;
  sectionId: string | null;
  metadata: { study: string; role: "worker"; idea: number; spawnToken: string };
  providerId?: string;
  model?: string;
  permissionMode?: "accept-edits" | "auto" | "full";
}

export interface BbPort {
  primaryHostId(): Promise<string | null>;
  /** The project's checkout on `hostId`, if it has one. */
  projectCheckout(projectId: string, hostId: string): Promise<string | null>;
  ensureSection(name: string): Promise<string | null>;
  spawnWorker(args: SpawnWorkerArgs): Promise<{ threadId: string; environmentId: string | null }>;
  /** Start a turn on an idle thread or queue/steer a running one (`mode: "auto"`). */
  send(threadId: string, text: string): Promise<void>;
  getThread(threadId: string): Promise<ThreadInfo | null>;
  getEnvironment(environmentId: string): Promise<EnvironmentInfo | null>;
  setMetadata(threadId: string, set: Record<string, string | number | boolean | null>): Promise<void>;
  getMetadata(threadId: string): Promise<Record<string, unknown>>;
  /** Threads this plugin spawned that carry `spawnToken` in their metadata. */
  findSpawnedThread(spawnToken: string): Promise<string | null>;
  stop(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
  /** Remove a worker's managed worktree environment once no live thread uses it. */
  releaseEnvironment(environmentId: string): Promise<void>;
  /** Retry a rate-limited turn at `sendAt`. */
  retryTurn(threadId: string, turnRequestId: string, sendAt: number | null): Promise<void>;
  hostRunner(hostId: string): HostRunner;
  log(level: "info" | "warn" | "error", message: string): void;
  publish(channel: string, payload: unknown): void;
}
