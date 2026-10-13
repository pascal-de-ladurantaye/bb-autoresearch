# bb-autoresearch

A BB plugin for long-running, measured code-optimization studies. Short-lived
agent workers propose changes in parallel; the plugin owns the loop, the
measurements, and every keep or discard decision. When a study is done, an
agent turns its wins into PRs (the `study-harvest` skill), and every number it
puts in them comes from the plugin. A study optimizes the benchmark you give
it: only changes that beat its noise are kept, and whether that benchmark
represents production is yours to judge.

![The Live tab mid-study: one lane per worker, candidate cards moving from tests to the bench and Promoted, and the measurement's confidence interval narrowing pair by pair against the win threshold](docs/screenshots/live.jpg)

| Read | For |
|---|---|
| [docs/guide.md](docs/guide.md) | Using it: write an oracle, run a study, read verdicts, harvest with your agent, and the spec settings people ask about most |
| [docs/design.md](docs/design.md) | How it works and why, and which milestone exit criteria were validated |
| [docs/release-notes.md](docs/release-notes.md) | What each version added, its decisions, live checks and known issues |
| [docs/bench-providers.md](docs/bench-providers.md) | Writing a bench provider plugin that lends remote machines |
| [docs/stability.md](docs/stability.md) | What 1.0 keeps stable (spec keys, the provider contract, `--json`, the evidence JSON) and the versioning policy |

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

The **Studies** page in the sidebar is where you run a study; every step also
has a `bb study` command. Each page leads with what needs you.

1. **Create.** Studies → **New study** opens a thread with the `study-create`
   skill. It interviews you, reads the code and drafts the spec: the metric,
   the benchmark and test commands, the files workers may edit, guardrails,
   bench hosts and budget. That thread becomes the **study thread**, where the
   strategist runs.
2. **Calibrate.** Approve the spec; calibration runs the tests on the base
   commit and the benchmark against itself to find its noise and the smallest
   win it can detect.
3. **Start.** Seed ideas and start. Hidden workers each take one idea in their
   own worktree and submit a candidate with their own commit message; the
   plugin tests it, measures it against best on the quietest free bench host,
   and keeps it only when its confidence interval clears that host's threshold.
4. **Watch and steer.** The Live tab shows workers, candidates and each
   measurement's CI band narrowing to its verdict; any study can be replayed.
   Steer from the Ideas tab and the Overview.
5. **Harvest.** Freeze best and ask your agent to turn it into reviewable PRs.
   It reads `bb study evidence`, groups and splits the changes, and has the
   plugin measure and gate every PR (`bb study measure`, `bb study gate`).

The [guide](docs/guide.md) walks through each step. Measurements can run on
this machine (single-machine mode keeps tests out of the way of timing runs),
on another BB machine, or on short-lived remote machines lent by a
[bench provider](docs/bench-providers.md) plugin;
[`examples/bench-provider-local/`](examples/bench-provider-local/) is one for
local temp directories. Each bench host decides with its own win threshold,
and one much noisier than the others is left out. The plugin never pushes:
your agent publishes when you ask. Every candidate stays under
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
| `bb study bench <slug>` | Bench hosts (remote machines too: state, expiry, rotation, own calibration), health checks, bundle transfers, drift checks, segments, seeds and base bundles on disk |
| `bb study drift <slug>` | Request an A/A drift check on every bench host |
| `bb study harvest <slug> [--wait] [--harvest N]` | Freeze best for harvest, or show the current (or an older) harvest |
| `bb study evidence <slug> [--samples] [--candidates 3,7]` | Everything an agent needs to harvest, as stable JSON with `--json` (`bb-autoresearch/evidence` v1) |
| `bb study measure <slug> <A> <B> [--pairs N] [--host H] [--detach] [--timeout D]` | Measure B against A (any two commits) with the study's protocol and guardrails, on the quietest free bench host with that host's own win threshold (waiting for remote machines a frozen study brings up); counts as bench time |
| `bb study gate <slug> <ref> [--detach] [--timeout D]` | The study's gates on any commit (edit host) |
| `bb study results <slug> [r<N>] [--wait]` | Measurements and gates asked for |
| `bb study report <slug>` | The study report (Markdown) |
| `bb study archive <slug> [--archive-thread]` | Stop for good: workers, bench checkouts and clones, measurements still running; `--archive-thread` also archives the study thread (the app's archive dialog does by default) |

Every command takes `--json` (one JSON document from the same view models as
the page; errors carry a hint with the next command; the shapes 1.x keeps are
in [stability.md](docs/stability.md)). Approval, freezing for harvest and
archiving work in the app or the CLI; both are deliberate, audited the same way, and the
CLI refuses human controls from a study's own worker and study threads (see
the [threat model](docs/design.md#threat-model)).

## Limits

- **The benchmark.** A study optimizes the benchmark it is given. Whether that benchmark represents production (workload, inputs, hardware) is yours to judge; the plugin doesn't second-guess it, and the holdout only helps if you configure one.
- **Trust.** Oracle commands run with full trust on edit and bench hosts, and agents with shell access can reach the plugin's RPC and CLI (see the [threat model](docs/design.md#threat-model)). Run studies whose results matter with the bench, and the holdout, on a machine the workers can't reach.
- **Edit host.** The edit host is the BB server's own machine. Remote edit hosts aren't built.
- **Budgets.** Max workers, candidates, bench hours, deadline, and tokens (per-thread usage as BB reports it) are enforced. Dollar cost isn't available to plugins.
- **Provider limits.** Rate-limited turns are retried at the window reset, and spawns hold until then. A tight usage window halves W. Neither path has been seen live yet.
- **Snapshots.** Workers' worktrees are committed with `git add -A`: give the repo a `.gitignore` for build outputs.
- **Harvest.** The plugin freezes best and measures and gates what an agent asks; grouping, splitting, PR descriptions and publishing are the agent's, with the repository's own tools. `measure` and `gate` are refused while the study runs workers and its bench is busy, and on a paused study whose bench is remote only (pausing destroys the machines; freezing brings them back). Harvests the plugin ran before 1.0 are readable, not resumable.
- **Bench hosts.** Each host is compared with its peers only at calibration: one that becomes noisy mid-segment pauses the study for drift rather than leaving the dispatch set.

## Layout

| Path | What |
|---|---|
| `server.ts` | Factory: storage, host client, tools, RPC, CLI, events, the engine service (reconcile, then tick) |
| `app.tsx`, `src/app/` | Studies nav panel (with the needs-you count), study page (Live, Overview, Ideas, Candidates, Findings, Oracle, Bench, Harvest), confirmed actions, header badge, rpc data hooks |
| `src/app/live/` | The Live view (Live tab and the thread-pane Live panel): lanes, pipeline cards, CI bands, bench strip, feed, transcript, replay player and scrubber, motion, realtime deltas |
| `src/live-model.ts`, `src/live.ts`, `src/live-feed.ts` | Live view model shared by server and app (phases, columns, deltas, replay skeleton), the feed, and the server side: phase and last-action recorder, CI band cache, throttled deltas, view and replay bundle |
| `src/band.ts`, `src/replay.ts`, `src/action.ts` | CI band of a measurement from its samples (seeded like the decision), the replay model (keyframes, the view at any t), and the sanitized "last action" labels |
| `src/present.ts` | The improvement convention (better is positive), shared by the page, CLI, report and agent messages |
| `host.ts`, `src/host/` | `bb.host` entry and ops: git (snapshot, prepare, compose/revert, logs), background jobs, bundles, bench clones, health, exports, seeds and base bundles (and their cleanup) |
| `src/engine.ts` | Lifecycle, control loop, worker/strategist tools, budgets, rate limits, notices, harvest control, reconciliation |
| `src/commit.ts` | Worker commit messages: checks, trailers, mapping commits back to candidates |
| `src/primitives.ts`, `src/evidence.ts` | `bb study measure` / `gate` (requested measurements and gates on the study's bench) and the `bb study evidence` document |
| `src/pipeline.ts` | Candidate pipeline and job launcher (parallel gates, one measurement per bench lock) |
| `src/harvest.ts`, `src/harvest-legacy.ts` | Harvest as a freeze (wait for the bench, pin best), and the display helpers for harvests the plugin ran before 1.0 |
| `src/report.ts` | The Markdown study report |
| `src/bench.ts`, `src/transfer.ts`, `src/health.ts`, `src/drift.ts`, `src/holdout.ts` | Bench sites, git bundle relay, health checks, drift checks, the private holdout |
| `src/bench-provider/`, `src/remote/` | The bench provider contract (zod schemas), its client and the remote bench runner; the fleet that joins, calibrates, rotates, re-adopts after a reload and cleans up remote machines, and its view |
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

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the install,
the typecheck, the tests and `bb plugin build` on every pull request and on
`main`. Tests never depend on the machine's load: real-git tests use
`localRunner()` (test/helpers.ts), which injects fixed health readings.

## Credits

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).

## License

MIT. See [LICENSE](LICENSE).
