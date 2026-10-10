// Study spec: TOML in, validated typed spec out. The spec lives in plugin
// storage (never in the repo), versioned and hash-pinned.
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export const NOISE_CLASSES = ["deterministic", "noisy", "expensive"] as const;
export type NoiseClass = (typeof NOISE_CLASSES)[number];
export type Direction = "lower" | "higher";

/** "5%" → 0.05, "0.5 %" → 0.005, 0.05 → 0.05. */
const fraction = z.union([z.number(), z.string()]).transform((value, ctx) => {
  let n: number;
  if (typeof value === "number") n = value;
  else {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/u.exec(value);
    if (!m) {
      ctx.addIssue({ code: "custom", message: `expected a percentage like "5%", got ${JSON.stringify(value)}` });
      return z.NEVER;
    }
    n = Number(m[1]) / 100;
  }
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    ctx.addIssue({ code: "custom", message: "must be between 0% and 1000%" });
    return z.NEVER;
  }
  return n;
});

const command = z.string().trim().min(1).max(4000);

/** Untracked files the worker snapshot never commits (gitignore-style patterns, see scope.ts). */
export const DEFAULT_IGNORE = [
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  ".pytest_cache/",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  ".DS_Store",
  "coverage/",
  ".coverage",
  ".nyc_output/",
  "htmlcov/",
] as const;

const ignorePattern = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((g) => !g.startsWith("!"), "ignore patterns can't be negated")
  .refine((g) => !g.split("/").includes(".."), "ignore patterns may not contain ..")
  .refine((g) => !/[:'"\\]/u.test(g), "ignore patterns may not contain quotes, backslashes or colons")
  .refine((g) => g.replace(/^\/+|\/+$/gu, "").length > 0, "ignore patterns must name something");

const glob = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((g) => !g.startsWith("/") && !g.split("/").includes(".."), "globs are repo-relative and may not contain ..");

const agentSpec = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permission_mode: z.enum(["accept-edits", "auto", "full"]).optional(),
  })
  .strict();

