// Host-side implementations of the host contract. Pure Node: child_process,
// fs, and git on PATH. host.ts wires these to RPC handlers; tests and the
// in-process LocalHostRunner call them directly.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import type {
  CommitInfo,
  ComposeInput,
  ComposeResult,
  DiffSummary,
  ExecInput,
  ExecResult,
  PrepareInput,
  PrepareResult,
  SnapshotInput,
  SnapshotResult,
} from "./contract.ts";

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "autoresearch",
  GIT_AUTHOR_EMAIL: "autoresearch@bb.local",
  GIT_COMMITTER_NAME: "autoresearch",
  GIT_COMMITTER_EMAIL: "autoresearch@bb.local",
};

class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max * 2 && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  toString(): string {
    const all = Buffer.concat(this.chunks);
    const text = all.subarray(Math.max(0, all.length - this.max)).toString("utf8");
    return all.length > this.max ? `…${text}` : text;
  }
}

export interface SpawnOptions {
  cwd: string;
  command: string;
  timeoutMs: number;
  env?: Record<string, string>;
  tailBytes?: number;
  signal?: AbortSignal;
  /** Called with the last complete output line, at most every `progressMs`. */
  onLine?: (line: string) => void;
  progressMs?: number;
}

/** Run a shell command in its own process group; kill the group on timeout or abort. */
export async function spawnCommand(o: SpawnOptions): Promise<ExecResult> {
  const started = Date.now();
  const tailBytes = o.tailBytes ?? 16 * 1024;
  return await new Promise<ExecResult>((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new Error("aborted before start"));
      return;
    }
    const child = spawn("/bin/sh", ["-c", o.command], {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = new Tail(tailBytes);
    const err = new Tail(tailBytes);
    let timedOut = false;
    let lastLine = "";
    let lastEmit = 0;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => kill();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const line = (c: Buffer) => {
      if (!o.onLine) return;
      const text = c.toString("utf8");
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length) lastLine = lines[lines.length - 1]!.slice(0, 500);
      const now = Date.now();
      if (now - lastEmit >= (o.progressMs ?? 5_000)) {
        lastEmit = now;
        o.onLine(lastLine);
      }
    };
    child.stdout.on("data", (c: Buffer) => {
      out.push(c);
      line(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      err.push(c);
      line(c);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        stdout: out.toString(),
        stderr: err.toString(),
      });
    });
  });
}

export async function exec(input: ExecInput, signal?: AbortSignal): Promise<ExecResult> {
  return await spawnCommand({ ...input, ...(signal ? { signal } : {}) });
}

