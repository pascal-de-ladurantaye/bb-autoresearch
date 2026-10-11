// v0.2.4 harvest: stack order (topological, commit-level overlap, coupled
// groups folded), dependency attribution by commit order, the fold loop that
// makes every PR apply on its base, per-dependency reasons, PR order, and
// per-study harvest numbers.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema.ts";
import { Store } from "../src/db/store.ts";
import { dependencyReasons, earlierDependencies, fitLayers, laterDependents, planStacks, prOrder, type FitOutcome, type Layer, type OrderNode } from "../src/harvest-math.ts";
import { dependencyLines } from "../src/report.ts";
import { makeDb } from "./helpers.ts";

const node = (id: number, k: number, commits: Array<[number, string[]]>, dependsOn: number[] = [], foldedInto: number | null = null): OrderNode => ({ id, k, dependsOn, foldedInto, commits: commits.map(([pos, paths]) => ({ pos, paths })) });
const order = (r: ReturnType<typeof planStacks>) => r.stacks.map((s) => s.layers.map((l) => l.members));

describe("stack order", () => {
  it("is topological from the dependency edges, ties by k: a changeset that needs a later k goes after it", () => {
    // #1 (k1) needs #2 (k2): the PR order is #2 → #1, not k order.
    const r = planStacks([node(10, 1, [[0, ["a"]], [4, ["d"]]], [20]), node(20, 2, [[2, ["h"]]]), node(30, 3, [[3, ["z"]]])]);
    expect(order(r)).toEqual([[[20], [10]]]);
    expect(r.folds).toEqual([]);
  });

  it("adds commit-level file overlap edges inside a stack: X needs Y when an earlier commit of Y touches a path X's commit touches", () => {
    // Stack {A, B, C} by C's dependencies. A's commit at 2 touches x after B's commit at 1: A needs B.
    const A = node(1, 1, [[0, ["y"]], [2, ["x"]]]);
    const B = node(2, 2, [[1, ["x"]]]);
    const C = node(3, 3, [[3, ["z"]]], [1, 2]);
    expect(order(planStacks([A, B, C]))).toEqual([[[2], [1], [3]]]);
    // Without the overlap (different paths), k order wins.
    const B2 = node(2, 2, [[1, ["w"]]]);
    expect(order(planStacks([A, B2, C]))).toEqual([[[1], [2], [3]]]);
  });

  it("overlap alone never makes a stack (independent changesets stay independent)", () => {
    expect(planStacks([node(1, 1, [[0, ["x"]]]), node(2, 2, [[1, ["x"]]])]).stacks).toEqual([]);
  });

  it("folds a cycle (commits interleaved on the same file) into one layer hosted by its smallest k, with the reason in words", () => {
    // #1 = c/1, c/3 on src/c.txt; #2 = c/2 on src/c.txt; #3 builds on both.
    const r = planStacks([node(1, 1, [[0, ["src/c.txt"]], [2, ["src/c.txt"]]], [2]), node(2, 2, [[1, ["src/c.txt"]]], [1]), node(3, 3, [[3, ["src/d.txt"]]], [1])]);
    expect(order(r)).toEqual([[[1, 2], [3]]]);
    expect(r.folds).toEqual([{ id: 2, into: 1, reason: "#1 and #2 need each other: their commits interleave on src/c.txt, so neither applies without the other" }]);
  });

  it("a cycle through dependency edges alone folds too; existing folds stay together", () => {
    const r = planStacks([node(1, 1, [[0, ["a"]]], [2]), node(2, 2, [[1, ["b"]]], [1])]);
    expect(r.folds[0]).toMatchObject({ id: 2, into: 1 });
    expect(r.folds[0]!.reason).toContain("depend on each other");
    // #2 already ships inside #3's PR; #1 depends on #2: the unit {3, 2} comes first.
    const f = planStacks([node(1, 1, [[0, ["a"]]], [2]), node(2, 2, [[1, ["b"]]], [], 3), node(3, 3, [[2, ["c"]]])]);
    expect(order(f)).toEqual([[[3, 2], [1]]]);
    expect(f.folds).toEqual([]);
  });
});

