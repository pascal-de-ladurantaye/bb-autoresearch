// v1, agents own commits, harvest and publishing: worker-written commit
// messages; harvest as a freeze; `bb study measure`, `gate`, `results` and
// `evidence` (the plugin's trust-boundary primitives); reconciliation of
// interrupted runs and of harvests the plugin was still running before 1.0.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoresearchPlugin } from "../server.ts";
import { candidateCommitMessage, candidateFromMessage, checkCommitMessage, commitParts } from "../src/commit.ts";
import { Engine } from "../src/engine.ts";
import { EVIDENCE_FORMAT, EVIDENCE_VERSION, studyEvidence } from "../src/evidence.ts";
import type { MeasureResult, GateResult } from "../src/primitives.ts";
import { validRef } from "../src/primitives.ts";
import type { SpawnWorkerArgs } from "../src/ports.ts";
import { candidateDetail } from "../src/views.ts";
import { DETERMINISTIC_SPEC, FakeHost, FakePort, fakeHostSpec, localRunner, makeCtx, waitFor } from "./helpers.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ text?: string }> };
  return r.content?.map((c) => c.text ?? "").join("") ?? "";
}

describe("commit messages are the worker's", () => {
  it("checks the title (one line, at most 72 characters) and keeps the body free of the plugin's trailers", () => {
    expect(checkCommitMessage("  Cache parsed headers per request  ", "Why: the parser ran twice.\n\n")).toEqual({ ok: true, title: "Cache parsed headers per request", body: "Why: the parser ran twice." });
    expect(checkCommitMessage("x".repeat(72), null)).toMatchObject({ ok: true, body: null });
    expect(checkCommitMessage("x".repeat(73), null)).toMatchObject({ ok: false, reason: expect.stringContaining("73 characters") });
    expect(checkCommitMessage("", null)).toMatchObject({ ok: false, reason: expect.stringContaining("empty") });
    expect(checkCommitMessage("two\nlines", null)).toMatchObject({ ok: false, reason: expect.stringContaining("one line") });
    expect(checkCommitMessage("ok", "text\nAutoresearch-Candidate: c/9")).toMatchObject({ ok: false, reason: expect.stringContaining("trailer") });
    expect(checkCommitMessage("ok", "y".repeat(4001))).toMatchObject({ ok: false });
  });

  it("builds the message verbatim plus trailers, maps it back to the candidate, and falls back for candidates from before 1.0", () => {
    const msg = candidateCommitMessage("toy", { n: 4, commit_title: "Skip the second parse", commit_body: "It ran twice per request.", summary: "ignored" });
    expect(msg).toBe("Skip the second parse\n\nIt ran twice per request.\n\nAutoresearch-Study: toy\nAutoresearch-Candidate: c/4");
    expect(candidateCommitMessage("toy", { n: 5, commit_title: "Title only", commit_body: null, summary: "" })).toBe("Title only\n\nAutoresearch-Study: toy\nAutoresearch-Candidate: c/5");
    expect(candidateFromMessage(msg, "toy")).toBe(4);
    // Another study's commit on the same repository is not this study's candidate.
    expect(candidateFromMessage(msg, "other")).toBeNull();
    // Before v1: the idea title (or the summary's first line) and the summary as the body.
    expect(commitParts({ n: 2, commit_title: null, commit_body: null, summary: "Drop the padding\nmore" }, "Idea title")).toEqual({ title: "Idea title", body: "Drop the padding\nmore" });
    expect(commitParts({ n: 2, commit_title: null, commit_body: null, summary: "Drop the padding" })).toMatchObject({ title: "Drop the padding" });
  });

  it("refs agents may pass", () => {
    for (const r of ["best", "base", "c/12", "best~2", "abc1234", "studies/x/best", "split/1", "HEAD^"]) expect(validRef(r)).toBe(true);
    for (const r of ["--upload-pack=x", "a b", "a..b", "$(x)", ""]) expect(validRef(r)).toBe(false);
  });
});

