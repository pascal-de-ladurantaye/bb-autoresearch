// M3 harvest against real git (LocalHostRunner): grouping, ablation with
// dependency detection (a revert conflict and a gate failure), stacks with a
// joint ablation, standalone checks, dry-run PR drafts and the report.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { harvestText } from "../src/cli.ts";
import { accountingFor } from "../src/report.ts";
import { harvestView } from "../src/views.ts";
import { localRunner, makeCtx, waitFor, type FakePort } from "./helpers.ts";

const SLUG = "toy-harvest";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

// Metric: the sum of the first number in each src/*.txt (lower is better), so effects add exactly.
const MEASURE = `total=0; for f in src/*.txt; do v=$(head -1 "$f" | tr -dc 0-9); total=$((total + \${v:-0})); done; echo "METRIC size=$total"`;
// Gate: a file that says "uses-helper" needs src/helper.txt.
const GATE = `if grep -q uses-helper src/*.txt && [ ! -f src/helper.txt ]; then echo "helper missing" >&2; exit 1; fi`;

function spec(extra = ""): string {
  return `
[study]
slug = "${SLUG}"
objective = "Make the sum of the toy numbers smaller."
base = "main"

[metric]
name = "size"
direction = "lower"

[scope]
editable = ["src/**"]
protected = ["bench/**"]

[oracle]
gate = ["sh bench/gate.sh"]
measure = "sh bench/measure.sh"
noise = "deterministic"

[budget]
max_workers = 1
max_candidates = 20

[harvest]
group_timeout_minutes = 5
${extra}
`;
}

