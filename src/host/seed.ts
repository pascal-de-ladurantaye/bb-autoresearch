// Bench seeds (host side): scan for credentials, then pack and cache.
//
// A seed is whatever the human's `seed` command built on the edit machine
// (toolchains, dependency caches, vendored packages). It leaves this machine
// for a lent bench host, so it is scanned before any upload and refused if
// anything looks like a credential. Findings carry the path, rule and line,
// never the matched text: they end up in notices the human reads.
//
// Accepted seeds are cached under <dataDir>/seeds by content hash, so an
// unchanged seed is packed once and uploaded by name.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { matchesAny } from "../scope.ts";

export interface SeedFinding {
  path: string;
  rule: string;
  line: number | null;
}

export type SeedPackResult =
  | { ok: true; path: string; sha256: string; bytes: number; files: number; kind: "dir" | "tarball"; cached: boolean; allowed: SeedFinding[] }
  | { ok: false; findings: SeedFinding[]; allowed: SeedFinding[]; files: number; error?: string };

export interface SeedScanOptions {
  /** Bytes of each file to scan for content patterns (default 8 MiB); the rest is not read. */
  maxFileBytes?: number;
  /** Where nested archives are extracted while scanning (default: the OS temp dir). */
  tmpDir?: string;
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- rules

/** File-name rules over the seed-relative path split into segments. */
const NAME_RULES: { rule: string; test: (segs: string[], base: string) => boolean }[] = [
  { rule: "file:netrc", test: (_s, b) => b === ".netrc" || b === "_netrc" },
  { rule: "file:git-credentials", test: (_s, b) => b === ".git-credentials" },
  { rule: "file:gem-credentials", test: (s, b) => b === "credentials" && parent(s) === ".gem" },
  { rule: "file:pypirc", test: (_s, b) => b === ".pypirc" },
  { rule: "file:ssh-key", test: (_s, b) => ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(b) },
  { rule: "file:ssh-dir", test: (s, b) => dirs(s).includes(".ssh") && b !== "known_hosts" && !b.endsWith(".pub") },
  { rule: "file:aws-config", test: (s, b) => (b === "credentials" || b === "config") && parent(s) === ".aws" },
  { rule: "file:gcloud-config", test: (s) => hasDirPair(dirs(s), ".config", "gcloud") },
  { rule: "file:azure-config", test: (s) => dirs(s).includes(".azure") },
  { rule: "file:kube-config", test: (s, b) => b === "config" && parent(s) === ".kube" },
  { rule: "file:docker-config", test: (s, b) => b === "config.json" && parent(s) === ".docker" },
  { rule: "file:env", test: (_s, b) => (b === ".env" || b.startsWith(".env.")) && !ENV_TEMPLATES.has(b) },
  { rule: "file:keystore", test: (_s, b) => /\.(?:p12|pfx|keystore|jks)$/iu.test(b) },
];
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/** Config files that are only a credential when they hold one. */
const CONFIG_RULES: { rule: string; applies: (segs: string[], base: string) => boolean; re: RegExp }[] = [
  {
    rule: "content:npm-auth",
    applies: (_s, b) => b === ".npmrc" || b === ".yarnrc" || b === ".yarnrc.yml",
    re: /_authToken|_auth\b|_password|npmAuthToken/u,
  },
  {
    // Host-keyed settings (BUNDLE_PKGS__EXAMPLE__COM: user:pass). BUNDLE_BUILD__<gem>
    // is a compile flag, not a host, so it is not a credential.
    rule: "content:bundler-credential",
    applies: (s, b) => b === "config" && parent(s) === ".bundle",
    re: /^BUNDLE_(?!BUILD__)[A-Z0-9_]+__[A-Z0-9_]+:/mu,
  },
  { rule: "content:aws-credentials", applies: (_s, b) => b === "credentials", re: /aws_secret_access_key/iu },
];

/** Token shapes looked for in every regular file. */
const CONTENT_RULES: { rule: string; re: RegExp }[] = [
  { rule: "content:private-key", re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/u },
  { rule: "content:aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { rule: "content:github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{20,}/u },
  { rule: "content:gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}/u },
  { rule: "content:slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/u },
  // Real keys always carry a digit; requiring one spares kebab-case words that start with "sk-".
  { rule: "content:api-key", re: /\bsk-(?:proj-|ant-)?(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/u },
  { rule: "content:google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/u },
  { rule: "content:npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/u },
  { rule: "content:stripe-live-key", re: /\b[sr]k_live_[0-9A-Za-z]{10,}/u },
  { rule: "content:jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/u },
];

function parent(segs: string[]): string | undefined {
  return segs[segs.length - 2];
}
function dirs(segs: string[]): string[] {
  return segs.slice(0, -1);
}
function hasDirPair(ds: string[], a: string, b: string): boolean {
  return ds.some((d, i) => d === a && ds[i + 1] === b);
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Every rule that fires on one file; `text` is the file's head read as latin1 so binaries never throw. */
function checkFile(rel: string, text: string): SeedFinding[] {
  const segs = rel.split("/");
  const base = segs[segs.length - 1] ?? rel;
  const out: SeedFinding[] = [];
  for (const r of NAME_RULES) if (r.test(segs, base)) out.push({ path: rel, rule: r.rule, line: null });
  for (const r of CONFIG_RULES) {
    if (!r.applies(segs, base)) continue;
    const m = r.re.exec(text);
    if (m) out.push({ path: rel, rule: r.rule, line: lineAt(text, m.index) });
  }
  for (const r of CONTENT_RULES) {
    const m = r.re.exec(text);
    if (m) out.push({ path: rel, rule: r.rule, line: lineAt(text, m.index) });
  }
  return out;
}

// ---------------------------------------------------------------- walk

interface Entry {
  rel: string;
  abs: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
}

/** Sorted depth-first listing; symlinks are reported as links and never followed. */
async function walk(root: string, rel = ""): Promise<Entry[]> {
  const out: Entry[] = [];
  const names = (await readdir(join(root, rel))).sort();
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name;
    const abs = join(root, r);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) out.push({ rel: r, abs, kind: "symlink", mode: st.mode & 0o7777 });
    else if (st.isDirectory()) {
      out.push({ rel: r, abs, kind: "dir", mode: st.mode & 0o7777 });
      out.push(...(await walk(root, r)));
    } else if (st.isFile()) out.push({ rel: r, abs, kind: "file", mode: st.mode & 0o7777 });
    // Sockets, fifos and devices carry no content to leak.
  }
  return out;
}

async function readHead(path: string, max: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, max));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

const isTarName = (name: string) => /\.(?:tar|tar\.gz|tgz)$/iu.test(name);
const isGemName = (name: string) => /\.gem$/iu.test(name);

interface TreeScan {
  findings: SeedFinding[];
  files: number;
  /** Content hash of the tree (see hashTree), when asked for. */
  hash?: string;
}

async function scanTree(root: string, o: { max: number; tmpDir: string; nested: boolean; hash: boolean }): Promise<TreeScan> {
  const findings: SeedFinding[] = [];
  const h = o.hash ? createHash("sha256").update("seed-dir-v1\n") : null;
  let files = 0;
  for (const e of await walk(root)) {
    if (e.kind === "dir") {
      h?.update(`d ${e.mode.toString(8)} ${e.rel}\0`);
      continue;
    }
    if (e.kind === "symlink") {
      h?.update(`l ${await readlink(e.abs)} ${e.rel}\0`);
      continue;
    }
    files++;
    let head: Buffer;
    try {
      head = await readHead(e.abs, o.max);
    } catch {
      // A file we cannot read is a file we cannot vouch for.
      findings.push({ path: e.rel, rule: "scan:unreadable", line: null });
      continue;
    }
    findings.push(...checkFile(e.rel, head.toString("latin1")));
    if (h) h.update(`f ${e.mode.toString(8)} ${await fileSha256(e.abs)} ${e.rel}\0`);
    if (o.nested && (isGemName(e.rel) || isTarName(e.rel))) findings.push(...(await scanNested(e.abs, e.rel, o)));
  }
  return { findings, files, ...(h ? { hash: h.digest("hex") } : {}) };
}

/** One level inside a .gem or tarball found in the seed; inner paths are reported as `outer!inner`. */
async function scanNested(abs: string, rel: string, o: { max: number; tmpDir: string }): Promise<SeedFinding[]> {
  const dir = await makeTemp(o.tmpDir, "seed-nested-");
  try {
    try {
      await untar(abs, dir);
    } catch {
      // A .gem that is not a tar is usually an old or broken package; still refuse
      // rather than ship something unscanned.
      return [{ path: rel, rule: "scan:archive-unreadable", line: null }];
    }
    const out: SeedFinding[] = [];
    if (isGemName(rel)) {
      // A gem is a tar of data.tar.gz (the files) and gzipped metadata.
      const data = join(dir, "data.tar.gz");
      if (existsSync(data)) {
        const inner = join(dir, "data");
        await mkdir(inner);
        try {
          await untar(data, inner);
          await rm(data, { force: true });
        } catch {
          out.push({ path: `${rel}!data.tar.gz`, rule: "scan:archive-unreadable", line: null });
        }
      }
      for (const name of ["metadata.gz", "checksums.yaml.gz"]) {
        const p = join(dir, name);
        if (!existsSync(p)) continue;
        try {
          out.push(...checkFile(name, gunzipSync(await readFile(p)).subarray(0, o.max).toString("latin1")).map((f) => ({ ...f, path: `${rel}!${f.path}` })));
        } catch {
          out.push({ path: `${rel}!${name}`, rule: "scan:archive-unreadable", line: null });
        }
        await rm(p, { force: true });
      }
    }
    const inner = await scanTree(dir, { ...o, nested: false, hash: false });
    for (const f of inner.findings) out.push({ ...f, path: `${rel}!${f.path}` });
    return out;
  } finally {
    await forceRemove(dir);
  }
}

// ---------------------------------------------------------------- scan

/** Scan a seed directory; findings whose path matches an `allow` glob move to `allowed`. */
export async function scanSeed(root: string, allow: readonly string[], opts: SeedScanOptions = {}): Promise<{ findings: SeedFinding[]; allowed: SeedFinding[]; files: number }> {
  const scan = await scanTree(root, { max: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, tmpDir: opts.tmpDir ?? tmpdir(), nested: true, hash: false });
  return { ...splitAllowed(scan.findings, allow), files: scan.files };
}

function splitAllowed(all: SeedFinding[], allow: readonly string[]): { findings: SeedFinding[]; allowed: SeedFinding[] } {
  const findings: SeedFinding[] = [];
  const allowed: SeedFinding[] = [];
  for (const f of all) {
    const outer = f.path.split("!")[0] ?? f.path;
    (matchesAny(f.path, allow) || matchesAny(outer, allow) ? allowed : findings).push(f);
  }
  return { findings, allowed };
}

export function seedFindingsText(findings: SeedFinding[], max = 20): string {
  const lines = findings.slice(0, max).map((f) => `- ${f.path} (${f.rule}${f.line === null ? "" : `, line ${f.line}`})`);
  if (findings.length > max) lines.push(`- … and ${findings.length - max} more`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- pack

/**
 * Scan, then pack and cache a seed. Nothing is written under <dataDir>/seeds
 * unless the scan is clean (after the allowlist).
 *
 * Cache key: a tarball source is keyed by the sha256 of its bytes and copied
 * as is. A directory is keyed by a hash of its content (sorted relative paths,
 * modes, file sha256s and symlink targets), because neither bsdtar nor older
 * GNU tar can portably write a byte-identical archive twice (no name sorting,
 * fixed mtimes or owners on bsdtar). For a directory `sha256` is therefore that
 * content hash, not the hash of the archive bytes.
 */
export async function packSeed(opts: { dataDir: string; source: string; cwd: string; allow: readonly string[]; maxFileBytes?: number }): Promise<SeedPackResult> {
  const raw = opts.source.trim();
  const fail = (error: string, files = 0): SeedPackResult => ({ ok: false, findings: [], allowed: [], files, error });
  if (!raw) return fail("the seed command printed no path");
  const source = isAbsolute(raw) ? raw : resolve(opts.cwd, raw);
  const st = await stat(source).catch(() => null);
  if (!st) return fail(`seed path ${source} does not exist`);
  const max = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const tmpDir = join(opts.dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const seeds = join(opts.dataDir, "seeds");

  if (st.isDirectory()) {
    const scan = await scanTree(source, { max, tmpDir, nested: true, hash: true });
    const split = splitAllowed(scan.findings, opts.allow);
    if (split.findings.length) return { ok: false, ...split, files: scan.files };
    const sha256 = scan.hash!;
    const dest = join(seeds, `${sha256}.tar.gz`);
    const cached = existsSync(dest);
    if (!cached) {
      await mkdir(seeds, { recursive: true });
      const tmp = join(seeds, `.${sha256}.${randomBytes(4).toString("hex")}.tmp`);
      try {
        await tarCreate(source, tmp);
        await rename(tmp, dest);
      } catch (e) {
        await rm(tmp, { force: true });
        return fail(`packing the seed failed: ${(e as Error).message}`, scan.files);
      }
    }
    return { ok: true, path: dest, sha256, bytes: (await stat(dest)).size, files: scan.files, kind: "dir", cached, allowed: split.allowed };
  }

  if (!st.isFile() || !isTarName(basename(source))) {
    return fail(`seed path ${source} is neither a directory nor a .tar, .tar.gz or .tgz file`);
  }
  const dir = await makeTemp(tmpDir, "seed-scan-");
  let scan: TreeScan;
  try {
    try {
      await untar(source, dir);
    } catch (e) {
      return fail(`cannot extract seed tarball ${source}: ${(e as Error).message}`);
    }
    scan = await scanTree(dir, { max, tmpDir, nested: true, hash: false });
  } finally {
    await forceRemove(dir);
  }
  const split = splitAllowed(scan.findings, opts.allow);
  if (split.findings.length) return { ok: false, ...split, files: scan.files };
  const sha256 = await fileSha256(source);
  const ext = /\.tar$/iu.test(source) ? ".tar" : ".tar.gz";
  const dest = join(seeds, `${sha256}${ext}`);
  const prior = await stat(dest).catch(() => null);
  const cached = prior?.size === st.size;
  if (!cached) {
    await mkdir(seeds, { recursive: true });
    const tmp = join(seeds, `.${sha256}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await copyFile(source, tmp);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      return fail(`copying the seed failed: ${(e as Error).message}`, scan.files);
    }
  }
  return { ok: true, path: dest, sha256, bytes: st.size, files: scan.files, kind: "tarball", cached, allowed: split.allowed };
}

// ---------------------------------------------------------------- helpers

async function fileSha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function makeTemp(base: string, prefix: string): Promise<string> {
  const dir = join(base, `${prefix}${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Archives can carry read-only directories; make them writable so rm can finish. */
async function forceRemove(dir: string): Promise<void> {
  const fix = async (d: string): Promise<void> => {
    await chmod(d, 0o700).catch(() => {});
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) await fix(join(d, e.name));
  };
  await fix(dir);
  await rm(dir, { recursive: true, force: true });
}

// macOS tar writes AppleDouble `._*` members and xattrs unless told not to;
// a bench host on another OS would unpack them as files.
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: "1" };
let createFlags: Promise<string[]> | null = null;

/**
 * bsdtar (macOS, BSDs) takes --no-xattrs/--no-acls/--no-mac-metadata but its
 * --help lists none of them. GNU tar's --help lists what this build supports,
 * so its flags are filtered by it; any other tar gets none.
 */
function tarCreateFlags(): Promise<string[]> {
  createFlags ??= (async () => {
    const version = await run("tar", ["--version"]).catch(() => "");
    if (/bsdtar/iu.test(version)) return ["--no-xattrs", "--no-acls", "--no-mac-metadata"];
    if (!/GNU tar/iu.test(version)) return [];
    const help = await run("tar", ["--help"]).catch(() => "");
    const wanted = ["--no-xattrs", "--no-acls", "--no-selinux", "--owner=0", "--group=0", "--numeric-owner"];
    return wanted.filter((f) => help.includes(f.split("=")[0]!));
  })();
  return createFlags;
}

async function tarCreate(dir: string, out: string): Promise<void> {
  await run("tar", ["-czf", out, ...(await tarCreateFlags()), "-C", dir, "."]);
}

async function untar(archive: string, dir: string): Promise<void> {
  // Both tars detect gzip on extraction and strip leading "/" and "..".
  await run("tar", ["-xf", archive, "-C", dir]);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env: TAR_ENV, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(out).toString("utf8"))
        : reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 500)}`)),
    );
  });
}
