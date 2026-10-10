// The engine's view of BB. server.ts adapts bb.sdk to this; tests fake it.
import type { HostRunner } from "./host/runner.ts";

export interface ThreadInfo {
  id: string;
  status: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  archivedAt: number | null;
  deletedAt: number | null;
  environmentId: string | null;
  /** The agent provider running the thread (when BB reports it). */
  providerId?: string | null;
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

export interface HostInfo {
  id: string;
  name: string;
  status: "connected" | "disconnected";
}

/** One provider's subscription/usage windows (bb.sdk.system.usageLimits). */
export interface ProviderUsage {
  providerId: string;
  status: "ok" | "not_installed" | "unauthenticated" | "expired" | "error";
  windows: Array<{ label: string; usedPercent: number; resetsAt: number | null }>;
}

/** A plugin message: a one-line summary for the human and the full detail for the agent (sent agent-only). */
export interface PortMessage {
  summary: string;
  detail: string;
}

export interface BbPort {
  primaryHostId(): Promise<string | null>;
  /** Enrolled BB machines (bench host names and ids are resolved against these). */
  listHosts(): Promise<HostInfo[]>;
  /** Connection state of one machine; "unknown" when BB can't say. */
  hostStatus(hostId: string): Promise<"connected" | "disconnected" | "unknown">;
  /** The project's checkout on `hostId`, if it has one. */
  projectCheckout(projectId: string, hostId: string): Promise<string | null>;
  ensureSection(name: string): Promise<string | null>;
  spawnWorker(args: SpawnWorkerArgs): Promise<{ threadId: string; environmentId: string | null }>;
  /** Start a turn on an idle thread or queue/steer a running one (`mode: "auto"`). */
  send(threadId: string, text: string | PortMessage): Promise<void>;
  /** Steer text into a turn that is running now. Never starts a turn; throws if none is running. */
  steer(threadId: string, text: string): Promise<void>;
  /** Flag a thread for the human without starting a turn. */
  markUnread(threadId: string): Promise<void>;
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
  /** Total tokens a thread has reported (latest thread/tokenUsage/updated), or null when it reported none. */
  threadTokens(threadId: string): Promise<number | null>;
  /** Provider usage windows; empty when BB can't say. */
  usageLimits(providerId?: string): Promise<ProviderUsage[]>;
  /** This plugin's id (the package name minus `bb-plugin-`), used in app links. */
  pluginId(): string;
  /** The configured public app URL (for links in PR bodies and reports), if any. */
  appUrl(): string | null;
  log(level: "info" | "warn" | "error", message: string): void;
  publish(channel: string, payload: unknown): void;
}
