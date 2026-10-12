# bb-autoresearch

A BB plugin for long-running, measured code-optimization studies. Short-lived
agent workers propose changes in parallel; the plugin owns the loop, the
measurements, and every keep or discard decision. When the study is done, an
agent turns the wins into PRs (the `study-harvest` skill), and every number it
puts in them comes from the plugin.

![The Live tab mid-study: one lane per worker, candidate cards moving from tests to the bench and Promoted, and the measurement's confidence interval narrowing pair by pair against the win threshold](docs/screenshots/live.jpg)

Design and status: [docs/design.md](docs/design.md). The "Status" section says
which milestone exit criteria were validated (short version: everything is
built; it has run on toy repositories and once, blind, against another
autoresearch loop on a real-world CLI performance task), and the "Implementation notes"
sections record how the code works and every deviation from the design.

## Install

```sh
bb plugin install https://github.com/pascal-de-ladurantaye/bb-autoresearch
```

The plugin id is `bb-autoresearch`; it shows up in BB as **Autoresearch**.
To install from a checkout instead:

```sh
pnpm install
bb plugin build
bb plugin install . --yes
bb plugin enable bb-autoresearch
```

Requires BB ≥ 0.45 and git ≥ 2.38 on every machine a study uses (for
`git merge-tree --write-tree`).

## Run a study

The **Studies** page in the sidebar is where you run a study; every step
also has a `bb study` command. Each page leads with what needs you
(approvals, system pauses, a failed calibration, a harvest ready for review),
and the sidebar entry and the study thread's header badge show how many items
wait.

1. **Create.** Studies → **New study** opens bb's composer with a prefilled
   request for the `study-create` skill and the current project selected
   (the latest active study's when the page has none); describe the goal. The skill interviews you, drafts the spec (TOML: objective, metric,
   guardrails, scope, oracle commands, noise class, bench hosts, budget) and
   submits it with `study_propose`. That thread becomes the **study thread**:
   the conversation with the strategist.

   Guardrails have two limits: how much worse one change may make a
   secondary metric than the current best (`max_regression`), and how much
   worse best may get than the segment base over all promotions
   (`max_total_regression`). Both are judged on a CI: a guardrail breaks a
   win only when its whole CI is beyond a limit, and is flagged
   *inconclusive* when the CI straddles one. Worker snapshots never commit
   untracked build outputs and caches (`[scope] ignore`, with defaults for
   Python, Node, Rust/Java and coverage), so a repo without a `.gitignore`
   works.
2. **Approve and calibrate.** Needs you → *Approve spec v1 and calibrate*
   (review the spec on the Oracle tab first). Calibration runs the gates on the
   base commit and A/A measurements on every bench host, and reports the
   smallest win it can detect (MDE), each guardrail's noise (with a warning
   when it exceeds the limit), and the cost per evaluation. If it fails,
   the page says why; ask the study thread for a revised spec and approve that.
   CLI: `bb study calibrate <slug> [--wait]`.
3. **Start.** Seed ideas on the Ideas tab, then Needs you → *Approve and
   start*. Hidden worker threads spawn in managed worktrees from
   `studies/<slug>/best`, submit candidates, and get verdicts as messages.
   Gates run in parallel (in single-machine mode, below, they take turns
   with measurements); each bench host measures one candidate at a time;
   wins are confirmed (and checked against a hidden holdout when configured)
   before they are squashed onto best. CLI: `bb study start <slug>`.
