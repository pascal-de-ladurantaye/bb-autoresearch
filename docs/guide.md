# User guide

How to run a study with bb-autoresearch, from an idea to reviewable PRs. The [README](../README.md) has install steps and the full CLI; the [design](design.md) explains why it works this way.

**A study optimizes the benchmark you give it.** The plugin measures exactly what your `measure` command reports, on the machines you name, and keeps what makes that number better beyond its noise. Whether the benchmark represents production (the workload, the inputs, the hardware) is your call. If it doesn't, the study will still find real wins, on the wrong thing. The holdout (below) can catch changes that special-case one input, but only if you set it up.

## 1. Write the oracle

The oracle is how a commit is judged. The `study-create` skill drafts it with you (Studies → **New study**, or ask an agent in a thread "start a study to make X faster"); it reads the code and proposes three commands, run from the root of a clean checkout:

- **`gate`**: correctness. Fast, focused tests every candidate must pass. A failure is a `gate_failed` verdict with the last lines of output; nothing is measured.
- **`measure`**: prints `METRIC <name>=<number>` for the primary metric and each guardrail. Optional `DIAG <text>` lines (phase timings, profile summaries) are passed to agents as diagnostics.
- **`build`** (optional): runs once per checkout before measuring.

Then the noise class, which decides the protocol:

| Class | For | How a candidate is judged |
|---|---|---|
| `deterministic` | Bundle size, instruction or allocation counts | One run each side; better beyond `tolerance` wins. |
| `noisy` | Wall time, latency, throughput | Paired, interleaved runs against best; a bootstrap CI of the median and a sequential test. |
| `expensive` | Runs of many minutes | One screening run against the calibrated per-run noise; a promising run is confirmed with fresh runs. |

A few rules make an oracle trustworthy:

- **Protect the harness.** List the benchmark and its tests under `[scope] protected`. Their content is hashed into the oracle: a worker can't edit them, and changing them yourself starts a new segment.
- **Measure the real thing.** Run `measure` yourself first. Use the inputs and machine shape you care about; on remote machines, set `cores` to the production machine's core count.
- **Guardrails** are secondary metrics with two limits: how much worse one change may make them than best (`max_regression`), and how much worse best may get over the whole study (`max_total_regression`). Both are judged on a CI.
- **Holdout** (optional, `[oracle.holdout]`): a second workload kept on the bench host. It runs on every win before promotion; agents only learn pass or fail.

## 2. Calibrate and start

1. **Approve and calibrate.** The study page's *Needs you* offers *Approve spec v1 and calibrate* (review the spec on the Oracle tab first), or run `bb study calibrate <slug>`. Calibration runs the gates on the base commit and A/A measurements (base against itself) on every bench host. The report gives each host's noise floor and the smallest win it can detect (its win threshold, or MDE, never below `min_effect`), each guardrail's noise, and the bench time per candidate.
2. **Read the report.** A threshold larger than any plausible win means the benchmark is too noisy for this study: make runs longer or quieter, add pairs, or move the bench to a quieter machine, then calibrate again. A guardrail whose noise is too wide for its limit fails calibration, with the two fixes (loosen the limit, or raise `n_max`): otherwise every win would be flagged inconclusive on it. A failed calibration says why; ask the study thread for a revised spec.
3. **Seed ideas and start.** Add ideas on the Ideas tab (or `bb study ideas add`), then *Approve and start* (`bb study start <slug>`). Workers spawn in their own worktrees from `studies/<slug>/best`; the strategist in the study thread keeps the idea queue full.

Where it measures: `bench_hosts = ["local"]` (the default) is this machine, where single-machine mode keeps gates from overlapping timing runs. Another BB machine keeps its own clone. Remote machines from a bench provider plugin (`[[oracle.remote_bench]]`, see [bench-providers.md](bench-providers.md)) each calibrate on arrival and are replaced before their lifetime ends; a plugin reload keeps them.

