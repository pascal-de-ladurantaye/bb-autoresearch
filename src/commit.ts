// Commit messages are the worker's: `study_submit_candidate` takes a title
// and an optional body, and the plugin uses them verbatim for the candidate
// commit and for the promotion squash on best. The plugin adds only its
// trailers, which the harvest freeze and agents use to map commits back to
// candidates (and to a study, when several studies share a repository).
import { clip } from "./prompts.ts";

export const COMMIT_TITLE_MAX = 72;
export const COMMIT_BODY_MAX = 4000;

/** Trailer keys the plugin owns; a worker's body may not contain them. */
export const STUDY_TRAILER = "Autoresearch-Study";
export const CANDIDATE_TRAILER = "Autoresearch-Candidate";

const TRAILER_LINE = /^\s*autoresearch-[a-z-]*\s*:/imu;

export type CommitMessageCheck = { ok: true; title: string; body: string | null } | { ok: false; reason: string };

/**
 * Check a worker's commit message: a one-line title of at most 72
 * characters (after trimming) and an optional body without the plugin's
 * trailers. The reasons are written for the worker.
 */
export function checkCommitMessage(title: string, body: string | null | undefined): CommitMessageCheck {
  const t = title.trim();
  if (!t) return { ok: false, reason: "the commit title is empty: pass `title`, one line saying what the change does" };
  if (/[\r\n]/u.test(t)) return { ok: false, reason: "the commit title must be one line; put the details in `body`" };
  if ([...t].length > COMMIT_TITLE_MAX) return { ok: false, reason: `the commit title is ${[...t].length} characters; keep it at most ${COMMIT_TITLE_MAX} (details go in \`body\`)` };
  const b = (body ?? "").replace(/\r\n/gu, "\n").replace(/\s+$/u, "").replace(/^\n+/u, "");
  if (b.length > COMMIT_BODY_MAX) return { ok: false, reason: `the commit body is ${b.length} characters; keep it at most ${COMMIT_BODY_MAX}` };
  if (TRAILER_LINE.test(b)) return { ok: false, reason: "the commit body may not contain Autoresearch-* trailer lines: the plugin adds its own" };
  return { ok: true, title: t, body: b || null };
}

export interface MessageSource {
  n: number;
  commit_title: string | null;
  commit_body: string | null;
  /** Before v1: the worker's summary, used when there is no commit title. */
  summary: string;
}

/** Title and body of a candidate's commits: the worker's, or for candidates from before 1.0 the idea title and summary. */
export function commitParts(c: MessageSource, ideaTitle?: string | null): { title: string; body: string | null } {
  if (c.commit_title) return { title: c.commit_title, body: c.commit_body };
  return { title: clip(ideaTitle ?? c.summary.split("\n")[0] ?? `candidate c/${c.n}`, COMMIT_TITLE_MAX), body: clip(c.summary, 2000) || null };
}

/** The message of a candidate's commits (snapshot, rebased candidate, promotion): the worker's title and body, then the plugin's trailers. */
export function candidateCommitMessage(slug: string, c: MessageSource, ideaTitle?: string | null): string {
  const { title, body } = commitParts(c, ideaTitle);
  return [title, "", ...(body ? [body, ""] : []), `${STUDY_TRAILER}: ${slug}`, `${CANDIDATE_TRAILER}: c/${c.n}`].join("\n");
}

/** The candidate number a commit message names in its trailer (null when it has none). */
export function candidateFromMessage(message: string, slug?: string): number | null {
  const study = new RegExp(`^${STUDY_TRAILER}:\\s*(\\S+)\\s*$`, "mu").exec(message)?.[1];
  if (slug && study && study !== slug) return null;
  const n = new RegExp(`^${CANDIDATE_TRAILER}:\\s*c/(\\d+)\\s*$`, "mu").exec(message)?.[1];
  return n === undefined ? null : Number(n);
}
