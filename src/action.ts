// "Last action" per worker: a short, safe label for what the worker's agent
// last did ("editing src/toy.py", "running pytest -q", "reading 3 files"),
// built from its thread's tool items (kind, a command, a tool name, file
// paths). Never from message text. Pure: shared by the engine and tests.
//
// Safety rules (docs/release-notes.md, "v0.2.0: live view, part 2"):
// - at most ACTION_MAX characters;
// - paths are made relative to the worker's worktree, other absolute paths
//   keep only their last two segments;
// - environment assignments, anything that looks like a token or a secret
//   (known prefixes, long hex/base64 runs, key=value pairs named like
//   secrets, flags like --token), and URL credentials and queries are removed;
// - heredoc bodies and inline scripts are never shown.
import type { ActivityItem } from "./live-model.ts";

export const ACTION_MAX = 80;

/** A tool item with what labelling may read: never message text. */
export interface ActionItem extends ActivityItem {
  /** File paths the item names (fileChange changes, fileRead/search path, a tool's path arguments). */
  paths?: readonly string[] | null;
}

const SECRET_PREFIX = /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?)/gu;
/** Long runs of hex or base64-ish characters (keys, hashes, tokens). */
const LONG_OPAQUE = /\b[A-Za-z0-9+/_=-]{32,}\b|\b[0-9a-fA-F]{24,}\b/gu;
const SECRET_KV = /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|session|cookie|bearer)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/giu;
const SECRET_FLAG = /(--?(?:token|secret|password|passwd|pass|api-key|apikey|auth|key|header|cookie|user|u|p|H)\b)(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gu;
const BEARER = /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gu;
const URL = /\b([a-z][a-z0-9+.-]*):\/\/([^\s'"<>]+)/giu;

function stripUrl(_m: string, _scheme: string, rest: string): string {
  // user:pass@host/path?query → host
  const noCred = rest.replace(/^[^/@]*@/u, "");
  const host = noCred.split(/[/?#]/u)[0] ?? "";
  return host ? host.replace(/:\d+$/u, "") : "a URL";
}

/** Remove anything that looks like a secret, a credential or a URL's sensitive parts. */
export function redact(text: string): string {
  return text
    .replace(URL, stripUrl)
    .replace(BEARER, "…")
    .replace(SECRET_KV, (_m, k: string) => `${k}=…`)
    .replace(SECRET_FLAG, (_m, f: string) => `${f} …`)
    .replace(SECRET_PREFIX, "…")
    .replace(LONG_OPAQUE, "…");
}

/** Clip to `max` characters on a word boundary when possible, with an ellipsis. */
export function clipLabel(text: string, max = ACTION_MAX): string {
  const t = text.replace(/\s+/gu, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** A path for display: relative to the worktree, else the last two segments of an absolute path. */
export function displayPath(path: string, worktree: string | null | undefined): string {
  let p = path.trim().replace(/^['"]|['"]$/gu, "");
  if (worktree) {
    const root = worktree.replace(/\/+$/u, "");
    if (p === root) return ".";
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  if (p.startsWith("~/") || p.startsWith("/")) {
    const parts = p.split("/").filter(Boolean);
    p = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : `${p.startsWith("~/") ? "~/" : "/"}${parts.filter((x) => x !== "~").join("/")}`;
  }
  return redact(p);
}

function unwrap(command: string): string {
  let c = command.trim();
  const wrapped = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/u.exec(c);
  if (wrapped) c = wrapped[2]!.trim();
  return c;
}

/** Split a command line into simple commands, dropping heredoc bodies. */
function simpleCommands(command: string): string[] {
  const lines: string[] = [];
  let skipUntil: string | null = null;
  for (const line of unwrap(command).split("\n")) {
    if (skipUntil !== null) {
      if (line.trim() === skipUntil) skipUntil = null;
      continue;
    }
    const h = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u.exec(line);
    lines.push(h ? line.slice(0, h.index) : line);
    if (h) skipUntil = h[1]!;
  }
  return lines
    .join(" ; ")
    .split(/\s*(?:&&|\|\||;|\|)\s*/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Words of a simple command, without leading env assignments, sudo/env/time wrappers, or redirects. */
function words(cmd: string): string[] {
  const w = cmd.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  let i = 0;
  while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(w[i]!) || ["sudo", "env", "time", "nice", "command", "exec", "nohup"].includes(w[i]!))) i++;
  const out: string[] = [];
  for (let j = i; j < w.length; j++) {
    const x = w[j]!;
    if (/^\d*[<>]/u.test(x) || /^&?>/u.test(x)) {
      if (/^\d*[<>]{1,2}&?$/u.test(x)) j++; // the redirect's target
      continue;
    }
    out.push(x);
  }
  return out;
}

const READS = new Set(["cat", "less", "more", "head", "tail", "nl", "bat", "view", "wc", "file", "stat"]);
const SEARCHES = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "find", "fd", "ls", "ll", "tree", "git-grep"]);
const NOISE = new Set(["cd", "pwd", "echo", "printf", "true", "set", "export", "source", ".", "clear", "sleep", "which", "type"]);
const RUNNERS = new Set(["python", "python3", "node", "deno", "bun", "ruby", "go", "cargo", "make", "npm", "pnpm", "yarn", "npx", "pytest", "uv", "poetry", "bundle", "rake", "rspec", "jest", "vitest", "mvn", "gradle", "dotnet", "swift", "java", "bash", "sh", "zsh", "perl", "php", "tsc", "ruff", "mypy", "eslint", "prettier", "black", "git"]);

const isPathLike = (w: string) => !w.startsWith("-") && /[./]/u.test(w) && !/[*?{}$`]/u.test(w) && w.length < 200;
const unquote = (w: string) => w.replace(/^['"]|['"]$/gu, "");

function filesWord(paths: string[], verb: string, worktree: string | null | undefined): string {
  const uniq = [...new Set(paths.map((p) => displayPath(unquote(p), worktree)))];
  if (!uniq.length) return verb === "editing" ? "editing files" : "reading files";
  return uniq.length === 1 ? `${verb} ${uniq[0]}` : `${verb} ${uniq.length} files`;
}

/** What a shell command line says, in a few words. */
export function commandLabel(command: string, worktree?: string | null): string | null {
  const cmds = simpleCommands(command)
    .map(words)
    .filter((w) => w.length && !NOISE.has(w[0]!));
  if (!cmds.length) return null;
  // Edits first (sed -i, patches, redirects into files, inline scripts that write).
  const raw = unwrap(command);
  const inPlace = cmds.find((w) => (w[0] === "sed" && w.some((x) => /^-i/u.test(x))) || (w[0] === "perl" && w.some((x) => /^-p?i/u.test(x))) || w[0] === "apply_patch" || w[0] === "patch");
  if (inPlace) return filesWord(inPlace.slice(1).filter(isPathLike).slice(-1), "editing", worktree);
  const redirect = /(?:^|[^>&0-9])>{1,2}\s*(?!\/dev\/null|&)([\w./-]+)/u.exec(raw.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/u, (m) => m.split("\n")[0]!));
  if (redirect && !/^\d+$/u.test(redirect[1]!)) return filesWord([redirect[1]!], "editing", worktree);
  if (/\.write(?:_text)?\(|open\([^)]*['"][wa]\+?['"]/u.test(raw)) {
    const target = /open\(\s*['"]([^'"]+)['"]/u.exec(raw)?.[1] ?? /\bp\s*=\s*['"]([^'"]+)['"]/u.exec(raw)?.[1];
    return target ? filesWord([target], "editing", worktree) : "editing files";
  }
  // The strongest part of a compound command: running beats reading beats searching.
  const run = cmds.find((w) => !READS.has(w[0]!) && !SEARCHES.has(w[0]!) && !(w[0] === "sed" && w[1] === "-n") && !(w[0] === "git" && ["log", "show", "diff", "status", "blame", "grep", "ls-files", "rev-parse", "branch"].includes(w[1] ?? "")));
  if (run) {
    const prog = run[0]!.split("/").pop()!;
    const args: string[] = [];
    for (const a of run.slice(1)) {
      if (args.length >= (RUNNERS.has(prog) ? 3 : 2)) break;
      if (/^-c$|^-e$|^--eval$/u.test(a)) {
        args.push(a, "…");
        break;
      }
      const u = unquote(a);
      // Flag values can be secrets: `--password=x` → `--password=…`, `-pSECRET` → `-p…`.
      if (/^--[\w-]+=/u.test(u)) args.push(`${u.slice(0, u.indexOf("=") + 1)}…`);
      else if (/^-[A-Za-z]\S{2,}$/u.test(u) && !/^-[a-z]{2,3}$/u.test(u)) args.push(`${u.slice(0, 2)}…`);
      else args.push(isPathLike(u) ? displayPath(u, worktree) : u.length > 24 ? "…" : u);
    }
    const more = run.length - 1 > args.length ? " …" : "";
    return `running ${[prog, ...args].join(" ")}${more}`;
  }
  const read = cmds.find((w) => READS.has(w[0]!) || (w[0] === "sed" && w[1] === "-n"));
  if (read) {
    const files = cmds.filter((w) => READS.has(w[0]!) || (w[0] === "sed" && w[1] === "-n")).flatMap((w) => w.slice(1).filter((x) => isPathLike(unquote(x))));
    return files.length ? filesWord(files, "reading", worktree) : "reading files";
  }
  const git = cmds.find((w) => w[0] === "git");
  if (git) return `reading git ${git[1] ?? ""}`.trim();
  return "searching the code";
}

/** The short, safe label of one tool item, or null when it says nothing (messages, reasoning). */
export function itemLabel(item: ActionItem, worktree?: string | null): string | null {
  const paths = (item.paths ?? []).filter((p) => typeof p === "string" && p.trim());
  switch (item.kind) {
    case "fileChange":
      return filesWord([...paths], "editing", worktree);
    case "fileRead":
      return filesWord([...paths], "reading", worktree);
    case "search":
      return paths.length ? `searching ${displayPath(paths[0]!, worktree)}` : "searching the code";
    case "webSearch":
      return "searching the web";
    case "webFetch":
      return "reading a web page";
    case "imageView":
      return "looking at an image";
    case "commandExecution":
      return item.command ? commandLabel(item.command, worktree) : "running a command";
    case "toolCall": {
      const t = (item.tool ?? "").toLowerCase();
      if (!t) return null;
      if (t.includes("study_submit")) return "submitting a candidate";
      if (t.includes("study_record_finding")) return "recording a finding";
      if (t.includes("study_finish")) return "finishing";
      if (t.startsWith("study_") || t.includes("study_")) return "checking the study";
      if (item.command) return commandLabel(item.command, worktree);
      if (/edit|write|patch|apply|replace|create/u.test(t)) return filesWord([...paths], "editing", worktree);
      if (/read|view|open|cat/u.test(t)) return filesWord([...paths], "reading", worktree);
      if (/grep|glob|search|find|list|ls/u.test(t)) return paths.length ? `searching ${displayPath(paths[0]!, worktree)}` : "searching the code";
      if (/bash|shell|exec|run|terminal/u.test(t)) return "running a command";
      const name = t.replace(/[^a-z0-9_.-]/gu, "").slice(0, 30);
      return name ? `using ${name}` : null;
    }
    default:
      return null;
  }
}

/**
 * The label of a batch of items: the latest item that says something.
 * Consecutive reads at the end of the batch are summed ("reading 3 files").
 */
export function actionLabel(items: readonly ActionItem[], worktree?: string | null): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    const label = itemLabel(it, worktree);
    if (!label) continue;
    if (it.kind === "fileRead") {
      const paths: string[] = [];
      for (let j = i; j >= 0; j--) {
        const x = items[j]!;
        if (x.kind === "fileRead") paths.push(...(x.paths ?? []));
        else if (itemLabel(x, worktree)) break;
      }
      return sanitizeLabel(filesWord(paths, "reading", worktree));
    }
    return sanitizeLabel(label);
  }
  return null;
}

/** The last line of defense: redact, collapse whitespace, clip to ACTION_MAX. */
export function sanitizeLabel(label: string): string {
  return clipLabel(redact(label), ACTION_MAX);
}
