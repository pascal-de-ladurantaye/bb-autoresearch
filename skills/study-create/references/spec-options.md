# Extended spec reference

Read when configuring guardrails, holdout, remote machines, health checks, drift, protocol overrides or advanced budgets. This is a menu, not a runnable default: include only the sections the study needs. Provider-specific machine options must come from the chosen provider.

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
