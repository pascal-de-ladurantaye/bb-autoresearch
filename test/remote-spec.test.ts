// [[oracle.remote_bench]]: parsing, defaults, validation, the oracle hash
// (older specs keep theirs), single-machine mode and bench host resolution.
import { describe, expect, it } from "vitest";
import { resolveBenchHosts } from "../src/bench.ts";
import { remoteGates, singleMachineMode } from "../src/single-machine.ts";
import { normalizeSpec, oracleHash, parseSpec, type StudySpec } from "../src/spec.ts";
import { DETERMINISTIC_SPEC } from "./helpers.ts";

const REMOTE = `
[[oracle.remote_bench]]
provider = "bench-provider-local"
hosts = 2
cores = 4
lifetime_minutes = 60
seed = "scripts/seed.sh"
setup = "scripts/setup.sh"
env = { LANG = "C.UTF-8" }
`;

function withRemote(extra = REMOTE, base = DETERMINISTIC_SPEC.replace('noise = "deterministic"', 'noise = "noisy"')): string {
  return base.replace("\n[budget]", `${extra}\n[budget]`);
}

function ok(toml: string): { spec: StudySpec; warnings: string[] } {
  const r = parseSpec(toml);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
}

describe("remote bench spec", () => {
  it("parses an entry with defaults", () => {
    const { spec, warnings } = ok(withRemote());
    expect(spec.oracle.remote_bench).toEqual([
      { provider: "bench-provider-local", hosts: 2, cores: 4, lifetime_minutes: 60, seed: "scripts/seed.sh", seed_allow: [], setup: "scripts/setup.sh", env: { LANG: "C.UTF-8" }, gates: false },
    ]);
    expect(warnings.join("\n")).toMatch(/only remote machines measure/u);
    expect(ok(DETERMINISTIC_SPEC).spec.oracle.remote_bench).toEqual([]);
  });

  it("rejects bad entries", () => {
    const bad = (extra: string) => parseSpec(withRemote(extra));
    expect(bad(`[[oracle.remote_bench]]\nprovider = "X Y"\ncores = 1\n`).ok).toBe(false);
    expect(bad(`[[oracle.remote_bench]]\nprovider = "p"\n`).ok).toBe(false); // cores is required
    expect(bad(`[[oracle.remote_bench]]\nprovider = "p"\ncores = 1\nunknown = 1\n`).ok).toBe(false);
    expect(bad(`[[oracle.remote_bench]]\nprovider = "p"\ncores = 1\nlifetime_minutes = 10\nrotate_before_minutes = 10\n`).ok).toBe(false);
    expect(bad(`[[oracle.remote_bench]]\nprovider = "p"\ncores = 1\nenv = { "1BAD" = "x" }\n`).ok).toBe(false);
  });

  it("warns when the rotation lead is most of the lifetime (machines would rotate almost continuously)", () => {
    const long = ok(withRemote(REMOTE.replace("lifetime_minutes = 60", "lifetime_minutes = 20\nrotate_before_minutes = 17")));
    expect(long.warnings.join("\n")).toMatch(/rotate_before_minutes = 17 is more than half of lifetime_minutes = 20: each machine is replaced 3 min after it was created/u);
    const fine = ok(withRemote(REMOTE.replace("lifetime_minutes = 60", "lifetime_minutes = 20\nrotate_before_minutes = 5")));
    expect(fine.warnings.join("\n")).not.toMatch(/rotate almost continuously/u);
  });

  it("older specs keep their oracle hash; operations don't change it, the machine does", () => {
    // The hash of this spec under v0.2.4's code.
    expect(oracleHash(ok(DETERMINISTIC_SPEC).spec)).toBe("8c0b5b606b195eed");
    expect(oracleHash(ok(DETERMINISTIC_SPEC).spec, "abc")).toBe("422adeedb3fbe5f2");
    // A spec stored before v0.3.0 has no remote_bench key at all.
    const stored = JSON.parse(JSON.stringify(ok(DETERMINISTIC_SPEC).spec)) as StudySpec;
    delete (stored.oracle as Partial<StudySpec["oracle"]>).remote_bench;
    expect(oracleHash(normalizeSpec(stored))).toBe("8c0b5b606b195eed");
    const base = oracleHash(ok(withRemote()).spec);
    expect(base).not.toBe(oracleHash(ok(withRemote("")).spec));
    const ops = withRemote(REMOTE.replace("hosts = 2", "hosts = 3").replace("lifetime_minutes = 60", 'lifetime_minutes = 90\nrotate_before_minutes = 15\ngates = true\nseed_allow = ["fixtures/**"]'));
    expect(oracleHash(ok(ops).spec)).toBe(base);
    expect(oracleHash(ok(withRemote(REMOTE.replace("cores = 4", "cores = 8"))).spec)).not.toBe(base);
    expect(oracleHash(ok(withRemote(REMOTE.replace('setup = "scripts/setup.sh"', 'setup = "scripts/setup2.sh"'))).spec)).not.toBe(base);
  });

  it("machine options: an inline table passed verbatim; hashed when set, so specs without it keep their hash", () => {
    // The hash this spec had before machine options existed (v0.3.x and the rest of 1.0).
    expect(oracleHash(ok(withRemote()).spec)).toBe("99cf09db8cf48db2");
    expect(oracleHash(ok(withRemote(`${REMOTE}machine = {}\n`)).spec)).toBe("99cf09db8cf48db2");
    const shaped = ok(withRemote(`${REMOTE}machine = { machine_type = "c3-standard-8", smt = false, threads_per_core = 1 }\n`)).spec;
    expect(shaped.oracle.remote_bench[0]!.machine).toEqual({ machine_type: "c3-standard-8", smt: false, threads_per_core: 1 });
    expect(oracleHash(shaped)).not.toBe("99cf09db8cf48db2");
    const other = ok(withRemote(`${REMOTE}machine = { machine_type = "c3-standard-4", smt = false, threads_per_core = 1 }\n`)).spec;
    expect(oracleHash(other)).not.toBe(oracleHash(shaped));
    const bad = (m: string) => parseSpec(withRemote(`${REMOTE}machine = ${m}\n`)).ok;
    expect(bad('{ "bad-key" = "x" }')).toBe(false);
    expect(bad(`{ image = "${"x".repeat(257)}" }`)).toBe(false);
    expect(bad("{ nested = { a = 1 } }")).toBe(false);
    expect(bad(`{ ${Array.from({ length: 33 }, (_, i) => `k${i} = ${i}`).join(", ")} }`)).toBe(false);
  });

  it("no bench_hosts with remote machines means remote only; gates on remote turn single-machine mode off", () => {
    expect(resolveBenchHosts([], [], "host_e", { remote: true })).toEqual({ ok: true, hosts: [] });
    expect(resolveBenchHosts([], [], "host_e")).toMatchObject({ ok: true, hosts: [{ entry: "local" }] });
    const { spec } = ok(withRemote(REMOTE.replace("hosts = 2", "hosts = 2\ngates = true")).replace("bench_hosts", "x").replace('measure = "measure.sh"', 'measure = "measure.sh"\nbench_hosts = ["local"]'));
    expect(remoteGates(spec)).toBe(true);
    const mode = singleMachineMode(spec, "host_e", ["host_e", "remote-1"]);
    expect(mode.on).toBe(false);
    expect(mode.reason).toMatch(/remote bench hosts/u);
    const remoteOnly = ok(withRemote()).spec;
    expect(singleMachineMode(remoteOnly, "host_e", null).shared).toBe(false);
  });
});
