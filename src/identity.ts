// Who the plugin's commits in the studied repository are authored and
// committed by: snapshots, prepared (squashed) candidates, promotions, and
// harvest commits. `[git] identity = "repo"` (default) uses the identity git
// resolves in the repo on the edit host (user.name / user.email, repo-local
// then global); when none is configured it falls back to the plugin's and
// says so. `"plugin"` always uses `autoresearch <autoresearch@bb.local>`.
// The server resolves it once per study (cached briefly) and passes it
// explicitly to every host that commits, so they all use the same one.
import type { GitIdentity } from "./host/contract.ts";
import type { HostRunner } from "./host/runner.ts";
import type { StudySpec } from "./spec.ts";

export const PLUGIN_IDENTITY: GitIdentity = { name: "autoresearch", email: "autoresearch@bb.local" };

export interface CommitIdentity extends GitIdentity {
  /** repo: the repository's own identity; plugin: asked for; fallback: the repo has none configured. */
  source: "repo" | "plugin" | "fallback";
}

export async function resolveCommitIdentity(runner: Pick<HostRunner, "gitIdentity">, repoPath: string, spec: Pick<StudySpec, "git">): Promise<CommitIdentity> {
  if ((spec.git?.identity ?? "repo") === "plugin") return { ...PLUGIN_IDENTITY, source: "plugin" };
  const r = await runner.gitIdentity(repoPath);
  if (r.name && r.email) return { name: r.name, email: r.email, source: "repo" };
  return { ...PLUGIN_IDENTITY, source: "fallback" };
}

/** One sentence for the calibration report, notices and `bb study show`. */
export function identityText(id: CommitIdentity): string {
  const who = `${id.name} <${id.email}>`;
  if (id.source === "repo") return `Commits in the repository are authored as ${who}, the repository's git identity.`;
  if (id.source === "plugin") return `Commits in the repository are authored as ${who} ([git] identity = "plugin").`;
  return `No git identity (user.name and user.email) is configured for the repository, so commits are authored as ${who}. Set one with git config, or [git] identity = "plugin" to make this the choice.`;
}
