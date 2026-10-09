// Git bundles and the bench-owned clone (host side).
//
// A remote bench host never shares refs or an object store with the edit
// host. It keeps its own bare clone under the host data dir, and commits reach
// it only as `git bundle` files relayed in chunks by the server:
//
//   edit host: bundleCreate → bundleRead × n      (8 MiB output cap per call)
//   bench host: bundleWrite × n → bundleApply      (32 MiB input cap per call)
//
// Bundles cover `tip` minus everything the bench already pins under
// refs/bench/*, so a candidate is usually a few KiB; the first transfer
// (bootstrap) carries the baseline's history.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BundleInfo } from "./contract.ts";
import { git } from "./ops.ts";

const BUNDLE_REF = "refs/autoresearch/bundle";

function bundleDir(dataDir: string): string {
  const dir = join(dataDir, "bundles");
  mkdirSync(dir, { recursive: true });
  return dir;
}
const outFile = (dataDir: string, id: string) => join(bundleDir(dataDir), `${id}.bundle`);
const inFile = (dataDir: string, id: string) => join(bundleDir(dataDir), `${id}.recv`);

export function benchRepoPath(dataDir: string, key: string): string {
  return join(dataDir, "bench", key, "repo.git");
}

/** Ensure the bench-owned bare clone exists; list the commits its refs pin. */
export async function benchRepo(dataDir: string, key: string): Promise<{ path: string; tips: string[] }> {
  const path = benchRepoPath(dataDir, key);
  if (!existsSync(join(path, "HEAD"))) {
    mkdirSync(path, { recursive: true });
    await git(path, ["init", "--bare", "-q"]);
    // Pinned refs keep every transferred commit alive; never prune them.
    await git(path, ["config", "gc.auto", "0"]);
  }
  const refs = await git(path, ["for-each-ref", "--sort=-committerdate", "--format=%(objectname)", "refs/bench/"]);
  const tips = [...new Set(refs.stdout.split("\n").filter(Boolean))].slice(0, 4096);
  return { path, tips };
}

export async function removeBenchRepo(dataDir: string, key: string): Promise<{ removed: boolean }> {
  const dir = join(dataDir, "bench", key);
  if (!existsSync(dir)) return { removed: false };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

/** `git cat-file --batch-check` over stdin: which shas exist as commits. */
export async function hasCommits(repoPath: string, shas: string[]): Promise<{ present: string[] }> {
  if (!shas.length) return { present: [] };
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: repoPath, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`git cat-file exited ${code}`))));
    child.stdin.end(shas.map((s) => `${s}^{commit}`).join("\n") + "\n");
  });
  const present = new Set<string>();
  const lines = out.split("\n");
  shas.forEach((s, i) => {
    const l = lines[i] ?? "";
    if (l.endsWith(" commit")) present.add(s);
  });
  return { present: [...present] };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Bundle `tip` minus everything reachable from `basis` into a host temp file. */
export async function bundleCreate(dataDir: string, repoPath: string, tip: string, basis: string[]): Promise<BundleInfo> {
  const id = randomBytes(8).toString("hex");
  const file = outFile(dataDir, id);
  const ref = `${BUNDLE_REF}/${id}`;
  const known = (await hasCommits(repoPath, basis)).present;
  await git(repoPath, ["update-ref", ref, tip]);
  try {
    const r = await git(repoPath, ["bundle", "create", "-q", file, ref, ...known.map((b) => `^${b}`)], { allowFail: true });
    if (r.code !== 0) {
      if (/empty bundle/iu.test(r.stderr)) return { id, bytes: 0, sha256: "", empty: true };
      throw new Error(`git bundle create failed (${r.code}): ${r.stderr.slice(-1000)}`);
    }
    return { id, bytes: statSync(file).size, sha256: sha256File(file), empty: false };
  } finally {
    await git(repoPath, ["update-ref", "-d", ref], { allowFail: true });
  }
}

export function bundleRead(dataDir: string, id: string, offset: number, length: number): { data: string; eof: boolean } {
  const file = outFile(dataDir, id);
  const size = statSync(file).size;
  if (offset > size) throw new Error(`bundle ${id}: offset ${offset} past end ${size}`);
  const n = Math.min(length, size - offset);
  const buf = Buffer.alloc(n);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, n, offset);
  } finally {
    closeSync(fd);
  }
  return { data: buf.toString("base64"), eof: offset + n >= size };
}

export function bundleWrite(dataDir: string, id: string, offset: number, data: string): { bytes: number } {
  const file = inFile(dataDir, id);
  const have = existsSync(file) ? statSync(file).size : 0;
  if (offset === 0 && have > 0) rmSync(file, { force: true });
  else if (offset !== have) throw new Error(`bundle ${id}: chunk at ${offset} but ${have} bytes received (out of order)`);
  appendFileSync(file, Buffer.from(data, "base64"));
  return { bytes: statSync(file).size };
}

/** Verify and fetch a received bundle; pin `sha` under `ref`. */
export async function bundleApply(dataDir: string, repoPath: string, id: string, sha: string, ref: string, sha256: string): Promise<{ ok: boolean; detail: string }> {
  const file = inFile(dataDir, id);
  if (!existsSync(file)) return { ok: false, detail: `bundle ${id} was never received` };
  try {
    const got = sha256File(file);
    if (got !== sha256) return { ok: false, detail: `bundle ${id} is corrupt (sha256 ${got.slice(0, 12)} != ${sha256.slice(0, 12)})` };
    const verify = await git(repoPath, ["bundle", "verify", "-q", file], { allowFail: true });
    if (verify.code !== 0) return { ok: false, detail: `git bundle verify failed: ${verify.stderr.slice(-800)}` };
    const fetched = await git(repoPath, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", file, `+${BUNDLE_REF}/${id}:${ref}`], { allowFail: true });
    if (fetched.code !== 0) return { ok: false, detail: `git fetch from bundle failed: ${fetched.stderr.slice(-800)}` };
    const have = await hasCommits(repoPath, [sha]);
    if (!have.present.length) return { ok: false, detail: `bundle applied but ${sha.slice(0, 12)} is missing` };
    await git(repoPath, ["update-ref", ref, sha]);
    return { ok: true, detail: `fetched ${statSync(file).size} bytes` };
  } finally {
    rmSync(file, { force: true });
  }
}

export function bundleDiscard(dataDir: string, id: string): { removed: boolean } {
  let removed = false;
  for (const f of [outFile(dataDir, id), inFile(dataDir, id)]) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed = true;
    }
  }
  return { removed };
}
