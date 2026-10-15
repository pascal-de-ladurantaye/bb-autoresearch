---
name: study-create
description: "Set up an autoresearch study: a long-running, measured optimization of one metric (latency, runtime, bundle size, instruction count) where short-lived agent workers propose changes and the plugin benchmarks and keeps only real wins. Use when the user wants to optimize, speed up, or shrink something over hours or days, or says \"start a study\", \"autoresearch\", \"optimize X overnight\". Interviews the user, reads the code, drafts the spec and oracle, and submits them with study_propose."
---

# Create an autoresearch study

You turn the user's goal into a study spec (TOML) that the autoresearch plugin can run unattended. You do not run the study and you do not decide what is kept: the plugin owns the loop, the measurements, and every verdict. Your job ends when `study_propose` accepts the spec and the human knows the next command.

## 1. Interview (short, one round if possible)

Ask only what you cannot find in the code:

- **Objective and metric.** What number should move, which direction is better, and its unit. One primary metric; others become guardrails.
- **The benchmark is theirs.** Say it plainly: the study optimizes exactly the benchmark it is given. Whether that benchmark represents the production workload, inputs and hardware is the human's responsibility; the plugin doesn't judge it. Help them pick a representative one, and offer the optional holdout (below), but don't add caveats or warnings to the spec.
- **Guardrails.** Secondary metrics that must not regress, each with two limits: how much worse one change may make it than the current best (`max_regression`, e.g. memory ≤ 5% worse), and how much worse it may get in total over the whole study, against the segment base (`max_total_regression`, default the same as `max_regression`; e.g. 10%). Without a total limit, many small regressions can each pass and add up.
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
- `noisy`: wall-clock time, latency, throughput. Paired, interleaved runs with a bootstrap CI of the median and a sequential test. Calibration measures the noise first, and (`side_runs = "auto"`, the default) picks how many runs of `measure` make one side of a pair so a side lasts at least `min_side_seconds`: a benchmark that already loops internally for several seconds stays at one run. When best gets much faster later, the plugin recalibrates by itself (shorter runs are noisier relative to themselves; that isn't drift).
- `expensive`: one run takes many minutes. One screening run per candidate against the calibrated per-run noise; a promising run is confirmed with `confirm_runs` (default 3) fresh runs.

Pick the bench hosts (`oracle.bench_hosts`): `["local"]` (default) measures in plugin checkouts on this machine. Any other entry is a BB machine name or host id (see `bb host list`); that machine keeps its own clone and receives commits as git bundles. A dedicated, quiet machine of the production architecture is best. When the bench host is this machine (the laptop case), **single-machine mode** (`oracle.single_machine`, default `"auto"`) turns on: gates take the same bench lock as measurements, one at a time, so tests never run while a candidate is timed. Size the gate for that: its time now counts as bench time per candidate. `quiet_bench = true` also holds new worker turns while a measurement runs. Ask whether there is a **holdout** workload that lives only on the bench host (a different input set): it is run on every win before promotion, and agents only learn pass/fail.

**Remote machines:** read [remote bench setup](references/remote-bench.md) before choosing a provider or drafting `[[oracle.remote_bench]]`. It covers production hardware matching, credentials/seed safety, setup, holdout delivery, rotation and gate placement.

Run `measure` once yourself to check the METRIC lines parse. If the harness lives in the repo, list its paths under `protected` (its content hash becomes part of the oracle).

## 3. Write the spec

```toml
[study]
slug = "parser-speed"
objective = "Reduce the time to parse the fixture corpus."
base = "main"

[metric]
name = "parse_ms"
unit = "ms"
direction = "lower"

[scope]
editable = ["src/parser/**"]
protected = ["bench/**", "test/**"]

[oracle]
build = "make release"
gate = ["make test-parser"]
measure = "bench/parse.sh"
noise = "noisy"
bench_hosts = ["local"]

[budget]
max_workers = 3
max_candidates = 50
max_bench_hours = 8
```

Replace the example paths and commands with ones verified in this repository. Read [spec options](references/spec-options.md) when adding guardrails, holdout, remote machines, health/drift settings, protocol overrides or advanced budgets. Include only what this study needs; omitted keys use the plugin’s defaults.

The plugin commits each worker's worktree for it (`git add`), so a repo without a complete `.gitignore` would otherwise get build outputs committed into candidates, where they conflict. `[scope] ignore` lists them, gitignore-style: a pattern without a slash matches at any depth (`*.pyc`, `__pycache__/`), one with a slash is anchored at the repo root (`/out/`), and a trailing slash means a directory. Untracked files matching it are never committed; changes to tracked files always are; a candidate that adds a matching file anyway (the worker committed it itself) is rejected with instructions. If the repo keeps sources in a directory the defaults name (a `build/` of scripts, say), set `ignore` without that pattern; calibration warns when the base tracks files that match.

Guardrails are judged on a confidence interval, like the primary metric: a guardrail breaks a win only when its whole CI is beyond a limit; when the CI straddles a limit it is flagged inconclusive, not a rejection. Calibration measures each guardrail's noise and fails when its CI at a full evaluation is not narrower than the limit (such a guardrail can never be shown within it); the report names the fixes: loosen the limit, or raise `n_max` (or make its measurement steadier). With several bench hosts, each decides with its own win threshold and a candidate goes to the quietest free host; a host much noisier than the others is left out (`[oracle] max_host_noise_ratio`, default 2).

Rules: globs are repo-relative (`**` spans directories). `bench_hosts` entries must name enrolled BB machines (checked when you call `study_propose`). A `remote_bench` entry is checked against its provider when the human approves the spec (calibration): available, enough machines, cores in range. Unknown keys are rejected.

## 4. Submit

Call `study_propose` with the full TOML. If it returns errors, fix them and call it again (same slug). This thread becomes the study thread: later you receive `[autoresearch]` strategist rounds here. The study thread may run in any environment of the project (a managed worktree, the project checkout on any branch): it only reads code, and it reads best through git without switching branches (`git show studies/<slug>/best:<path>`; each round's "Code" block gives the commands), so don't move this thread's checkout to follow best.

Then tell the human, in two or three lines, that the study waits for them on the **Studies** page (sidebar → Studies → `<slug>`; the header badge of this thread links there):

1. **Now — review the spec:** Studies → `<slug>` → Oracle. The human approves calibration (`bb study calibrate <slug>`); tests and baseline measurements run, but no worker starts yet.
2. **Next — review calibration:** only when ready, the human approves starting workers (`bb study start <slug>`), which spends tokens and bench time.

Keep optional idea seeding out of that handoff unless asked. Ideas can be added later on the Ideas tab or with `bb study ideas add`.

Keep numbers in the plugin's convention: better is positive, in the metric's own terms ("12% lower p99", "+12%").

The plugin doesn't start turns in this thread to report calibration: the result is a notice on the Studies page, and it reaches you with the human's next message here.

Never approve, calibrate, start, or pause yourself (neither in the app nor with the CLI): those are the human's decisions.

## Revising the spec later

Once the study has run, `study_propose` with the same slug records a **pending** spec; the study keeps running on the old one. If the oracle is unchanged (budget, agents, scope limits), the human applies it on the Oracle tab ("Apply spec…", or `bb study approve <slug>`). If the oracle changed (metric, guardrails, commands, protocol, bench hosts, holdout, protected paths), the human approves and recalibrates there ("Approve and recalibrate…", or `bb study calibrate <slug>`): in-flight measurements are cancelled, best is calibrated under the new oracle, and approving that calibration opens a new segment.
