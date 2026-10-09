// Machine health probe (host side): load, competing processes, CPU governor
// and turbo where the platform exposes them. Whatever can't be detected is
// listed in `notDetectable` instead of guessed. The server's policy
// (src/health.ts) decides what counts as unhealthy.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
import { basename } from "node:path";
import type { HealthReport } from "./contract.ts";

async function run(cmd: string, args: string[], timeoutMs = 5_000): Promise<string | null> {
  return await new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!done) resolve(null);
      done = true;
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      if (!done) resolve(null);
      done = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!done) resolve(code === 0 ? out : null);
      done = true;
    });
  });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

type Proc = { pid: number; cpu: number; command: string };

/** Own process tree: this worker and anything it spawned (jobs are excluded too). */
function excluded(pid: number): boolean {
  return pid === process.pid || pid === process.ppid;
}

async function topProcessesPs(): Promise<Proc[] | null> {
  const out = await run("ps", ["-A", "-o", "pid=,pcpu=,comm="]);
  if (out === null) return null;
  const rows: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/u.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (excluded(pid)) continue;
    rows.push({ pid, cpu: Number(m[2]), command: basename(m[3]!.trim()).slice(0, 80) });
  }
  return rows;
}

/** Linux: instantaneous CPU share from two /proc samples (ps pcpu is a lifetime average there). */
async function topProcessesProc(sampleMs = 500): Promise<Proc[] | null> {
  if (!existsSync("/proc/self/stat")) return null;
  const read = () => {
    const m = new Map<number, { ticks: number; comm: string }>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      const stat = readText(`/proc/${name}/stat`);
      if (!stat) continue;
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const fields = stat.slice(close + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      if (Number.isFinite(ticks)) m.set(Number(name), { ticks, comm });
    }
    return m;
  };
  const a = read();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = read();
  const hz = 100;
  const rows: Proc[] = [];
  for (const [pid, v] of b) {
    if (excluded(pid)) continue;
    const before = a.get(pid);
    if (!before) continue;
    rows.push({ pid, cpu: ((v.ticks - before.ticks) / hz / (sampleMs / 1000)) * 100, command: v.comm.slice(0, 80) });
  }
  return rows;
}

export async function health(): Promise<HealthReport> {
  const os = platform();
  const notDetectable: string[] = [];
  let procs = os === "linux" ? await topProcessesProc() : null;
  procs ??= await topProcessesPs();
  if (procs === null) notDetectable.push("process list");
  const topProcesses = (procs ?? [])
    .filter((p) => p.command !== "ps")
    .sort((x, y) => y.cpu - x.cpu)
    .slice(0, 10)
    .map((p) => ({ ...p, cpu: Math.round(p.cpu * 10) / 10 }));

  let governor: string | null = null;
  let turbo: boolean | null = null;
  let onAcPower: boolean | null = null;
  let cpuSpeedLimit: number | null = null;
  if (os === "linux") {
    governor = readText("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor");
    if (governor === null) notDetectable.push("cpu governor (no cpufreq)");
    const noTurbo = readText("/sys/devices/system/cpu/intel_pstate/no_turbo");
    const boost = readText("/sys/devices/system/cpu/cpufreq/boost");
    if (noTurbo !== null) turbo = noTurbo === "0";
    else if (boost !== null) turbo = boost === "1";
    else notDetectable.push("turbo/boost state");
    const ac = existsSync("/sys/class/power_supply")
      ? readdirSync("/sys/class/power_supply")
          .filter((n) => /^(AC|ADP)/iu.test(n))
          .map((n) => readText(`/sys/class/power_supply/${n}/online`))
          .find((v) => v !== null)
      : undefined;
    if (ac !== undefined && ac !== null) onAcPower = ac === "1";
  } else if (os === "darwin") {
    notDetectable.push("cpu governor (macOS has none)", "turbo boost state (not exposed on macOS)");
    const batt = await run("pmset", ["-g", "batt"]);
    if (batt !== null) onAcPower = /'AC Power'/u.test(batt);
    else notDetectable.push("power source");
    const therm = await run("pmset", ["-g", "therm"]);
    const m = therm ? /CPU_Speed_Limit\s*=\s*(\d+)/u.exec(therm) : null;
    if (m) cpuSpeedLimit = Number(m[1]);
    else notDetectable.push("cpu speed limit (pmset reports none on this Mac)");
  } else {
    notDetectable.push("cpu governor", "turbo/boost state", "power source");
  }
  return {
    hostname: hostname(),
    platform: os,
    arch: arch(),
    cpus: cpus().length,
    loadavg: loadavg().map((v) => Math.round(v * 100) / 100),
    freeMemMb: Math.round(freemem() / 1048576),
    totalMemMb: Math.round(totalmem() / 1048576),
    topProcesses,
    governor,
    turbo,
    onAcPower,
    cpuSpeedLimit,
    notDetectable,
    at: Date.now(),
  };
}
