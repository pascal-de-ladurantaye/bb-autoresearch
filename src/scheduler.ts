// Scheduling policy as pure functions over plain data, so M1 can change W
// and the diversity rules without touching the engine.
import type { CandidateRow, IdeaRow, ThreadRow } from "./db/store.ts";

export interface WorkerTargetInput {
  maxWorkers: number;
  /** Mean seconds a worker thinks before submitting; null until learned. */
  tThink: number | null;
  /** Mean bench seconds per evaluation; null until learned. */
  tEval: number | null;
  /** Hard ceiling for this milestone (M0: 1). */
  ceiling: number;
}

/** W = min(max_workers, ceil(T_think / T_eval) + 1), capped by the milestone ceiling. */
export function targetWorkers(input: WorkerTargetInput): number {
  let w = input.maxWorkers;
  if (input.tThink !== null && input.tEval !== null && input.tEval > 0) {
    w = Math.min(w, Math.ceil(input.tThink / input.tEval) + 1);
  }
  return Math.max(1, Math.min(w, input.ceiling));
}

/**
 * Next idea to assign: pinned first, then priority, then age; at most
 * ceil(W/2) running workers per theme; ideas whose lineage already lost are
 * skipped unless re-queued as a variation (a new idea row).
 */
export function pickIdea(queued: readonly IdeaRow[], running: readonly IdeaRow[], w: number): IdeaRow | null {
  const perTheme = Math.ceil(w / 2);
  const counts = new Map<string, number>();
  for (const r of running) if (r.theme) counts.set(r.theme, (counts.get(r.theme) ?? 0) + 1);
  const sorted = [...queued].sort((a, b) => b.pinned - a.pinned || b.priority - a.priority || a.id - b.id);
  for (const idea of sorted) {
    if (idea.theme && (counts.get(idea.theme) ?? 0) >= perTheme && w > 1) continue;
    return idea;
  }
  return null;
}

export interface BudgetState {
  candidates: number;
  maxCandidates: number;
  benchSeconds: number;
  maxBenchHours: number;
  deadline: string | undefined;
  now: number;
}

export function budgetExhausted(b: BudgetState): string | null {
  if (b.candidates >= b.maxCandidates) return `max_candidates reached (${b.candidates}/${b.maxCandidates})`;
  if (b.benchSeconds >= b.maxBenchHours * 3600) return `max_bench_hours reached (${(b.benchSeconds / 3600).toFixed(2)}h)`;
  if (b.deadline) {
    const end = Date.parse(b.deadline.length === 10 ? `${b.deadline}T23:59:59` : b.deadline);
    if (Number.isFinite(end) && b.now > end) return `deadline ${b.deadline} passed`;
  }
  return null;
}

export type RoundTrigger = "verdicts" | "queue_low" | "stall" | "human" | "start";

export interface RoundInput {
  roundInFlight: boolean;
  verdictsSinceRound: number;
  k: number;
  readyIdeas: number;
  w: number;
  /** Decided candidates, most recent last. */
  recentVerdicts: ReadonlyArray<Pick<CandidateRow, "verdict">>;
  stallAfter: number;
  /** Total verdict count when the last stall round was sent. */
  stallSignaledAt: number;
  totalVerdicts: number;
  rounds: number;
}

/** Which strategist round to start now, if any. Only one round runs at a time. */
export function roundTrigger(input: RoundInput): RoundTrigger | null {
  if (input.roundInFlight) return null;
  if (input.rounds === 0) return "start";
  const tail = input.recentVerdicts.slice(-input.stallAfter);
  const stalled =
    tail.length >= input.stallAfter &&
    tail.every((c) => c.verdict !== "win") &&
    input.totalVerdicts - input.stallSignaledAt >= input.stallAfter;
  if (stalled) return "stall";
  if (input.verdictsSinceRound >= input.k) return "verdicts";
  // Queue-low only re-fires after something changed, so a strategist that
  // adds nothing doesn't get re-prompted in a loop.
  if (input.readyIdeas < input.w && input.verdictsSinceRound > 0) return "queue_low";
  return null;
}

export type IdleAction = { kind: "none" } | { kind: "nudge" } | { kind: "abandon" };

/**
 * One nudge after `nudgeMs` idle. Once nudged (cleared on the next
 * submission), a worker idle for another `abandonMs - nudgeMs` is abandoned.
 * Idle while waiting for a verdict doesn't count.
 */
export function idleAction(
  worker: Pick<ThreadRow, "state" | "last_idle_at" | "nudged_at">,
  opts: { now: number; awaitingVerdict: boolean; threadIdle: boolean; nudgeMs: number; abandonMs: number },
): IdleAction {
  if (worker.state !== "active" || !opts.threadIdle || opts.awaitingVerdict || worker.last_idle_at === null) return { kind: "none" };
  const idleFor = opts.now - worker.last_idle_at;
  if (worker.nudged_at !== null) {
    const since = opts.now - Math.max(worker.last_idle_at, worker.nudged_at);
    return since >= opts.abandonMs - opts.nudgeMs ? { kind: "abandon" } : { kind: "none" };
  }
  return idleFor >= opts.nudgeMs ? { kind: "nudge" } : { kind: "none" };
}
