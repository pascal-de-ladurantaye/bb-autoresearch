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

**Remote machines** (`[[oracle.remote_bench]]`): when a bench provider plugin is installed (a BB plugin that lends short-lived machines; see docs/bench-providers.md in the bb-autoresearch repo, and `bb plugin list`), the study can measure on `hosts` machines from it at a time, each its own bench host with its own calibration. Ask which production node shape the workload runs on (machine type, cores, SMT on or off, CPU platform, image) and match it: set `cores` to its core count (code that sizes thread pools from the CPU count otherwise behaves differently there; every command gets `AUTORESEARCH_CORES`), and put the rest in `machine = { ... }`, an inline table of the provider's own options, passed to it verbatim. Use only keys the provider lists (its `describe` answer, or its README); calibration rejects unknown keys and names the valid ones. `machine` is part of the oracle hash. Machines live `lifetime_minutes` (capped by the provider) and are replaced before they end. They start from nothing: a shallow copy of the study base, plus what `seed` ships (a command run here in a checkout of best that prints the path of a directory or tarball: toolchains, dependency caches, vendored packages) and what `setup` does there (run in a checkout of best after the seed is unpacked, with `AUTORESEARCH_SEED` pointing at it). The seed is scanned for credentials before any upload and refused if anything matches: never put tokens, `.netrc`, SSH keys, cloud CLI configs or `.env` files in it; list known test fixtures in `seed_allow`. With `gates = true` the gates run on those machines too (so single-machine mode no longer serializes them here). With remote machines and no `bench_hosts`, only the remote machines measure; add `"local"` to measure here too. The holdout, if any, must reach the machines through the seed.

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
max_regression = "5%"            # per step: vs the current best
max_total_regression = "10%"     # in total: best vs the segment base (default: max_regression)
direction = "lower"              # direction of "better" for this metric

[scope]
editable = ["src/parser/**"]
protected = ["bench/**", "test/**"]
max_files = 20                   # optional, default 50
max_lines = 800                  # optional, default 2000
# optional: untracked build outputs and caches the snapshot never commits
# (gitignore-style; setting it replaces the defaults below; [] turns it off)
ignore = ["__pycache__/", "*.pyc", "*.pyo", ".pytest_cache/", "node_modules/", "dist/", "build/", "target/", ".DS_Store", "coverage/", ".coverage", ".nyc_output/", "htmlcov/"]

[oracle]
build = "make release"           # optional
gate = ["make test-parser"]
measure = "bench/parse.sh"
noise = "noisy"                  # deterministic | noisy | expensive
bench_hosts = ["local"]          # or BB machine names/ids: own clone, git bundles
timeout_minutes = 20             # per command (runs as a host job; up to 1440)
max_bundle_mib = 256             # optional: largest git bundle sent to a bench host
offline_grace_minutes = 10       # optional: notify when a bench host stays offline
single_machine = "auto"          # optional: auto | on | off. On: gates share the bench lock with measurements (auto: when a bench host is this machine)
quiet_bench = false              # optional: hold new worker turns on the bench machine while a measurement runs

[[oracle.remote_bench]]          # optional, repeatable: machines from a bench provider plugin
provider = "bench-provider-local" # the provider plugin's id
hosts = 2                        # machines measuring at a time (+1 replacement per slot while rotating)
cores = 8                        # match the production machine
machine = { machine_type = "c3-standard-8", threads_per_core = 1 }   # provider-specific options: the production node shape (optional)
memory_gb = 16                   # optional
lifetime_minutes = 120           # capped by the provider; replaced before the end
rotate_before_minutes = 20       # optional: when the replacement starts (default: a fifth of the lifetime, at least 1.5x a join)
seed = "scripts/build_seed.sh"   # optional: runs here in a checkout of best; prints a directory or tarball to ship
seed_allow = ["vendor/cache/**"] # optional: seed paths the credential scan ignores (known test fixtures)
setup = "scripts/remote_setup.sh" # optional: runs on each machine in a checkout of best, after the seed is unpacked
env = { LANG = "C.UTF-8" }       # optional: environment for every command there
gates = false                    # optional: run the gates on these machines too

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
recalibrate_below = 0.6          # best's runs under 60% of their calibrated time: recalibrate (no pause)

