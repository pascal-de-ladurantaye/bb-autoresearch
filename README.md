# bb-plugin-autoresearch

A BB plugin for long-running, measured code-optimization studies. Short-lived
agent workers propose changes in parallel; the plugin owns the loop, the
measurements, and every keep or discard decision, then turns the wins into
reviewable PRs whose contributions are measured by ablation.

Design and status: [docs/design.md](docs/design.md). The "Status" section says
which milestone exit criteria were validated (short version: everything is
built; it has only run on toy repositories), and the "Implementation notes"
sections record how the code works and every deviation from the design.

## Install

```sh
pnpm install
bb plugin build
bb plugin install . --yes      # from this checkout
bb plugin enable autoresearch
```

Requires BB ≥ 0.45, git ≥ 2.38 on every machine a study uses (for
`git merge-tree --write-tree`), and the GitHub CLI (`gh`) only if you publish
PRs.

## Run a study

1. **Create.** In a thread of the project you want to optimize, ask the agent
   to set up a study. The `study-create` skill interviews you, drafts the spec
   (TOML: objective, metric, guardrails, scope, oracle commands, noise class,
   bench hosts, budget) and submits it with `study_propose`. That thread
   becomes the **study thread** (the strategist).
2. **Review and calibrate.** `bb study show <slug>`, then
   `bb study calibrate <slug> [--wait]`: approves the spec, runs the gates on
   the base commit and A/A measurements on every bench host to find the noise
   floor and the minimum detectable effect.
3. **Start.** Seed ideas with `bb study ideas add <slug> "<idea>"` (or let the
   strategist do it), then `bb study start <slug>`. Hidden worker threads
   spawn in managed worktrees from `studies/<slug>/best`, submit candidates,
   and get verdicts as messages. Gates run in parallel; each bench host
   measures one candidate at a time; wins are confirmed (and checked against
   a hidden holdout when configured) before they are squashed onto best.
4. **Watch and steer** on the **Studies** page in the sidebar:
   - Overview: trajectory, budget, provider usage, controls.
   - Ideas: add, reorder, pin, veto.
   - Candidates: verdicts, samples, diffs.
   - Findings: searchable.
   - Oracle: spec, versions, segments, calibration, pending spec.
   - Bench: hosts, queue, health, drift, bundles.
   - Harvest.

   Notices (new best, stall, budget thresholds, broken oracle, drift, rate
   limits, harvest ready) mark the study thread unread.
5. **Harvest.** `bb study harvest <slug>` (or the Harvest tab's dry-run button) freezes best and works through the promotions:
   - The strategist groups the promotions into changesets. Use `--one-per-promotion` to skip that.
   - Each changeset is ablated: best with it reverted is measured against best, which gives its contribution with a CI. A revert conflict or a gate failure becomes a dependency, and dependent changesets form a stack.
   - Each changeset is gated (and measured) alone on its PR base, then drafted as a local branch `studies/<slug>/harvest/h<N>/*` with a PR body. The bodies and `report.md` are exported under the plugin's data dir.

   The report compares the sum of the contributions with the measured total gain, and warns when they don't add up. Then do one of these:
   - `bb study harvest <slug> --publish`: push the branches and open DRAFT PRs with `gh`. It refuses without a GitHub remote.
   - `bb study resume <slug>`: keep exploring.
   - `bb study archive <slug>`: done.

Nothing is pushed before `--publish`. Every candidate stays under
`refs/studies/<slug>/c/<n>`.

## CLI

| Command | What it does |
|---|---|
| `bb study list` | Studies with state, best vs base, budget |
| `bb study show <slug> [--events N]` | Spec summary, calibration, best, budget, usage, bench hosts, ideas, candidates, workers, notices, events |
| `bb study calibrate <slug> [--wait]` | Approve the spec and calibrate; mid-run, an oracle change (new segment) |
| `bb study approve <slug>` | Apply a pending spec whose oracle is unchanged |
| `bb study start <slug>` | Approve calibration and run (or resume) |
| `bb study pause` / `resume <slug>` | Pause; resume (from Harvesting: keep exploring) |
| `bb study concurrency <slug> <n\|auto>` | Lower max workers (clamped to the spec) |
| `bb study ideas add <slug> "<title>" [...]` / `ideas list <slug>` | The idea board |
| `bb study workers <slug>` | Worker threads |
| `bb study bench <slug>` | Health checks, bundle transfers, drift checks, segments |
| `bb study drift <slug>` | Request an A/A drift check on every bench host |
| `bb study harvest <slug> [--wait] [--restart] [--one-per-promotion] [--no-measure-standalone]` | Start or show a dry-run harvest |
| `bb study harvest <slug> --publish` | Publish the ready harvest as DRAFT PRs on GitHub |
| `bb study report <slug>` | The study report (Markdown) |
| `bb study archive <slug>` | Stop for good: workers, bench checkouts and clones, a running harvest |

Approval (`calibrate`, `approve`, `start`) and publishing are CLI-only, and
human controls are refused from a study's own worker and study threads (see
the threat model in the design).

