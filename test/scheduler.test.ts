import { describe, expect, it } from "vitest";
import type { IdeaRow } from "../src/db/store.ts";
import { budgetExhausted, idleAction, pickIdea, roundTrigger, targetWorkers } from "../src/scheduler.ts";

function idea(id: number, p: Partial<IdeaRow> = {}): IdeaRow {
  return { id, study_id: "s", title: `idea ${id}`, rationale: "", theme: "", source: "strategist", priority: 0, pinned: 0, status: "queued", start_ref: null, status_reason: null, created_at: 0, updated_at: 0, ...p };
}

describe("targetWorkers", () => {
  it("applies W = min(max, ceil(think/eval)+1) under the milestone ceiling", () => {
    expect(targetWorkers({ maxWorkers: 8, tThink: 600, tEval: 120, ceiling: 64 })).toBe(6);
    expect(targetWorkers({ maxWorkers: 4, tThink: 600, tEval: 120, ceiling: 64 })).toBe(4);
    expect(targetWorkers({ maxWorkers: 4, tThink: null, tEval: null, ceiling: 64 })).toBe(4);
    expect(targetWorkers({ maxWorkers: 8, tThink: 600, tEval: 120, ceiling: 1 })).toBe(1);
  });
});

describe("pickIdea", () => {
  it("takes pinned first, then priority, then age", () => {
    const q = [idea(1, { priority: 5 }), idea(2, { priority: 9 }), idea(3, { pinned: 1, priority: -1 })];
    expect(pickIdea(q, [], 1)?.id).toBe(3);
    expect(pickIdea(q.slice(0, 2), [], 1)?.id).toBe(2);
    expect(pickIdea([], [], 1)).toBeNull();
  });
  it("limits workers per theme to ceil(W/2) when W > 1", () => {
    const q = [idea(1, { theme: "alloc", priority: 9 }), idea(2, { theme: "simd" })];
    const running = [idea(9, { theme: "alloc", status: "running" }), idea(10, { theme: "alloc", status: "running" })];
    expect(pickIdea(q, running, 4)?.id).toBe(2);
  });
});

describe("budgetExhausted", () => {
  const b = { candidates: 0, maxCandidates: 3, benchSeconds: 0, maxBenchHours: 1, deadline: undefined, now: Date.parse("2026-01-01T00:00:00") };
  it("detects each limit", () => {
    expect(budgetExhausted(b)).toBeNull();
    expect(budgetExhausted({ ...b, candidates: 3 })).toContain("max_candidates");
    expect(budgetExhausted({ ...b, benchSeconds: 3600 })).toContain("max_bench_hours");
    expect(budgetExhausted({ ...b, deadline: "2025-12-31" })).toContain("deadline");
  });
});

describe("roundTrigger", () => {
  const base = { roundInFlight: false, verdictsSinceRound: 0, k: 3, readyIdeas: 5, w: 1, recentVerdicts: [], stallAfter: 4, stallSignaledAt: 0, totalVerdicts: 0, rounds: 1 };
  it("starts with a first round and never overlaps rounds", () => {
    expect(roundTrigger({ ...base, rounds: 0 })).toBe("start");
    expect(roundTrigger({ ...base, rounds: 0, roundInFlight: true })).toBeNull();
  });
  it("fires after K verdicts and when the queue is low after a change", () => {
    expect(roundTrigger({ ...base, verdictsSinceRound: 3 })).toBe("verdicts");
    expect(roundTrigger({ ...base, readyIdeas: 0 })).toBeNull();
    expect(roundTrigger({ ...base, readyIdeas: 0, verdictsSinceRound: 1 })).toBe("queue_low");
  });
  it("fires a stall round once per stall window", () => {
    const loses = Array.from({ length: 4 }, () => ({ verdict: "lose" as const }));
    expect(roundTrigger({ ...base, recentVerdicts: loses, totalVerdicts: 4 })).toBe("stall");
    expect(roundTrigger({ ...base, recentVerdicts: loses, totalVerdicts: 4, stallSignaledAt: 4 })).toBeNull();
    expect(roundTrigger({ ...base, recentVerdicts: [...loses.slice(1), { verdict: "win" as const }], totalVerdicts: 4 })).toBeNull();
  });
});

describe("idleAction", () => {
  const opts = { now: 100 * 60_000, awaitingVerdict: false, threadIdle: true, nudgeMs: 10 * 60_000, abandonMs: 20 * 60_000 };
  it("nudges once, then abandons", () => {
    expect(idleAction({ state: "active", last_idle_at: 95 * 60_000, nudged_at: null }, opts).kind).toBe("none");
    expect(idleAction({ state: "active", last_idle_at: 85 * 60_000, nudged_at: null }, opts).kind).toBe("nudge");
    expect(idleAction({ state: "active", last_idle_at: 85 * 60_000, nudged_at: 95 * 60_000 }, opts).kind).toBe("none");
    expect(idleAction({ state: "active", last_idle_at: 70 * 60_000, nudged_at: 80 * 60_000 }, opts).kind).toBe("abandon");
  });
  it("ignores workers waiting for a verdict or still working", () => {
    expect(idleAction({ state: "active", last_idle_at: 0, nudged_at: null }, { ...opts, awaitingVerdict: true }).kind).toBe("none");
    expect(idleAction({ state: "active", last_idle_at: 0, nudged_at: null }, { ...opts, threadIdle: false }).kind).toBe("none");
  });
});
