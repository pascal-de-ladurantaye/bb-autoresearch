// Server-side relay of git bundles from the edit host to a bench host's own
// clone. Nothing is shared between the two hosts but these bundles: no refs,
// no object store, no network path between them.
//
// Every host call stays inside the host RPC limits: chunks are
// BUNDLE_CHUNK_BYTES raw (5.33 MiB base64), under the 8 MiB output cap on
// bundleRead and the 32 MiB input cap on bundleWrite. A bundle above the
// study's `oracle.max_bundle_mib` fails with a clear error before any chunk
// moves.
import { BUNDLE_CHUNK_BYTES, HOST_RPC_INPUT_LIMIT, HOST_RPC_OUTPUT_LIMIT } from "./host/contract.ts";
import type { HostRunner } from "./host/runner.ts";

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}

export interface TransferResult {
  /** True when the bench already had the commit. */
  skipped: boolean;
  bytes: number;
  chunks: number;
  ms: number;
}

export interface TransferArgs {
  edit: HostRunner;
  editRepo: string;
  bench: HostRunner;
  benchRepo: string;
  /** Commits the bench clone pins already (benchRepo().tips): the bundle basis. */
  benchTips: string[];
  sha: string;
  /** Where the bench pins the commit, e.g. refs/bench/s/<sha>. */
  ref: string;
  maxBytes: number;
  chunkBytes?: number;
  signal?: AbortSignal;
  now?: () => number;
}

const MiB = 1024 * 1024;
const mib = (n: number) => `${(n / MiB).toFixed(n < MiB ? 3 : 1)} MiB`;

/** Ensure `sha` exists in the bench clone, sending a `git bundle` of what it lacks. */
export async function ensureCommit(a: TransferArgs): Promise<TransferResult> {
  const now = a.now ?? Date.now;
  const started = now();
  if ((await a.bench.hasCommits(a.benchRepo, [a.sha])).includes(a.sha)) {
    return { skipped: true, bytes: 0, chunks: 0, ms: 0 };
  }
  const chunk = Math.min(a.chunkBytes ?? BUNDLE_CHUNK_BYTES, BUNDLE_CHUNK_BYTES);
  // Base64 of one chunk (plus a generous JSON envelope) must fit both host RPC limits.
  if (Math.ceil(chunk / 3) * 4 + 4096 > Math.min(HOST_RPC_OUTPUT_LIMIT, HOST_RPC_INPUT_LIMIT)) {
    throw new TransferError(`bundle chunk of ${mib(chunk)} exceeds the host RPC limits`);
  }
  const info = await a.edit.bundleCreate(a.editRepo, a.sha, a.benchTips);
  try {
    if (info.empty) throw new TransferError(`bench clone lacks ${a.sha.slice(0, 12)} but it is reachable from the bench's refs (bundle would be empty)`);
    if (info.bytes > a.maxBytes) {
      throw new TransferError(
        `git bundle for ${a.sha.slice(0, 12)} is ${mib(info.bytes)}, above the ${mib(a.maxBytes)} limit (oracle.max_bundle_mib). ` +
          "Raise the limit, or seed the bench clone so the bundle only carries the difference.",
      );
    }
    let offset = 0;
    let chunks = 0;
    while (offset < info.bytes) {
      if (a.signal?.aborted) throw new TransferError("transfer cancelled");
      const part = await a.edit.bundleRead(info.id, offset, chunk);
      const written = await a.bench.bundleWrite(info.id, offset, part.data);
      const sent = Buffer.byteLength(part.data, "base64");
      if (written !== offset + sent) throw new TransferError(`bundle ${info.id}: bench has ${written} bytes after chunk at ${offset} (+${sent})`);
      offset += sent;
      chunks += 1;
      if (part.eof || sent === 0) break;
    }
    if (offset !== info.bytes) throw new TransferError(`bundle ${info.id}: sent ${offset} of ${info.bytes} bytes`);
    const applied = await a.bench.bundleApply({ repoPath: a.benchRepo, id: info.id, sha: a.sha, ref: a.ref, sha256: info.sha256 });
    if (!applied.ok) throw new TransferError(`bundle for ${a.sha.slice(0, 12)} failed on the bench host: ${applied.detail}`);
    return { skipped: false, bytes: info.bytes, chunks, ms: now() - started };
  } finally {
    await a.edit.bundleDiscard(info.id).catch(() => undefined);
    await a.bench.bundleDiscard(info.id).catch(() => undefined);
  }
}
