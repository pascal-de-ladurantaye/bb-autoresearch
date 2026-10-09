// bb.rpc: the study page's data plane. Reads return view models from
// views.ts; writes are human controls (pause, resume, concurrency, the idea
// board) and are refused when another plugin calls them. The frontend
// refetches on the "study-changed" realtime signal.
//
// Trust: BB reports every non-plugin caller (the app, the `bb` CLI, agents)
// as "client", so an agent can reach these through `bb plugin rpc call`.
// Writes are therefore bounded to the approved spec (concurrency can only go
// down, priorities are clamped), and every write is audited as an event and
// a notice with whatever caller information exists (see the threat model in
// docs/design.md). Oracle and spec approval are not exposed over RPC at all.
import { defineRpcContract, type BbPluginApi, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { EngineError, type Caller, type Engine } from "./engine.ts";
import { candidateDetail, candidatesView, ideasView, overview, studySummary, threadBadge } from "./views.ts";

type Overview = ReturnType<typeof overview>;
type IdeaView = ReturnType<typeof ideasView>[number];
type CandidateView = ReturnType<typeof candidatesView>[number];
type CandidateDetail = NonNullable<Awaited<ReturnType<typeof candidateDetail>>>;
type Summary = ReturnType<typeof studySummary>;
type Badge = ReturnType<typeof threadBadge>;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/u);
const ok = z.object({ ok: z.boolean(), message: z.string() }).strict();

/** View models are built by plugin code; the schema only carries their type. */
function trusted<T>() {
  return z.custom<T>(() => true);
}