## Limits

- **Trust.** Oracle commands run with full trust on edit and bench hosts, and agents with shell access can reach the plugin's RPC and CLI (see the threat model). Run studies whose results matter with the bench, and the holdout, on a machine the workers can't reach.
- **Edit host.** The edit host is the BB server's own machine. Remote edit hosts aren't built.
- **Budgets.** Max workers, candidates, bench hours, deadline, and tokens (per-thread usage as BB reports it) are enforced. Dollar cost isn't available to plugins.
- **Provider limits.** Rate-limited turns are retried at the window reset, and spawns hold until then. A tight usage window halves W. Neither path has been seen live yet.
- **Snapshots.** Workers' worktrees are committed with `git add -A`: give the repo a `.gitignore` for build outputs.
- **Harvest.** Dependencies are detected only through revert conflicts and gate failures. Contributions are relative to best, so they get large after big wins.

## Layout

| Path | What |
|---|---|
| `server.ts` | Factory: storage, host client, tools, RPC, CLI, events, the engine service (reconcile, then tick) |
| `app.tsx`, `src/app/` | Studies nav panel, study page (Overview, Ideas, Candidates, Findings, Oracle, Bench, Harvest), header badge, rpc data hooks |
| `host.ts`, `src/host/` | `bb.host` entry and ops: git (snapshot, prepare, compose/revert, logs), background jobs, bundles, bench clones, health, exports |
| `src/engine.ts` | Lifecycle, control loop, worker/strategist tools, budgets, rate limits, notices, harvest control, reconciliation |
| `src/pipeline.ts` | Candidate pipeline and job launcher (parallel gates, one measurement per bench lock) |
| `src/harvest.ts`, `src/harvest-math.ts` | Harvest phases (grouping, ablation, dependencies, stacks, standalone, drafting) and their pure math |
| `src/publisher.ts` | `PrPublisher`: dry-run (local branches + files) and GitHub (draft PRs via `gh`) |
| `src/report.ts` | PR bodies and the Markdown study report |
| `src/bench.ts`, `src/transfer.ts`, `src/health.ts`, `src/drift.ts`, `src/holdout.ts` | Bench sites, git bundle relay, health checks, drift checks, the private holdout |
| `src/spec.ts`, `src/scope.ts`, `src/stats.ts`, `src/noise.ts`, `src/verdict.ts`, `src/calibration.ts` | Spec, scope check, statistics, noise classes, verdicts, calibration |
| `src/scheduler.ts` | Pure policy: adaptive W, backpressure, provider-limit W, idea choice, budgets, strategist triggers, idle handling |
| `src/views.ts`, `src/rpc.ts`, `src/cli.ts`, `src/tools.ts`, `src/prompts.ts` | View models, RPC, `bb study`, role-gated agent tools, agent-facing text |
| `src/db/` | SQLite schema (append-only migrations) and typed store |
| `skills/` | `study-create` and `autoresearch` (usage, strategist, harvest) |

## Develop

```sh
pnpm test          # vitest: backend, real-git host and harvest tests, rpc, jsdom frontend
pnpm typecheck     # tsc --noEmit
bb plugin build
bb plugin install . --yes && bb plugin reload autoresearch
```

Tests never depend on the machine's load: real-git tests use `localRunner()`
(test/helpers.ts), which injects fixed health readings.
