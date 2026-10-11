// The repository a remote bench machine starts from (host side, on the edit
// host): a shallow git bundle of one commit, the study base. Remote machines
// are short-lived and a full history can be gigabytes, so each one gets the
// base's tree and nothing older; best and every candidate follow as small
// delta bundles whose prerequisite is the base. Built once per base commit and
// cached under <dataDir>/bundles.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "./ops.ts";

/** The ref the base commit travels under inside the bundle (bench-provider/runner.ts fetches it). */
export const BASE_REF = "refs/autoresearch/base";

export async function baseBundle(dataDir: string, repoPath: string, sha: string): Promise<{ path: string; sha256: string; bytes: number; cached: boolean }> {
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new Error(`base bundle: not a full commit sha: ${sha}`);
  const dir = join(dataDir, "bundles");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `base-${sha}.bundle`);
  const sum = `${out}.sha256`;
  if (existsSync(out) && existsSync(sum)) {
    const sha256 = readFileSync(sum, "utf8").trim();
    if (/^[0-9a-f]{64}$/u.test(sha256)) return { path: out, sha256, bytes: statSync(out).size, cached: true };
  }
  const scratch = join(dir, `base-${sha}.scratch`);
  const ref = `${BASE_REF}/${sha}`;
  rmSync(scratch, { recursive: true, force: true });
  await git(dir, ["init", "--bare", "-q", scratch]);
  // A depth-1 fetch needs a ref to ask for (and the file:// transport: a plain path ignores --depth).
  await git(repoPath, ["update-ref", ref, sha]);
  try {
    await git(scratch, ["fetch", "-q", "--no-tags", "--depth", "1", pathToFileURL(repoPath).href, `+${ref}:${ref}`]);
  } finally {
    await git(repoPath, ["update-ref", "-d", ref], { allowFail: true });
  }
  const tmp = `${out}.tmp`;
  try {
    await git(scratch, ["bundle", "create", "-q", tmp, ref]);
    const sha256 = createHash("sha256").update(readFileSync(tmp)).digest("hex");
    renameSync(tmp, out);
    writeFileSync(sum, `${sha256}\n`);
    return { path: out, sha256, bytes: statSync(out).size, cached: false };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
