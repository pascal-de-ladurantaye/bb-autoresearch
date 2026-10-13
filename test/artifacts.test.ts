// Seeds and base bundles on the edit host (host/artifacts.ts): what the
// garbage collection keeps, deletes, and reports.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactStore } from "../src/host/artifacts.ts";

describe("artifact store", () => {
  let dir: string;
  const now = Date.now();
  const old = new Date(now - 2 * 24 * 3_600_000);

  function file(rel: string, bytes: number, aged = true): string {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x".repeat(bytes));
    if (aged) utimesSync(p, old, old);
    return p;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ar-artifacts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports seeds and base bundles without deleting anything when gc is off", async () => {
    const seed = file(`seeds/${"a".repeat(64)}.tar.gz`, 100);
    const base = file(`bundles/base-${"b".repeat(40)}.bundle`, 50);
    file(`bundles/base-${"b".repeat(40)}.bundle.sha256`, 65);
    const r = await artifactStore(dir, { keep: [], gc: false, now });
    expect(r.seeds).toEqual({ files: 1, bytes: 100 });
    expect(r.bases).toEqual({ files: 1, bytes: 115 });
    expect(r.deleted).toEqual({ files: 0, bytes: 0 });
    expect(existsSync(seed) && existsSync(base)).toBe(true);
    expect(r.files.map((f) => [f.kind, f.kept, f.deleted])).toEqual([
      ["seed", false, false],
      ["base", false, false],
    ]);
  });

  it("deletes what isn't kept (a base bundle with its checksum), keeps the keep list and young files", async () => {
    const kept = file(`seeds/${"a".repeat(64)}.tar.gz`, 100);
    const unused = file(`seeds/${"c".repeat(64)}.tar`, 200);
    const young = file(`seeds/${"d".repeat(64)}.tar.gz`, 300, false);
    const base = file(`bundles/base-${"b".repeat(40)}.bundle`, 50);
    const sum = file(`bundles/base-${"b".repeat(40)}.bundle.sha256`, 65);
    const r = await artifactStore(dir, { keep: [kept], gc: true, now });
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(unused)).toBe(false);
    expect(existsSync(base) || existsSync(sum)).toBe(false);
    expect(r.deleted).toEqual({ files: 2, bytes: 315 });
    expect(r.seeds.files).toBe(3);
  });

  it("leaves files it doesn't own alone, and removes old scratch left by interrupted builds", async () => {
    const foreign = file("seeds/notes.txt", 10);
    const tmpOld = file(`seeds/.${"e".repeat(64)}.1234abcd.tmp`, 10);
    const tmpNew = file(`seeds/.${"f".repeat(64)}.1234abcd.tmp`, 10, false);
    mkdirSync(join(dir, `bundles/base-${"1".repeat(40)}.scratch`), { recursive: true });
    utimesSync(join(dir, `bundles/base-${"1".repeat(40)}.scratch`), old, old);
    const r = await artifactStore(dir, { keep: [], gc: true, now });
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(tmpOld)).toBe(false);
    expect(existsSync(tmpNew)).toBe(true);
    expect(existsSync(join(dir, `bundles/base-${"1".repeat(40)}.scratch`))).toBe(false);
    expect(r.scratch).toBe(2);
    expect(r.deleted.files).toBe(0);
  });

  it("is empty for a data dir without artifacts", async () => {
    const r = await artifactStore(join(dir, "missing"), { keep: [], gc: true, now });
    expect(r).toEqual({ files: [], seeds: { files: 0, bytes: 0 }, bases: { files: 0, bytes: 0 }, deleted: { files: 0, bytes: 0 }, scratch: 0 });
  });
});

describe("artifact size line (bb study bench)", () => {
  it("says a cleanup deleted nothing instead of a size", async () => {
    const { artifactLine } = await import("../src/cli.ts");
    const base = { seeds: { files: 1, bytes: 2048 }, bases: { files: 1, bytes: 2048 }, study: { files: 2, bytes: 4096 } };
    expect(artifactLine({ ...base, lastCleanup: { at: 0, reason: "study archived", files: 0, bytes: 0 } })).toMatch(/last cleanup \(study archived\) deleted nothing$/u);
    expect(artifactLine({ ...base, lastCleanup: { at: 0, reason: "plugin loaded", files: 2, bytes: 3 * 1024 * 1024 } })).toMatch(/deleted 2 file\(s\), 3\.0 MiB$/u);
  });
});