export const specSchema = z
  .object({
    study: z
      .object({
        slug: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,47}$/u, "slug: 2-48 chars of lowercase letters, digits and dashes"),
        objective: z.string().trim().min(10).max(2000),
        base: z.string().trim().min(1).max(200).default("main"),
      })
      .strict(),
    metric: z
      .object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u),
        unit: z.string().max(32).default(""),
        direction: z.enum(["lower", "higher"]),
      })
      .strict(),
    guardrail: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u),
            /** Per step: how much worse a candidate may be than the current best. */
            max_regression: fraction,
            /** Cumulative: how much worse best may get than the segment base, over all promotions (default: max_regression). */
            max_total_regression: fraction.optional(),
            direction: z.enum(["lower", "higher"]).default("lower"),
          })
          .strict()
          .transform((g) => ({ ...g, max_total_regression: g.max_total_regression ?? g.max_regression })),
      )
      .max(16)
      .default([]),
    scope: z
      .object({
        editable: z.array(glob).min(1).max(64),
        protected: z.array(glob).max(64).default([]),
        max_files: z.number().int().min(1).max(10_000).default(50),
        max_lines: z.number().int().min(1).max(1_000_000).default(2000),
        /**
         * Build outputs and caches (gitignore-style patterns) that snapshots never
         * commit, and that a candidate may not add. Replaces the defaults when set.
         */
        ignore: z.array(ignorePattern).max(64).default([...DEFAULT_IGNORE]),
      })
      .strict(),
    oracle: z
      .object({
        build: command.optional(),
        gate: z.union([command, z.array(command).max(16)]).transform((g) => (typeof g === "string" ? [g] : g)).default([]),
        measure: command,
        profile: command.optional(),
        noise: z.enum(NOISE_CLASSES),
        /**
         * "local" measures in plugin checkouts of the project repo on the edit
         * host (no transfer). Any other entry is a BB host id or name, the
         * server's own machine included: it gets a bench-owned clone that
         * receives commits only as git bundles (the remote path).
         */
        bench_hosts: z.array(z.string().trim().min(1).max(200)).max(16).default([]),
        /** Per command (build, gate, one measure run). Long commands run as host jobs, so this may exceed the 30-minute host call cap. */
        timeout_minutes: z.number().min(0.1).max(24 * 60).default(20),
        /** A git bundle larger than this fails the transfer to a bench host. */
        max_bundle_mib: z.number().min(1).max(4096).default(256),
        /** Notify the human when a bench host stays offline this long. */
        offline_grace_minutes: z.number().min(0.5).max(24 * 60).default(10),
        /**
         * Single-machine mode: gates take the same per-host bench lock as
         * measurements, in one queue with them, so tests never run while a
         * candidate is timed. "auto" turns it on when a bench host is the edit
         * machine (and the noise class takes the bench lock). Scheduling, not
         * measurement: not part of the oracle hash.
         */
        single_machine: z.enum(["auto", "on", "off"]).default("auto"),
        /**
         * While a measurement runs on a host, hold the start of new worker turns
         * whose environment is on that host (running turns are not interrupted).
         * Not part of the oracle hash.
         */
        quiet_bench: z.boolean().default(false),
        /** Hidden workload on the bench host, run only on candidates about to be promoted. Agents see pass/fail only. */
        holdout: z
          .object({
            measure: command,
            /** Metric to compare (default: the primary metric). */
            metric: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u).optional(),
            /** Paired best/candidate runs. */
            runs: z.number().int().min(1).max(50).default(3),
            /** Fail when the candidate's median paired holdout change is worse than this. */
            max_regression: fraction.default(0.01),
          })
          .strict()
          .optional(),
        /** Machine health checked before every measurement; a failing check defers it. */
        health: z
          .object({
            enabled: z.boolean().default(true),
            /** 1-minute load average per CPU. */
            max_load: z.number().min(0).max(64).default(0.8),
            /** CPU % (of one core) of the busiest other process. */
            max_process_cpu: z.number().min(0).max(6400).default(60),
            /** Process names ignored by the competing-process check. */
            ignore_processes: z.array(z.string().min(1).max(80)).max(32).default([]),
            /** Linux: required scaling governor, e.g. "performance". */
            require_governor: z.string().min(1).max(40).optional(),
            /** Require turbo/boost off where detectable. */
            require_turbo_off: z.boolean().default(false),
            /** Fail on battery power where detectable. */
            require_ac_power: z.boolean().default(true),
            /** Fail when macOS reports a CPU speed limit below this (thermal throttling). */
            min_cpu_speed_limit: z.number().min(0).max(100).default(100),
            /** How long a deferred bench host waits before the next try. */
            retry_seconds: z.number().min(1).max(3600).default(60),
            /** Notify the human when a host stays unhealthy this long. */
            notify_after_minutes: z.number().min(0).max(24 * 60).default(15),
          })
          .strict()
          .prefault({}),
        /** Repeat an A/A run on best every `every` evaluations per bench host; pause when noise exceeds max_ratio × calibrated. */
        drift: z
          .object({
            every: z.number().int().min(0).max(10_000).default(10),
            pairs: z.number().int().min(2).max(200).default(6),
            max_ratio: z.number().min(1).max(100).default(2),
          })
          .strict()
          .prefault({}),
        protocol: z
          .object({
            warmup: z.number().int().min(0).max(20).default(1),
            n_min: z.number().int().min(3).max(500).default(6),
            n_max: z.number().int().min(3).max(1000).default(20),
            confidence: z.number().min(0.5).max(0.999).default(0.95),
            /** Floor for the minimum detectable effect; calibration may raise it. */
            min_effect: fraction.default(0.01),
            /** Calibration fails when the measured MDE exceeds this. */
            max_mde: fraction.default(0.2),
            /** deterministic: improvement must exceed this to win. */
            tolerance: fraction.default(0),
            confirm: z.boolean().default(true),
            /** expensive: k fresh runs of the candidate that must confirm a promising single run (see design, M2 notes). */
            confirm_runs: z.number().int().min(1).max(20).default(3),
            /** expensive: baseline runs at calibration (the noise floor). */
            calibration_runs: z.number().int().min(3).max(50).default(5),
            calibration_pairs: z.number().int().min(4).max(500).default(12),
            bootstrap: z.number().int().min(200).max(20_000).default(2000),
          })
          .strict()
          .prefault({}),
      })
      .strict(),
    budget: z
      .object({
        max_workers: z.number().int().min(1).max(64).default(1),
        max_candidates: z.number().int().min(1).max(100_000).default(50),
        max_bench_hours: z.number().min(0.01).max(10_000).default(24),
        deadline: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/u, "deadline: YYYY-MM-DD")
          .optional(),
        /** Total tokens the study's threads may use (workers, plus the study thread since start), read from BB's per-thread usage. */
        max_tokens: z.number().int().min(1000).max(1e12).optional(),
        /** Budget shares that raise a notice once each (percent of every limit). */
        notify_at: z.array(z.number().min(1).max(100)).max(5).default([50, 80]),
      })
      .strict()
      .prefault({}),
    agents: z
      .object({
        strategist: agentSpec.prefault({}),
        worker: agentSpec.prefault({}),
        max_submissions_per_worker: z.number().int().min(1).max(50).default(3),
        /** Strategist round after K verdicts. */
        strategist_every: z.number().int().min(1).max(1000).default(5),
        /** Stall: no win in the last N verdicts. */
        stall_after: z.number().int().min(2).max(1000).default(10),
        idle_nudge_minutes: z.number().min(0.1).max(24 * 60).default(15),
        idle_abandon_minutes: z.number().min(0.1).max(24 * 60).default(30),
        /** study_request_profile calls per worker (each uses bench time). */
        max_profiles_per_worker: z.number().int().min(0).max(20).default(2),
        /** Rate-limited turns are retried at the provider's window reset, at most this many times per thread. */
        max_rate_limit_retries: z.number().int().min(0).max(20).default(3),
        /** A usage window at or above this percent counts as "tight": the scheduler halves W. */
        usage_tight_percent: z.number().min(1).max(100).default(90),
      })
      .strict()
      .prefault({}),
    /** Commits the plugin makes in the studied repository (not part of the oracle hash). */
    git: z
      .object({
        /**
         * "repo": author and commit as the identity git resolves in the repo
         * (user.name / user.email, repo-local then global), falling back to the
         * plugin's when none is configured. "plugin": always
         * `autoresearch <autoresearch@bb.local>`.
         */
        identity: z.enum(["repo", "plugin"]).default("repo"),
      })
      .strict()
      .prefault({}),
    /** Harvest: grouping, ablation and PR drafting (not part of the oracle hash). */
    harvest: z
      .object({
        /** Measure each changeset applied alone on its PR base (costs bench time); gates always run. */
        measure_standalone: z.boolean().default(true),
        /** How long to wait for the strategist's study_propose_harvest before grouping one changeset per promotion. */
        group_timeout_minutes: z.number().min(0.1).max(24 * 60).default(10),
        /** Remote the github publisher pushes to. */
        remote: z.string().min(1).max(100).default("origin"),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type StudySpec = z.output<typeof specSchema>;

export type SpecResult = { ok: true; spec: StudySpec; warnings: string[] } | { ok: false; errors: string[] };

export function parseSpec(toml: string): SpecResult {
  if (toml.length > 64 * 1024) return { ok: false, errors: ["spec is larger than 64 KiB"] };
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch (error) {
    return { ok: false, errors: [`TOML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`] };
  }
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return validateSemantics(parsed.data);
}

/** Cross-field rules zod can't express directly. Bench host names are resolved against BB later (engine). */
export function validateSemantics(spec: StudySpec): SpecResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = spec.oracle.protocol;
  if (p.n_min > p.n_max) errors.push("oracle.protocol: n_min must be <= n_max");
  if (spec.agents.idle_abandon_minutes <= spec.agents.idle_nudge_minutes) {
    errors.push("agents: idle_abandon_minutes must be greater than idle_nudge_minutes");
  }
  const names = new Set([spec.metric.name]);
  for (const g of spec.guardrail) {
    if (names.has(g.name)) errors.push(`guardrail ${g.name}: duplicates another metric name`);
    names.add(g.name);
    if (g.max_total_regression < g.max_regression) {
      warnings.push(`guardrail ${g.name}: max_total_regression ${(g.max_total_regression * 100).toFixed(1)}% is below max_regression ${(g.max_regression * 100).toFixed(1)}%, so the total limit is the one that binds`);
    }
  }
  for (const e of spec.scope.editable) {
    for (const pr of spec.scope.protected) {
      if (e === pr) errors.push(`scope: ${e} is both editable and protected`);
    }
  }
  const seen = new Set<string>();
  for (const h of spec.oracle.bench_hosts) {
    const k = h.toLowerCase();
    if (seen.has(k)) errors.push(`oracle.bench_hosts: ${h} is listed twice`);
    seen.add(k);
  }
  if (spec.oracle.holdout && spec.oracle.noise === "deterministic") {
    warnings.push("oracle.holdout with a deterministic oracle compares one run per side");
  }
  if (spec.oracle.noise === "noisy" && spec.oracle.gate.length === 0) {
    warnings.push("oracle.gate is empty: candidates are measured without a correctness check");
  }
  if (spec.oracle.single_machine === "on" && spec.oracle.noise === "deterministic") {
    warnings.push('oracle.single_machine = "on" with a deterministic oracle: its measurements don\'t take the machine-wide bench lock, so gates only wait for this study\'s own measurements');
  }
  if (spec.oracle.single_machine === "on" && spec.oracle.gate.length === 0) {
    warnings.push('oracle.single_machine = "on" has nothing to serialize: oracle.gate is empty');
  }
  if (spec.oracle.quiet_bench && spec.oracle.noise === "deterministic") {
    warnings.push("oracle.quiet_bench with a deterministic oracle holds worker turns during measurements that don't need a quiet machine");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, spec, warnings };
}

/**
 * Fill fields added after a spec version was stored (spec_json is the parsed
 * spec as it was then), so old versions read like new ones and hash the same.
 */
export function normalizeSpec(spec: StudySpec): StudySpec {
  const guardrail = (spec.guardrail ?? []).map((g) => ({ ...g, direction: g.direction ?? "lower", max_total_regression: g.max_total_regression ?? g.max_regression }));
  const scope = { ...spec.scope, ignore: spec.scope.ignore ?? [...DEFAULT_IGNORE] };
  const oracle = { ...spec.oracle, single_machine: spec.oracle.single_machine ?? "auto", quiet_bench: spec.oracle.quiet_bench ?? false };
  const git = { ...(spec.git ?? {}), identity: spec.git?.identity ?? "repo" };
  return { ...spec, guardrail, scope, oracle, git };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Hash of everything that changes how a commit is judged. Protected-path
 * content is folded in separately at segment start (it needs the repo).
 */
export function oracleHash(spec: StudySpec, protectedContentHash = ""): string {
  // Bench operations (health thresholds, drift schedule, transfer cap, offline
  // grace) and scheduling (single-machine mode, quiet bench) don't change how a
  // commit is judged, so tuning them is not a new segment.
  const { health: _health, drift: _drift, max_bundle_mib: _mib, offline_grace_minutes: _grace, single_machine: _single, quiet_bench: _quiet, ...oracle } = spec.oracle;
  const judged = {
    metric: spec.metric,
    guardrail: spec.guardrail,
    oracle,
    protected: spec.scope.protected,
    protectedContent: protectedContentHash,
  };
  return createHash("sha256").update(canonical(judged)).digest("hex").slice(0, 16);
}

export function bestBranch(slug: string): string {
  return `studies/${slug}/best`;
}
export function candidateRef(slug: string, n: number): string {
  return `refs/studies/${slug}/c/${n}`;
}
export function segmentRef(slug: string, k: number): string {
  return `refs/studies/${slug}/segment/${k}`;
}

export function formatPct(fractionValue: number | null | undefined, digits = 2): string {
  if (fractionValue === null || fractionValue === undefined || !Number.isFinite(fractionValue)) return "n/a";
  const v = fractionValue * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
