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
            max_regression: fraction,
            direction: z.enum(["lower", "higher"]).default("lower"),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    scope: z
      .object({
        editable: z.array(glob).min(1).max(64),
        protected: z.array(glob).max(64).default([]),
        max_files: z.number().int().min(1).max(10_000).default(50),
        max_lines: z.number().int().min(1).max(1_000_000).default(2000),
      })
      .strict(),
    oracle: z
      .object({
        build: command.optional(),
        gate: z.union([command, z.array(command).max(16)]).transform((g) => (typeof g === "string" ? [g] : g)).default([]),
        measure: command,
        profile: command.optional(),
        noise: z.enum(NOISE_CLASSES),
        bench_hosts: z.array(z.string().min(1)).max(16).default([]),
        timeout_minutes: z.number().min(0.1).max(29).default(20),
        holdout: z.object({ measure: command }).strict().optional(),
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
            /** expensive: extra runs used to confirm a win. */
            confirm_runs: z.number().int().min(1).max(20).default(3),
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

/** Cross-field rules zod can't express directly, and M0 capability limits. */
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
  }
  for (const e of spec.scope.editable) {
    for (const pr of spec.scope.protected) {
      if (e === pr) errors.push(`scope: ${e} is both editable and protected`);
    }
  }
  // M0 runs everything on the server's own machine. Remote bench hosts land in M2.
  if (spec.oracle.bench_hosts.some((h) => h !== "local")) {
    errors.push('oracle.bench_hosts: only "local" (or empty) is supported until remote bench hosts land (M2)');
  }
  if (spec.oracle.holdout) warnings.push("oracle.holdout is recorded but not evaluated until M2");
  if (spec.oracle.noise === "noisy" && spec.oracle.gate.length === 0) {
    warnings.push("oracle.gate is empty: candidates are measured without a correctness check");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, spec, warnings };
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
  const judged = {
    metric: spec.metric,
    guardrail: spec.guardrail,
    oracle: spec.oracle,
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
