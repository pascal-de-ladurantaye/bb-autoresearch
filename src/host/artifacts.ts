// What remote bench hosts are sent from the edit host, as files under the
// plugin's data dir there: packed seeds (<dataDir>/seeds, host/seed.ts) and
// shallow base bundles (<dataDir>/bundles, host/base.ts). Both are content
// addressed and can be hundreds of MB, so they are garbage collected: the
// server passes the paths its non-archived studies still use, and every other
// artifact file is deleted. A file deleted by mistake costs a rebuild, never a
// wrong result (the fleet checks the file exists before it reuses a seed, and
// rebuilds a missing base bundle).
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ArtifactFile {
  path: string;
  kind: "seed" | "base";
  bytes: number;
  /** In the keep list (a non-archived study uses it). */
  kept: boolean;
  /** Deleted by this call. */
  deleted: boolean;
}

export interface ArtifactReport {
  /** Seeds and base bundles on disk before this call, with what happened to each (at most `MAX_LISTED`). */
  files: ArtifactFile[];
  seeds: { files: number; bytes: number };
  bases: { files: number; bytes: number };
  deleted: { files: number; bytes: number };
  /** Leftover temporary files and directories removed (interrupted packs and bundle builds). */
  scratch: number;
}

export interface ArtifactOptions {
  /** Absolute paths to keep (seed archives, base bundles). */
  keep: readonly string[];
  /** Delete what isn't kept; false only reports. */
  gc: boolean;
  /** Files younger than this are kept anyway: a seed or bundle being built has no row yet (default 10 min). */
  graceMs?: number;
  now?: number;
}

const SEED_FILE = /^[0-9a-f]{64}\.tar(?:\.gz)?$/u;
const BASE_FILE = /^base-[0-9a-f]{40,64}\.bundle$/u;
const MAX_LISTED = 500;
/** Temporary files older than this are leftovers of an interrupted build. */
const SCRATCH_AGE_MS = 24 * 3_600_000;

export async function artifactStore(dataDir: string, opts: ArtifactOptions): Promise<ArtifactReport> {
  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? 10 * 60_000;
  const keep = new Set(opts.keep.map((p) => resolve(p)));
  const report: ArtifactReport = { files: [], seeds: { files: 0, bytes: 0 }, bases: { files: 0, bytes: 0 }, deleted: { files: 0, bytes: 0 }, scratch: 0 };
  const dirs: Array<{ dir: string; kind: "seed" | "base"; re: RegExp }> = [
    { dir: join(dataDir, "seeds"), kind: "seed", re: SEED_FILE },
    { dir: join(dataDir, "bundles"), kind: "base", re: BASE_FILE },
  ];
  for (const { dir, kind, re } of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (!re.test(name)) {
        // Interrupted builds: `.<sha>.<rand>.tmp` (seeds), `base-<sha>.bundle.tmp` and `base-<sha>.scratch/` (bundles).
        const scratch = name.endsWith(".tmp") || name.endsWith(".scratch");
        if (opts.gc && scratch && now - st.mtimeMs > SCRATCH_AGE_MS) {
          await rm(path, { recursive: true, force: true });
          report.scratch += 1;
        }
        continue;
      }
      if (!st.isFile()) continue;
      const sidecar = kind === "base" ? `${path}.sha256` : null;
      const bytes = st.size + (sidecar ? ((await stat(sidecar).catch(() => null))?.size ?? 0) : 0);
      const kept = keep.has(resolve(path)) || now - st.mtimeMs < grace;
      const totals = kind === "seed" ? report.seeds : report.bases;
      totals.files += 1;
      totals.bytes += bytes;
      let deleted = false;
      if (opts.gc && !kept) {
        await rm(path, { force: true });
        if (sidecar) await rm(sidecar, { force: true });
        deleted = true;
        report.deleted.files += 1;
        report.deleted.bytes += bytes;
      }
      if (report.files.length < MAX_LISTED) report.files.push({ path, kind, bytes, kept: keep.has(resolve(path)), deleted });
    }
  }
  return report;
}