export const rpcContract = defineRpcContract({
  "studies.list": { input: z.null(), output: z.object({ studies: z.array(trusted<Summary>()) }) },
  "study.overview": { input: z.object({ slug }).strict(), output: trusted<Overview>() },
  "study.ideas": { input: z.object({ slug }).strict(), output: z.object({ ideas: z.array(trusted<IdeaView>()) }) },
  "study.candidates": {
    input: z
      .object({
        slug,
        verdict: z.enum(["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"]).optional(),
        stage: z.enum(["submitted", "gating", "queued", "measuring", "confirming", "promoting", "decided"]).optional(),
        ideaId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    output: z.object({ candidates: z.array(trusted<CandidateView>()) }),
  },
  "study.candidate": { input: z.object({ slug, n: z.number().int().positive() }).strict(), output: z.object({ candidate: trusted<CandidateDetail>().nullable() }) },
  "thread.badge": { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: z.object({ badge: trusted<Badge>() }) },
  "study.pause": { input: z.object({ slug }).strict(), output: ok },
  "study.resume": { input: z.object({ slug }).strict(), output: ok },
  "study.concurrency": { input: z.object({ slug, maxWorkers: z.number().int().min(1).max(64).nullable() }).strict(), output: ok },
  "ideas.add": {
    input: z
      .object({
        slug,
        title: z.string().trim().min(3).max(200),
        rationale: z.string().max(2000).optional(),
        theme: z.string().max(60).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        pinned: z.boolean().optional(),
        startRef: z.string().max(200).optional(),
        variationOf: z.number().int().positive().optional(),
      })
      .strict(),
    output: ok,
  },
  "ideas.update": {
    input: z.object({ slug, id: z.number().int().positive(), priority: z.number().int().min(-100).max(100).optional(), pinned: z.boolean().optional() }).strict(),
    output: ok,
  },
  "ideas.reorder": { input: z.object({ slug, ids: z.array(z.number().int().positive()).max(200) }).strict(), output: ok },
  "ideas.veto": { input: z.object({ slug, id: z.number().int().positive(), reason: z.string().max(500).optional() }).strict(), output: ok },
});
export type RpcContract = typeof rpcContract;

const ACTOR = "human:ui";

function humanOnly(ctx: ExperimentalPluginRpcHandlerContext | undefined): Caller {
  if (ctx?.experimental_caller.kind === "plugin") throw new EngineError("study controls are for humans; plugins may only read");
  return { via: "rpc" };
}

export function registerRpc(bb: BbPluginApi, engine: Engine): void {
  const { store } = engine.ctx;
  bb.rpc.register(rpcContract, {
    "studies.list": () => ({ studies: store.studies().slice(0, 200).map((s) => studySummary(engine, s)) }),
    "study.overview": ({ slug }) => overview(engine, engine.study(slug)),
    "study.ideas": ({ slug }) => ({ ideas: ideasView(engine, engine.study(slug)) }),
    "study.candidates": ({ slug, ...f }) => ({ candidates: candidatesView(engine, engine.study(slug), f) }),
    "study.candidate": async ({ slug, n }) => ({ candidate: await candidateDetail(engine, engine.study(slug), n) }),
    "thread.badge": ({ threadId }) => ({ badge: threadBadge(engine, threadId) }),
    "study.pause": async ({ slug }, ctx) => {
      const caller = humanOnly(ctx);
      const message = engine.pause(slug, ACTOR);
      await engine.auditControl(slug, "pause", caller, "study paused");
      return { ok: true, message };
    },
    "study.resume": async ({ slug }, ctx) => {
      const caller = humanOnly(ctx);
      const before = engine.study(slug).pause_reason;
      const message = engine.resume(slug, ACTOR);
      await engine.auditControl(slug, "resume", caller, `study resumed${before ? ` (was paused: ${before.slice(0, 200)})` : ""}`);
      return { ok: true, message };
    },
    "study.concurrency": async ({ slug, maxWorkers }, ctx) => {
      const caller = humanOnly(ctx);
      const message = engine.setConcurrency(slug, maxWorkers, ACTOR);
      const now = engine.maxWorkers(engine.study(slug));
      await engine.auditControl(slug, "concurrency", caller, `max workers ${maxWorkers === null ? "back to the spec" : `set to ${now}${now !== maxWorkers ? ` (requested ${maxWorkers}, clamped)` : ""}`}`, { requested: maxWorkers, applied: now });
      return { ok: true, message };
    },
    "ideas.add": async ({ slug, ...i }, ctx) => {
      const caller = humanOnly(ctx);
      const idea = engine.addIdea(slug, { title: i.title, rationale: i.rationale, theme: i.theme, priority: i.priority, pinned: i.pinned ?? true, startRef: i.startRef ?? null, variationOf: i.variationOf ?? null }, ACTOR, "human");
      await engine.auditControl(slug, "idea_added", caller, `idea #${idea.id} added${idea.pinned ? " (pinned)" : ""}: ${idea.title.slice(0, 120)}`, { idea: idea.id });
      return { ok: true, message: `Idea #${idea.id} queued${idea.pinned ? " (pinned)" : ""}.` };
    },
    "ideas.update": async ({ slug, id, priority, pinned }, ctx) => {
      const caller = humanOnly(ctx);
      const idea = engine.updateIdea(slug, id, { ...(priority !== undefined ? { priority } : {}), ...(pinned !== undefined ? { pinned } : {}) }, ACTOR);
      await engine.auditControl(slug, "idea_updated", caller, `idea #${idea.id}: priority ${idea.priority}${idea.pinned ? ", pinned" : ""}`, { idea: idea.id, priority: idea.priority, pinned: idea.pinned === 1 });
      return { ok: true, message: `Idea #${idea.id}: priority ${idea.priority}${idea.pinned ? ", pinned" : ""}.` };
    },
    "ideas.reorder": async ({ slug, ids }, ctx) => {
      const caller = humanOnly(ctx);
      engine.reorderIdeas(slug, ids, ACTOR);
      await engine.auditControl(slug, "ideas_reordered", caller, `${ids.length} idea(s) reordered`, { ids: ids.slice(0, 50) });
      return { ok: true, message: `Reordered ${ids.length} idea(s).` };
    },
    "ideas.veto": async ({ slug, id, reason }, ctx) => {
      const caller = humanOnly(ctx);
      engine.vetoIdea(slug, id, reason ?? "", ACTOR);
      await engine.auditControl(slug, "idea_vetoed", caller, `idea #${id} vetoed${reason ? `: ${reason.slice(0, 200)}` : ""}`, { idea: id });
      return { ok: true, message: `Idea #${id} vetoed.` };
    },
  });
}
