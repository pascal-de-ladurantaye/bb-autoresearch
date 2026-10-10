// M3 operations on fake hosts: harvest grouping and accounting math, the
// GitHub publisher's refusals (mock gh), the report's interaction warning,
// rate-limit retries and W lowering, budgets (tokens, thresholds), milestone
// notices, and the new RPC view models.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import type { Store } from "../src/db/store.ts";
import { Engine } from "../src/engine.ts";
import { applyProposal, computeStacks, contributionFromAblation, fallbackGrouping, harvestAccounting, isDroppable, laterDependents, shellQuote, type Promotion } from "../src/harvest-math.ts";
import type { ExecInput, ExecResult } from "../src/host/contract.ts";
import { GithubPublisher, isGithubUrl, PublishRefused } from "../src/publisher.ts";
import { accountingText, harvestSection } from "../src/report.ts";
import { budgetShares, newBudgetThresholds, rateLimitedTarget } from "../src/scheduler.ts";
import { benchView, findingsView, harvestView, oracleView, redactedSpecToml, usageView } from "../src/views.ts";
import { FakeHost, FakePort, fakeHostSpec, makeCtx, waitFor, type Clock } from "./helpers.ts";

const P = (sha: string, n: number | null, paths: string[]): Promotion => ({ sha, n, title: `t${n ?? sha}`, paths });

