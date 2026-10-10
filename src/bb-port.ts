// Adapts bb.sdk + bb.hosts to the engine's BbPort.
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { HostContract, hostSignals } from "./host/contract.ts";
import { BbHostRunner, type HostRunner, type ProgressBus } from "./host/runner.ts";
import type { BbPort, EnvironmentInfo, SpawnWorkerArgs, ThreadInfo } from "./ports.ts";

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b404\b|not[ _]found/iu.test(msg);
}

export function createBbPort(bb: BbPluginApi, client: ExperimentalHostClient<HostContract, typeof hostSignals>, progress?: ProgressBus): BbPort {
  const runners = new Map<string, HostRunner>();
  return {
    async primaryHostId() {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    },
    async listHosts() {
      const hosts = await bb.sdk.hosts.list();
      return hosts.filter((h) => h.lifecycle.phase === "active").map((h) => ({ id: h.id, name: h.name, status: h.status }));
    },
    async hostStatus(hostId) {
      try {
        const h = await bb.sdk.hosts.get({ hostId });
        if (h.lifecycle.phase !== "active") return "disconnected";
        return h.status;
      } catch (e) {
        if (isNotFound(e)) return "disconnected";
        return "unknown";
      }
    },
    async projectCheckout(projectId, hostId) {
      const project = await bb.sdk.projects.get({ projectId });
      const sources = project.sources.filter((s) => s.hostId === hostId);
      return (sources.find((s) => s.isDefault) ?? sources[0])?.path ?? null;
    },
    async ensureSection(name) {
      const sections = await bb.sdk.threadSections.list();
      const found = sections.find((s) => s.name === name);
      if (found) return found.id;
      return (await bb.sdk.threadSections.create({ name })).id;
    },
    async spawnWorker(args: SpawnWorkerArgs) {
      const thread = await bb.sdk.threads.spawn({
        projectId: args.projectId,
        environment: { type: "host", hostId: args.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: args.baseBranch } } },
        prompt: args.prompt,
        title: args.title,
        visibility: "hidden",
        ...(args.sectionId ? { sectionId: args.sectionId } : {}),
        pluginMetadata: { ...args.metadata },
        ...(args.providerId ? { providerId: args.providerId } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      });
      return { threadId: thread.id, environmentId: thread.environmentId };
    },
    async send(threadId, text) {
      // A structured message: the human sees the one-line summary in the
      // timeline; the detail is an agent-only block (still in the agent's context).
      const input =
        typeof text === "string"
          ? [{ type: "text" as const, text, mentions: [] }]
          : [{ type: "text" as const, text: text.summary, mentions: [] }, ...(text.detail ? [{ type: "text" as const, text: text.detail, mentions: [], visibility: "agent-only" as const }] : [])];
      await bb.sdk.threads.send({ threadId, mode: "auto", input });
    },
    async steer(threadId, text) {
      await bb.sdk.threads.send({ threadId, mode: "steer", input: [{ type: "text", text, mentions: [] }] });
    },
    async markUnread(threadId) {
      await bb.sdk.threads.markUnread({ threadId });
    },
    async getThread(threadId): Promise<ThreadInfo | null> {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        return { id: t.id, status: t.status, archivedAt: t.archivedAt, deletedAt: t.deletedAt, environmentId: t.environmentId, providerId: t.providerId };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async getEnvironment(environmentId): Promise<EnvironmentInfo | null> {
      try {
        const env = await bb.sdk.environments.get({ environmentId });
        return { id: env.id, hostId: env.hostId, path: env.path, branchName: env.branchName };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async setMetadata(threadId, set) {
      await bb.sdk.threads.updatePluginMetadata({ threadId, set });
    },
    async getMetadata(threadId) {
      return (await bb.sdk.threads.getPluginMetadata({ threadId })) as Record<string, unknown>;
    },
    async findSpawnedThread(spawnToken) {
      const threads = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, limit: 200 });
      for (const t of threads) {
        const meta = (await bb.sdk.threads.getPluginMetadata({ threadId: t.id }).catch(() => ({}))) as Record<string, unknown>;
        if (meta.spawnToken === spawnToken) return t.id;
      }
      return null;
    },
    async stop(threadId) {
      await bb.sdk.threads.stop({ threadId });
    },
    async archive(threadId) {
      await bb.sdk.threads.archive({ threadId });
    },
    async releaseEnvironment(environmentId) {
      // Archiving the last thread starts core's retirement of the managed
      // worktree after its grace period; delete now when nothing else uses it.
      const live = await bb.sdk.threads.list({ environmentId, includeHidden: true, archived: false, limit: 5 });
      if (live.length === 0) await bb.sdk.environments.delete({ environmentId });
    },
    async retryTurn(threadId, turnRequestId, sendAt) {
      await bb.sdk.threads.retry({ threadId, turnRequestId, ...(sendAt === null ? {} : { sendAt }), reason: "Rate limited (autoresearch retry)" });
    },
    hostRunner(hostId) {
      let r = runners.get(hostId);
      if (!r) {
        r = new BbHostRunner(client, hostId, progress);
        runners.set(hostId, r);
      }
      return r;
    },
    async threadTokens(threadId) {
      // Per-thread usage is readable from the thread's event log: the latest
      // thread/tokenUsage/updated carries cumulative totals. Providers that
      // never report usage leave this null.
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" });
      const row = rows[0] as { data?: { tokenUsage?: { total?: { totalTokens?: number } } } } | undefined;
      const total = row?.data?.tokenUsage?.total?.totalTokens;
      return typeof total === "number" && Number.isFinite(total) ? total : null;
    },
    async threadActivity(threadId, afterSeq, limit = 100) {
      const rows = await bb.sdk.threads.events.list({ threadId, afterSeq: String(afterSeq), types: ["item/started"], order: "asc", limit: String(Math.min(100, limit)) });
      let seq = afterSeq;
      const items = [];
      for (const r of rows) {
        seq = Math.max(seq, r.seq);
        const item = (r.data as { item?: { type?: string; command?: unknown; tool?: unknown } }).item;
        if (!item?.type) continue;
        // Never message text: the kind, a command, a tool name, and the file paths the item names.
        const args = (item as { arguments?: unknown }).arguments;
        const argCommand = args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string" ? ((args as { command: string }).command) : null;
        const command = typeof item.command === "string" ? item.command : item.type === "toolCall" ? argCommand : null;
        items.push({ seq: r.seq, at: r.createdAt, kind: item.type, command: command ? command.slice(0, 300) : null, tool: typeof item.tool === "string" ? item.tool.slice(0, 80) : null, paths: itemPaths(item) });
      }
      return { seq, items };
    },
    async usageLimits(providerId) {
      const res = await bb.sdk.system.usageLimits(providerId ? { providerId } : {});
      return Object.entries(res).map(([id, u]) => ({
        providerId: id,
        status: u.status,
        windows:
          u.status === "ok"
            ? u.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ? Date.parse(w.resetsAt) || null : null }))
            : [],
      }));
    },
    pluginId() {
      return bb.pluginId;
    },
    appUrl() {
      return bb.server.experimental_appUrl ?? null;
    },
    log(level, message) {
      bb.log[level](message);
    },
    publish(channel, payload) {
      bb.realtime.publish(channel, payload as never);
    },
  };
}

/** File paths a thread item names (at most 5, each clipped), for the worker's "last action" label. */
export function itemPaths(item: unknown): string[] | null {
  if (!item || typeof item !== "object") return null;
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim() && out.length < 5) out.push(v.slice(0, 200));
  };
  const it = item as { changes?: unknown; path?: unknown; arguments?: unknown };
  if (Array.isArray(it.changes)) for (const c of it.changes) add((c as { path?: unknown } | null)?.path);
  add(it.path);
  const a = it.arguments;
  if (a && typeof a === "object") {
    const r = a as Record<string, unknown>;
    for (const k of ["path", "file_path", "filePath", "file", "filename"]) add(r[k]);
    for (const k of ["paths", "files"]) if (Array.isArray(r[k])) for (const p of r[k] as unknown[]) add(p);
  }
  return out.length ? out : null;
}
