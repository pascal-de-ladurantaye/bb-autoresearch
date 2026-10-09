---
name: study-create
description: "Set up an autoresearch study: a long-running, measured optimization of one metric (latency, runtime, bundle size, instruction count) where short-lived agent workers propose changes and the plugin benchmarks and keeps only real wins. Use when the user wants to optimize, speed up, or shrink something over hours or days, or says \"start a study\", \"autoresearch\", \"optimize X overnight\". Interviews the user, reads the code, drafts the spec and oracle, and submits them with study_propose."
---

# Create an autoresearch study

You turn the user's goal into a study spec (TOML) that the autoresearch plugin can run unattended. You do not run the study and you do not decide what is kept: the plugin owns the loop, the measurements, and every verdict. Your job ends when `study_propose` accepts the spec and the human knows the next command.

## 1. Interview (short, one round if possible)

Ask only what you cannot find in the code:

- **Objective and metric.** What number should move, which direction is better, and its unit. One primary metric; others become guardrails.
- **Guardrails.** Secondary metrics that must not regress, each with a limit (e.g. memory ≤ 5% worse).
- **Scope.** Which directories workers may edit. Everything else, and especially the benchmark harness and tests, is protected.
- **Budget.** How many candidates and bench hours; a deadline if any.
- **Base.** The branch to start from (default `main`).

## 2. Read the code and draft the oracle

Find or write, with the user, three commands. They run from the repository root of a clean checkout:

- `gate`: correctness. Fast, focused tests that must pass for any candidate (list of commands).
- `measure`: prints one line `METRIC <name>=<number>` for the primary metric and each guardrail. Optional `DIAG <text>` lines (phase timings, profile summaries) are shown to agents.
- `build` (optional): run once per checkout before measuring.

Pick the noise class:

- `deterministic`: the number is identical run to run (bundle size, instruction or allocation counts, output size). One run per side; a candidate wins when it is better beyond `tolerance`.
- `noisy`: wall-clock time, latency, throughput. Paired, interleaved runs with a bootstrap CI of the median and a sequential test. Calibration measures the noise first.
- `expensive`: one run takes many minutes. One screening run per candidate against the calibrated per-run noise; a promising run is confirmed with `confirm_runs` (default 3) fresh runs.

Pick the bench hosts (`oracle.bench_hosts`): `["local"]` (default) measures in plugin checkouts on this machine. Any other entry is a BB machine name or host id (see `bb host list`); that machine keeps its own clone and receives commits as git bundles. A dedicated, quiet machine of the production architecture is best. Ask whether there is a **holdout** workload that lives only on the bench host (a different input set): it is run on every win before promotion, and agents only learn pass/fail.

Run `measure` once yourself to check the METRIC lines parse. If the harness lives in the repo, list its paths under `protected` (its content hash becomes part of the oracle).

## 3. Write the spec

```toml
[study]
slug = "parser-speed"            # 2-48 chars: lowercase, digits, dashes
objective = "Reduce the time to parse the fixture corpus."
base = "main"

[metric]
name = "parse_ms"
unit = "ms"
direction = "lower"              # lower | higher

[[guardrail]]
name = "rss_mb"
max_regression = "5%"
direction = "lower"              # direction of "better" for this metric

[scope]
editable = ["src/parser/**"]
protected = ["bench/**", "test/**"]
max_files = 20                   # optional, default 50
max_lines = 800                  # optional, default 2000

[oracle]
build = "make release"           # optional
gate = ["make test-parser"]
measure = "bench/parse.sh"
noise = "noisy"                  # deterministic | noisy | expensive
bench_hosts = ["local"]          # or BB machine names/ids: own clone, git bundles
timeout_minutes = 20             # per command (runs as a host job; up to 1440)
max_bundle_mib = 256             # optional: largest git bundle sent to a bench host
offline_grace_minutes = 10       # optional: notify when a bench host stays offline

[oracle.holdout]                 # optional: hidden workload on the bench host
measure = "/srv/holdout/parse.sh"   # prints METRIC lines like measure
runs = 3                         # paired best/candidate runs
max_regression = "1%"            # fail when the candidate is worse than this

[oracle.health]                  # optional: checked before every measurement
max_load = 0.8                   # 1-minute load per CPU
max_process_cpu = 60             # % of one core for the busiest other process
require_ac_power = true          # where detectable (laptops)
retry_seconds = 60               # a deferred host waits this long

[oracle.drift]                   # optional: A/A on best while running
every = 10                       # evaluations per bench host (0 = off)
pairs = 6
max_ratio = 2                    # pause when noise > 2x calibrated

[oracle.protocol]                # all optional
n_min = 6                        # noisy: pairs before an early stop
n_max = 20                       # noisy: pairs before inconclusive
min_effect = "1%"                # floor for the win threshold
max_mde = "20%"                  # calibration fails above this
tolerance = "0%"                 # deterministic: required improvement
confirm = true                   # noisy: re-measure wins before promotion
confirm_runs = 3                 # expensive: k confirmation runs
calibration_runs = 5             # expensive: baseline runs at calibration

[budget]
max_workers = 3                  # W adapts up to this: min(max, ceil(think/eval)+1)
max_candidates = 50
max_bench_hours = 8
deadline = "2026-12-31"          # optional

[agents]
worker = { permission_mode = "full" }   # optional: provider, model, permission_mode
max_submissions_per_worker = 3
```

Rules: globs are repo-relative (`**` spans directories). `bench_hosts` entries must name enrolled BB machines (checked when you call `study_propose`). Unknown keys are rejected.

## 4. Submit

Call `study_propose` with the full TOML. If it returns errors, fix them and call it again (same slug). This thread becomes the study thread: later you receive `[autoresearch]` strategist rounds here.

Then tell the human, in two or three lines:

1. Review: `bb study show <slug>`
2. Approve and calibrate: `bb study calibrate <slug>` (gates on base, then A/A noise measurement; prints the detectable effect and cost per evaluation)
3. Start: `bb study start <slug>`. Seed ideas any time with `bb study ideas add <slug> "<idea>"` or on the **Studies** page in the sidebar, which also shows calibration results, the trajectory, and every candidate.

The plugin doesn't start turns in this thread to report calibration: the result is a notice on the Studies page, and it reaches you with the human's next message here.

Never run those commands yourself: approval, calibration, starting, and pausing are the human's decisions.

## Revising the spec later

Once the study has run, `study_propose` with the same slug records a **pending** spec; the study keeps running on the old one. If the oracle is unchanged (budget, agents, scope limits), the human applies it with `bb study approve <slug>`. If the oracle changed (metric, guardrails, commands, protocol, bench hosts, holdout, protected paths), the human runs `bb study calibrate <slug>`: in-flight measurements are cancelled, best is calibrated under the new oracle, and `bb study start` opens a new segment.
