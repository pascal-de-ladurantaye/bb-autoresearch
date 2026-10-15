// [scope] ignore: worker snapshots never commit untracked build outputs and
// caches, and the scope check rejects a candidate that still adds them (the
// toy-m3 failure: a repo without .gitignore got __pycache__/*.pyc committed
// into candidates, which then conflicted).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackedIgnoredWarning } from "../src/calibration.ts";
import { Engine } from "../src/engine.ts";
import * as ops from "../src/host/ops.ts";
import { checkScope, ignoreGlobs, matchesIgnore } from "../src/scope.ts";
import { DEFAULT_IGNORE, parseSpec } from "../src/spec.ts";
import { DETERMINISTIC_SPEC, FakeHost, fakeHostSpec, makeCtx } from "./helpers.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

describe("spec and patterns", () => {
  it("defaults cover Python, Node, Rust/Java and coverage outputs; a list replaces them; bad patterns are refused", () => {
    const r = parseSpec(DETERMINISTIC_SPEC);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.spec.scope.ignore).toEqual([...DEFAULT_IGNORE]);
    for (const p of ["__pycache__/", "*.pyc", "node_modules/", "dist/", "build/", "target/", ".DS_Store", "coverage/", ".coverage"]) expect(r.spec.scope.ignore).toContain(p);
    const custom = parseSpec(DETERMINISTIC_SPEC.replace('protected = ["bench/**"]', 'protected = ["bench/**"]\nignore = ["out/"]'));
    expect(custom.ok && custom.spec.scope.ignore).toEqual(["out/"]);
    const off = parseSpec(DETERMINISTIC_SPEC.replace('protected = ["bench/**"]', 'protected = ["bench/**"]\nignore = []'));
    expect(off.ok && off.spec.scope.ignore).toEqual([]);
    for (const bad of ['"!keep.pyc"', '"../x"', "\"a'b\"", '"/"']) {
      expect(parseSpec(DETERMINISTIC_SPEC.replace('protected = ["bench/**"]', `protected = ["bench/**"]\nignore = [${bad}]`)).ok).toBe(false);
    }
  });
  it("gitignore semantics: no slash matches at any depth, a slash anchors, a trailing slash means directories", () => {
    expect(ignoreGlobs("__pycache__/")).toEqual(["**/__pycache__/**"]);
    expect(ignoreGlobs("*.pyc")).toEqual(["**/*.pyc", "**/*.pyc/**"]);
    expect(ignoreGlobs("/build/")).toEqual(["build/**"]);
    expect(ignoreGlobs("out/gen")).toEqual(["out/gen", "out/gen/**"]);
    const d = [...DEFAULT_IGNORE];
    expect(matchesIgnore("src/__pycache__/toy.cpython-312.pyc", d)).toBe(true);
    expect(matchesIgnore("toy.pyc", d)).toBe(true);
    expect(matchesIgnore("web/node_modules/x/index.js", d)).toBe(true);
    expect(matchesIgnore(".DS_Store", d)).toBe(true);
    expect(matchesIgnore("a/.DS_Store", d)).toBe(true);
    expect(matchesIgnore("src/build.py", d)).toBe(false);
    expect(matchesIgnore("src/toy.py", d)).toBe(false);
    expect(matchesIgnore("lib/build", ["/build/"])).toBe(false);
  });
  it("the scope check rejects added ignored files with a message that says what to do; modified tracked ones pass", () => {
    const rules = { editable: ["src/**"], protected: ["bench/**"], max_files: 50, max_lines: 2000, ignore: [...DEFAULT_IGNORE] };
    const r = checkScope(rules, { changedPaths: ["src/toy.py", "src/__pycache__/toy.pyc"], addedPaths: ["src/__pycache__/toy.pyc"], linesAdded: 2, linesDeleted: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons[0]).toContain("adds files the study ignores as build outputs or caches");
      expect(r.reasons[0]).toContain("src/__pycache__/toy.pyc");
      expect(r.reasons[0]).toContain("git rm -r --cached <path>");
    }
    expect(checkScope(rules, { changedPaths: ["src/build/gen.txt"], addedPaths: [], linesAdded: 1, linesDeleted: 1 }).ok).toBe(true);
  });
});

