// Adapts bb.sdk + bb.hosts to the engine's BbPort.
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { HostContract, hostSignals } from "./host/contract.ts";
import { BbHostRunner, type HostRunner } from "./host/runner.ts";
import type { BbPort, EnvironmentInfo, SpawnWorkerArgs, ThreadInfo } from "./ports.ts";

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b404\b|not[ _]found/iu.test(msg);
}

export function createBbPort(bb: BbPluginApi, client: ExperimentalHostClient<HostContract, typeof hostSignals>): BbPort {
  const runners = new Map<string, HostRunner>();
  return {
    async primaryHostId() {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
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
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
    },
    async getThread(threadId): Promise<ThreadInfo | null> {
      try {
        const t = await bb.sdk.threads.get({ threadId });
        return { id: t.id, status: t.status, archivedAt: t.archivedAt, deletedAt: t.deletedAt, environmentId: t.environmentId };
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
        r = new BbHostRunner(client, hostId);
        runners.set(hostId, r);
      }
      return r;
    },
    log(level, message) {
      bb.log[level](message);
    },
    publish(channel, payload) {
      bb.realtime.publish(channel, payload as never);
    },
  };
}
