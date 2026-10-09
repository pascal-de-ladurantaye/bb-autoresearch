// Agent tools, gated by role twice: bb.agents.configure selects them from
// thread metadata + the threads table, and every call re-checks the role
// against the plugin's own threads table (metadata can be forged).
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Engine, Role } from "./engine.ts";
import { errText } from "./pipeline.ts";
import { clip } from "./prompts.ts";

// Every tool carries the `study_` prefix so it can't collide with another plugin's tools.
export const WORKER_TOOLS = ["study_submit_candidate", "study_record_finding", "study_propose_idea", "study_request_profile", "study_finish"] as const;
export const STRATEGIST_TOOLS = ["study_queue_ideas", "study_retire_idea", "study_update_dossier", "study_search_findings", "study_propose_harvest"] as const;
export const CREATOR_TOOLS = ["study_propose"] as const;
export const SKILLS = { create: "study-create", usage: "autoresearch" } as const;

const MAX_OUTPUT = 12_000;

export function toolsForRole(role: Role | null): string[] {
  switch (role) {
    case "worker":
      return [...WORKER_TOOLS];
    case "strategist":
      return [...STRATEGIST_TOOLS, ...CREATOR_TOOLS];
    case "creator":
      return [...CREATOR_TOOLS];
    default:
      return [];
  }
}

export function skillsForRole(role: Role | null): string[] {
  switch (role) {
    case "strategist":
      return [SKILLS.usage];
    case "creator":
      return [SKILLS.create, SKILLS.usage];
    default:
      return [];
  }
}

async function run(fn: () => Promise<string> | string): Promise<PluginAgentToolResult> {
  try {
    return clip(await fn(), MAX_OUTPUT);
  } catch (e) {
    return { content: [{ type: "text", text: clip(errText(e), 4000) }], isError: true };
  }
}