4. **Watch and steer.**
   - Live (the default tab while the study runs): one lane per worker with its idea, phase (reading, editing, testing, waiting for the bench, being measured, verdict received, refining, finishing), time in phase and submissions used; candidate cards moving from Submitted through Tests, Queue and Bench to a verdict or Promoted, with pair progress and the improvement once known; each bench host with what it measures, the queue and how busy it was; the ideas up next; a feed of what just happened, grouped by candidate; and one worker's transcript at a time (select its lane). Each measurement on the bench gets a **CI band**: the estimate and its confidence interval narrowing pair by pair against zero and the win threshold, with the test's lose / continue / win regions shaded, the pairs before `n_min` hatched, and the stop marked ("decided after 9 of 20 pairs: win"); the confirmation is a second phase, deterministic measurements show the run against the tolerance, expensive ones the runs against the calibrated σ band, and guardrails sit underneath (the step and the total against their limits). Each lane shows its worker's **last action** ("editing src/toy.py", "running pytest -q"; shortened, secrets and URL credentials removed, never message text). When best moves, the card lands in Promoted, the header counts up to the new best and its trajectory steps, and the other lanes say "best moved: rebases on next submit". Up next is in the order the scheduler will pick (the theme cap can put a later idea first). It is read only, follows realtime updates, and respects reduced motion.
   - **Replay** (Live tab → Replay, the Overview's Replay button, or the Replay switch in the side panel): the whole Live view of any study (finished, archived, or a running one rewound) rebuilt at any moment from its recorded events and samples. A timeline shows event density and milestones (wins, best moves, pauses, segment and harvest changes); play/pause, 1×, 10×, 60× and 600×, "Next win", and the keyboard (Space, ←/→, Shift for bigger steps, Home/End, N/P for next/previous win, 1-4 for the speed). The position is in the URL (`studies/<slug>/live/replay/<ms>`), so a moment can be reopened or shared. Transcripts are not time-synced: a worker's transcript in a replay is its current one, and says so. **Open beside the study thread** (or the **Live** button on the study thread's header badge, or "Study live view" in a thread's right-panel launcher) shows the same view in the thread's split pane, so you can watch while talking to the strategist.
   - Overview: Needs you; best vs base in words with raw values and CI; what's running; the trajectory; secondary metrics, and each guardrail's cumulative position against its total limit with the CI and the room left; controls (pause, resume, max workers, harvest, archive); notices, each with the action it asks for.
   - Ideas: add, reorder, pin, veto (with a reason).
   - Candidates: verdict, improvement, CI and guardrail status per row (ok, near limit, inconclusive, BROKEN, and whether the step or the total is the problem); each opens its measurement's CI band (how the verdict formed), every recorded metric, samples, diffs, and the worker thread.
   - Findings: searchable, with counts per outcome, theme and verdict.
   - Oracle: spec, versions, pending spec with its diff, calibration with its approval and guardrail noise, segments.
   - Bench: hosts, queue, health (latest marked), drift, bundles.
   - Harvest: below.

   The study thread shows one line per plugin message (strategist round,
   verdict); the full detail goes to the agent as an agent-only block.
   Notices (new best, stall, budget thresholds, broken oracle, drift, rate
   limits, harvest ready) mark the study thread unread. A "?" next to each
   statistical term (MDE, CI, noise floor) explains it.
5. **Harvest.** When the budget is used up the study pauses and Needs you
   offers to harvest (or start one any time from the Overview; CLI
   `bb study harvest <slug>`). Harvest **freezes best**: no new workers,
   submissions close, in-flight candidates finish, and best is pinned as
   `refs/studies/<slug>/harvest/h<N>`. Then ask an agent to harvest it (the
   Harvest tab has the prompt and opens a thread with it; the study thread
   works too). Following the `study-harvest` skill, it reads
   `bb study evidence`, groups and splits the changes, builds branches or a
   stack, has the plugin measure each PR (`bb study measure <slug> <A> <B>`)
   and run the gates (`bb study gate <slug> <ref>`), writes the PR
   descriptions in your repository's style, and publishes with your
   repository's own tools only when you ask. The Harvest tab shows the frozen
   best, its promotions with their commit messages, and every measurement and
   gate asked for. Or *Keep exploring* (`bb study resume <slug>`), or
   *Archive*. Harvests made by the plugin before 1.0 stay readable there.

### One machine for everything

On a laptop the edit host is also the bench host, and gates (tests, type
checks, renders) running next to a timing run add noise to it. The spec's
`[oracle]` table has two scheduling settings for this; neither is part of the
oracle hash, so changing them never needs a recalibration:

| Key | Default | What it does |
|---|---|---|
| `single_machine` | `"auto"` | `"auto"`, `"on"` or `"off"`. When on, gates take the same per-host bench lock as measurements, in one queue with them (oldest first), so a gate never overlaps a measurement. `"auto"` is on when a bench host is the edit machine (`bench_hosts = ["local"]`, the default, or the edit machine's own name or id) and the oracle is `noisy` or `expensive`. Gate time then counts as bench time: in utilization, and in the worker target W (gate + measure time per candidate). |
| `quiet_bench` | `false` | While a measurement runs on a machine, a new worker turn there waits to start (BB's dispatch hook; the thread's queued card says why). Turns already running are not interrupted, and a held turn waits for at most one measurement. |

The Oracle tab, the calibration report and `bb study show` say whether
single-machine mode is on and why; the Overview, Bench and Live views show
"testing c/N" on the bench host while a gate holds it.

### Remote bench hosts

A study can also measure on short-lived machines lent by a **bench provider**:
another BB plugin that creates machines, moves files and runs processes for
bb-autoresearch over a small RPC contract ([docs/bench-providers.md](docs/bench-providers.md)).
Machines that can't be BB machines (cloud machines that only allow outbound
calls, say) work, because the BB server drives them. Each `[[oracle.remote_bench]]`
entry keeps `hosts` machines measuring at a time; each machine is its own
bench host with its own calibration and drift checks.

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
| `seed` | none | A command run on the edit host in a checkout of the segment's baseline that prints the path of a directory or tarball (toolchains, dependency caches, vendored packages). Built once per segment, packed and cached by content hash, uploaded to each machine and unpacked; `AUTORESEARCH_SEED` points at it. |
| `seed_allow` | `[]` | Seed paths (globs) the credential scan ignores: known test fixtures. |
| `setup` | none | A command run on each machine in a checkout of best, after the seed is unpacked. |
| `env` | `{}` | Environment for every command on the machines. |
| `gates` | `false` | Run the gates on these machines (under their bench lock), so single-machine mode no longer serializes them with measurements here. |

- **Joining.** The seed is built and scanned before any machine exists; then
  create, wait until ready, upload the seed, a shallow git bundle of the study
  base (built once), best as a delta bundle, and `setup`. Each candidate then
  travels as a delta bundle (a few KiB) into a reused checkout.
- **Calibration per host.** The study's calibration waits for its machines
  and calibrates them with every other bench host (the segment takes the
  worst). A machine that joins later (a replacement) runs an A/A on best on
  its own; it measures with its own noise floor and win threshold, never
  below the segment's. A machine noisier than `max_mde` is replaced.
- **Leaving.** A machine whose lifetime ends, or that the provider reports
  suspended, gone or failed, leaves at once and is never reused (it may come
  back on different hardware); a measurement on it restarts from scratch on
  another bench host.
- **Seed safety.** Before any upload the seed is scanned for credentials
  (token and key patterns; files such as gem, bundler and npm credentials,
  `.netrc`, SSH keys, cloud CLI configs, `.env`). Anything that matches (minus
  `seed_allow`) refuses the seed: no machine is created, and a notice lists
  what matched (paths and rules, never the values).
- **Cleanup.** Machines carry the study id and slot as labels. They are
  destroyed when the study pauses (once idle), is archived, or the plugin
  unloads; on load, and every 10 minutes, the plugin lists each provider's
  machines and destroys the ones no study uses.
- **Where it shows.** The Bench tab's *Remote bench hosts* section (each
  entry, each machine's state, expiry, rotation and calibration, what it
  measures, recently gone ones), the bench host lists, the Live bench strip
  (joining machines included) and its feed, notices for provider failures,
  and `bb study bench`.