/** Run git with argv (no shell) and return trimmed stdout; throws on non-zero exit. */
export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, ...GIT_IDENTITY, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout: Buffer.concat(out).toString("utf8").trim(), stderr: Buffer.concat(err).toString("utf8").trim() };
      if (result.code !== 0 && !opts.allowFail) {
        reject(new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.slice(-2000)}`));
      } else resolve(result);
    });
  });
}

export async function ping(dataDir: string): Promise<{ hostname: string; platform: string; gitVersion: string; dataDir: string }> {
  const v = await git(process.cwd(), ["--version"], { allowFail: true });
  return { hostname: hostname(), platform: platform(), gitVersion: v.stdout, dataDir };
}

export async function resolveRef(repoPath: string, ref: string): Promise<{ sha: string | null }> {
  const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return { sha: r.code === 0 && r.stdout ? r.stdout : null };
}

export async function updateRef(repoPath: string, ref: string, newSha: string, oldSha: string | null): Promise<{ ok: boolean; current: string | null }> {
  const args = ["update-ref", ref, newSha, oldSha ?? "0000000000000000000000000000000000000000"];
  const r = await git(repoPath, args, { allowFail: true });
  const current = (await resolveRef(repoPath, ref)).sha;
  return { ok: r.code === 0, current };
}

export async function deleteRef(repoPath: string, ref: string): Promise<{ deleted: boolean }> {
  const r = await git(repoPath, ["update-ref", "-d", ref], { allowFail: true });
  return { deleted: r.code === 0 };
}

export async function snapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const cwd = input.worktreePath;
  await git(cwd, ["add", "-A"]);
  const status = await git(cwd, ["status", "--porcelain"]);
  let committed = false;
  if (status.stdout.length > 0) {
    await git(cwd, ["commit", "--no-verify", "--no-gpg-sign", "-q", "-m", input.message]);
    committed = true;
  }
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).stdout;
  await git(cwd, ["update-ref", input.candidateRef, sha]);
  let forkSha = input.baseSha;
  if (input.bestSha) {
    const mb = await git(cwd, ["merge-base", sha, input.bestSha], { allowFail: true });
    if (mb.code === 0 && mb.stdout) forkSha = mb.stdout;
  }
  const names = await git(cwd, ["diff", "--name-only", "--no-renames", forkSha, sha]);
  const numstat = await git(cwd, ["diff", "--numstat", "--no-renames", forkSha, sha]);
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const line of numstat.stdout.split("\n")) {
    const [a, d] = line.split("\t");
    if (a && a !== "-") linesAdded += Number(a) || 0;
    if (d && d !== "-") linesDeleted += Number(d) || 0;
  }
  return {
    sha,
    forkSha,
    committed,
    changedPaths: names.stdout ? names.stdout.split("\n").filter(Boolean) : [],
    linesAdded,
    linesDeleted,
  };
}

export async function prepareCandidate(input: PrepareInput): Promise<PrepareResult> {
  const { repoPath } = input;
  let tree: string;
  if (input.forkSha === input.bestSha) {
    tree = (await git(repoPath, ["rev-parse", `${input.candidateSha}^{tree}`])).stdout;
  } else {
    // Three-way: apply forkSha..candidate onto best without touching any checkout.
    const r = await git(
      repoPath,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${input.forkSha}`, input.bestSha, input.candidateSha],
      { allowFail: true },
    );
    const lines = r.stdout.split("\n").filter(Boolean);
    if (r.code === 1) {
      return { status: "conflict", paths: lines.slice(1, 200), detail: r.stderr.slice(-2000) };
    }
    if (r.code !== 0 || !lines[0]) throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.slice(-2000)}`);
    tree = lines[0];
  }
  const sha = (await git(repoPath, ["commit-tree", tree, "-p", input.bestSha, "-m", input.message])).stdout;
  return { status: "ok", sha, tree };
}

export async function rewordCommit(repoPath: string, sha: string, message: string): Promise<{ sha: string }> {
  const tree = (await git(repoPath, ["rev-parse", `${sha}^{tree}`])).stdout;
  const parents = (await git(repoPath, ["rev-list", "--parents", "-n", "1", sha])).stdout.split(" ").slice(1);
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", message);
  return { sha: (await git(repoPath, args)).stdout };
}

export async function diffSummary(repoPath: string, from: string, to: string, maxPatchBytes: number): Promise<DiffSummary> {
  const numstat = await git(repoPath, ["diff", "--numstat", "--no-renames", from, to]);
  const files: DiffSummary["files"] = [];
  for (const line of numstat.stdout.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (!rest.length) continue;
    files.push({ path: rest.join("\t"), added: a === "-" ? 0 : Number(a) || 0, deleted: d === "-" ? 0 : Number(d) || 0 });
  }
  if (maxPatchBytes === 0) return { files: files.slice(0, 500), patch: "", truncated: false };
  const patch = await git(repoPath, ["diff", "--no-renames", "--no-color", from, to]);
  const truncated = Buffer.byteLength(patch.stdout) > maxPatchBytes;
  return { files: files.slice(0, 500), patch: truncated ? patch.stdout.slice(0, maxPatchBytes) : patch.stdout, truncated };
}

function checkoutRoot(dataDir: string): string {
  return join(dataDir, "checkouts");
}

export async function checkout(dataDir: string, repoPath: string, key: string, sha: string): Promise<{ path: string }> {
  const root = checkoutRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, key);
  if (existsSync(join(path, ".git"))) {
    await git(path, ["checkout", "--detach", "--force", "-q", sha]);
    await git(path, ["clean", "-fdq"]);
  } else {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await git(repoPath, ["worktree", "prune"], { allowFail: true });
    await git(repoPath, ["worktree", "add", "--detach", "-f", path, sha]);
  }
  return { path };
}

export async function removeCheckouts(dataDir: string, repoPath: string, keyPrefix: string): Promise<{ removed: number }> {
  const root = checkoutRoot(dataDir);
  if (!existsSync(root)) return { removed: 0 };
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(keyPrefix)) continue;
    const path = join(root, name);
    await git(repoPath, ["worktree", "remove", "--force", path], { allowFail: true });
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  await git(repoPath, ["worktree", "prune"], { allowFail: true });
  return { removed };
}

// ---- harvest (M3) ----

/** First-parent commits in from..to, oldest first, with changed paths. */
export async function commitLog(repoPath: string, from: string, to: string): Promise<{ commits: CommitInfo[] }> {
  const list = await git(repoPath, ["rev-list", "--first-parent", "--reverse", "--parents", `${from}..${to}`]);
  const commits: CommitInfo[] = [];
  for (const line of list.stdout.split("\n").filter(Boolean).slice(0, 5000)) {
    const [sha, parent] = line.split(" ");
    const message = (await git(repoPath, ["log", "-1", "--format=%B", sha!])).stdout;
    const paths = parent
      ? (await git(repoPath, ["diff", "--name-only", "--no-renames", parent, sha!])).stdout.split("\n").filter(Boolean)
      : (await git(repoPath, ["show", "--name-only", "--format=", sha!])).stdout.split("\n").filter(Boolean);
    commits.push({ sha: sha!, parent: parent ?? null, subject: message.split("\n")[0] ?? "", message: message.slice(0, 8192), paths: paths.slice(0, 2000) });
  }
  return { commits };
}

/**
 * Replay (pick) or undo (revert) commits on `onto` with `git merge-tree`,
 * one three-way merge per step, and return one commit whose parent is
 * `onto`. A pick merges parent→sha into the current tree; a revert merges
 * sha→parent. A conflict reports the step and the paths.
 */
export async function composeCommits(input: ComposeInput): Promise<ComposeResult> {
  const { repoPath } = input;
  let current = input.onto;
  let tree = (await git(repoPath, ["rev-parse", `${current}^{tree}`])).stdout;
  for (const step of input.steps) {
    const parent = (await git(repoPath, ["rev-parse", `${step.sha}^`])).stdout;
    const [mergeBase, theirs] = step.revert ? [step.sha, parent] : [parent, step.sha];
    const r = await git(repoPath, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${mergeBase}`, current, theirs], { allowFail: true });
    const lines = r.stdout.split("\n").filter(Boolean);
    if (r.code === 1) return { status: "conflict", at: step.sha, revert: step.revert, paths: lines.slice(1, 200), detail: r.stderr.slice(-2000) };
    if (r.code !== 0 || !lines[0]) throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.slice(-2000)}`);
    tree = lines[0];
    current = (await git(repoPath, ["commit-tree", tree, "-p", current, "-m", "autoresearch harvest step"])).stdout;
  }
  const sha = (await git(repoPath, ["commit-tree", tree, "-p", input.onto, "-m", input.message])).stdout;
  return { status: "ok", sha, tree };
}

export async function gitRemotes(repoPath: string): Promise<{ remotes: Array<{ name: string; url: string }> }> {
  const r = await git(repoPath, ["remote", "-v"], { allowFail: true });
  const seen = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim());
    if (m && !seen.has(m[1]!)) seen.set(m[1]!, m[2]!);
  }
  return { remotes: [...seen].slice(0, 50).map(([name, url]) => ({ name, url })) };
}

export function writeExport(dataDir: string, key: string, files: Array<{ path: string; content: string }>): { dir: string } {
  const dir = join(dataDir, "exports", key);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    if (f.path.split("/").includes("..") || f.path.startsWith("/")) throw new Error(`bad export path ${f.path}`);
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  return { dir };
}