describe("snapshot against real git (no .gitignore)", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ar-ignore-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/toy.py"), "x = 1\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("leaves out build outputs at any depth, keeps sources and tracked changes, and reports what it left out", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src/toy.py"), "x = 2\n");
    writeFileSync(join(repo, "src/new.py"), "y = 1\n");
    mkdirSync(join(repo, "src/__pycache__"));
    writeFileSync(join(repo, "src/__pycache__/toy.cpython-312.pyc"), "bytecode");
    mkdirSync(join(repo, "node_modules/x"), { recursive: true });
    writeFileSync(join(repo, "node_modules/x/index.js"), "js");
    writeFileSync(join(repo, ".DS_Store"), "mac");
    writeFileSync(join(repo, "stray.pyc"), "bc");
    const snap = await ops.snapshot({ worktreePath: repo, message: "c1", candidateRef: "refs/studies/t/c/1", baseSha: base, ignore: [...DEFAULT_IGNORE] });
    expect(snap.committed).toBe(true);
    expect(snap.changedPaths.sort()).toEqual(["src/new.py", "src/toy.py"]);
    expect(snap.addedPaths).toEqual(["src/new.py"]);
    expect(snap.ignoredPaths!.sort()).toEqual([".DS_Store", "node_modules/x/index.js", "src/__pycache__/toy.cpython-312.pyc", "stray.pyc"]);
    expect(sh(repo, "ls-tree", "-r", "--name-only", snap.sha).split("\n").sort()).toEqual(["src/new.py", "src/toy.py"]);
    // Only build outputs left: nothing to commit.
    const again = await ops.snapshot({ worktreePath: repo, message: "c2", candidateRef: "refs/studies/t/c/2", baseSha: base, ignore: [...DEFAULT_IGNORE] });
    expect(again).toMatchObject({ committed: false, sha: snap.sha });
  });

  it("a build output the worker committed itself is reported as added (and the scope check rejects it)", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    mkdirSync(join(repo, "src/__pycache__"));
    writeFileSync(join(repo, "src/__pycache__/toy.pyc"), "bytecode");
    sh(repo, "add", "-f", "src/__pycache__/toy.pyc");
    sh(repo, "commit", "-qm", "oops");
    const snap = await ops.snapshot({ worktreePath: repo, message: "c1", candidateRef: "refs/studies/t/c/1", baseSha: base, ignore: [...DEFAULT_IGNORE] });
    expect(snap.addedPaths).toEqual(["src/__pycache__/toy.pyc"]);
    expect(checkScope({ editable: ["src/**"], protected: [], max_files: 50, max_lines: 2000, ignore: [...DEFAULT_IGNORE] }, snap).ok).toBe(false);
  });

  it("modifications to tracked files under an ignore pattern are still committed", async () => {
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build/gen.sh"), "echo 1\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "tracked build dir");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "build/gen.sh"), "echo 2\n");
    writeFileSync(join(repo, "build/new.sh"), "echo 3\n");
    const snap = await ops.snapshot({ worktreePath: repo, message: "c1", candidateRef: "refs/studies/t/c/1", baseSha: base, ignore: [...DEFAULT_IGNORE] });
    expect(snap.changedPaths).toEqual(["build/gen.sh"]);
    expect(snap.ignoredPaths).toEqual(["build/new.sh"]);
    // Calibration warns that the base tracks files under an ignore pattern.
    const warn = await trackedIgnoredWarning({ exec: (i) => ops.exec(i) }, repo, base, [...DEFAULT_IGNORE]);
    expect(warn[0]).toContain("the baseline tracks file(s) matching [scope] ignore (build/gen.sh)");
    expect(await trackedIgnoredWarning({ exec: (i) => ops.exec(i) }, repo, base, ["dist/"])).toEqual([]);
  });
});

describe("pipeline: the ignore list reaches the snapshot; the worker hears what was left out or why it was rejected", () => {
  it("submission", async () => {
    const host = new FakeHost();
    const made = makeCtx(host);
    const engine = new Engine(made.ctx);
    host.refs.set("main", host.commit("T0", null, "base"));
    host.metric.set("T0", 1000);
    made.port.addThread("thr_study");
    await engine.proposeStudy("thr_study", "proj_1", fakeHostSpec());
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 5_000);
    engine.addIdea("toy-size", { title: "Shrink" }, "human");
    await engine.start("toy-size", "human");
    await engine.settle();
    host.metric.set("T1", 900);
    host.nextSnapshot = { tree: "T1", changedPaths: ["src/a.py"], addedPaths: [], ignoredPaths: ["src/__pycache__/a.cpython-312.pyc"] };
    const ticket = await engine.submit("thr_w1", { title: "first" });
    expect(host.snapshotInputs.at(-1)!.ignore).toEqual([...DEFAULT_IGNORE]);
    expect(ticket).toContain("Left out 1 untracked build output(s) or cache file(s) matching [scope] ignore (e.g. src/__pycache__/a.cpython-312.pyc); they are never committed.");
    await engine.settle();
    host.nextSnapshot = { tree: "T2", changedPaths: ["src/a.py", "src/__pycache__/a.pyc"], addedPaths: ["src/__pycache__/a.pyc"] };
    const rejected = await engine.submit("thr_w1", { title: "second" });
    expect(rejected).toContain("Rejected (scope)");
    expect(rejected).toContain("adds files the study ignores as build outputs or caches");
  });
});
