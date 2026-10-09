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
- `expensive`: one run takes many minutes. One run per candidate, confirmed with extra runs.

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
timeout_minutes = 20             # per command, max 29

[oracle.protocol]                # all optional
n_min = 6                        # noisy: pairs before an early stop
n_max = 20                       # noisy: pairs before inconclusive
min_effect = "1%"                # floor for the win threshold
max_mde = "20%"                  # calibration fails above this
tolerance = "0%"                 # deterministic: required improvement
confirm = true                   # noisy: re-measure wins before promotion

[budget]
max_workers = 1                  # M0 runs one worker at a time
max_candidates = 50
max_bench_hours = 8
deadline = "2026-12-31"          # optional

[agents]
worker = { permission_mode = "full" }   # optional: provider, model, permission_mode
max_submissions_per_worker = 3
```

Rules: globs are repo-relative (`**` spans directories). `bench_hosts` must be empty or `["local"]` until remote bench hosts land. Unknown keys are rejected.

## 4. Submit

Call `study_propose` with the full TOML. If it returns errors, fix them and call it again (same slug). This thread becomes the study thread: later you receive `[autoresearch]` strategist rounds here.

Then tell the human, in two or three lines:

1. Review: `bb study show <slug>`
2. Approve and calibrate: `bb study calibrate <slug>` (gates on base, then A/A noise measurement; prints the detectable effect and cost per evaluation)
3. Start: `bb study start <slug>`. Seed ideas any time with `bb study ideas add <slug> "<idea>"`.

Never run those commands yourself: approval, calibration, starting, and pausing are the human's decisions.