[oracle.protocol]                # all optional
n_min = 6                        # noisy: pairs before an early stop
n_max = 20                       # noisy: pairs before inconclusive
min_effect = "1%"                # floor for the win threshold
max_mde = "20%"                  # calibration fails above this
tolerance = "0%"                 # deterministic: required improvement
confirm = true                   # noisy: re-measure wins before promotion
skip_confirm_factor = 3          # noisy: no confirmation when the CI's low end is >= 3x the win threshold (0 = always)
futility = true                  # noisy: stop as inconclusive once the CI's high end is below the win threshold
early_lose_from = 3              # noisy: a clear loss stops from 3 pairs (0 = off)
early_lose_confidence = 0.99     # ... when a t interval at this confidence is entirely below 0
side_runs = "auto"               # noisy: measure runs per side (best per metric); "auto": >= min_side_seconds a side
min_side_seconds = 5
confirm_runs = 3                 # expensive: k confirmation runs
calibration_runs = 5             # expensive: baseline runs at calibration

[budget]
max_workers = 3                  # W adapts up to this: min(max, ceil(think/eval)+1)
max_candidates = 50
max_bench_hours = 8
deadline = "2026-12-31"          # optional
max_tokens = 5000000             # optional: tokens across the study's threads (as BB reports them)
notify_at = [50, 80]             # budget shares (%) that raise a notice once

[agents]
worker = { permission_mode = "full" }   # optional: provider, model, permission_mode
max_submissions_per_worker = 3
max_rate_limit_retries = 3       # rate-limited turns retried at the window reset
usage_tight_percent = 90         # a provider window at this % halves W

[git]
identity = "repo"                # optional: "repo" commits as the repo's git identity (falls back to the plugin's); "plugin" as autoresearch <autoresearch@bb.local>
```

The plugin commits each worker's worktree for it (`git add`), so a repo without a complete `.gitignore` would otherwise get build outputs committed into candidates, where they conflict. `[scope] ignore` lists them, gitignore-style: a pattern without a slash matches at any depth (`*.pyc`, `__pycache__/`), one with a slash is anchored at the repo root (`/out/`), and a trailing slash means a directory. Untracked files matching it are never committed; changes to tracked files always are; a candidate that adds a matching file anyway (the worker committed it itself) is rejected with instructions. If the repo keeps sources in a directory the defaults name (a `build/` of scripts, say), set `ignore` without that pattern; calibration warns when the base tracks files that match.

Guardrails are judged on a confidence interval, like the primary metric: a guardrail breaks a win only when its whole CI is beyond a limit; when the CI straddles a limit it is flagged inconclusive, not a rejection. Calibration measures each guardrail's noise and fails when its CI at a full evaluation is not narrower than the limit (such a guardrail can never be shown within it); the report names the fixes: loosen the limit, or raise `n_max` (or make its measurement steadier). With several bench hosts, each decides with its own win threshold and a candidate goes to the quietest free host; a host much noisier than the others is left out (`[oracle] max_host_noise_ratio`, default 2).

Rules: globs are repo-relative (`**` spans directories). `bench_hosts` entries must name enrolled BB machines (checked when you call `study_propose`). A `remote_bench` entry is checked against its provider when the human approves the spec (calibration): available, enough machines, cores in range. Unknown keys are rejected.

## 4. Submit

Call `study_propose` with the full TOML. If it returns errors, fix them and call it again (same slug). This thread becomes the study thread: later you receive `[autoresearch]` strategist rounds here. The study thread may run in any environment of the project (a managed worktree, the project checkout on any branch): it only reads code, and it reads best through git without switching branches (`git show studies/<slug>/best:<path>`; each round's "Code" block gives the commands), so don't move this thread's checkout to follow best.

Then tell the human, in two or three lines, that the study waits for them on the **Studies** page (sidebar → Studies → `<slug>`; the header badge of this thread links there):

1. **Needs you → Approve spec vN and calibrate**: they review the spec on the Oracle tab and approve it in the app (CLI: `bb study calibrate <slug>`). Calibration runs the gates on the base commit, then A/A measurements, and reports the smallest win it can detect and the cost per evaluation.
2. **Needs you → Approve and start** once calibration is ready (CLI: `bb study start <slug>`).
3. Ideas can be seeded on the Ideas tab (or `bb study ideas add <slug> "<idea>"`) at any time.

Keep numbers in the plugin's convention: better is positive, in the metric's own terms ("12% lower p99", "+12%").

The plugin doesn't start turns in this thread to report calibration: the result is a notice on the Studies page, and it reaches you with the human's next message here.

Never approve, calibrate, start, or pause yourself (neither in the app nor with the CLI): those are the human's decisions.

## Revising the spec later

Once the study has run, `study_propose` with the same slug records a **pending** spec; the study keeps running on the old one. If the oracle is unchanged (budget, agents, scope limits), the human applies it on the Oracle tab ("Apply spec…", or `bb study approve <slug>`). If the oracle changed (metric, guardrails, commands, protocol, bench hosts, holdout, protected paths), the human approves and recalibrates there ("Approve and recalibrate…", or `bb study calibrate <slug>`): in-flight measurements are cancelled, best is calibrated under the new oracle, and approving that calibration opens a new segment.
