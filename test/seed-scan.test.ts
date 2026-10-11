import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packSeed, scanSeed, seedFindingsText } from "../src/host/seed.ts";

// Fake secrets are assembled at test time so this file never holds a literal
// token that a credential scanner would flag.
const FAKE = {
  pem: "-----BEGIN " + "RSA PRIVATE" + " KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----",
  openssh: "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----",
  aws: "AK" + "IA" + "A".repeat(16),
  awsTemp: "AS" + "IA" + "B1".repeat(8),
  github: "gh" + "p_" + "a1".repeat(18),
  githubPat: "github" + "_pat_" + "11ABCDEFG0123456789_abcdef",
  gitlab: "gl" + "pat-" + "x".repeat(20),
  slack: "xo" + "xb-" + "1234567890-abc",
  openai: "sk" + "-proj-" + "abc123".repeat(5),
  anthropic: "sk" + "-ant-" + "api03-" + "Z9".repeat(12),
  google: "AI" + "za" + "C".repeat(34) + "1",
  npm: "np" + "m_" + "n1".repeat(18),
  stripe: "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
};

const dirs: string[] = [];
function tmp(prefix = "seed-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

const has = (fs: { path: string; rule: string }[], path: string, rule: string) => fs.some((f) => f.path === path && f.rule === rule);

describe("scanSeed rules", () => {
  it("fires every file-name rule and spares templates and public ssh files", async () => {
    const root = tmp();
    const cases: [string, string][] = [
      [".netrc", "file:netrc"],
      ["win/_netrc", "file:netrc"],
      ["home/.git-credentials", "file:git-credentials"],
      ["home/.gem/credentials", "file:gem-credentials"],
      [".pypirc", "file:pypirc"],
      ["keys/id_rsa", "file:ssh-key"],
      ["keys/id_ed25519", "file:ssh-key"],
      ["home/.ssh/config", "file:ssh-dir"],
      ["home/.aws/credentials", "file:aws-config"],
      ["home/.aws/config", "file:aws-config"],
      ["home/.config/gcloud/application_default_credentials.json", "file:gcloud-config"],
      ["home/.azure/azureProfile.json", "file:azure-config"],
      ["home/.kube/config", "file:kube-config"],
      ["home/.docker/config.json", "file:docker-config"],
      ["app/.env", "file:env"],
      ["app/.env.production", "file:env"],
      ["certs/client.p12", "file:keystore"],
      ["certs/server.PFX", "file:keystore"],
      ["android/release.keystore", "file:keystore"],
      ["java/trust.jks", "file:keystore"],
    ];
    for (const [p] of cases) put(root, p, "nothing here\n");
    for (const p of ["app/.env.example", "app/.env.sample", "app/.env.template", "app/.env.dist", "home/.ssh/known_hosts", "home/.ssh/id_rsa.pub", "src/config", "docs/environment.md"]) {
      put(root, p, "nothing here\n");
    }
    const { findings, files } = await scanSeed(root, []);
    expect(files).toBe(cases.length + 8);
    for (const [p, rule] of cases) expect(has(findings, p, rule), `${p} ${rule}`).toBe(true);
    expect(findings.filter((f) => /\.env\.|known_hosts|\.pub$|src\/config|docs\//u.test(f.path) && f.path !== "app/.env.production")).toEqual([]);
    expect(findings.every((f) => f.line === null)).toBe(true);
  });

  it("flags config files only when they hold a credential", async () => {
    const root = tmp();
    put(root, "a/.npmrc", "registry=https://registry.example.test/\n//registry.example.test/:_authToken=abc\n");
    put(root, "b/.npmrc", "registry=https://registry.example.test/\n");
    put(root, "c/.yarnrc.yml", "npmRegistryServer: x\nnpmAuthToken: abc\n");
    put(root, "d/.bundle/config", "---\nBUNDLE_PATH: vendor\nBUNDLE_PKGS__EXAMPLE__TEST: \"user:pass\"\n");
    put(root, "e/.bundle/config", "---\nBUNDLE_BUILD__NOKOGIRI: \"--use-system-libraries\"\nBUNDLE_PATH: vendor\n");
    put(root, "f/credentials", "[default]\naws_secret_access_key = x\n");
    put(root, "g/credentials", "nothing\n");
    const { findings } = await scanSeed(root, []);
    expect(findings).toEqual([
      { path: "a/.npmrc", rule: "content:npm-auth", line: 2 },
      { path: "c/.yarnrc.yml", rule: "content:npm-auth", line: 2 },
      { path: "d/.bundle/config", rule: "content:bundler-credential", line: 3 },
      { path: "f/credentials", rule: "content:aws-credentials", line: 2 },
    ]);
  });

  it("fires every content pattern with the line of the first match and never the secret", async () => {
    const root = tmp();
    const cases: [string, string, string][] = [
      ["pem.txt", FAKE.pem, "content:private-key"],
      ["openssh.txt", FAKE.openssh, "content:private-key"],
      ["aws.txt", FAKE.aws, "content:aws-access-key"],
      ["aws-temp.txt", FAKE.awsTemp, "content:aws-access-key"],
      ["gh.txt", FAKE.github, "content:github-token"],
      ["gh-pat.txt", FAKE.githubPat, "content:github-token"],
      ["gl.txt", FAKE.gitlab, "content:gitlab-token"],
      ["slack.txt", FAKE.slack, "content:slack-token"],
      ["openai.txt", FAKE.openai, "content:api-key"],
      ["anthropic.txt", FAKE.anthropic, "content:api-key"],
      ["google.txt", FAKE.google, "content:google-api-key"],
      ["npm.txt", FAKE.npm, "content:npm-token"],
      ["stripe.txt", FAKE.stripe, "content:stripe-live-key"],
      ["jwt.txt", FAKE.jwt, "content:jwt"],
    ];
    for (const [p, secret] of cases) put(root, p, `line one\nline two\nkey = "${secret}"\n${secret}\n`);
    put(root, "clean.txt", "task-runner-for-everything-in-the-repo sk-learn-compatible-estimators\n");
    // Binary content around a token still scans.
    put(root, "blob.bin", "\u0000\u00ff\u0001\n" + FAKE.aws);
    const { findings } = await scanSeed(root, []);
    for (const [p, , rule] of cases) expect(findings).toContainEqual({ path: p, rule, line: 3 });
    expect(findings).toContainEqual({ path: "blob.bin", rule: "content:aws-access-key", line: 2 });
    expect(findings.some((f) => f.path === "clean.txt")).toBe(false);
    const serialized = JSON.stringify(findings) + seedFindingsText(findings, 100);
    for (const secret of Object.values(FAKE)) expect(serialized.includes(secret)).toBe(false);
  });

  it("scans only the first maxFileBytes of a large file", async () => {
    const root = tmp();
    put(root, "big.txt", "x".repeat(2048) + " " + FAKE.aws);
    expect((await scanSeed(root, [], { maxFileBytes: 1024 })).findings).toEqual([]);
    expect((await scanSeed(root, [])).findings).toHaveLength(1);
  });

  it("moves allowlisted findings to allowed", async () => {
    const root = tmp();
    put(root, "vendor/gems/x/spec/fixtures/key.pem", FAKE.pem);
    put(root, "test/fixtures/.env", "A=1\n");
    put(root, "src/leak.txt", FAKE.github);
    const { findings, allowed } = await scanSeed(root, ["vendor/**/fixtures/**", "test/fixtures/"]);
    expect(findings).toEqual([{ path: "src/leak.txt", rule: "content:github-token", line: 1 }]);
    expect(allowed.map((f) => f.path).sort()).toEqual(["test/fixtures/.env", "vendor/gems/x/spec/fixtures/key.pem"]);
  });

  it("does not follow symlinks", async () => {
    const root = tmp();
    const outside = tmp("seed-outside-");
    put(outside, "secret.txt", FAKE.aws);
    mkdirSync(join(outside, "dir"));
    put(outside, "dir/id_rsa", FAKE.pem);
    put(root, "ok.txt", "fine\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(join(outside, "dir"), join(root, "linkdir"));
    const r = await scanSeed(root, []);
    expect(r).toEqual({ findings: [], allowed: [], files: 1 });
  });

  it("looks one level inside .gem files and nested tarballs", async () => {
    const root = tmp();
    const work = tmp("seed-gem-");
    put(work, "data/lib/thing.rb", "puts 1\n");
    put(work, "data/spec/key.pem", FAKE.pem);
    execFileSync("tar", ["-czf", join(work, "data.tar.gz"), "-C", join(work, "data"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    writeFileSync(join(work, "metadata"), "name: thing\n");
    execFileSync("gzip", [join(work, "metadata")]);
    mkdirSync(join(root, "vendor/cache"), { recursive: true });
    execFileSync("tar", ["-cf", join(root, "vendor/cache/thing-1.0.gem"), "-C", work, "data.tar.gz", "metadata.gz"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });

    put(work, "inner/.netrc", "machine x\n");
    execFileSync("tar", ["-czf", join(root, "pkgs.tgz"), "-C", join(work, "inner"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });

    const r = await scanSeed(root, []);
    expect(r.findings).toContainEqual({ path: "vendor/cache/thing-1.0.gem!data/spec/key.pem", rule: "content:private-key", line: 1 });
    expect(r.findings).toContainEqual({ path: "pkgs.tgz!.netrc", rule: "file:netrc", line: null });
    expect(r.findings).toHaveLength(2);
    // The outer archive path allowlists everything inside it.
    const a = await scanSeed(root, ["vendor/cache/*.gem", "pkgs.tgz!.netrc"]);
    expect(a.findings).toEqual([]);
    expect(a.allowed).toHaveLength(2);
  });

  it("formats findings for notices", () => {
    const text = seedFindingsText(
      [
        { path: "a/.env", rule: "file:env", line: null },
        { path: "b.txt", rule: "content:jwt", line: 4 },
        { path: "c.txt", rule: "content:jwt", line: 1 },
      ],
      2,
    );
    expect(text).toBe("- a/.env (file:env)\n- b.txt (content:jwt, line 4)\n- … and 1 more");
  });
});

describe("packSeed", () => {
  function seedFiles(dataDir: string): string[] {
    const d = join(dataDir, "seeds");
    return existsSync(d) ? readdirSync(d) : [];
  }

  it("packs a clean directory into a relative tarball, cached by content", async () => {
    const cwd = tmp();
    const dataDir = tmp("seed-data-");
    put(cwd, "seed/bin/tool", "#!/bin/sh\necho hi\n");
    put(cwd, "seed/cache/a.txt", "a\n");
    put(cwd, "seed/vendor/fixtures/key.pem", FAKE.pem);
    const r = await packSeed({ dataDir, cwd, source: "seed\n", allow: ["vendor/fixtures/**"] });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ kind: "dir", cached: false, files: 3 });
    expect(r.allowed).toEqual([{ path: "vendor/fixtures/key.pem", rule: "content:private-key", line: 1 }]);
    expect(r.path).toBe(join(dataDir, "seeds", `${r.sha256}.tar.gz`));
    expect(r.bytes).toBe(readFileSync(r.path).length);
    const members = execFileSync("tar", ["-tzf", r.path], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(members.every((m) => m.startsWith("./") || m === ".")).toBe(true);
    expect(members.some((m) => m.includes("._"))).toBe(false);
    expect(members).toContain("./cache/a.txt");
    const out = tmp("seed-extract-");
    execFileSync("tar", ["-xzf", r.path, "-C", out]);
    expect(readFileSync(join(out, "bin/tool"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(readFileSync(join(out, "cache/a.txt"), "utf8")).toBe("a\n");

    const again = await packSeed({ dataDir, cwd, source: join(cwd, "seed"), allow: ["vendor/fixtures/**"] });
    expect(again).toMatchObject({ ok: true, path: r.path, sha256: r.sha256, cached: true });
    put(cwd, "seed/cache/a.txt", "changed\n");
    const changed = await packSeed({ dataDir, cwd, source: "seed", allow: ["vendor/fixtures/**"] });
    expect(changed.ok && changed.sha256 !== r.sha256 && !changed.cached).toBe(true);
    expect(seedFiles(dataDir)).toHaveLength(2);
  });

  it("refuses a directory with findings and writes nothing", async () => {
    const cwd = tmp();
    const dataDir = tmp("seed-data-");
    put(cwd, "seed/.env", "TOKEN=1\n");
    put(cwd, "seed/notes.txt", `x\n${FAKE.slack}\n`);
    const r = await packSeed({ dataDir, cwd, source: "seed", allow: [] });
    expect(r).toEqual({
      ok: false,
      files: 2,
      allowed: [],
      findings: [
        { path: ".env", rule: "file:env", line: null },
        { path: "notes.txt", rule: "content:slack-token", line: 2 },
      ],
    });
    expect(seedFiles(dataDir)).toEqual([]);
    expect(readdirSync(join(dataDir, "tmp"))).toEqual([]);
  });

  it("scans a tarball source and copies it as is", async () => {
    const cwd = tmp();
    const dataDir = tmp("seed-data-");
    put(cwd, "src/lib/a.txt", "a\n");
    execFileSync("tar", ["-czf", join(cwd, "seed.tgz"), "-C", join(cwd, "src"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const r = await packSeed({ dataDir, cwd, source: "seed.tgz", allow: [] });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r).toMatchObject({ kind: "tarball", cached: false, files: 1 });
    expect(r.path).toBe(join(dataDir, "seeds", `${r.sha256}.tar.gz`));
    expect(readFileSync(r.path).equals(readFileSync(join(cwd, "seed.tgz")))).toBe(true);
    expect((await packSeed({ dataDir, cwd, source: "seed.tgz", allow: [] })).ok && true).toBe(true);
    expect(await packSeed({ dataDir, cwd, source: "seed.tgz", allow: [] })).toMatchObject({ cached: true });

    execFileSync("tar", ["-cf", join(cwd, "plain.tar"), "-C", join(cwd, "src"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const plain = await packSeed({ dataDir, cwd, source: join(cwd, "plain.tar"), allow: [] });
    expect(plain.ok && plain.path.endsWith(".tar") && !plain.path.endsWith(".tar.gz")).toBe(true);
    expect(readdirSync(join(dataDir, "tmp"))).toEqual([]);
  });

  it("refuses a tarball with a secret inside and writes nothing", async () => {
    const cwd = tmp();
    const dataDir = tmp("seed-data-");
    put(cwd, "src/config/keys.yml", `aws: ${FAKE.aws}\n`);
    execFileSync("tar", ["-czf", join(cwd, "seed.tar.gz"), "-C", join(cwd, "src"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const r = await packSeed({ dataDir, cwd, source: "seed.tar.gz", allow: [] });
    expect(r).toMatchObject({ ok: false, findings: [{ path: "config/keys.yml", rule: "content:aws-access-key", line: 1 }] });
    expect(seedFiles(dataDir)).toEqual([]);
    expect(readdirSync(join(dataDir, "tmp"))).toEqual([]);
  });

  it("reports a clear error for a missing or unsupported source", async () => {
    const cwd = tmp();
    const dataDir = tmp("seed-data-");
    put(cwd, "seed.zip", "PK");
    const missing = await packSeed({ dataDir, cwd, source: "nope", allow: [] });
    expect(missing.ok === false && missing.error).toMatch(/does not exist/u);
    const zip = await packSeed({ dataDir, cwd, source: "seed.zip", allow: [] });
    expect(zip.ok === false && zip.error).toMatch(/neither a directory nor a \.tar/u);
    const empty = await packSeed({ dataDir, cwd, source: "  \n", allow: [] });
    expect(empty.ok === false && empty.error).toMatch(/no path/u);
    expect(seedFiles(dataDir)).toEqual([]);
  });
});
