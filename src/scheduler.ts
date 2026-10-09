// Scheduling policy as pure functions over plain data: how many workers,
// when to spawn (backpressure), which idea next (diversity, no repeats),
// budgets, strategist triggers, and idle handling.
import type { CandidateRow, IdeaRow, ThreadRow } from "./db/store.ts";

export interface WorkerTargetInput {
  maxWorkers: number;
  /** Mean seconds a worker thinks before submitting; null until learned. */
  tThink: number | null;
  /** Mean bench seconds per evaluation; null until learned. */
  tEval: number | null;
  /** Hard ceiling (EngineConfig.workerCeiling). */
  ceiling: number;
}

/** W = min(max_workers, ceil(T_think / T_eval) + 1), capped by the configured ceiling. */
export function targetWorkers(input: WorkerTargetInput): number {
  let w = input.maxWorkers;
  if (input.tThink !== null && input.tEval !== null && input.tEval > 0) {
    w = Math.min(w, Math.ceil(input.tThink / input.tEval) + 1);
  }
  return Math.max(1, Math.min(w, input.ceiling));
}

export interface ThinkSample {
  /** When the worker could start on this submission: its spawn, or the delivery of its previous verdict. */
  startedAt: number;
  submittedAt: number;
}

/** Mean think seconds over recent submissions; null until there is one. */
export function meanThinkSeconds(samples: readonly ThinkSample[]): number | null {
  const s = samples.map((x) => (x.submittedAt - x.startedAt) / 1000).filter((v) => Number.isFinite(v) && v >= 0);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

export interface SpawnInput {
  /** Live workers, including ones still spawning or finishing. */
  live: number;
  w: number;
  /** Candidates gating, queued, or on the bench. */
  benchDepth: number;
  candidates: number;
  maxCandidates: number;
}

/**
 * How many workers may start now. Backpressure: none while the bench queue
 * is at least W deep. Budget: each live worker reserves one submission, so
 * new workers only start while the candidate budget can still take one more.
 */
export function spawnSlots(i: SpawnInput): number {
  if (i.benchDepth >= i.w) return 0;
  const free = i.w - i.live;
  const room = i.maxCandidates - i.candidates - i.live;
  return Math.max(0, Math.min(free, room));
}

/** Title key for the no-repeat rule. */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export interface PickOptions {
  /** Title keys of ideas that already lost. */
  lostTitles?: ReadonlySet<string>;
}

/** Why an idea can't be assigned under the no-repeat rule (null when it can). */
export function repeatsLostIdea(idea: Pick<IdeaRow, "title" | "source" | "variation_of">, lostTitles: ReadonlySet<string>): boolean {
  return idea.source !== "human" && idea.variation_of === null && lostTitles.has(titleKey(idea.title));
}

/**
 * Next idea to assign: pinned first, then priority, then age.
 * - Diversity: at most ceil(W/2) running workers per theme.
 * - No repeats: a non-human idea whose title repeats a lost idea is skipped
 *   unless it is an explicit variation (`variation_of`). Lost ideas themselves
 *   never return to the queue.
 */
export function pickIdea(queued: readonly IdeaRow[], running: readonly IdeaRow[], w: number, opts: PickOptions = {}): IdeaRow | null {
  const perTheme = Math.ceil(w / 2);
  const counts = new Map<string, number>();
  for (const r of running) if (r.theme) counts.set(r.theme, (counts.get(r.theme) ?? 0) + 1);
  const lost = opts.lostTitles ?? new Set<string>();
  const sorted = [...queued].sort((a, b) => b.pinned - a.pinned || b.priority - a.priority || a.id - b.id);
  for (const idea of sorted) {
    if (idea.status !== "queued") continue;
    if (idea.theme && (counts.get(idea.theme) ?? 0) >= perTheme) continue;
    if (repeatsLostIdea(idea, lost)) continue;
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
  /** Tokens the study's threads used (null when no provider reports usage). */
  tokens?: number | null;
  maxTokens?: number | undefined;
}

export function budgetExhausted(b: BudgetState): string | null {
  if (b.candidates >= b.maxCandidates) return `max_candidates reached (${b.candidates}/${b.maxCandidates})`;
  if (b.benchSeconds >= b.maxBenchHours * 3600) return `max_bench_hours reached (${(b.benchSeconds / 3600).toFixed(3)} h)`;
  if (b.maxTokens !== undefined && b.tokens !== null && b.tokens !== undefined && b.tokens >= b.maxTokens) return `max_tokens reached (${b.tokens.toLocaleString("en-US")} of ${b.maxTokens.toLocaleString("en-US")})`;
  if (b.deadline) {
    const end = Date.parse(b.deadline.length === 10 ? `${b.deadline}T23:59:59` : b.deadline);
    if (Number.isFinite(end) && b.now > end) return `deadline ${b.deadline} passed`;
  }
  return null;
}

/** Share of each budget limit used (0..1+); deadline is the share of time from `startedAt` to the deadline. */
export function budgetShares(b: BudgetState & { startedAt?: number | null }): Record<"candidates" | "bench" | "tokens" | "deadline", number | null> {
  let deadline: number | null = null;
  if (b.deadline && b.startedAt) {
    const end = Date.parse(b.deadline.length === 10 ? `${b.deadline}T23:59:59` : b.deadline);
    if (Number.isFinite(end) && end > b.startedAt) deadline = (b.now - b.startedAt) / (end - b.startedAt);
  }
  return {
    candidates: b.maxCandidates > 0 ? b.candidates / b.maxCandidates : null,
    bench: b.maxBenchHours > 0 ? b.benchSeconds / (b.maxBenchHours * 3600) : null,
    tokens: b.maxTokens !== undefined && b.tokens !== null && b.tokens !== undefined ? b.tokens / b.maxTokens : null,
    deadline,
  };
}

/** Thresholds (percent) newly crossed per budget dimension, as "dim:pct" keys not yet in `announced`. */
export function newBudgetThresholds(shares: Record<string, number | null>, thresholds: readonly number[], announced: ReadonlySet<string>): Array<{ key: string; dim: string; pct: number; share: number }> {
  const out: Array<{ key: string; dim: string; pct: number; share: number }> = [];
  for (const [dim, share] of Object.entries(shares)) {
    if (share === null) continue;
    const crossed = [...thresholds].sort((a, b) => b - a).find((t) => share * 100 >= t);
    if (crossed === undefined) continue;
    const key = `${dim}:${crossed}`;
    if (!announced.has(key)) out.push({ key, dim, pct: crossed, share });
  }
  return out;
}

/**
 * W under provider limits: while a rate limit blocks turns, hold spawns
 * (W = 1, and no new worker starts); while a usage window is tight, halve W.
 */
export function rateLimitedTarget(w: number, s: { blocked: boolean; tight: boolean }): { w: number; hold: boolean; reason: string | null } {
  if (s.blocked) return { w: 1, hold: true, reason: "rate limited: spawns held until the window resets" };
  if (s.tight) return { w: Math.max(1, Math.ceil(w / 2)), hold: false, reason: "usage window tight: W halved" };
  return { w, hold: false, reason: null };
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
