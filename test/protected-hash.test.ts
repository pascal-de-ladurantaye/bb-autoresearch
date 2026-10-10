// The oracle hash folds in the content of the protected paths at the
// baseline. `git ls-tree` doesn't expand `**` pathspecs, so it used to list
// nothing and every study hashed the same empty content: editing a protected
// benchmark never started a new segment. Real git throughout.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import * as ops from "../src/host/ops.ts";
import { DETERMINISTIC_SPEC, localRunner, makeCtx } from "./helpers.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

let root: string;
let repo: string;

function commitFile(path: string, content: string): string {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", `edit ${path}`);
  return sh(repo, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ar-prot-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "bench", "data"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/data.txt"), "hello      world\n");
  writeFileSync(join(repo, "bench/measure.sh"), 'printf "METRIC size=%s\\nMETRIC rss=100\\n" "$(wc -c < src/data.txt | tr -d " ")"\n');
  writeFileSync(join(repo, "bench/data/input.txt"), "workload\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("protected-path hash (host op, real git)", () => {
  it("changes with a protected file's content, not with an unprotected one's", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    const h0 = await ops.protectedHash(repo, base, ["bench/**"]);
    expect(h0.files).toBe(2);
    expect(h0.hash).toMatch(/^[0-9a-f]{16}$/u);
    const srcEdit = commitFile("src/data.txt", "hello world\n");
    expect(await ops.protectedHash(repo, srcEdit, ["bench/**"])).toEqual(h0);
    const benchEdit = commitFile("bench/measure.sh", "echo METRIC size=1\n");
    const h1 = await ops.protectedHash(repo, benchEdit, ["bench/**"]);
    expect(h1.files).toBe(2);
    expect(h1.hash).not.toBe(h0.hash);
    // A nested protected file counts too.
    const nested = commitFile("bench/data/input.txt", "another workload\n");
    expect((await ops.protectedHash(repo, nested, ["bench/**"])).hash).not.toBe(h1.hash);
  });

  it("matches `**`, single-segment and bare-directory globs with the scope check's matcher", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    expect((await ops.protectedHash(repo, base, ["bench/**"])).files).toBe(2);
    expect((await ops.protectedHash(repo, base, ["bench/*.sh"])).files).toBe(1);
    expect((await ops.protectedHash(repo, base, ["bench/*"])).files).toBe(1); // `*` doesn't cross directories
    expect((await ops.protectedHash(repo, base, ["**/*.txt"])).files).toBe(2);
    expect((await ops.protectedHash(repo, base, ["bench"])).files).toBe(2);
    expect((await ops.protectedHash(repo, base, ["bench/measure.sh"])).files).toBe(1);
    // The same file through different globs hashes the same.
    expect((await ops.protectedHash(repo, base, ["bench/*.sh"])).hash).toBe((await ops.protectedHash(repo, base, ["bench/measure.sh"])).hash);
  });

  it("hashes nothing-matched as a distinct value, and no protected globs as empty", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    expect(await ops.protectedHash(repo, base, ["benhc/**"])).toEqual({ hash: ops.NO_PROTECTED_FILES, files: 0 });
    expect(await ops.protectedHash(repo, base, [])).toEqual({ hash: "", files: 0 });
  });
});

describe("protected-path hash in calibration (LocalHostRunner)", () => {
  async function calibrate(slug: string, protectedGlobs: string[]) {
    const runner = localRunner(join(root, `data-${slug}`), "host_test");
    const { ctx, store, port } = makeCtx(runner);
    port.projectCheckout = async () => repo;
    port.addThread(`thr_study_${slug.replace(/-/gu, "")}`);
    const spec = DETERMINISTIC_SPEC.replace('slug = "toy-size"', `slug = "${slug}"`)
      .replace('protected = ["bench/**"]', `protected = ${JSON.stringify(protectedGlobs)}`)
      .replace('gate = ["gate.sh"]', 'gate = ["test -s src/data.txt"]')
      .replace('measure = "measure.sh"', 'measure = "sh bench/measure.sh"');
    const engine = new Engine(ctx);
    await engine.proposeStudy(`thr_study_${slug.replace(/-/gu, "")}`, "proj_1", spec);
    await engine.calibrate(slug, "human");
    await engine.waitForCalibration(slug, 20_000);
    const study = store.study(slug)!;
    expect(study.calibration_status).toBe("ready");
    const report = JSON.parse(study.calibration_json!) as { oracleHash: string; warnings: string[] };
    engine.dispose();
    return report;
  }

  it("editing the protected benchmark changes the oracle hash; editing a source file doesn't; a typo warns", async () => {
    const a = await calibrate("prot-a", ["bench/**"]);
    commitFile("src/data.txt", "hello world padded\n");
    const b = await calibrate("prot-b", ["bench/**"]);
    expect(b.oracleHash).toBe(a.oracleHash);
    commitFile("bench/measure.sh", 'printf "METRIC size=%s\\nMETRIC rss=101\\n" "$(wc -c < src/data.txt | tr -d " ")"\n');
    const c = await calibrate("prot-c", ["bench/**"]);
    expect(c.oracleHash).not.toBe(a.oracleHash);
    expect(c.warnings.join(" ")).not.toMatch(/matches no files/u);
    const typo = await calibrate("prot-d", ["benhc/**"]);
    expect(typo.warnings.join(" ")).toMatch(/\[scope\] protected \(benhc\/\*\*\) matches no files at the baseline/u);
  }, 60_000);
});