With remote machines and an empty `bench_hosts`, only the remote machines
measure; `bench_hosts = ["local"]` measures here too. Machines lent this way
are reached only through the provider: nothing on them holds your
credentials. [`examples/bench-provider-local/`](examples/bench-provider-local/)
is a provider for local temp directories, for tests and trying it out.

### Measurement protocol (noisy oracles)

`[oracle.protocol]` keys that decide how much bench time a candidate takes. They are part of the oracle hash (changing one recalibrates), except where noted:

| Key | Default | What it does |
|---|---|---|
| `n_min`, `n_max` | 6, 20 | Pairs before a win can be declared, and the cap. |
| `futility` | `true` | After `n_min`, stop as inconclusive once the CI's upper bound is below the win threshold: more pairs couldn't make it a win. |
| `early_lose_from`, `early_lose_confidence` | 3, 0.99 | From 3 pairs, a clear loss (a t interval at 99% entirely below 0) stops before `n_min`. `0` turns it off. |
| `confirm`, `skip_confirm_factor` | `true`, 3 | Wins are re-measured with fresh pairs, unless the CI's lower bound is at least 3× the win threshold (the verdict says it skipped). `0` always confirms. |
| `side_runs`, `min_side_seconds` | `"auto"`, 5 | Runs of `measure` per side of a pair, keeping each metric's best value. `"auto"` picks the count at calibration so a side lasts at least 5 s. |