describe("primitives and evidence through the CLI (fake host)", () => {
  let harness: Harness;
  let host: FakeHost;
  let port: FakePort;
  let engine!: Engine;

  async function setup(spec = DETERMINISTIC_SPEC) {
    host = new FakeHost();
    port = new FakePort(host);
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    port.addThread("thr_study");
    port.addThread("thr_agent");
    const fake = createFakePluginHost({ pluginId: "bb-autoresearch", agentSkillIds: ["study-create", "autoresearch", "study-harvest"] });
    await createAutoresearchPlugin({ port: () => port, seed: 1, config: { retryDelayMs: 0, harvestPollMs: 5 }, onEngine: (e) => (engine = e) })(fake.bb);
    harness = fake.harness;
    expect(text(await harness.behavior.callAgentTool("study_propose", { spec_toml: fakeHostSpec(spec) }, { threadId: "thr_study", projectId: "proj_1" }))).toContain("drafted with spec v1");
    await cli(["calibrate", "toy-size", "--wait"]);
    await cli(["ideas", "add", "toy-size", "Shrink the output"]);
    await cli(["start", "toy-size"]);
    await waitFor(() => port.threads.has("thr_w1") && port.spawned.length >= 1);
  }
  const cli = (args: string[], threadId?: string) => harness.behavior.runCli(args, threadId ? { threadId } : undefined);
  const json = async (args: string[], threadId?: string) => {
    const r = await cli([...args, "--json"], threadId);
    expect(r.exitCode, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout) as Record<string, any>;
  };
  const study = () => engine.study("toy-size");

  /** One win (base 1000 → 800) with the worker's own commit message. */
  async function win() {
    host.nextSnapshot = { tree: "T1" };
    host.metric.set("T1", 800);
    const r = await harness.behavior.callAgentTool("study_submit_candidate", { title: "Drop trailing whitespace", body: "Every line ended in padding.\nChecked: the toy test passes." }, { threadId: "thr_w1" });
    expect(text(r)).toContain("Submitted as c/1");
    await waitFor(() => engine.ctx.store.candidateByN(study().id, 1)?.stage === "decided");
    expect(engine.ctx.store.candidateByN(study().id, 1)!.verdict).toBe("win");
  }

  afterEach(async () => {
    await harness?.lifecycle.dispose();
  });

  it("the worker's title and body are the candidate commit and the promotion on best, verbatim, with only the trailers added", async () => {
    await setup();
    // A title that breaks the rules commits nothing and says why.
    host.nextSnapshot = { tree: "T9" };
    const refused = await harness.behavior.callAgentTool("study_submit_candidate", { title: "x".repeat(80) }, { threadId: "thr_w1" });
    expect(text(refused)).toContain("Not submitted: the commit title is 80 characters");
    expect(engine.ctx.store.candidateCount(study().id)).toBe(0);
    await win();
    const c = engine.ctx.store.candidateByN(study().id, 1)!;
    const expected = "Drop trailing whitespace\n\nEvery line ended in padding.\nChecked: the toy test passes.\n\nAutoresearch-Study: toy-size\nAutoresearch-Candidate: c/1";
    expect(host.commits.get(c.sha)!.message).toBe(expected);
    expect(host.commits.get(c.prepared_sha!)!.message).toBe(expected);
    // The promotion on best: same message, no measured numbers and no idea title.
    expect(host.commits.get(study().best_sha!)!.message).toBe(expected);
    expect(c).toMatchObject({ commit_title: "Drop trailing whitespace", commit_body: "Every line ended in padding.\nChecked: the toy test passes." });
    // The candidate page shows it.
    const detail = await candidateDetail(engine, study(), 1);
    expect(detail!.commit).toEqual({ title: "Drop trailing whitespace", body: "Every line ended in padding.\nChecked: the toy test passes.", fromWorker: true });
    expect(detail!.title).toBe("Drop trailing whitespace");
  });

  it("harvest freezes best: promotions with their messages, a pinned ref, and a notice that points at an agent", async () => {
    await setup();
    await win();
    const started = await json(["harvest", "toy-size", "--wait"]);
    expect(started.harvest).toMatchObject({ state: "frozen", legacy: false, frozenRef: "refs/studies/toy-size/harvest/h1" });
    expect(started.harvest.promotions).toEqual([expect.objectContaining({ n: 1, title: "Drop trailing whitespace", body: "Every line ended in padding.\nChecked: the toy test passes.", effect: expect.closeTo(0.2, 6) })]);
    expect(host.refs.get("refs/studies/toy-size/harvest/h1")).toBe(study().best_sha);
    const notice = engine.ctx.store.notices(study().id).find((n) => n.kind === "harvest.frozen")!;
    expect(notice.text).toContain("study-harvest skill");
    expect(notice.text).toContain("bb study evidence toy-size --json");
    // Already frozen: asking again shows it (a read, so the study thread may ask too).
    const again = await cli(["harvest", "toy-size"], "thr_study");
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("Harvest h1 of toy-size · frozen");
    // Keep exploring: the frozen ref stays.
    expect((await json(["resume", "toy-size"])).message).toContain("frozen best stays pinned");
    expect(host.refs.get("refs/studies/toy-size/harvest/h1")).toBeTruthy();
  });

  it("bb study measure: B against A with the study's protocol and guardrails, on its bench host, audited and counted as bench time", async () => {
    await setup();
    await win();
    await json(["harvest", "toy-size", "--wait"]);
    const before = engine.ctx.store.budget(study()).bench_seconds;
    const r = await json(["measure", "toy-size", "base", "best"], "thr_agent");
    const run = r.run;
    expect(run).toMatchObject({ seq: 1, kind: "measure", refA: "base", refB: "best", state: "done", actor: "thr_agent" });
    const m = run.result as MeasureResult;
    expect(m).toMatchObject({ kind: "measure", noise: "deterministic", classification: "win", a: { ref: "base", sha: study().base_sha }, b: { ref: "best", sha: study().best_sha }, host: { name: expect.stringContaining("local") } });
    expect(m.effect).toBeCloseTo(0.2, 6);
    expect(m.metrics.a.size).toBe(1000);
    expect(m.metrics.b.size).toBe(800);
    expect(Object.keys(m.guardrails)).toEqual(["rss"]);
    expect(m.guardrails.rss!.state).toBe("ok");
    expect(m.samples.map((s) => s.side).sort()).toEqual(["a", "b"]);
    expect(m.text).toMatch(/^B \(best\) vs A \(base\): 20\.0% lower size/u);
    // The reverse is a loss.
    const back = (await json(["measure", "toy-size", "best", "base"], "thr_agent")).run.result as MeasureResult;
    expect(back.classification).toBe("lose");
    // Audited: who asked and what came out; bench time counted.
    const id = study().id;
    expect(engine.ctx.store.events(id, { kinds: ["control.measure"] })).toHaveLength(2);
    expect(JSON.parse(engine.ctx.store.events(id, { kinds: ["measure.adhoc_finished"] })[0]!.data_json)).toMatchObject({ classification: expect.any(String), host: expect.any(String) });
    expect(engine.ctx.store.events(id, { kinds: ["control.measure"] })[0]!.actor).toBe("thr_agent");
    expect(engine.ctx.store.budget(study()).bench_seconds).toBeGreaterThan(before);
    expect(engine.ctx.store.adhocRuns(id).every((x) => x.bench_seconds > 0)).toBe(true);
    // Text output, the results list, and one run by id.
    expect((await cli(["results", "toy-size"])).stdout).toMatch(/r2 measure B base vs A best: .*lose/u);
    expect((await json(["results", "toy-size", "r1"])).run.result.classification).toBe("win");
    // --pairs applies to noisy oracles only; an unknown ref and an unknown host say what's wrong.
    expect((await cli(["measure", "toy-size", "base", "best", "--pairs", "4"])).stderr).toContain("--pairs applies to noisy oracles");
    expect((await cli(["measure", "toy-size", "base", "nope"])).stderr).toContain('"nope" does not name a commit');
    expect((await cli(["measure", "toy-size", "base", "best", "--host", "elsewhere"])).stderr).toContain('no active bench host "elsewhere"');
    expect((await cli(["measure", "toy-size", "--x", "best"])).exitCode).not.toBe(0);
  });

  it("bb study gate: pass, a failure with its output tail, and a flaky pass; a worker can't ask", async () => {
    await setup();
    await win();
    await json(["harvest", "toy-size", "--wait"]);
    const ok = (await json(["gate", "toy-size", "c/1"])).run.result as GateResult;
    expect(ok).toMatchObject({ kind: "gate", ok: true, commands: [{ command: "gate run", ok: true, flaky: false }] });
    host.gateFailures.set("T1", 1);
    const flaky = (await json(["gate", "toy-size", "best"])).run.result as GateResult;
    expect(flaky).toMatchObject({ ok: true, commands: [{ ok: true, flaky: true }] });
    expect(flaky.text).toContain("1 flaky");
    host.gateFailures.set("T1", 2);
    const failed = await cli(["gate", "toy-size", "best"]);
    expect(failed.stdout).toContain("gate failed: gate run exited 1");
    expect(failed.stdout).toContain("assertion failed");
    // Workers measure through their submissions only.
    const worker = await cli(["gate", "toy-size", "best"], "thr_w1");
    expect(worker.exitCode).not.toBe(0);
    expect(worker.stderr).toContain("study workers can't request measurements or gates");
    expect((await cli(["measure", "toy-size", "base", "best"], "thr_w1")).exitCode).not.toBe(0);
  });

  it("while the study runs workers, a request is refused unless the bench is idle; --detach returns at once", async () => {
    await setup();
    await win();
    // The worker is still live; a candidate waiting for the bench makes it busy.
    const c = engine.ctx.store.candidateByN(study().id, 1)!;
    engine.ctx.store.updateCandidate(c.id, { stage: "queued" });
    const busy = await cli(["measure", "toy-size", "base", "best"]);
    expect(busy.exitCode).not.toBe(0);
    expect(busy.stderr).toMatch(/running 1 worker\(s\) and its bench is busy \(1 candidate\(s\) testing, queued or measuring\)/u);
    expect(busy.stderr).toContain("bb study pause toy-size");
    engine.ctx.store.updateCandidate(c.id, { stage: "decided" });
    // Idle bench: allowed even while running.
    const detached = await json(["measure", "toy-size", "base", "best", "--detach"]);
    expect(["queued", "running", "done"]).toContain(detached.run.state);
    const done = await json(["results", "toy-size", `r${detached.run.seq}`, "--wait"]);
    expect(done.run.state).toBe("done");
    // Drafts can't be measured: nothing is calibrated.
    expect(engine.primitives.refusal({ ...study(), state: "draft" }, 0)).toContain("is a draft");
    expect(engine.primitives.refusal({ ...study(), state: "archived" }, 0)).toContain("archived");
  });

  it("bb study evidence --json: the stable document, with commit messages, promotions, runs, and never the holdout", async () => {
    await setup(DETERMINISTIC_SPEC.replace('noise = "deterministic"', 'noise = "deterministic"\n\n[oracle.holdout]\nmeasure = "holdout run --secret-workload"'));
    await win();
    await json(["harvest", "toy-size", "--wait"]);
    await json(["measure", "toy-size", "base", "best"]);
    engine.ctx.store.addFinding({ study_id: study().id, idea_id: 1, candidate_id: engine.ctx.store.candidateByN(study().id, 1)!.id, thread_id: "thr_w1", outcome: "improved", learned: "Padding dominated the output", revisit_if: "", evidence: "" }, "thr_w1");
    const doc = await json(["evidence", "toy-size"]);
    expect(doc).toMatchObject({ format: EVIDENCE_FORMAT, version: EVIDENCE_VERSION });
    expect(Object.keys(doc)).toEqual(["format", "version", "generatedAt", "study", "git", "promotions", "promotionsError", "segments", "benchHosts", "candidates", "findings", "ideas", "harvests", "runs", "budget"]);
    expect(doc.study).toMatchObject({ slug: "toy-size", metric: { name: "size", direction: "lower" }, noise: "deterministic", holdout: true, gates: ["gate run"] });
    expect(doc.git).toMatchObject({ base: study().base_sha, best: study().best_sha, bestBranch: "studies/toy-size/best", frozen: { harvest: 1, ref: "refs/studies/toy-size/harvest/h1", best: study().best_sha } });
    expect(doc.promotions).toEqual([{ sha: study().best_sha, n: 1, title: "Drop trailing whitespace", body: "Every line ended in padding.\nChecked: the toy test passes.", paths: expect.any(Array) }]);
    const c1 = doc.candidates[0];
    expect(c1).toMatchObject({ n: 1, ref: "refs/studies/toy-size/c/1", verdict: "win", commit: { title: "Drop trailing whitespace", fromWorker: true }, idea: { id: 1, title: "Shrink the output" }, stats: { files: 1, linesAdded: 3, linesDeleted: 1 }, holdout: "pass", benchHost: expect.stringContaining("local") });
    expect(c1.effect).toBeCloseTo(0.2, 6);
    expect(c1.guardrails.rss).toMatchObject({ state: "ok" });
    expect(c1.findings).toHaveLength(1);
    expect(c1).not.toHaveProperty("samples");
    expect(doc.findings[0]).toMatchObject({ candidate: 1, outcome: "improved" });
    expect(doc.runs[0]).toMatchObject({ id: "r1", kind: "measure", a: { ref: "base" }, b: { ref: "best" }, state: "done", result: { classification: "win" } });
    expect(doc.harvests).toEqual([expect.objectContaining({ seq: 1, state: "frozen", legacy: false })]);
    // Never the holdout's command or numbers.
    expect(JSON.stringify(doc)).not.toContain("secret-workload");
    // Samples on request; a subset of candidates.
    const withSamples = await json(["evidence", "toy-size", "--samples", "--candidates", "c/1"]);
    expect(withSamples.candidates).toHaveLength(1);
    expect(withSamples.candidates[0].samples.length).toBeGreaterThan(0);
    expect(withSamples.candidates[0].samples[0]).toMatchObject({ run: expect.any(String), side: expect.stringMatching(/best|candidate/u), metrics: { size: expect.any(Number) } });
    // The text form is a short summary.
    expect((await cli(["evidence", "toy-size"])).stdout).toContain("Promotions on best (1, oldest first)");
  });

  it("evidence too large for one CLI response is written whole to a file", async () => {
    await setup();
    await win();
    const s = study();
    // Inflate the document: many findings with long text.
    for (let i = 0; i < 80; i++) engine.ctx.store.addFinding({ study_id: s.id, idea_id: 1, candidate_id: null, thread_id: "thr_w1", outcome: "no_effect", learned: "x".repeat(4000), revisit_if: "", evidence: "" }, "thr_w1");
    const r = await json(["evidence", "toy-size"]);
    expect(r).toEqual({ format: EVIDENCE_FORMAT, version: EVIDENCE_VERSION, file: "/exports/toy-size-evidence/evidence.json", bytes: expect.any(Number) });
    const file = host.exports.get("toy-size-evidence")![0]!;
    expect(JSON.parse(file.content).findings).toHaveLength(80);
  });

  it("a reload fails interrupted runs and stops a harvest the plugin was running before 1.0, keeping it readable", async () => {
    await setup();
    await win();
    const s = study();
    const { store } = engine.ctx;
    const run = store.insertAdhocRun({ study_id: s.id, kind: "measure", ref_a: "base", ref_b: "best", sha_a: s.base_sha, sha_b: s.best_sha!, host_id: "local", pairs: null, actor: "thr_agent" });
    store.updateAdhocRun(run.id, { state: "running" });
    store.setStudyState(s.id, "harvesting", "test");
    const h = store.insertHarvest({ study_id: s.id, from_state: "paused" }, "test");
    store.updateHarvest(h.id, { state: "ablating", base_sha: s.base_sha, best_sha: s.best_sha, promotions_json: "[]", grouping_source: "strategist" });
    store.insertChangeset({ harvest_id: h.id, study_id: s.id, k: 1, title: "One", rationale: "", candidates_json: "[1]", commits_json: "[]", paths_json: "[]" });
    await engine.reconcile();
    expect(store.adhocRun(run.id)).toMatchObject({ state: "failed", error: expect.stringContaining("interrupted by a plugin reload") });
    expect(store.harvest(h.id)).toMatchObject({ state: "frozen", phase_detail: expect.stringContaining("stopped while ablating") });
    const v = await json(["harvest", "toy-size"]);
    expect(v.harvest).toMatchObject({ state: "frozen", legacy: true });
    expect(v.harvest.changesets).toHaveLength(1);
  });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

describe("with real git (LocalHostRunner)", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ar-v1-"));
    repo = join(root, "repo");
    execFileSync("mkdir", ["-p", join(repo, "src"), join(repo, "bench")]);
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/data.txt"), "hello      world      padding      \n");
    writeFileSync(join(repo, "src/other.txt"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    writeFileSync(join(repo, "bench/measure.sh"), 'printf "METRIC size=%s\\nMETRIC rss=100\\n" "$(cat src/*.txt | wc -c | tr -d " ")"\n');
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a bundled win is frozen, split into two commits by an agent, and each part measured and gated by the plugin", async () => {
    const runner = localRunner(join(root, "data"), "host_test");
    const { ctx, store, port } = makeCtx(runner);
    port.projectCheckout = async () => repo;
    port.spawnWorker = async (args: SpawnWorkerArgs) => {
      const id = `thr_w${port.spawned.length + 1}`;
      port.spawned.push(args);
      const path = join(root, id);
      sh(repo, "worktree", "add", "-q", "-b", `bb/${id}`, path, args.baseBranch);
      port.threads.set(id, { id, status: "active", archivedAt: null, deletedAt: null, environmentId: `env_${id}`, metadata: { ...args.metadata } });
      port.envs.set(`env_${id}`, { id: `env_${id}`, hostId: "host_test", path, branchName: `bb/${id}` });
      return { threadId: id, environmentId: `env_${id}` };
    };
    port.addThread("thr_study");
    const spec = DETERMINISTIC_SPEC.replace('gate = ["gate.sh"]', 'gate = ["test -s src/data.txt"]').replace('measure = "measure.sh"', 'measure = "sh bench/measure.sh"');
    const engine = new Engine(ctx);
    await engine.proposeStudy("thr_study", "proj_1", spec);
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 20_000);
    engine.onThreadIdle("thr_study");
    engine.addIdea("toy-size", { title: "Shrink everything" }, "human");
    await engine.start("toy-size", "human");
    await engine.settle();
    // One candidate that bundles two unrelated changes.
    const wt = join(root, "thr_w1");
    writeFileSync(join(wt, "src/data.txt"), "hello world padding\n");
    writeFileSync(join(wt, "src/other.txt"), "a\n");
    expect(await engine.submit("thr_w1", { title: "Collapse spaces and shorten the filler", body: "Two size wins in one go." })).toContain("Submitted as c/1");
    await engine.settle();
    const study = store.study("toy-size")!;
    expect(store.candidateByN(study.id, 1)!.verdict).toBe("win");
    const best = sh(repo, "rev-parse", "studies/toy-size/best");
    expect(sh(repo, "log", "-1", "--format=%B", best)).toBe("Collapse spaces and shorten the filler\n\nTwo size wins in one go.\n\nAutoresearch-Study: toy-size\nAutoresearch-Candidate: c/1");

    // Freeze.
    engine.pause("toy-size", "human");
    engine.startHarvest("toy-size", "human");
    await engine.waitForHarvest("toy-size", 10_000);
    const h = store.latestHarvest(study.id)!;
    expect(h.state).toBe("frozen");
    expect(sh(repo, "rev-parse", "refs/studies/toy-size/harvest/h1")).toBe(best);
    const evidence = await studyEvidence(ctx, store.study("toy-size")!, store.spec(study));
    expect(evidence.promotions).toEqual([{ sha: best, n: 1, title: "Collapse spaces and shorten the filler", body: "Two size wins in one go.", paths: ["src/data.txt", "src/other.txt"] }]);

    // The agent splits the bundled commit into two, with the repository's own git.
    const base = study.base_sha!;
    sh(repo, "branch", "split/1", base);
    const split = join(root, "split");
    sh(repo, "worktree", "add", "-q", split, "split/1");
    sh(split, "checkout", "-q", best, "--", "src/data.txt");
    sh(split, "commit", "-qm", "Collapse runs of spaces");
    sh(split, "checkout", "-q", best, "--", "src/other.txt");
    sh(split, "commit", "-qm", "Shorten the filler line");
    expect(sh(repo, "rev-parse", "split/1^{tree}")).toBe(sh(repo, "rev-parse", `${best}^{tree}`));

    // Each part measured on its own PR base, and gated.
    const first = await engine.requestMeasure("toy-size", { refA: "base", refB: "split/1~1" }, "thr_agent");
    await engine.primitives.wait(first.id, 20_000);
    const r1 = JSON.parse(store.adhocRun(first.id)!.result_json!) as MeasureResult;
    const second = await engine.requestMeasure("toy-size", { refA: "split/1~1", refB: "split/1" }, "thr_agent");
    await engine.primitives.wait(second.id, 20_000);
    const r2 = JSON.parse(store.adhocRun(second.id)!.result_json!) as MeasureResult;
    expect(r1.classification).toBe("win");
    expect(r2.classification).toBe("win");
    // 77 → 61 bytes, then 61 → 22: the parts compose to the whole.
    expect(r1.metrics).toEqual({ a: expect.objectContaining({ size: 77 }), b: expect.objectContaining({ size: 61 }) });
    expect(r2.metrics.b.size).toBe(22);
    const gate = await engine.requestGate("toy-size", { ref: "split/1~1" }, "thr_agent");
    await engine.primitives.wait(gate.id, 20_000);
    expect((JSON.parse(store.adhocRun(gate.id)!.result_json!) as GateResult).ok).toBe(true);
    await engine.archiveStudy("toy-size", "human");
  });
});
