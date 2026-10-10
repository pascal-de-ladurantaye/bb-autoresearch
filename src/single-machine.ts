// Single-machine mode: when one machine is both the edit host and a bench
// host, gates (tests, type checks, renders) compete for CPU with timing runs.
// In this mode gates take the same per-host bench lock as measurements, in
// one oldest-first queue with them, so a gate and a measurement never
// overlap on that machine. Pure: decides from the spec and the resolved
// bench host ids (null before they are resolved).
import type { StudySpec } from "./spec.ts";

export type SingleMachineSetting = "auto" | "on" | "off";

export interface SingleMachineMode {
  /** Gates take the edit machine's bench lock. */
  on: boolean;
  setting: SingleMachineSetting;
  /** Why it is on or off, in words. */
  reason: string;
  /** The machine whose bench lock gates take (the edit host), when on. */
  hostId: string | null;
  /** A bench host of the study is the edit machine. */
  shared: boolean;
}

/**
 * Whether gates are serialized with measurements.
 * - "off": never.
 * - "on": always (gates take the edit host's bench lock key).
 * - "auto": on when a bench host is the edit machine, unless the oracle is
 *   deterministic (its measurements don't need a quiet machine).
 */
export function singleMachineMode(spec: Pick<StudySpec, "oracle">, editHostId: string | null, benchHostIds: readonly string[] | null): SingleMachineMode {
  const setting: SingleMachineSetting = spec.oracle.single_machine ?? "auto";
  const shared =
    benchHostIds !== null
      ? editHostId !== null && benchHostIds.includes(editHostId)
      : spec.oracle.bench_hosts.length === 0 || spec.oracle.bench_hosts.some((h) => h.toLowerCase() === "local");
  const hostId = editHostId;
  if (setting === "off") return { on: false, setting, reason: 'off (single_machine = "off"): gates run in parallel, outside the bench lock', hostId: null, shared };
  if (setting === "on") {
    return {
      on: true,
      setting,
      reason: shared ? 'on (single_machine = "on")' : 'on (single_machine = "on"; no bench host is the edit machine, so gates only wait for each other)',
      hostId,
      shared,
    };
  }
  if (spec.oracle.noise === "deterministic") return { on: false, setting, reason: "off (auto: deterministic measurements don't need a quiet machine)", hostId: null, shared };
  if (shared) return { on: true, setting, reason: "on (auto: a bench host is the edit machine)", hostId, shared };
  return { on: false, setting, reason: "off (auto: no bench host is the edit machine)", hostId: null, shared };
}

/** One paragraph for the Oracle tab, the calibration report and `bb study show`. */
export function singleMachineText(mode: SingleMachineMode, spec: Pick<StudySpec, "oracle">, hostName: string | null): string {
  const quiet = spec.oracle.quiet_bench
    ? " Quiet bench is on: while a measurement runs, new worker turns on that machine wait to start (turns already running are not interrupted; a held turn waits for at most one measurement)."
    : "";
  if (!mode.on) return `Single-machine mode is ${mode.reason}.${quiet}`;
  if (!spec.oracle.gate.length) return `Single-machine mode is ${mode.reason}, but there are no gates to serialize.${quiet}`;
  return (
    `Single-machine mode is ${mode.reason}: gates take the bench lock of ${hostName ?? "the edit machine"}, in one queue with measurements (oldest first), so tests never run while a candidate is timed. ` +
    `Gate time counts as bench time: utilization includes it, and the worker target W uses gate + measure time per candidate.${quiet}`
  );
}