With several bench hosts, each one decides with its own win threshold, and a candidate goes to the quietest free host first, so a quiet machine detects smaller wins than a noisy one. A host much noisier than the others (`[oracle] max_host_noise_ratio`, 2× the median of the others' noise floor by default, and beyond what chance gives equal hosts) is left out: a remote machine is replaced, a local or BB host measures nothing until the next calibration. The report and the Bench tab say which and why.

## 3. Read verdicts

Every candidate gets one verdict from the plugin, never from an agent:

| Verdict | Means |
|---|---|
| `win` | The CI's lower bound cleared the win threshold, and a confirmation with fresh pairs agreed (skipped when the CI is far beyond it). It is squashed onto best. |
| `lose` | Clearly worse, or a guardrail's whole CI is beyond a limit. |
| `inconclusive` | Not shown better within `n_max` pairs, or it can no longer reach the threshold (futility). Real but small effects land here. |
| `gate_failed`, `conflict`, `rejected` | Tests failed; the candidate didn't rebase onto best; it edited outside its scope. Nothing was measured. |

Every number reads the same everywhere: **better is positive, in the metric's own terms** ("74.7% fewer ops (4.0×)"), with the raw values next to it. The Live tab shows each measurement's CI band narrowing pair by pair to the decision; the Candidates tab keeps every candidate, win or lose, under `refs/studies/<slug>/c/<n>`.

Steer from the Ideas tab (add, pin, reorder, veto) and the Overview (pause, resume, lower the worker count). The study pauses itself when the budget runs out, when gates fail on best, or when the bench drifts, and says so in a notice.

## 4. Harvest with your agent

When the study has done its work, freeze it: *Freeze best for harvest…* on the Harvest tab or the Overview (Needs you offers it when the budget runs out), or `bb study harvest <slug>`. Best stops moving, no more candidates are taken, in-flight ones finish, and best is pinned as `refs/studies/<slug>/harvest/h<N>`.

Turning best into pull requests is an agent's job, not the plugin's: ask your agent (the study thread, or any thread in the project) to harvest the study. The `study-harvest` skill guides it. It reads the study's evidence (`bb study evidence <slug> --json`), groups and splits the changes into reviewable PRs or stacks, and checks each one with the plugin: `bb study measure` for an A/B on the study's bench hosts, `bb study gate` for the study's gates on any commit. The numbers in the PR descriptions are the plugin's measurements, not the agent's. It writes descriptions in your repository's conventions and publishes only when you ask, with your repository's own tools. The plugin never pushes.

A requested measurement runs like a candidate's: on the quietest free bench host, judged with that host's own win threshold and guardrail noise, under its bench lock, and its time counts toward the bench budget. A study whose bench is remote only has no machines while paused (pausing destroys them); freezing it brings them up again, and a measurement asked before they are ready waits for them. `measure` and `gate` are refused while the study runs workers and its bench is busy: freeze it first. Every request and result is in `bb study results <slug>` and on the Harvest tab.

Then resume the study to keep exploring (`bb study resume <slug>`), or archive it (`bb study archive <slug>`): workers stop, bench checkouts and remote machines go, and every candidate ref and the best branch stay.

## Spec reference

The settings people ask about most; the `study-create` skill knows every key, and [stability.md](stability.md) says which ones 1.x keeps.

### One machine for everything (`[oracle]`)

On a laptop the edit host is also the bench host, and gates running next to a timing run add noise to it. Neither setting is part of the oracle hash, so changing one never needs a recalibration.

| Key | Default | What it does |
|---|---|---|
| `single_machine` | `"auto"` | `"auto"`, `"on"` or `"off"`. When on, gates take the same per-host bench lock as measurements, in one queue with them (oldest first), so a gate never overlaps a measurement. `"auto"` is on when a bench host is the edit machine (`bench_hosts = ["local"]`, the default, or the edit machine's own name or id) and the oracle is `noisy` or `expensive`. Gate time then counts as bench time: in utilization, and in the worker target W (gate + measure time per candidate). |
| `quiet_bench` | `false` | While a measurement runs on a machine, a new worker turn there waits to start (BB's dispatch hook; the thread's queued card says why). Turns already running are not interrupted, and a held turn waits for at most one measurement. |

### Measurement protocol (`[oracle.protocol]`, noisy oracles)

Part of the oracle hash (changing one recalibrates), except where noted.

| Key | Default | What it does |
|---|---|---|
| `n_min`, `n_max` | 6, 20 | Pairs before a win can be declared, and the cap. |
| `futility` | `true` | After `n_min`, stop as inconclusive once the CI's upper bound is below the win threshold: more pairs couldn't make it a win. |
| `early_lose_from`, `early_lose_confidence` | 3, 0.99 | From 3 pairs, a clear loss (a t interval at 99% entirely below 0) stops before `n_min`. `0` turns it off. |
| `confirm`, `skip_confirm_factor` | `true`, 3 | Wins are re-measured with fresh pairs, unless the CI's lower bound is at least 3× the win threshold (the verdict says it skipped). `0` always confirms. |
| `side_runs`, `min_side_seconds` | `"auto"`, 5 | Runs of `measure` per side of a pair, keeping each metric's best value. `"auto"` picks the count at calibration so a side lasts at least 5 s. |

`[oracle.drift] recalibrate_below = 0.6` (not hashed): when best's runs take less than 60% of their calibrated time (code that got several times faster is noisier relative to itself), the plugin recalibrates on best at the next free bench slot, in a new segment with the same oracle, instead of letting a drift check pause the study. Noise that grows at the same run time still pauses it, and nothing more is measured on that machine until you resume. An automatic recalibration that finds a bench host unhealthy waits `[oracle.health] retry_seconds` and tries again, up to `recalibration_retries` (30) times, before it pauses the study. Best vs base compounds every segment ("81.8% lower time (5.5×) across 3 segments · this segment 3.62 → 2.04 s"). Simulated error rates and bench savings are in the [v0.2.4 release notes](release-notes.md#v024).

### Several bench hosts (`[oracle]`)

`bench_hosts` is part of the oracle hash (changing it recalibrates); `max_host_noise_ratio` isn't.

| Key | Default | What it does |
|---|---|---|
| `bench_hosts` | `["local"]` | Where candidates are measured: `"local"` (this machine), or BB machine names or ids. Each host is calibrated on its own and decides with its own win threshold; a candidate goes to the quietest free one. |
| `max_host_noise_ratio` | `2` | A host whose noise floor is more than this times the median of the other hosts' (and beyond what chance gives equal hosts with the calibration's pairs) is left out until the next calibration; a remote machine is replaced (after two replacements in a row, an entry keeps its machines). `0` turns it off. |

### Remote bench hosts (`[[oracle.remote_bench]]`)

Machines lent by a bench provider plugin ([bench-providers.md](bench-providers.md)). Each entry keeps `hosts` machines measuring; each machine is its own bench host with its own calibration and drift checks. With remote entries and an empty `bench_hosts`, only the remote machines measure; `bench_hosts = ["local"]` measures here too.

```toml
[[oracle.remote_bench]]
provider = "bench-provider-local"   # the provider plugin's id
hosts = 2                           # machines at a time
cores = 8                           # match the production machine
lifetime_minutes = 120              # capped by the provider
seed = "scripts/build_seed.sh"      # runs here in a checkout of best; prints a directory or tarball to ship
setup = "scripts/remote_setup.sh"   # runs on each machine after the seed is unpacked
gates = true                        # run the gates there too
```

| Key | Default | What it does |
|---|---|---|
| `provider` | (required) | The bench provider plugin's id. |
| `hosts` | 1 | Machines measuring at a time. While one rotates its slot has one more (never more than `hosts` + one replacement per slot). |
| `cores`, `memory_gb` | (required), none | The machine shape. Match the production machine's core count: code that sizes thread pools from the visible CPU count behaves differently on a machine whose quota is lower (every command gets `AUTORESEARCH_CORES`, and the Bench tab warns when the counts differ). |
| `lifetime_minutes` | 120 | How long a machine lives, capped by the provider's maximum. |
| `rotate_before_minutes` | a fifth of the lifetime, at least 1.5× the last join plus one evaluation | When the replacement starts. It joins and calibrates first; the old machine then takes no new work and is destroyed once nothing runs on it. |
| `seed` | none | A command run on the edit host in a checkout of the segment's baseline that prints the path of a directory or tarball (toolchains, dependency caches, vendored packages). Built once per segment baseline and seed inputs (the command, `seed_allow`, `cores`), packed and cached by content hash, uploaded to each machine and unpacked; `AUTORESEARCH_SEED` points at it. |
| `seed_allow` | `[]` | Seed paths (globs) the credential scan ignores: known test fixtures. |
| `setup` | none | A command run on each machine in a checkout of best, after the seed is unpacked. |
| `env` | `{}` | Environment for every command on the machines. |
| `gates` | `false` | Run the gates on these machines (under their bench lock), so single-machine mode no longer serializes them with measurements here. |

The seed is scanned for credentials (token and key patterns; files such as gem, bundler and npm credentials, `.netrc`, SSH keys, cloud CLI configs, `.env`) before any upload, and refused when anything matches outside `seed_allow`: no machine is created, and a notice lists what matched (paths and rules, never the values). Machines are destroyed when the study pauses (once idle) or is archived, and come back when it resumes or is frozen for harvest; a plugin reload keeps calibrated machines and re-adopts them. Seeds and base bundles no study uses are deleted from the edit host at load and on archive; `bb study bench` shows their size.

### Commit identity (`[git] identity`)

The plugin commits in the studied repository: worker snapshots, candidates and promotions on `studies/<slug>/best`. Resolved on the edit host and passed to every commit; not part of the oracle hash.

| Value | Commits are authored and committed as |
|---|---|
| `"repo"` (default) | The identity git resolves in the repository on the edit host (`user.name` / `user.email`, repo-local then global), so a work repo carries your work identity. With none configured, `autoresearch <autoresearch@bb.local>`, and the calibration report and a notice say so. |
| `"plugin"` | Always `autoresearch <autoresearch@bb.local>`. |
