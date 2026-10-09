// Scope check: every changed path must be editable and none protected, and
// the diff must be within size limits. Enforced at submission, not edit time.

const cache = new Map<string, RegExp>();

/** Repo-relative glob → RegExp. `**` spans directories, `*` and `?` do not. A trailing `/` or a bare directory matches everything under it. */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let g = glob.trim().replace(/^\.\//u, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories; a trailing "**" matches anything.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) re += `\\${c}`;
    else re += c;
  }
  // A pattern without wildcards also matches a directory prefix.
  const hasWildcard = /[*?]/u.test(g);
  const out = new RegExp(hasWildcard ? `^${re}$` : `^${re}(?:/.*)?$`, "u");
  cache.set(glob, out);
  return out;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export interface ScopeRules {
  editable: readonly string[];
  protected: readonly string[];
  max_files: number;
  max_lines: number;
}

export interface ScopeInput {
  changedPaths: readonly string[];
  linesAdded: number;
  linesDeleted: number;
}

export type ScopeResult = { ok: true } | { ok: false; reasons: string[] };

export function checkScope(rules: ScopeRules, diff: ScopeInput): ScopeResult {
  const reasons: string[] = [];
  if (diff.changedPaths.length === 0) reasons.push("no changes relative to best");
  const outside: string[] = [];
  const protectedHits: string[] = [];
  for (const raw of diff.changedPaths) {
    const path = raw.replace(/^\.\//u, "");
    if (path.split("/").includes("..")) {
      outside.push(path);
      continue;
    }
    if (matchesAny(path, rules.protected)) protectedHits.push(path);
    else if (!matchesAny(path, rules.editable)) outside.push(path);
  }
  if (protectedHits.length) reasons.push(`protected paths changed: ${list(protectedHits)}`);
  if (outside.length) reasons.push(`paths outside editable scope: ${list(outside)}`);
  if (diff.changedPaths.length > rules.max_files) {
    reasons.push(`${diff.changedPaths.length} files changed, limit is ${rules.max_files}`);
  }
  const lines = diff.linesAdded + diff.linesDeleted;
  if (lines > rules.max_lines) reasons.push(`${lines} lines changed, limit is ${rules.max_lines}`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

function list(paths: string[]): string {
  const shown = paths.slice(0, 10).join(", ");
  return paths.length > 10 ? `${shown} (+${paths.length - 10} more)` : shown;
}