describe("harvest math", () => {
  const promos = [P("a1", 1, ["x"]), P("a2", 2, ["y"]), P("a3", 3, ["x"]), P("a4", null, ["z"])];

  it("fallback: one changeset per promotion in best order", () => {
    const f = fallbackGrouping(promos);
    expect(f.map((c) => c.promotions.map((p) => p.sha))).toEqual([["a1"], ["a2"], ["a3"], ["a4"]]);
  });

  it("a proposal must cover promotions exactly once; leftovers get their own changeset; order follows best", () => {
    expect(applyProposal(promos, [{ title: "g", candidates: [1, 9], rationale: "" }])).toMatchObject({ ok: false });
    expect(applyProposal(promos, [{ title: "g", candidates: [1], rationale: "" }, { title: "h", candidates: [1], rationale: "" }])).toMatchObject({ ok: false, errors: ["c/1 is in more than one group"] });
    const r = applyProposal(promos, [{ title: "later", candidates: [3, 2], rationale: "why" }]);
    if (!r.ok) throw new Error("expected ok");
    expect(r.changesets.map((c) => [c.title, c.promotions.map((p) => p.sha)])).toEqual([
      ["t1", ["a1"]],
      ["later", ["a2", "a3"]],
      ["ta4", ["a4"]],
    ]);
    expect(r.notes).toHaveLength(2);
  });

  it("dependency attribution and stacks", () => {
    const nodes = [
      { id: 10, k: 1, paths: ["x"], dependsOn: [] },
      { id: 11, k: 2, paths: ["y"], dependsOn: [] },
      { id: 12, k: 3, paths: ["x", "w"], dependsOn: [10] },
      { id: 13, k: 4, paths: ["q"], dependsOn: [] },
    ];
    expect(laterDependents(nodes[0]!, nodes, ["x"])).toEqual({ ids: [12], attributed: true });
    // No shared file: every later changeset is treated as dependent (stacking is always safe).
    expect(laterDependents(nodes[1]!, nodes)).toEqual({ ids: [12, 13], attributed: false });
    const { stacks, stackOf } = computeStacks(nodes);
    expect(stacks).toEqual([[10, 12]]);
    expect(stackOf.get(12)).toBe(1);
    expect(stackOf.has(11)).toBe(false);
  });

  it("ablation math: contribution is the negated effect with the CI flipped; droppable when the CI reaches zero", () => {
    expect(contributionFromAblation(-0.1, -0.12, -0.08)).toEqual({ value: 0.1, lo: 0.08, hi: 0.12 });
    expect(isDroppable({ value: 0.1, lo: 0.08, hi: 0.12 })).toBe(false);
    expect(isDroppable({ value: 0.004, lo: -0.01, hi: 0.02 })).toBe(true);
    expect(isDroppable({ value: 0.0, lo: 0, hi: 0 }, 0)).toBe(true);
  });

  it("accounting: sum vs total, joint stack ablation stands in, interaction warning when the gap exceeds its CI", () => {
    const changesets = [
      { id: 1, k: 1, title: "a", estimate: { value: 0.1, lo: 0.09, hi: 0.11 } },
      { id: 2, k: 2, title: "b", estimate: null },
      { id: 3, k: 3, title: "c", estimate: { value: 0.05, lo: 0.04, hi: 0.06 } },
    ];
    const stacks = [{ members: [2, 3], estimate: { value: 0.08, lo: 0.07, hi: 0.09 } }];
    const additive = harvestAccounting({ changesets, stacks, total: { value: 0.18, lo: 0.17, hi: 0.19 } });
    expect(additive.items.map((i) => i.source)).toEqual(["changeset", "stack"]);
    expect(additive.sum).toBeCloseTo(0.18, 9);
    expect(additive.interaction).toBe(false);
    const interacting = harvestAccounting({ changesets, stacks, total: { value: 0.3, lo: 0.29, hi: 0.31 } });
    expect(interacting.gap).toBeCloseTo(0.12, 9);
    expect(interacting.interaction).toBe(true);
    expect(accountingText(interacting).join("\n")).toContain("Interaction warning");
    expect(accountingText(additive).join("\n")).toContain("add up to the total gain within the CI");
    const missing = harvestAccounting({ changesets, stacks: [{ members: [2, 3], estimate: null }], total: { value: 0.1, lo: 0.09, hi: 0.11 } });
    expect(missing.missing).toEqual(["stack 1"]);
    expect(accountingText(missing).join("\n")).toContain("could not be measured");
  });

  it("shell quoting", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

/** A minimal edit host for the publisher: records commands, answers like gh would. */
class GhHost extends FakeHost {
  ran: string[] = [];
  ghInstalled = true;
  pushFails = false;
  async exec(input: ExecInput): Promise<ExecResult> {
    this.ran.push(input.command);
    const ok = (stdout = ""): ExecResult => ({ exitCode: 0, timedOut: false, durationMs: 1, stdout, stderr: "" });
    if (input.command === "gh --version") return this.ghInstalled ? ok("gh version 2.0") : { exitCode: 127, timedOut: false, durationMs: 1, stdout: "", stderr: "gh: not found" };
    if (input.command.startsWith("git push")) return this.pushFails ? { exitCode: 1, timedOut: false, durationMs: 1, stdout: "", stderr: "denied" } : ok();
    if (input.command.startsWith("gh pr create")) return ok(`https://github.com/acme/repo/pull/${this.ran.filter((c) => c.startsWith("gh pr create")).length}\n`);
    return ok();
  }
}

describe("GitHub publisher (mock gh)", () => {
  const drafts = [
    { changesetId: 1, k: 1, branch: "studies/s/harvest/h1/01-a", baseBranch: "main", title: "A", body: "body a", sha: "abc1234", stacked: false },
    { changesetId: 2, k: 2, branch: "studies/s/harvest/h1/02-b", baseBranch: "studies/s/harvest/h1/01-a", title: "B's", body: "body b", sha: "abc1235", stacked: true },
    { changesetId: 3, k: 3, branch: "studies/s/harvest/h1/03-c", baseBranch: "main", title: "C", body: "body c", sha: null, stacked: false },
  ];

  it("refuses without --publish, without a remote, with a non-GitHub remote, and without gh", async () => {
    const host = new GhHost();
    await expect(new GithubPublisher(host, "/repo", "origin", false).publish({ key: "k", drafts, report: "r" })).rejects.toThrow(/explicit `bb study harvest <slug> --publish`/u);
    await expect(new GithubPublisher(host, "/repo", "origin", true).publish({ key: "k", drafts, report: "r" })).rejects.toThrow(/no remote named "origin" \(it has no remotes\)/u);
    host.remotes = [{ name: "origin", url: "https://gitlab.com/acme/repo.git" }];
    await expect(new GithubPublisher(host, "/repo", "origin", true).preflight()).rejects.toBeInstanceOf(PublishRefused);
    host.remotes = [{ name: "origin", url: "git@github.com:acme/repo.git" }];
    host.ghInstalled = false;
    await expect(new GithubPublisher(host, "/repo", "origin", true).preflight()).rejects.toThrow(/gh\) is not available/u);
    expect(host.ran.filter((c) => c.startsWith("git push") || c.startsWith("gh pr"))).toEqual([]);
    expect(isGithubUrl("https://github.com/a/b")).toBe(true);
    expect(isGithubUrl("ssh://git@github.com/a/b.git")).toBe(true);
  });

  it("pushes branches and opens DRAFT PRs in stack order; skips changesets without a branch", async () => {
    const host = new GhHost();
    host.remotes = [{ name: "origin", url: "https://github.com/acme/repo.git" }];
    const out = await new GithubPublisher(host, "/repo", "origin", true).publish({ key: "k", drafts, report: "r" });
    expect(out.prs.map((p) => p.status)).toEqual(["opened", "opened", "skipped"]);
    expect(out.prs[0]!.url).toBe("https://github.com/acme/repo/pull/1");
    const gh = host.ran.filter((c) => c.startsWith("gh pr create"));
    expect(gh).toHaveLength(2);
    expect(gh.every((c) => c.includes("--draft"))).toBe(true);
    expect(gh[1]).toContain("--base 'studies/s/harvest/h1/01-a'");
    expect(gh[1]).toContain(`--title 'B'\\''s'`);
    expect(host.ran.filter((c) => c.startsWith("git push"))).toEqual(["git push 'origin' 'refs/heads/studies/s/harvest/h1/01-a:refs/heads/studies/s/harvest/h1/01-a'", "git push 'origin' 'refs/heads/studies/s/harvest/h1/02-b:refs/heads/studies/s/harvest/h1/02-b'"]);
  });

  it("a failed push skips the PRs stacked on it", async () => {
    const host = new GhHost();
    host.remotes = [{ name: "origin", url: "https://github.com/acme/repo.git" }];
    host.pushFails = true;
    const out = await new GithubPublisher(host, "/repo", "origin", true).publish({ key: "k", drafts, report: "r" });
    expect(out.prs.map((p) => p.status)).toEqual(["failed", "skipped", "skipped"]);
  });
});

describe("scheduler policy: provider limits and budget shares", () => {
  it("rate limited holds spawns; a tight usage window halves W", () => {
    expect(rateLimitedTarget(4, { blocked: true, tight: false })).toMatchObject({ w: 1, hold: true });
    expect(rateLimitedTarget(4, { blocked: false, tight: true })).toMatchObject({ w: 2, hold: false });
    expect(rateLimitedTarget(3, { blocked: false, tight: true }).w).toBe(2);
    expect(rateLimitedTarget(1, { blocked: false, tight: true }).w).toBe(1);
    expect(rateLimitedTarget(4, { blocked: false, tight: false })).toEqual({ w: 4, hold: false, reason: null });
  });

  it("budget shares and once-only thresholds", () => {
    const shares = budgetShares({ candidates: 8, maxCandidates: 10, benchSeconds: 1800, maxBenchHours: 1, deadline: undefined, now: 0, tokens: 100, maxTokens: undefined });
    expect(shares).toEqual({ candidates: 0.8, bench: 0.5, tokens: null, deadline: null });
    const crossed = newBudgetThresholds(shares, [50, 80], new Set(["bench:50"]));
    expect(crossed.map((c) => c.key)).toEqual(["candidates:80"]);
  });
});

const SPEC_NOISY = (extra = "") =>
  fakeHostSpec()
    .replace('noise = "deterministic"', 'noise = "deterministic"')
    .replace("max_workers = 1", "max_workers = 4")
    .replace("max_candidates = 3", `max_candidates = 10\nmax_tokens = 5000\nnotify_at = [50, 80]`) + extra;

describe("operations on a running study (fake host)", () => {
  let host: FakeHost;
  let engine: Engine;
  let store: Store;
  let port: FakePort;
  let clock: Clock;
  let id: string;

  beforeEach(async () => {
    host = new FakeHost();
    const made = makeCtx(host);
    ({ store, port, clock } = made);
    engine = new Engine(made.ctx);
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    await engine.proposeStudy("thr_study", "proj_1", SPEC_NOISY());
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 5_000);
    await engine.start("toy-size", "human");
    id = store.study("toy-size")!.id;
  });

  it("a rate-limited worker turn is retried at the window reset (capped), spawns hold until then, and the page shows it", async () => {
    engine.addIdea("toy-size", { title: "Idea one", theme: "a" }, "human");
    await engine.settle();
    expect(port.spawned).toHaveLength(1);
    const reset = clock.now() + 10 * 60_000;
    const failed = { threadId: "thr_w1", requestId: "req_1", attemptNumber: 1, errorInfo: { category: "rate-limit" }, rateLimits: { status: "blocked", windows: [{ resetsAtMs: reset, status: "blocked" }] } };
    await engine.onTurnFailed(failed);
    expect(port.retries).toEqual([{ threadId: "thr_w1", turnRequestId: "req_1", sendAt: reset + 15_000 }]);
    expect(store.study(id)!.rate_limited_until).toBe(reset + 15_000);
    expect(store.notices(id).map((n) => n.kind)).toContain("rate_limit");
    // While limited: no new worker even with ideas and free slots.
    engine.addIdea("toy-size", { title: "Idea two", theme: "b" }, "human");
    await engine.settle();
    expect(port.spawned).toHaveLength(1);
    expect(store.study(id)!.target_workers).toBe(1);
    expect(usageView(engine, store.study(id)!)).toMatchObject({ rateLimited: true, rateLimitedUntil: reset + 15_000 });
    // The cap: after max_rate_limit_retries (3) the plugin gives up and says so.
    for (let a = 2; a <= 4; a++) await engine.onTurnFailed({ ...failed, attemptNumber: a });
    expect(port.retries).toHaveLength(3);
    expect(store.events(id, { kinds: ["turn.rate_limit_gave_up"] })).toHaveLength(1);
    // After the reset, spawning resumes.
    clock.advance(11 * 60_000);
    await engine.settle();
    expect(port.spawned.length).toBeGreaterThan(1);
  });

  it("a tight usage window halves W; usage is read for the study's providers", async () => {
    port.usage = [
      { providerId: "pi", status: "ok", windows: [{ label: "5h", usedPercent: 95, resetsAt: clock.now() + 3_600_000 }] },
      { providerId: "other", status: "ok", windows: [{ label: "5h", usedPercent: 10, resetsAt: null }] },
    ];
    port.threads.get("thr_study")!.providerId = "pi";
    store.updateThread(store.threadById("thr_study")!.id, { provider_id: "pi" });
    await engine.tick();
    const s = store.study(id)!;
    expect(engine.usageState(s)).toMatchObject({ tight: true, maxPercent: 95 });
    expect(s.target_workers).toBe(2);
    expect(store.events(id, { kinds: ["scheduler.target"] })[0]!.data_json).toContain("usage window tight");
    expect(store.notices(id).map((n) => n.kind)).toContain("usage.tight");
  });

  it("token budget: per-thread usage is summed, thresholds notify once, exhaustion pauses and proposes a harvest", async () => {
    port.tokens.set("thr_study", 1000);
    await engine.tick();
    // The study thread counts from the study's start: its first reading is the baseline.
    expect(store.studyTokens(id)).toBe(0);
    port.tokens.set("thr_study", 3600);
    clock.advance(120_000);
    await engine.tick();
    expect(store.studyTokens(id)).toBe(2600);
    expect(store.notices(id).filter((n) => n.kind === "budget.threshold").map((n) => n.text).join("\n")).toContain("52% of its tokens budget");
    port.tokens.set("thr_study", 7000);
    clock.advance(120_000);
    await engine.tick();
    await engine.tick();
    const s = store.study(id)!;
    expect(s.state).toBe("paused");
    expect(s.pause_reason).toContain("max_tokens reached");
    expect(s.pause_reason).toContain("bb study harvest toy-size");
    const kinds = store.notices(id).map((n) => n.kind);
    expect(kinds.filter((k) => k === "budget.threshold")).toHaveLength(2);
    expect(kinds).toContain("budget.exhausted");
    expect(usageView(engine, s).tokens).toBe(6000);
  });

  it("milestone notices: a new best marks the study thread unread; stalls and broken oracles get their own kinds", async () => {
    engine.addIdea("toy-size", { title: "Idea one", theme: "a" }, "human");
    await engine.settle();
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    await engine.submit("thr_w1", "drop trailing whitespace");
    await engine.settle();
    expect(store.candidateByN(id, 1)!.verdict).toBe("win");
    await waitFor(() => store.notices(id).some((n) => n.kind === "best.new"));
    const best = store.notices(id).find((n) => n.kind === "best.new")!;
    expect(best.text).toContain("New best");
    expect(best.text).toContain("c/1");
    expect(port.unread).toContain("thr_study");
    await engine.systemPause(id, "oracle broken: measuring best failed");
    expect(store.notices(id)[0]!.kind).toBe("oracle.broken");
  });

  it("RPC view models: findings search, oracle (versions, pending diff, no holdout), bench, harvest", async () => {
    engine.addIdea("toy-size", { title: "Idea one", theme: "alloc" }, "human");
    await engine.settle();
    store.addFinding({ study_id: id, idea_id: 1, candidate_id: null, thread_id: "thr_w1", outcome: "no_effect", learned: "The allocator is not hot", revisit_if: "profile changes", evidence: "" }, "thr_w1");
    store.addFinding({ study_id: id, idea_id: 1, candidate_id: null, thread_id: "thr_w1", outcome: "improved", learned: "Whitespace dominated", revisit_if: "", evidence: "" }, "thr_w1");
    const s = store.study(id)!;
    const f = findingsView(engine, s, { query: "allocator" });
    expect(f.total).toBe(2);
    expect(f.findings.map((x) => x.learned)).toEqual(["The allocator is not hot"]);
    expect(f.outcomes.map((o) => o.value).sort()).toEqual(["improved", "no_effect"]);
    expect(f.themes.map(({ value, count }) => ({ value, count }))).toEqual([{ value: "alloc", count: 2 }]);
    expect(findingsView(engine, s, { outcome: "improved" }).findings).toHaveLength(1);
    // A revised spec after the run started is pending: the view shows its diff and the CLI command.
    await engine.proposeStudy("thr_study", "proj_1", SPEC_NOISY('\n[oracle.holdout]\nmeasure = "holdout run --secret-workload"\n').replace("max_candidates = 10", "max_candidates = 12"));
    const o = oracleView(engine, store.study(id)!);
    expect(o.versions.map((v) => [v.version, v.active, v.pending])).toEqual([
      [2, false, true],
      [1, true, false],
    ]);
    expect(o.pending!.changesOracle).toBe(true);
    expect(o.pending!.command).toBe("bb study calibrate toy-size");
    expect(o.pending!.diff.some((d) => d.op === "add" && d.text.includes("max_candidates = 12"))).toBe(true);
    expect(JSON.stringify(o)).not.toContain("secret-workload");
    expect(o.segments).toHaveLength(1);
    expect(o.calibration.status).toBe("ready");
    expect(redactedSpecToml('[oracle]\nmeasure = "m"\nholdout = { measure = "secret" }\n').toml).not.toContain("secret");
    const b = benchView(engine, s);
    expect(b.health.length).toBeGreaterThan(0);
    expect(b.hosts).toHaveLength(1);
    expect(b.intervals.some((i) => i.kind === "calibration")).toBe(true);
    const hv = harvestView(engine, s);
    // No promotion yet: harvest can't start, and the view says why.
    expect(hv).toMatchObject({ harvest: null, canStart: false, promotions: 0, startCommand: "bb study harvest toy-size" });
    expect(hv.cannotStartReason).toMatch(/no candidate has been promoted/u);
  });

  it("harvest needs a best; report section renders the interaction warning from stored results", async () => {
    expect(() => engine.startHarvest("toy-size", "human")).not.toThrow();
    const h = store.latestHarvest(id)!;
    // Seed a finished harvest whose contributions don't add up.
    const c1 = store.insertChangeset({ harvest_id: h.id, study_id: id, k: 1, title: "One", rationale: "", candidates_json: "[1]", commits_json: '["aaaaaaa"]', paths_json: '["src/a"]' });
    const c2 = store.insertChangeset({ harvest_id: h.id, study_id: id, k: 2, title: "Two", rationale: "", candidates_json: "[2]", commits_json: '["bbbbbbb"]', paths_json: '["src/b"]' });
    engine.harvester.cancel(h.id);
    store.updateChangeset(c1.id, { ablation_status: "measured", contribution: 0.05, ci_lo: 0.04, ci_hi: 0.06 });
    store.updateChangeset(c2.id, { ablation_status: "measured", contribution: 0.05, ci_lo: 0.04, ci_hi: 0.06 });
    store.updateHarvest(h.id, { state: "ready", total_effect: 0.2, total_ci_lo: 0.19, total_ci_hi: 0.21, total_guardrails_json: JSON.stringify({ rss: { value: 0.04, lo: 0.03, hi: 0.05, n: 6 } }) });
    store.updateChangeset(c1.id, { guardrails_json: JSON.stringify({ rss: { value: 0.03, lo: 0.02, hi: 0.04, n: 6 } }) });
    const text = harvestSection(engine.ctx, store.study(id)!, store.spec(store.study(id)!), store.harvest(h.id)!).join("\n");
    expect(text).toContain("Interaction warning");
    // Guardrails at harvest: the whole study's cost (base vs best, measured directly) and each changeset's, relative to best.
    expect(text).toContain("### Guardrails at harvest");
    expect(text).toMatch(/- rss: best: 4\.2% worse than base \(CI 3\.1% to 5\.3% worse\), measured directly \(total limit 5\.0%\); per changeset: #1 3\.0% worse \(CI 2\.0% to 4\.0% worse\)\./u);
    // 0.1 of a 0.2 total: half the gain, in shares (the convention), not raw relative-to-best numbers.
    expect(text).toContain("Explained by the 2 measured term(s): 50.0% of the gain");
    expect(text).toContain("| 1 | One | c/1 | 25.0% of the gain (CI 20.0% to 30.0%)");
    expect(harvestView(engine, store.study(id)!).harvest!.accounting.interaction).toBe(true);
  });
});

describe("RPC handlers (plugin harness)", () => {
  let harness: ReturnType<typeof createFakePluginHost>["harness"];
  let engine!: Engine;
  beforeEach(async () => {
    const host = new FakeHost();
    const port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    const fake = createFakePluginHost({ pluginId: "autoresearch", agentSkillIds: ["study-create", "autoresearch"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0, harvestPollMs: 5, harvestGroupGraceMs: 0 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec() }, { threadId: "thr_study", projectId: "proj_1" });
    await harness.behavior.runCli(["calibrate", "toy-size", "--wait"]);
    await harness.behavior.runCli(["start", "toy-size"]);
  });
  afterEach(async () => {
    await harness.lifecycle.dispose();
  });

  it("study.findings / oracle / bench / harvest / report answer; study.harvest.start runs a dry-run harvest and is audited", async () => {
    const call = (m: string, input: unknown) => harness.behavior.callRpc(m as never, input as never) as Promise<any>;
    expect((await call("study.findings", { slug: "toy-size", query: "x" })).total).toBe(0);
    expect((await call("study.oracle", { slug: "toy-size" })).activeToml).toContain("[study]");
    expect((await call("study.bench", { slug: "toy-size" })).hosts).toHaveLength(1);
    expect((await call("study.report", { slug: "toy-size" })).markdown).toContain("# Study report: toy-size");
    const started = await call("study.harvest.start", { slug: "toy-size" });
    expect(started.ok).toBe(true);
    expect(started.message).toContain("harvesting (h1, dry run)");
    await engine.waitForHarvest("toy-size", 10_000);
    const v = await call("study.harvest", { slug: "toy-size" });
    // No promotions yet: the harvest is ready with nothing to draft.
    expect(v.harvest.state).toBe("ready");
    expect(v.harvest.changesets).toEqual([]);
    expect(engine.ctx.store.events(engine.study("toy-size").id, { kinds: ["control.harvest"] })).toHaveLength(1);
    // Publishing is CLI-only, and refuses without a GitHub remote.
    const pub = await harness.behavior.runCli(["harvest", "toy-size", "--publish"]).catch((e: Error) => ({ exitCode: 1, stdout: "", stderr: e.message }));
    expect(pub.exitCode).not.toBe(0);
    expect(`${pub.stderr ?? ""}`).toContain("publish refused");
    // The refusal says what to run next.
    expect(`${pub.stderr ?? ""}`).toContain("`bb study harvest toy-size`");
  });
});
