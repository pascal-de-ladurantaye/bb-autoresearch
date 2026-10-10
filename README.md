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
   Gates run in parallel; each bench host measures one candidate at a time;
   wins are confirmed (and checked against a hidden holdout when configured)
   before they are squashed onto best. CLI: `bb study start <slug>`.
4. **Watch and steer.**
   - Overview: Needs you; best vs base in words with raw values and CI; what's running; the trajectory; secondary metrics, and each guardrail's cumulative position against its total limit with the CI and the room left; controls (pause, resume, max workers, harvest, archive); notices, each with the action it asks for.
   - Ideas: add, reorder, pin, veto (with a reason).
   - Candidates: verdict, improvement, CI and guardrail status per row (ok, near limit, inconclusive, BROKEN, and whether the step or the total is the problem); each opens every recorded metric, samples, diffs, and the worker thread.
   - Findings: searchable, with counts per outcome, theme and verdict.
   - Oracle: spec, versions, pending spec with its diff, calibration with its approval and guardrail noise, segments.
   - Bench: hosts, queue, health (latest marked), drift, bundles.
   - Harvest: below.

   The study thread shows one line per plugin message (strategist round,
   verdict); the full detail goes to the agent as an agent-only block.
   Notices (new best, stall, budget thresholds, broken oracle, drift, rate
   limits, harvest ready) mark the study thread unread. A "?" next to each
   statistical term (MDE, CI, noise floor, ablation, dependency) explains it.
5. **Harvest.** When the budget is used up the study pauses and Needs you
   offers *Start harvest* (or start one any time from the Overview; CLI
   `bb study harvest <slug>`). It freezes best and works through the
   promotions:
   - The strategist groups the promotions into changesets (or one per promotion, if you tick that in the dialog or pass `--one-per-promotion`).
   - Each changeset is ablated: best with it reverted is measured against best. Its contribution is shown as a share of the base→best gain, in points and metric units, with the CI. A revert conflict or a gate failure becomes a dependency, explained in words, and dependent changesets form a stack.
   - Each changeset is gated (and measured) alone on its PR base, then drafted as a local branch `studies/<slug>/harvest/h<N>/*` with a PR body you can preview. The bodies and `report.md` are exported under the plugin's data dir.

   Then: **Publish draft PRs…** shows exactly which branches go to which
   remote and which draft PRs open (and refuses without a GitHub remote), and
   keeps the PR URLs or errors on the page afterwards; droppable changesets can
   be kept or dropped first. Or *Keep exploring* (resume), or *Archive*. CLI:
   `bb study harvest <slug> --publish`, `bb study resume <slug>`,
   `bb study archive <slug>`.

Every number reads the same everywhere: **better is positive, in the
metric's own terms** ("74.7% fewer ops (4.0×)", "+74.7%"), with raw values
next to it. Nothing is pushed before you publish. Every candidate stays under
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
| `bb study bench <slug>` | Health checks, bundle transfers, drift checks, segments |
| `bb study drift <slug>` | Request an A/A drift check on every bench host |
| `bb study harvest <slug> [--wait] [--restart] [--one-per-promotion] [--no-measure-standalone]` | Start or show a dry-run harvest |
| `bb study harvest <slug> --publish` | Publish the ready harvest as DRAFT PRs on GitHub |
| `bb study report <slug>` | The study report (Markdown) |
| `bb study archive <slug> [--archive-thread]` | Stop for good: workers, bench checkouts and clones, a running harvest; `--archive-thread` also archives the study thread (the app's archive dialog does by default) |

Every command takes `--json` (one JSON document from the same view models as
the page; errors carry a hint with the next command). Approval and publishing
work in the app or the CLI; both are deliberate, audited the same way, and the
CLI refuses human controls from a study's own worker and study threads (see
the threat model in the design).

## Limits

- **Trust.** Oracle commands run with full trust on edit and bench hosts, and agents with shell access can reach the plugin's RPC and CLI (see the threat model). Run studies whose results matter with the bench, and the holdout, on a machine the workers can't reach.
- **Edit host.** The edit host is the BB server's own machine. Remote edit hosts aren't built.
- **Budgets.** Max workers, candidates, bench hours, deadline, and tokens (per-thread usage as BB reports it) are enforced. Dollar cost isn't available to plugins.
- **Provider limits.** Rate-limited turns are retried at the window reset, and spawns hold until then. A tight usage window halves W. Neither path has been seen live yet.
- **Snapshots.** Workers' worktrees are committed with `git add -A`: give the repo a `.gitignore` for build outputs.
- **Harvest.** Dependencies are detected only through revert conflicts and gate failures. Contributions are measured relative to best and shown as shares of the gain.

## Layout

| Path | What |
|---|---|
| `server.ts` | Factory: storage, host client, tools, RPC, CLI, events, the engine service (reconcile, then tick) |
| `app.tsx`, `src/app/` | Studies nav panel (with the needs-you count), study page (Overview, Ideas, Candidates, Findings, Oracle, Bench, Harvest), confirmed actions, header badge, rpc data hooks |
| `src/present.ts` | The improvement convention (better is positive), shared by the page, CLI, report and agent messages |
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