describe("harvest (real git)", () => {
  let root: string;
  let repo: string;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let studyId: string;
  let n = 0;

  beforeEach(async () => {
    n = 0;
    root = mkdtempSync(join(tmpdir(), "ar-harvest-"));
    repo = join(root, "repo");
    execFileSync("mkdir", ["-p", join(repo, "src"), join(repo, "bench")]);
    sh(repo, "init", "-q", "-b", "main");
    for (const f of ["a", "b", "c", "d"]) writeFileSync(join(repo, `src/${f}.txt`), "100\n");
    writeFileSync(join(repo, "bench/measure.sh"), `${MEASURE}\n`);
    writeFileSync(join(repo, "bench/gate.sh"), `${GATE}\n`);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
    const runner = localRunner(join(root, "data"), "host_test", { pollMs: 10, progressMs: 10 });
    const made = makeCtx(runner);
    ({ store, port } = made);
    port.projectCheckout = async () => repo;
    port.addThread("thr_study");
    engine = new Engine(made.ctx);
    await engine.proposeStudy("thr_study", "proj_1", spec());
    await engine.calibrate(SLUG, "human");
    await engine.waitForCalibration(SLUG, 20_000);
    expect(store.study(SLUG)!.calibration_status).toBe("ready");
    await engine.start(SLUG, "human");
    studyId = store.study(SLUG)!.id;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Commit a promotion onto studies/<slug>/best the way the pipeline does (trailer + candidate row). */
  function promote(title: string, files: Record<string, string | null>, effect: number): void {
    n += 1;
    const wt = join(root, `wt${n}`);
    sh(repo, "worktree", "add", "-q", "--detach", wt, `studies/${SLUG}/best`);
    for (const [f, content] of Object.entries(files)) {
      if (content === null) rmSync(join(wt, f));
      else writeFileSync(join(wt, f), content);
    }
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", `${title}\n\nAutoresearch study ${SLUG}, candidate c/${n}.\n\nAutoresearch-Candidate: c/${n}`);
    const sha = sh(wt, "rev-parse", "HEAD");
    const parent = sh(wt, "rev-parse", "HEAD^");
    sh(repo, "update-ref", `refs/heads/studies/${SLUG}/best`, sha, parent);
    sh(repo, "worktree", "remove", "--force", wt);
    const idea = store.addIdea(studyId, { title, source: "strategist", theme: "t" }, "test");
    const c = store.insertCandidate({ study_id: studyId, n, idea_id: idea.id, thread_id: null, sha, parent_sha: parent, summary: `${title}: summary`, stage: "decided", changed_paths_json: JSON.stringify(Object.keys(files)) });
    store.updateCandidate(c.id, { verdict: "win", effect, ci_lo: effect, ci_hi: effect, promoted_sha: sha, prepared_sha: sha, against_sha: parent, decided_at: Date.now() + n, reported_at: Date.now() });
    store.setIdeaStatus(idea.id, "won", "test");
    store.addFinding({ study_id: studyId, idea_id: idea.id, candidate_id: c.id, thread_id: null, outcome: "improved", learned: `${title} helped because of reasons`, revisit_if: "", evidence: "" }, "test");
    store.updateStudy(studyId, { best_sha: sha });
  }

  function sixPromotions() {
    promote("Shrink a", { "src/a.txt": "60\n" }, 0.1);
    promote("Shrink b", { "src/b.txt": "70\n" }, 0.08);
    promote("Shrink c", { "src/c.txt": "80\n" }, 0.06);
    // Same line as "Shrink c": reverting "Shrink c" alone from best conflicts.
    promote("Shrink c more", { "src/c.txt": "75\n" }, 0.02);
    // No metric effect, but "Use helper for d" needs it: reverting it from best fails the gate.
    promote("Add helper", { "src/helper.txt": "0 helper\n" }, 0);
    promote("Use helper for d", { "src/d.txt": "50 uses-helper\n" }, 0.19);
  }

  async function harvested(): Promise<number> {
    const r = engine.startHarvest(SLUG, "human");
    expect(store.study(SLUG)!.state).toBe("harvesting");
    // The grouping round went to the study thread; its turn ends without a proposal → fallback.
    await waitFor(() => store.harvest(r.harvest.id)!.state === "grouping" && store.harvest(r.harvest.id)!.round_sent_at !== null);
    engine.onThreadIdle("thr_study");
    await engine.waitForHarvest(SLUG, 60_000);
    return r.harvest.id;
  }

  it("ablates every changeset, detects a revert conflict and a gate failure as dependencies, and the contributions add up", async () => {
    sixPromotions();
    const id = await harvested();
    const h = store.harvest(id)!;
    expect(h.error).toBeNull();
    expect(h.state).toBe("ready");
    expect(h.grouping_source).toBe("fallback");
    const cs = store.changesets(id);
    expect(cs.map((c) => c.title)).toEqual(["Shrink a", "Shrink b", "Shrink c", "Shrink c more", "Add helper", "Use helper for d"]);
    const by = (t: string) => cs.find((c) => c.title === t)!;
    const best = 255;
    // Contributions relative to best: (best without S − best) / best.
    expect(by("Shrink a").contribution).toBeCloseTo(40 / best, 6);
    expect(by("Shrink b").contribution).toBeCloseTo(30 / best, 6);
    expect(by("Shrink c more").contribution).toBeCloseTo(5 / best, 6);
    expect(by("Use helper for d").contribution).toBeCloseTo(50 / best, 6);
    // Revert conflict: "Shrink c more" depends on "Shrink c".
    expect(by("Shrink c").ablation_status).toBe("conflict");
    expect(JSON.parse(by("Shrink c more").depends_on_json)).toEqual([by("Shrink c").id]);
    // Gate failure: best without the helper breaks the gate → "Use helper for d" depends on it.
    expect(by("Add helper").ablation_status).toBe("gate_failed");
    expect(by("Add helper").ablation_detail).toContain("gate failed");
    expect(JSON.parse(by("Use helper for d").depends_on_json)).toEqual([by("Add helper").id]);
    // Stacks, PR bases, and the joint ablations that stand in for the members without their own.
    expect(by("Shrink a").stack).toBeNull();
    expect(by("Shrink c").stack).toBe(1);
    expect(by("Shrink c more").pr_base).toBe(`#${by("Shrink c").k}`);
    const stacks = JSON.parse(h.stacks_json!) as Array<{ members: number[]; status: string; estimate: { value: number } | null }>;
    expect(stacks.map((s) => s.status)).toEqual(["measured", "measured"]);
    expect(stacks[0]!.estimate!.value).toBeCloseTo(25 / best, 6);
    expect(stacks[1]!.estimate!.value).toBeCloseTo(50 / best, 6);
    // Total gain (base vs best, relative to best) and the sum of contributions agree: no interaction.
    expect(h.total_effect).toBeCloseTo(145 / best, 6);
    expect(h.total_vs_base).toBeCloseTo(145 / 400, 6);
    const acc = accountingFor(engine.ctx, h);
    expect(acc.sum).toBeCloseTo(145 / best, 6);
    expect(acc.interaction).toBe(false);
    // Droppable: no measurable contribution on its own (the human decides).
    expect(cs.filter((c) => c.droppable).map((c) => c.title)).toEqual([]);
    // Standalone: every changeset applies on its PR base and passes gates; independent ones measured vs base.
    expect(cs.every((c) => c.standalone_status === "pass")).toBe(true);
    expect(by("Shrink a").standalone_effect).toBeCloseTo(40 / 400, 6);
    expect(by("Shrink c more").standalone_effect).toBeCloseTo(5 / 380, 6); // 80 → 75 on the 380 layer below
  });

  it("drafts one local branch per changeset (stacked ones on the layer below) and writes PR bodies and the report in dry-run", async () => {
    sixPromotions();
    const id = await harvested();
    const h = store.harvest(id)!;
    const cs = store.changesets(id);
    for (const c of cs) {
      expect(c.branch).toMatch(new RegExp(`^studies/${SLUG}/harvest/h${id}/0${c.k}-`, "u"));
      expect(sh(repo, "rev-parse", `refs/heads/${c.branch}`)).toBe(c.standalone_sha);
      expect(c.pr_status).toBe("branch");
    }
    const base = sh(repo, "rev-parse", "main");
    const a = cs.find((c) => c.title === "Shrink a")!;
    expect(sh(repo, "rev-parse", `${a.branch}^`)).toBe(base);
    expect(sh(repo, "show", `${a.branch}:src/a.txt`)).toBe("60");
    expect(sh(repo, "show", `${a.branch}:src/c.txt`)).toBe("100");
    const c3 = cs.find((c) => c.title === "Shrink c")!;
    const c4 = cs.find((c) => c.title === "Shrink c more")!;
    expect(sh(repo, "rev-parse", `${c4.branch}^`)).toBe(c3.standalone_sha);
    // Nothing was pushed: the repo has no remote, and the publisher was the dry run.
    expect(h.publish_state).toBe("dry-run");
    expect(sh(repo, "remote")).toBe("");
    // PR body: what/why, contribution with CI, standalone effect, findings, study link.
    expect(a.pr_body).toContain("Contribution (ablation");
    expect(a.pr_body).toContain("+15.69%");
    expect(a.pr_body).toContain("Standalone");
    expect(a.pr_body).toContain("Finding #1");
    expect(a.pr_body).toContain(`studies/${SLUG}/harvest`);
    expect(c4.pr_body).toContain("Depends on: #3 Shrink c");
    // Exported files.
    expect(h.export_dir).toBe(join(root, "data", "exports", `${SLUG}-harvest-h${id}`));
    const report = readFileSync(join(h.export_dir!, "report.md"), "utf8");
    expect(report).toContain(`# Study report: ${SLUG}`);
    expect(report).toContain("Sum of contributions vs total gain");
    expect(report).toContain("add up to the total gain within the CI");
    expect(existsSync(join(h.export_dir!, `prs/${a.branch!.split("/").pop()}.md`))).toBe(true);
    expect(report).toContain(`## Harvest h${id} (ready)`);
    expect(JSON.parse(readFileSync(join(h.export_dir!, "manifest.json"), "utf8")).mode).toBe("dry-run");
    // Views and CLI.
    const v = harvestView(engine, store.study(SLUG)!);
    expect(v.harvest!.changesets.find((c) => c.title === "Shrink c more")!.dependsOn).toEqual([3]);
    expect(v.harvest!.publishCommand).toBe(`bb study harvest ${SLUG} --publish`);
    expect(harvestText(engine, SLUG)).toContain("depends on #3");
    expect(store.notices(studyId).map((x) => x.kind)).toContain("harvest.ready");
    // GitHub publishing refuses: there is no remote.
    await expect(engine.publishHarvest(SLUG, "human", true)).rejects.toThrow(/no remote named "origin"/u);
    // Keep exploring returns to Running; the ready harvest stays for review.
    expect(engine.resume(SLUG, "human")).toContain("keep exploring");
    expect(store.study(SLUG)!.state).toBe("running");
  });

  it("uses the strategist's grouping; invalid proposals are refused with the reason", async () => {
    sixPromotions();
    const r = engine.startHarvest(SLUG, "human");
    await waitFor(() => store.harvest(r.harvest.id)!.round_sent_at !== null);
    const round = port.sent.filter((m) => m.threadId === "thr_study").at(-1)!.text;
    expect(round).toContain(`Harvest h${r.harvest.id}`);
    expect(round).toContain("c/4");
    await expect(engine.proposeHarvest("thr_study", [{ title: "bogus", candidates: [99], rationale: "x" }])).rejects.toThrow(/c\/99 is not a promotion/u);
    const ok = await engine.proposeHarvest("thr_study", [
      { title: "Shrink a and b", candidates: [1, 2], rationale: "Two small files" },
      { title: "Shrink c", candidates: [3, 4], rationale: "One idea, refined" },
      { title: "Helper for d", candidates: [5, 6], rationale: "Helper plus its use" },
    ]);
    expect(ok).toContain("accepted");
    await engine.waitForHarvest(SLUG, 60_000);
    const h = store.harvest(r.harvest.id)!;
    expect(h.grouping_source).toBe("strategist");
    const cs = store.changesets(h.id);
    expect(cs.map((c) => c.title)).toEqual(["Shrink a and b", "Shrink c", "Helper for d"]);
    // Grouped this way nothing conflicts or breaks gates: three independent changesets.
    expect(cs.every((c) => c.ablation_status === "measured" && c.stack === null)).toBe(true);
    expect(cs.map((c) => Math.round(c.contribution! * 255))).toEqual([70, 25, 50]);
    expect(accountingFor(engine.ctx, h).interaction).toBe(false);
  });

  it("--one-per-promotion skips the strategist round", async () => {
    sixPromotions();
    const before = port.sent.length;
    const r = engine.startHarvest(SLUG, "human", { onePerPromotion: true, measureStandalone: false });
    await engine.waitForHarvest(SLUG, 60_000);
    const h = store.harvest(r.harvest.id)!;
    expect(h.state).toBe("ready");
    expect(h.grouping_source).toBe("fallback");
    expect(port.sent.slice(before).some((m) => m.text.includes("[autoresearch] Harvest"))).toBe(false);
    expect(store.changesets(h.id)).toHaveLength(6);
    expect(store.changesets(h.id).every((c) => c.standalone_status === "pass" && c.standalone_effect === null)).toBe(true);
  });

  it("waits for in-flight candidates, refuses submissions while harvesting, and archive cancels it", async () => {
    promote("Shrink a", { "src/a.txt": "60\n" }, 0.1);
    // A candidate still on the bench: the harvest waits for it.
    const c = store.insertCandidate({ study_id: studyId, n: 99, idea_id: null, thread_id: null, sha: store.study(SLUG)!.best_sha!, parent_sha: store.study(SLUG)!.best_sha!, summary: "in flight", stage: "measuring", changed_paths_json: "[]" });
    const r = engine.startHarvest(SLUG, "human");
    await waitFor(() => (store.harvest(r.harvest.id)!.phase_detail ?? "").includes("in-flight"));
    expect(store.harvest(r.harvest.id)!.state).toBe("waiting");
    store.updateCandidate(c.id, { stage: "decided", verdict: "inconclusive", decided_at: Date.now() });
    await engine.waitForHarvest(SLUG, 60_000);
    const h = store.harvest(r.harvest.id)!;
    expect(h.state).toBe("ready");
    // A single promotion is its own changeset (no round needed).
    expect(h.grouping_source).toBe("fallback");
    expect(store.changesets(h.id)).toHaveLength(1);
    // A second harvest needs --restart; then archive cancels it and cleans up.
    expect(engine.startHarvest(SLUG, "human").harvest.id).toBe(h.id);
    const again = engine.startHarvest(SLUG, "human", { restart: true });
    expect(again.harvest.id).not.toBe(h.id);
    await engine.archiveStudy(SLUG, "human");
    await engine.waitForHarvest(SLUG, 10_000);
    expect(store.harvest(again.harvest.id)!.state).toBe("cancelled");
  });
});