`[oracle.drift] recalibrate_below = 0.6` (not hashed): when best's runs take less than 60% of their calibrated time (code that got several times faster is noisier relative to itself), the plugin recalibrates on best at the next free bench slot, in a new segment with the same oracle, instead of letting a drift check pause the study. Noise that grows at the same run time still pauses it, and nothing more is measured on that machine until you resume. Best vs base compounds every segment ("81.8% lower time (5.5×) across 3 segments · this segment 3.62 → 2.04 s"). Simulated error rates and bench savings are in the design notes ("Implementation notes: v0.2.4").

### Commit identity

The plugin commits in the studied repository: worker snapshots, candidates
and promotions on `studies/<slug>/best`. Their messages are the workers': a
title (at most 72 characters) and a body they pass to `study_submit_candidate`,
used verbatim, plus the plugin's `Autoresearch-Study` and
`Autoresearch-Candidate` trailers. `[git] identity` says as whom:

| Value | Commits are authored and committed as |
|---|---|
| `"repo"` (default) | The identity git resolves in the repository on the edit host (`user.name` / `user.email`, repo-local then global), so a work repo carries your work identity. With none configured, `autoresearch <autoresearch@bb.local>`, and the calibration report and a notice say so. |
| `"plugin"` | Always `autoresearch <autoresearch@bb.local>`. |

It's resolved on the edit host and passed explicitly to every commit, so a
bench host's clone sees exactly the same commits. Not part of the oracle hash.

Every number reads the same everywhere: **better is positive, in the
metric's own terms** ("74.7% fewer ops (4.0×)", "+74.7%"), with raw values
next to it. The plugin never pushes. Every candidate stays under
`refs/studies/<slug>/c/<n>`.

## CLI

| Command | What it does |
|---|---|
| `bb study list` | Studies (active first) with state, what needs you, best vs base, budget |
| `bb study needs [slug]` | What needs you, one line each with the command that resolves it |
| `bb study show <slug> [--events N]` | Spec summary, calibration, best, budget, usage, bench hosts, ideas, candidates, workers, notices, events |
| `bb study calibrate <slug> [--wait]` | Approve the spec and calibrate; mid-run, an oracle change (new segment) |
| `bb study approve <slug>` | Apply a pending spec whose oracle is unchanged |
| `bb study start <slug>` | Approve calibration and run (or resume) |
| `bb study pause` / `resume <slug>` | Pause; resume (from Harvesting: keep exploring) |
| `bb study concurrency <slug> <n\|auto>` | Lower max workers (clamped to the spec) |
| `bb study ideas add <slug> "<title>" [...]` / `ideas list <slug>` | The idea board |
| `bb study workers <slug>` | Worker threads |
| `bb study bench <slug>` | Bench hosts (remote machines too: state, expiry, rotation, own calibration), health checks, bundle transfers, drift checks, segments |
| `bb study drift <slug>` | Request an A/A drift check on every bench host |
| `bb study harvest <slug> [--wait] [--harvest N]` | Freeze best for harvest, or show the current (or an older) harvest |
| `bb study evidence <slug> [--samples] [--candidates 3,7]` | Everything an agent needs to harvest, as stable JSON with `--json` (`bb-autoresearch/evidence` v1) |
| `bb study measure <slug> <A> <B> [--pairs N] [--host H] [--detach]` | Measure B against A (any two commits) with the study's protocol and guardrails on its bench host; counts as bench time |
| `bb study gate <slug> <ref> [--detach]` | The study's gates on any commit |
| `bb study results <slug> [r<N>] [--wait]` | Measurements and gates asked for |
| `bb study report <slug>` | The study report (Markdown) |
| `bb study archive <slug> [--archive-thread]` | Stop for good: workers, bench checkouts and clones, measurements still running; `--archive-thread` also archives the study thread (the app's archive dialog does by default) |

Every command takes `--json` (one JSON document from the same view models as
the page; errors carry a hint with the next command). Approval, harvest and
archiving work in the app or the CLI; both are deliberate, audited the same way, and the
CLI refuses human controls from a study's own worker and study threads (see
the threat model in the design).

## Limits

