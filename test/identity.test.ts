// Commit identity in the studied repository ([git] identity): the repo's own
// identity when configured, the plugin's as a fallback (said in the report and
// a notice) or on request, resolved on the edit host and passed explicitly,
// so commits that reach a bench clone as bundles carry the same identity.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import * as bundle from "../src/host/bundle.ts";
import * as ops from "../src/host/ops.ts";
import { PLUGIN_IDENTITY, resolveCommitIdentity } from "../src/identity.ts";
import type { SpawnWorkerArgs } from "../src/ports.ts";
import { oracleHash, parseSpec } from "../src/spec.ts";
import { DETERMINISTIC_SPEC, FakeHost, fakeHostSpec, localRunner, makeCtx } from "./helpers.ts";

/** git without any global or system config, so only the repo's own config counts. */
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ISOLATED, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}
function who(cwd: string, rev: string): string {
  return sh(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>", rev);
}

let root: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  // The host ops inherit process.env: isolate them from this machine's git config.
  for (const [k, v] of Object.entries(ISOLATED)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  root = mkdtempSync(join(tmpdir(), "ar-ident-"));
  repo = join(root, "repo");
  execFileSync("mkdir", ["-p", join(repo, "src"), join(repo, "bench")]);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/data.txt"), "hello      world      padding      \n");
  writeFileSync(join(repo, "bench/measure.sh"), 'printf "METRIC size=%s\\nMETRIC rss=100\\n" "$(wc -c < src/data.txt | tr -d " ")"\n');
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("[git] identity: spec", () => {
  it("defaults to repo, accepts plugin, rejects anything else, and is not part of the oracle hash", () => {
    const d = parseSpec(DETERMINISTIC_SPEC);
    const p = parseSpec(`${DETERMINISTIC_SPEC}\n[git]\nidentity = "plugin"\n`);
    const bad = parseSpec(`${DETERMINISTIC_SPEC}\n[git]\nidentity = "me"\n`);
    expect(d.ok && d.spec.git.identity).toBe("repo");
    expect(p.ok && p.spec.git.identity).toBe("plugin");
    expect(bad.ok).toBe(false);
    if (d.ok && p.ok) expect(oracleHash(p.spec)).toBe(oracleHash(d.spec));
  });
});

describe("[git] identity: host ops against real git", () => {
  it("reads the repo's identity (repo-local config), or nulls when none is configured", async () => {
    expect(await ops.gitIdentityOf(repo)).toEqual({ name: null, email: null });
    const r = { gitIdentity: (path: string) => ops.gitIdentityOf(path) };
    expect(await resolveCommitIdentity(r, repo, { git: { identity: "repo" } })).toEqual({ ...PLUGIN_IDENTITY, source: "fallback" });
    sh(repo, "config", "user.name", "Jane Doe");
    sh(repo, "config", "user.email", "jane@example.com");
    expect(await ops.gitIdentityOf(repo)).toEqual({ name: "Jane Doe", email: "jane@example.com" });
    expect(await resolveCommitIdentity(r, repo, { git: { identity: "repo" } })).toEqual({ name: "Jane Doe", email: "jane@example.com", source: "repo" });
    // "plugin" never asks the host.
    expect(await resolveCommitIdentity({ gitIdentity: () => Promise.reject(new Error("not asked")) }, repo, { git: { identity: "plugin" } })).toEqual({ ...PLUGIN_IDENTITY, source: "plugin" });
  });

  it("snapshot, prepare, reword and compose commit with the identity they are given (default: the plugin's)", async () => {
    const id = { name: "Jane Doe", email: "jane@example.com" };
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src/data.txt"), "hello world\n");
    const snap = await ops.snapshot({ worktreePath: repo, message: "c1", candidateRef: "refs/studies/t/c/1", baseSha: base, identity: id });
    expect(who(repo, snap.sha)).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
    const prep = await ops.prepareCandidate({ repoPath: repo, bestSha: base, forkSha: base, candidateSha: snap.sha, message: "p", identity: id });
    expect(prep.status === "ok" && who(repo, prep.sha)).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
    const reworded = await ops.rewordCommit(repo, snap.sha, "r", id);
    expect(who(repo, reworded.sha)).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
    const composed = await ops.composeCommits({ repoPath: repo, onto: base, steps: [{ sha: snap.sha, revert: false }], message: "h", identity: id });
    expect(composed.status === "ok" && who(repo, composed.sha)).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
    const plain = await ops.rewordCommit(repo, snap.sha, "plugin");
    expect(who(repo, plain.sha)).toBe("autoresearch <autoresearch@bb.local>|autoresearch <autoresearch@bb.local>");
  });

  it("a commit sent to a bench clone as a bundle keeps the edit host's identity", async () => {
    sh(repo, "config", "user.name", "Jane Doe");
    sh(repo, "config", "user.email", "jane@example.com");
    const id = await resolveCommitIdentity({ gitIdentity: (p) => ops.gitIdentityOf(p) }, repo, { git: { identity: "repo" } });
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src/data.txt"), "hello world\n");
    const snap = await ops.snapshot({ worktreePath: repo, message: "c1", candidateRef: "refs/studies/t/c/1", baseSha: base, identity: id });
    const prep = await ops.prepareCandidate({ repoPath: repo, bestSha: base, forkSha: base, candidateSha: snap.sha, message: "p", identity: id });
    if (prep.status !== "ok") throw new Error("prepare failed");
    // The bench host keeps its own clone (no user config of the repo there) and receives commits by bundle.
    const dataDir = join(root, "bench-data");
    const clone = await bundle.benchRepo(dataDir, "t");
    const made = await bundle.bundleCreate(join(root, "edit-data"), repo, prep.sha, []);
    let offset = 0;
    for (;;) {
      const chunk = bundle.bundleRead(join(root, "edit-data"), made.id, offset, 1 << 20);
      bundle.bundleWrite(dataDir, made.id, offset, chunk.data);
      offset += Buffer.from(chunk.data, "base64").length;
      if (chunk.eof) break;
    }
    expect((await bundle.bundleApply(dataDir, clone.path, made.id, prep.sha, `refs/bench/s/${prep.sha}`, made.sha256)).ok).toBe(true);
    expect(await ops.gitIdentityOf(clone.path)).toEqual({ name: null, email: null });
    // Same commit, same identity: the bench measures exactly what the edit host made.
    expect(who(clone.path, prep.sha)).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
  });
});

describe("[git] identity: the engine", () => {
  it("end to end with real git: snapshot and promotion carry the repo's identity, and calibration says so", async () => {
    sh(repo, "config", "user.name", "Jane Doe");
    sh(repo, "config", "user.email", "jane@example.com");
    const runner = localRunner(join(root, "data"), "host_test");
    const { ctx, store, port } = makeCtx(runner);
    port.projectCheckout = async () => repo;
    port.spawnWorker = async (args: SpawnWorkerArgs) => {
      const tid = `thr_w${port.spawned.length + 1}`;
      port.spawned.push(args);
      const path = join(root, tid);
      sh(repo, "worktree", "add", "-q", "-b", `bb/${tid}`, path, args.baseBranch);
      port.threads.set(tid, { id: tid, status: "active", archivedAt: null, deletedAt: null, environmentId: `env_${tid}`, metadata: { ...args.metadata } });
      port.envs.set(`env_${tid}`, { id: `env_${tid}`, hostId: "host_test", path, branchName: `bb/${tid}` });
      return { threadId: tid, environmentId: `env_${tid}` };
    };
    port.addThread("thr_study");
    const spec = DETERMINISTIC_SPEC.replace('gate = ["gate.sh"]', 'gate = ["test -s src/data.txt"]').replace('measure = "measure.sh"', 'measure = "sh bench/measure.sh"');
    const engine = new Engine(ctx);
    await engine.proposeStudy("thr_study", "proj_1", spec);
    await engine.calibrate("toy-size", "human");
    await engine.waitForCalibration("toy-size", 20_000);
    const study = store.study("toy-size")!;
    expect(study.calibration_status).toBe("ready");
    expect(study.calibration_json).toContain("authored as Jane Doe <jane@example.com>, the repository's git identity");
    engine.addIdea("toy-size", { title: "Collapse whitespace" }, "human");
    await engine.start("toy-size", "human");
    await engine.settle();
    writeFileSync(join(root, "thr_w1", "src/data.txt"), "hello world padding\n");
    expect(await engine.submit("thr_w1", { title: "Collapse runs of spaces" })).toContain("Submitted as c/1");
    await engine.settle();
    const c = store.candidateByN(study.id, 1)!;
    expect(c.verdict).toBe("win");
    expect(who(repo, c.sha)).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
    expect(who(repo, "studies/toy-size/best")).toBe("Jane Doe <jane@example.com>|Jane Doe <jane@example.com>");
    engine.dispose();
  }, 60_000);

  it("fake host: every commit op gets the edit host's identity; a repo without one falls back with a warning and a notice; plugin mode never asks", async () => {
    for (const mode of ["repo", "fallback", "plugin"] as const) {
      const host = new FakeHost();
      const bench = new FakeHost("host_bench", host);
      const { ctx, store, port } = makeCtx(host);
      port.addHost(bench, "bench-box");
      if (mode === "fallback") host.repoIdentity = { name: null, email: null };
      bench.repoIdentity = { name: "Bench Box", email: "bench@example.com" };
      host.refs.set("main", host.commit("T0", null));
      host.metric.set("T0", 1000);
      port.addThread("thr_study");
      const engine = new Engine(ctx);
      // Clone mode: commits reach the bench host only as bundles.
      const toml = fakeHostSpec().replace('noise = "deterministic"', 'noise = "deterministic"\nbench_hosts = ["bench-box"]') + (mode === "plugin" ? '\n[git]\nidentity = "plugin"\n' : "");
      const proposed = await engine.proposeStudy("thr_study", "proj_1", toml);
      expect(proposed).not.toMatch(/error/iu);
      await engine.calibrate("toy-size", "human");
      await engine.waitForCalibration("toy-size", 5_000);
      const id = store.study("toy-size")!.id;
      engine.addIdea("toy-size", { title: "Shrink it" }, "human");
      await engine.start("toy-size", "human");
      await engine.settle();
      host.nextSnapshot = { tree: "T1" };
      host.metric.set("T1", 800);
      await engine.submit("thr_w1", { title: "shrink" });
      await engine.settle();
      expect(store.candidateByN(id, 1)!.verdict).toBe("win");
      const expected = mode === "repo" ? "Repo Owner <owner@example.com>" : "autoresearch <autoresearch@bb.local>";
      expect(host.commitIdentities.map((x) => x.op)).toEqual(expect.arrayContaining(["snapshot", "prepareCandidate", "rewordCommit"]));
      expect(new Set(host.commitIdentities.map((x) => x.identity))).toEqual(new Set([expected]));
      // Resolved on the edit host only (never on the bench), and never in plugin mode; the bench made no commits.
      expect(bench.gitIdentityCalls).toBe(0);
      expect(bench.commitIdentities).toEqual([]);
      expect(host.gitIdentityCalls > 0).toBe(mode !== "plugin");
      const report = (JSON.parse(store.study(id)!.calibration_json ?? "{}") as { report?: string }).report ?? "";
      const notices = store.db.prepare(`SELECT text FROM notices WHERE study_id = ? AND kind = 'git.identity'`).all(id) as Array<{ text: string }>;
      if (mode === "fallback") {
        expect(report).toContain("No git identity (user.name and user.email) is configured for the repository");
        expect((JSON.parse(store.study(id)!.calibration_json!) as { warnings: string[] }).warnings.join(" ")).toContain("No git identity");
        expect(notices).toHaveLength(1);
      } else {
        expect(notices).toHaveLength(0);
        expect(report).toContain(mode === "plugin" ? '([git] identity = "plugin")' : "the repository's git identity");
      }
      engine.dispose();
    }
  });
});