describe("dependency attribution by commit order", () => {
  it("a revert of S can be blocked by a changeset with a smaller k whose later commit builds on S", () => {
    // S = #2 (commit at 2). T = #1 (commits at 0 and 4): T's commit at 4 comes after S's.
    const s = { id: 2, k: 2, paths: ["h"], dependsOn: [], first: 2, last: 2 };
    const t = { id: 1, k: 1, paths: ["a", "h"], dependsOn: [], first: 0, last: 4 };
    expect(laterDependents(s, [s, t], ["h"]).ids).toEqual([1]);
    // By k alone (no positions) it was missed.
    expect(laterDependents({ ...s, first: undefined, last: undefined }, [s, { ...t, first: undefined, last: undefined }], ["h"]).ids).toEqual([]);
    // Forward: T (#1) may need S (#2) to apply on the base.
    expect(earlierDependencies(t, [s, t], ["h"]).ids).toEqual([2]);
  });
});

describe("fitLayers: every PR applies on its PR base", () => {
  // A model repo: a changeset applies when what it needs is below it or in the same layer, and not when something it can't follow is below it as a separate PR.
  function model(needs: Record<number, number[]>, notAfter: Record<number, number[]> = {}) {
    const calls: string[] = [];
    const apply = async (layer: Layer, on: number[]): Promise<FitOutcome<number[]>> => {
      calls.push(`${layer.members.join("+")}@${on.join(",") || "base"}`);
      const have = new Set([...on, ...layer.members]);
      for (const m of layer.members) {
        const missing = (needs[m] ?? []).filter((x) => !have.has(x));
        if (missing.length) return { ok: false, kind: "conflict", paths: missing.map((x) => `src/f${x}`), detail: "conflict" };
        const bad = (notAfter[m] ?? []).filter((x) => on.includes(x));
        if (bad.length) return { ok: false, kind: "gate_failed", paths: [], detail: `gate failed after #${bad[0]}` };
      }
      return { ok: true, value: [...on, ...layer.members] };
    };
    return { apply, calls };
  }
  const words = { k: (id: number) => id, paths: (ids: number[]) => ids.map((x) => `src/f${x}`), baseLabel: "`main`" };
  const layers = (...xs: number[][]): Layer[] => xs.map((m) => ({ host: m[0]!, members: m }));

  it("every layer applies: no folds, each on the one below", async () => {
    const m = model({ 2: [1], 3: [2] });
    const r = await fitLayers(layers([1], [2], [3]), [], m.apply, words);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layers.map((l) => l.value)).toEqual([[1], [1, 2], [1, 2, 3]]);
    expect(m.calls).toEqual(["1@base", "2@1", "3@1,2"]);
  });

  it("a layer that needs a file a later layer adds ships inside that layer's PR", async () => {
    // #6 needs #7's file; order #5 → #6 → #7 → #8.
    const m = model({ 6: [7], 8: [7] });
    const r = await fitLayers(layers([5], [6], [7], [8]), [], m.apply, words);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layers.map((l) => [l.host, l.members])).toEqual([[5, [5]], [7, [7, 6]], [8, [8]]]);
    expect(r.folds).toEqual([{ ids: [6], into: 7, reason: "#6 needs src/f7, which #7 adds or changes, so it doesn't apply on #5 alone" }]);
  });

  it("no later layer fixes it: it folds into the previous layer and the check resumes there", async () => {
    // #2 fails its gates on #1's PR (but not together with #1); #3 doesn't help.
    const m = model({}, { 2: [1] });
    const r = await fitLayers(layers([1], [2], [3]), [], m.apply, words);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layers.map((l) => l.members)).toEqual([[1, 2], [3]]);
    expect(r.folds[0]).toMatchObject({ ids: [2], into: 1 });
    expect(r.folds[0]!.reason).toBe("#2 fails the gates on #1 (gate failed after #1) and no later layer fixes it, so it ships inside #1's PR");
  });

  it("when even the whole stack squashed onto the base fails, it reports that (the caller probes outside)", async () => {
    const m = model({ 2: [9] });
    const r = await fitLayers(layers([1], [2]), [], m.apply, words);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failed.host).toBe(2);
    expect(r.squashed.kind).toBe("conflict");
    expect(r.layers.map((l) => l.members)).toEqual([[1]]);
  });

  it("terminates with every layer applying for any requirement graph satisfiable by the squash", async () => {
    // Exhaustive over small random graphs: needs only within the stack.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 200; t++) {
      const n = 2 + Math.floor(rnd() * 5);
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const needs: Record<number, number[]> = {};
      const notAfter: Record<number, number[]> = {};
      for (const a of ids) for (const b of ids) if (a !== b && rnd() < 0.2) (rnd() < 0.7 ? (needs[a] ??= []) : (notAfter[a] ??= [])).push(b);
      const m = model(needs, notAfter);
      const r = await fitLayers(layers(...ids.map((x) => [x])), [], m.apply, words);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.layers.flatMap((l) => l.members).sort()).toEqual(ids);
      expect(m.calls.length).toBeLessThan(4 * n * n + 4);
      // Each layer re-applied on the one below succeeds.
      let on: number[] = [];
      for (const l of r.layers) {
        const again = await m.apply(l, on);
        expect(again.ok).toBe(true);
        if (again.ok) on = again.value;
      }
    }
  });
});