- **Trust.** Oracle commands run with full trust on edit and bench hosts, and agents with shell access can reach the plugin's RPC and CLI (see the threat model). Run studies whose results matter with the bench, and the holdout, on a machine the workers can't reach.
- **Edit host.** The edit host is the BB server's own machine. Remote edit hosts aren't built.
- **Budgets.** Max workers, candidates, bench hours, deadline, and tokens (per-thread usage as BB reports it) are enforced. Dollar cost isn't available to plugins.
- **Provider limits.** Rate-limited turns are retried at the window reset, and spawns hold until then. A tight usage window halves W. Neither path has been seen live yet.
- **Snapshots.** Workers' worktrees are committed with `git add -A`: give the repo a `.gitignore` for build outputs.
- **Harvest.** The plugin freezes best and measures and gates what an agent asks; grouping, PR descriptions and publishing are the agent's, with the repository's own tools. `measure` and `gate` are refused while the study runs workers and its bench is busy.

## Layout

| Path | What |
|---|---|
| `server.ts` | Factory: storage, host client, tools, RPC, CLI, events, the engine service (reconcile, then tick) |
| `app.tsx`, `src/app/` | Studies nav panel (with the needs-you count), study page (Live, Overview, Ideas, Candidates, Findings, Oracle, Bench, Harvest), confirmed actions, header badge, rpc data hooks |
| `src/app/live/` | The Live view (Live tab and the thread-pane Live panel): lanes, pipeline cards, CI bands, bench strip, feed, transcript, replay player and scrubber, motion, realtime deltas |
| `src/live-model.ts`, `src/live.ts`, `src/live-feed.ts` | Live view model shared by server and app (phases, columns, deltas, replay skeleton), the feed, and the server side: phase and last-action recorder, CI band cache, throttled deltas, view and replay bundle |
| `src/band.ts`, `src/replay.ts`, `src/action.ts` | CI band of a measurement from its samples (seeded like the decision), the replay model (keyframes, the view at any t), and the sanitized "last action" labels |
| `src/present.ts` | The improvement convention (better is positive), shared by the page, CLI, report and agent messages |
| `host.ts`, `src/host/` | `bb.host` entry and ops: git (snapshot, prepare, compose/revert, logs), background jobs, bundles, bench clones, health, exports |
| `src/engine.ts` | Lifecycle, control loop, worker/strategist tools, budgets, rate limits, notices, harvest control, reconciliation |
| `src/commit.ts` | Worker commit messages: checks, trailers, mapping commits back to candidates |
| `src/primitives.ts`, `src/evidence.ts` | `bb study measure` / `gate` (requested measurements and gates on the study's bench) and the `bb study evidence` document |
| `src/pipeline.ts` | Candidate pipeline and job launcher (parallel gates, one measurement per bench lock) |
| `src/harvest.ts`, `src/harvest-legacy.ts` | Harvest as a freeze (wait for the bench, pin best), and the display helpers for harvests the plugin ran before 1.0 |
| `src/report.ts` | The Markdown study report |
| `src/bench.ts`, `src/transfer.ts`, `src/health.ts`, `src/drift.ts`, `src/holdout.ts` | Bench sites, git bundle relay, health checks, drift checks, the private holdout |
| `src/bench-provider/`, `src/remote/` | The bench provider contract (zod schemas), its client and the remote bench runner; the fleet that joins, calibrates, rotates and cleans up remote machines, and its view |
| `examples/bench-provider-local/` | An example bench provider plugin (local temp directories and child processes) |
| `src/spec.ts`, `src/scope.ts`, `src/stats.ts`, `src/noise.ts`, `src/verdict.ts`, `src/calibration.ts` | Spec, scope check, statistics, noise classes, verdicts, calibration |
| `src/scheduler.ts` | Pure policy: adaptive W, backpressure, provider-limit W, idea choice, budgets, strategist triggers, idle handling |
| `src/views.ts`, `src/rpc.ts`, `src/cli.ts`, `src/tools.ts`, `src/prompts.ts` | View models, RPC, `bb study`, role-gated agent tools, agent-facing text |
| `src/db/` | SQLite schema (append-only migrations) and typed store |
| `skills/` | `study-create`, `autoresearch` (usage, strategist) and `study-harvest` (an agent's harvest into PRs, one study or several) |

## Develop

```sh
pnpm test          # vitest: backend, real-git host and harvest tests, rpc, jsdom frontend
pnpm typecheck     # tsc --noEmit
bb plugin build
bb plugin install . --yes && bb plugin reload bb-autoresearch
```

Tests never depend on the machine's load: real-git tests use `localRunner()`
(test/helpers.ts), which injects fixed health readings.

## Credits

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).

## License

MIT. See [LICENSE](LICENSE).