export function registerTools(bb: BbPluginApi, engine: Engine): void {
  // ---- worker ----
  bb.agents.registerTool({
    name: "study_submit_candidate",
    description:
      "Submit your worktree as a candidate. The plugin commits it, checks scope, runs gates and measures it against best. Returns a ticket; the verdict arrives later as a message. End your turn after submitting.",
    presentation: { label: { pending: "Submitting candidate", completed: "Submitted candidate" } },
    parameters: z.object({ summary: z.string().min(10).max(4000).describe("What you changed and why you expect it to help.") }),
    execute: ({ summary }, ctx) => run(() => engine.submit(ctx.threadId, summary)),
  });
  bb.agents.registerTool({
    name: "study_record_finding",
    description: "Record what you learned: outcome, why it won or lost, when the idea would be worth revisiting, and evidence. Required before study_finish.",
    presentation: { label: { pending: "Recording finding", completed: "Recorded finding" } },
    parameters: z.object({
      outcome: z.enum(["improved", "no_effect", "regressed", "broke_gate", "blocked", "not_attempted"]),
      learned: z.string().min(10).max(4000),
      revisit_if: z.string().max(1000).optional(),
      evidence: z.string().max(2000).optional(),
      candidate: z.number().int().positive().optional().describe("Candidate number (c/N) the finding is about; defaults to your latest."),
    }),
    execute: (args, ctx) => run(() => engine.recordFinding(ctx.threadId, args)),
  });
  bb.agents.registerTool({
    name: "study_propose_idea",
    description: "Add an idea you noticed but won't pursue. The strategist triages it.",
    parameters: z.object({ title: z.string().min(5).max(200), rationale: z.string().min(10).max(2000), theme: z.string().max(60).optional() }),
    execute: (args, ctx) => run(() => engine.proposeIdea(ctx.threadId, args)),
  });
  bb.agents.registerTool({
    name: "study_request_profile",
    description: "Profile best or your latest candidate on the bench host with the study's profile command. Uses bench time and counts against the budget.",
    presentation: { label: { pending: "Profiling on the bench host", completed: "Profiled on the bench host" } },
    parameters: z.object({ target: z.enum(["best", "candidate"]) }),
    execute: ({ target }, ctx) => run(() => engine.requestProfile(ctx.threadId, target)),
  });
  bb.agents.registerTool({
    name: "study_finish",
    description: "End your assignment. Refuses until study_record_finding has been called. The plugin then archives this thread and removes its worktree.",
    parameters: z.object({}),
    execute: (_args, ctx) => run(() => engine.finish(ctx.threadId)),
  });

  // ---- creator ----
  bb.agents.registerTool({
    name: "study_propose",
    description:
      "Submit an autoresearch study spec (TOML) for validation. Creates the study in Draft (or revises its spec) and binds this thread as the study thread. The human approves with `bb study calibrate`.",
    presentation: { label: { pending: "Proposing study spec", completed: "Proposed study spec" } },
    parameters: z.object({ spec_toml: z.string().min(50).max(64 * 1024).describe("The full study spec in TOML; see the study-create skill.") }),
    execute: ({ spec_toml }, ctx) =>
      run(async () => {
        await engine.requireRole(ctx.threadId, "creator");
        return await engine.proposeStudy(ctx.threadId, ctx.projectId, spec_toml);
      }),
  });

  // ---- strategist ----
  bb.agents.registerTool({
    name: "study_queue_ideas",
    description: "Add ideas to the study's queue (each with rationale, theme, optional priority, starting candidate, and the idea it varies) and/or reprioritize queued ideas. Ideas repeating a lost idea are skipped unless marked as a variation.",
    presentation: { label: { pending: "Queueing ideas", completed: "Queued ideas" } },
    parameters: z.object({
      ideas: z
        .array(
          z.object({
            title: z.string().min(5).max(200),
            rationale: z.string().min(10).max(2000),
            theme: z.string().min(1).max(60),
            priority: z.number().min(-100).max(100).optional(),
            start_ref: z.string().max(200).optional().describe('Start from a candidate, e.g. "c/12" (a near miss to build on).'),
            variation_of: z.number().int().positive().optional().describe("Id of an earlier idea this varies. Required to retry a direction that already lost."),
          }),
        )
        .max(20)
        .default([]),
      reorder: z.array(z.object({ id: z.number().int(), priority: z.number().min(-100).max(100) })).max(50).optional(),
    }),
    execute: (args, ctx) => run(() => engine.queueIdeas(ctx.threadId, args)),
  });
  bb.agents.registerTool({
    name: "study_retire_idea",
    description: "Close a queued idea or direction, with a reason.",
    parameters: z.object({ id: z.number().int().positive(), reason: z.string().min(5).max(500) }),
    execute: ({ id, reason }, ctx) => run(() => engine.retireIdea(ctx.threadId, id, reason)),
  });
  bb.agents.registerTool({
    name: "study_update_dossier",
    description: "Replace the study dossier: your running map of the codebase (hot paths, what's been learned, dead ends). Workers get it in their brief.",
    parameters: z.object({ text: z.string().min(20).max(20_000) }),
    execute: ({ text }, ctx) => run(() => engine.updateDossier(ctx.threadId, text)),
  });
  bb.agents.registerTool({
    name: "study_search_findings",
    description: "Search findings and candidates by text, theme, or verdict.",
    parameters: z.object({
      query: z.string().max(200).optional(),
      theme: z.string().max(60).optional(),
      verdict: z.enum(["win", "lose", "inconclusive", "gate_failed", "conflict", "rejected"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    execute: (args, ctx) => run(() => engine.searchFindings(ctx.threadId, args)),
  });
  bb.agents.registerTool({
    name: "study_propose_harvest",
    description: "Propose how to group promotions into reviewable changesets. Recorded now; ablation and PRs arrive in M3.",
    parameters: z.object({
      groups: z.array(z.object({ title: z.string().min(3).max(200), candidates: z.array(z.number().int().positive()).min(1), rationale: z.string().max(2000) })).min(1).max(50),
    }),
    execute: ({ groups }, ctx) => run(() => engine.proposeHarvest(ctx.threadId, groups)),
  });

  bb.agents.configure((context) => {
    if (context.origin.kind === "fork" && context.origin.pluginId === "side-chat") return { tools: [], skills: [] };
    let role: Role | null = null;
    try {
      role = engine.roleForConfigure(context.thread.id, context.pluginMetadata);
    } catch {
      role = null;
    }
    const instructions =
      role === "worker"
        ? "You are an autoresearch worker. Follow the brief in your first message: one idea, study_submit_candidate then end your turn, study_record_finding before study_finish."
        : role === "strategist"
          ? `This is the study thread for autoresearch study ${JSON.stringify(String(context.pluginMetadata.study ?? ""))}. Plugin messages starting with [autoresearch] are strategist rounds: maintain ideas and the dossier with your tools; you never edit code or decide verdicts.`
          : undefined;
    return { tools: toolsForRole(role), skills: skillsForRole(role), ...(instructions ? { instructions } : {}) };
  });
}