describe("dependency reasons", () => {
  it("splits the stored list per k and keeps older rows readable", () => {
    const r = dependencyReasons("depends on #4: reverting #4 from best conflicts in a.txt; b.txt unless this one is reverted too; depends on #5: best without #5 fails gates");
    expect(r.get(4)).toEqual(["reverting #4 from best conflicts in a.txt; b.txt unless this one is reverted too"]);
    expect(r.get(5)).toEqual(["best without #5 fails gates"]);
    expect(dependencyReasons("touches the same lines").get(null)).toEqual(["touches the same lines"]);
  });

  it("renders one line per dependency without repeating it", () => {
    const row = (id: number, k: number, title: string, deps: number[] = [], reason: string | null = null) => ({ id, k, title, depends_on_json: JSON.stringify(deps), dependency_reason: reason }) as never;
    const all = [row(1, 4, "Shrink c"), row(2, 5, "Add helper"), row(3, 6, "Use it", [1, 2], "depends on #4: reverting #4 from best conflicts in src/c.txt; depends on #5: best without #5 fails gates")];
    expect(dependencyLines([all[2]!], all)).toEqual(["Depends on #4 Shrink c: reverting #4 from best conflicts in src/c.txt", "Depends on #5 Add helper: best without #5 fails gates"]);
    const legacy = [row(1, 4, "Shrink c"), row(3, 6, "Use it", [1], "touches the same lines")];
    expect(dependencyLines([legacy[1]!], legacy)).toEqual(["Depends on #4 Shrink c: touches the same lines"]);
  });
});

describe("PR order", () => {
  it("interleaves independent PRs and stacks by their first k; a stack bottom first; folded right after their host", () => {
    const r = (id: number, k: number, stack: number | null = null, layer: number | null = null, folded_into: number | null = null) => ({ id, k, stack, layer, folded_into });
    const rows = [r(1, 1, 1, 2), r(2, 2), r(3, 3, 1, 1), r(4, 4, 1, 2, 1), r(5, 5)];
    expect(prOrder(rows).map((x) => x.k)).toEqual([3, 1, 4, 2, 5]);
  });
});

describe("harvest numbers per study", () => {
  it("new harvests count per study: a second study's first harvest is h1 while its global id is 2", () => {
    const store = new Store(makeDb(), () => 1);
    const a1 = store.insertHarvest({ study_id: "st_a", from_state: "running", measure_standalone: 1 }, "test");
    const b1 = store.insertHarvest({ study_id: "st_b", from_state: "running", measure_standalone: 1 }, "test");
    const a2 = store.insertHarvest({ study_id: "st_a", from_state: "paused", measure_standalone: 1 }, "test");
    expect([a1.id, a1.seq]).toEqual([1, 1]);
    expect([b1.id, b1.seq]).toEqual([2, 1]);
    expect([a2.id, a2.seq]).toEqual([3, 2]);
  });

  it("the migration backfills existing harvests in id order per study", () => {
    const db = new Database(":memory:");
    const at = MIGRATIONS.findIndex((m) => m.includes("ALTER TABLE harvests ADD COLUMN seq"));
    expect(at).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, at)) db.exec(sql);
    for (const study of ["st_a", "st_b", "st_a", "st_a", "st_b"]) db.prepare(`INSERT INTO harvests (study_id, state, from_state, started_at) VALUES (?, 'ready', 'running', 1)`).run(study);
    for (const sql of MIGRATIONS.slice(at)) db.exec(sql);
    expect(db.prepare(`SELECT id, study_id, seq FROM harvests ORDER BY id`).all()).toEqual([
      { id: 1, study_id: "st_a", seq: 1 },
      { id: 2, study_id: "st_b", seq: 1 },
      { id: 3, study_id: "st_a", seq: 2 },
      { id: 4, study_id: "st_a", seq: 3 },
      { id: 5, study_id: "st_b", seq: 2 },
    ]);
  });
});
