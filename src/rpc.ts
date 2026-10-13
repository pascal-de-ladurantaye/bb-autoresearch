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
// docs/design.md). Approval (spec, calibration), harvest and archiving are
// deliberate steps: the call must carry `confirm: true`, which the page only
// sends from a dialog that states exactly what will happen. In-app and CLI
// approval are equivalent (BB can't tell an agent from a human on either
// path); both are audited the same way.
import { defineRpcContract, type BbPluginApi, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { EngineError, type Caller, type Engine } from "./engine.ts";
import { studyReport } from "./report.ts";
import { liveView, replayBundle, threadStudy } from "./live.ts";
import type { LiveView } from "./live-model.ts";
import type { ReplayBundle } from "./replay.ts";
import { attentionView, benchView, candidateDetail, candidatesView, findingsView, harvestView, ideasView, oracleView, overview, studySummary, threadBadge, type BenchView, type FindingsView, type HarvestView, type OracleView } from "./views.ts";

type Overview = ReturnType<typeof overview>;
type IdeaView = ReturnType<typeof ideasView>[number];
type CandidateView = ReturnType<typeof candidatesView>[number];
type CandidateDetail = NonNullable<Awaited<ReturnType<typeof candidateDetail>>>;
type Summary = ReturnType<typeof studySummary>;
type Badge = ReturnType<typeof threadBadge>;
type Attention = ReturnType<typeof attentionView>;

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
  /** The Live view of a study: worker lanes, candidate cards, bench, idea queue, feed. Read only. */
  "study.live": { input: z.object({ slug }).strict(), output: trusted<LiveView>() },
  /** Everything a replay of the study needs (events, bands, metadata); the app rebuilds the Live view at any time t. Read only. */
  "study.replay": { input: z.object({ slug }).strict(), output: trusted<ReplayBundle>() },
  /** Which study a thread belongs to (the study thread's Live panel resolves its study from the thread). */
  "thread.study": { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: z.object({ study: trusted<ReturnType<typeof threadStudy>>() }) },
  "study.findings": {
    input: z
      .object({
        slug,
        query: z.string().max(200).optional(),
        outcome: z.string().max(40).optional(),
        theme: z.string().max(60).optional(),
        verdict: z.enum(["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected", "none"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).max(100_000).optional(),
      })
      .strict(),
    output: trusted<FindingsView>(),
  },
  "study.oracle": { input: z.object({ slug }).strict(), output: trusted<OracleView>() },
  "study.bench": { input: z.object({ slug }).strict(), output: trusted<BenchView>() },
  /** The latest harvest, or an older one by id (read only). */
  "study.harvest": { input: z.object({ slug, harvestId: z.number().int().positive().optional() }).strict(), output: trusted<HarvestView>() },
  "study.report": { input: z.object({ slug }).strict(), output: z.object({ markdown: z.string() }) },
  /** Needs-you counts across studies (the nav panel badge). */
  "studies.attention": { input: z.null(), output: trusted<Attention>() },
  /** The human looked at the study's notices (they stop counting as new). */
  "study.notices.seen": { input: z.object({ slug }).strict(), output: ok },
  /** Human control: freeze best for harvest (no new workers, submissions closed). On a study already frozen it shows that freeze and changes nothing, unless `refreeze` (and best moved, or the freeze is from before 1.0). */
  "study.harvest.start": { input: z.object({ slug, refreeze: z.boolean().optional() }).strict(), output: ok },
  /** Human control (confirmed): approve the spec version the human reviewed. Draft: approve and calibrate; pending: apply, or recalibrate when the oracle changed. */
  "study.spec.approve": { input: z.object({ slug, version: z.number().int().positive(), confirm: z.boolean().optional() }).strict(), output: ok },
  /** Human control (confirmed): approve the finished calibration and start running. */
  "study.start": { input: z.object({ slug, confirm: z.boolean().optional() }).strict(), output: ok },
  /** Human control (confirmed): archive the study (stop workers, remove bench checkouts; refs are kept). */
  "study.archive": { input: z.object({ slug, confirm: z.boolean().optional(), archiveThread: z.boolean().optional() }).strict(), output: ok },
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

/** Deliberate steps need `confirm: true`; without it, say what the call would do. */
function requireConfirm(confirm: boolean | undefined, what: string): void {
  if (confirm !== true) throw new EngineError(`confirmation required: this ${what}. Call again with confirm: true (the Studies page asks in a dialog).`);
}

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
    "study.live": ({ slug }) => liveView(engine, engine.study(slug)),
    "study.replay": ({ slug }) => replayBundle(engine, engine.study(slug)),
    "thread.study": ({ threadId }) => ({ study: threadStudy(engine, threadId) }),
    "study.findings": ({ slug, ...q }) => findingsView(engine, engine.study(slug), q),
    "study.oracle": ({ slug }) => oracleView(engine, engine.study(slug)),
    "study.bench": ({ slug }) => benchView(engine, engine.study(slug)),
    "study.harvest": ({ slug, harvestId }) => harvestView(engine, engine.study(slug), harvestId),
    "study.report": ({ slug }) => {
      const s = engine.study(slug);
      return { markdown: studyReport(engine.ctx, s, store.spec(s), store.latestHarvest(s.id) ?? null) };
    },
    "studies.attention": () => attentionView(engine),
    "study.notices.seen": ({ slug }) => {
      engine.markNoticesSeen(slug);
      return { ok: true, message: "Notices marked as seen." };
    },
    "study.spec.approve": async ({ slug, version, confirm }, ctx) => {
      const caller = humanOnly(ctx);
      const s = engine.study(slug);
      requireConfirm(confirm, `approves spec v${version} of ${slug}${s.state === "draft" ? " and starts calibration (gates on the base commit, then A/A measurements)" : ""}`);
      const r = await engine.approveSpecVersion(slug, version, ACTOR);
      await engine.auditControl(slug, r.kind, caller, r.kind === "approve" ? `spec v${version} applied without recalibration` : `spec v${version} approved and calibration started`, { spec_version: version });
      return { ok: true, message: r.text };
    },
    "study.start": async ({ slug, confirm }, ctx) => {
      const caller = humanOnly(ctx);
      const s = engine.study(slug);
      if (!(s.state === "calibrating" && s.calibration_status === "ready")) throw new EngineError(`${slug} has no finished calibration to approve (state ${s.state}, calibration ${s.calibration_status ?? "none"})`);
      requireConfirm(confirm, `approves the calibration of ${slug} and starts running: workers spawn and spend tokens and bench time`);
      const message = await engine.start(slug, ACTOR);
      await engine.auditControl(slug, "start", caller, "calibration approved / study started");
      return { ok: true, message };
    },
    "study.archive": async ({ slug, confirm, archiveThread }, ctx) => {
      const caller = humanOnly(ctx);
      requireConfirm(confirm, `archives ${slug}: live workers stop, their threads are archived, bench checkouts and clones are removed${archiveThread ? ", and the study thread is archived" : ""} (git refs and the best branch are kept)`);
      await engine.auditControl(slug, "archive", caller, `study archived${archiveThread ? " with its study thread" : ""}`, { archiveThread: Boolean(archiveThread) });
      return { ok: true, message: await engine.archiveStudy(slug, ACTOR, { archiveThread: Boolean(archiveThread) }) };
    },
    "study.harvest.start": async ({ slug, refreeze }, ctx) => {
      const caller = humanOnly(ctx);
      const s0 = engine.study(slug);
      const before = s0.state === "harvesting" && refreeze ? store.latestHarvest(s0.id) : undefined;
      const r = engine.startHarvest(slug, ACTOR, { refreeze: Boolean(refreeze) });
      const refrozen = r.started && before ? before : null;
      if (r.started) await engine.auditControl(slug, "harvest", caller, `harvest h${r.harvest.seq} started${refrozen ? ` (refreeze after h${refrozen.seq})` : ""}: best freezes for an agent to harvest`, { harvest: r.harvest.id, ...(refrozen ? { refreeze: refrozen.id } : {}) });
      return { ok: true, message: r.text };
    },
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
