---
eyebrow: BB plugin design
title: Autoresearch for BB
subtitle: A BB plugin for long-running, measured code-optimization studies. Short-lived agent workers propose changes in parallel. The plugin owns the loop, the measurements, and every keep or discard decision.
brand: AR
brandLabel: bb-autoresearch
brandSublabel: BB plugin design
pills: v0.2.3 | M0-M3 built | Live view and replay | Single-machine mode | Toy-validated | Exit criteria partly validated
cards: Unit of work=Study | Agents=Strategist + workers | Verdicts=Plugin-owned | Output=PRs with measured gains
---

# Autoresearch for BB

> Autoresearch works like a merge queue. The CI is a benchmark, and the authors are short-lived agents. The plugin runs the loop, measures every candidate, and decides what to keep. Agents only propose changes and explain what they learned.

## Status

All four milestones are built (BB 0.45, plugin SDK 0.6.14). Each was smoke-tested live on toy repositories on one MacBook. With v0.2.2 it also ran once on a real workload: a blind comparison against another autoresearch loop on a real-world CLI performance task, from the same starting commit (5.4× against the other loop's 3.9× on that benchmark, in about 3.6× the wall time; one run of each). The exit criteria:

| Milestone | Exit criterion | Validated? |
|---|---|---|
| M0: test the main assumption | Equal or better improvement than a serial single-agent loop at equal tokens, and a measured false-win rate | **No.** The head-to-head against a serial loop was never run. False-win rates are measured in simulation only (stats and expensive-class tests). |
| M1: parallel | Bench busy > 80% of Running time; time to target clearly below M0 at similar tokens per win | **No.** Toy studies reached 85% in steady state when eval > think, but they are too short; no real workload, no M0 comparison. |
| M2: remote bench and trust | A study runs a full day on a remote x86 bench host without a human stepping in | **No.** Only one BB machine existed; the remote path ran against the server's own machine in clone mode for minutes. |
| M3: harvest and operations | A harvested PR set whose measured contributions add up to the total gain within the CI | **On a toy only.** Harvest h4 of `toy-m3b`: sum of contributions +290.7% ± 1.4% vs measured total +293.9% (CI half-width of the gap 3.7%). See the M3 notes. |

After M3, a dedicated human interface pass reworked the Studies page, the study thread messages, notices and the CLI around one way of expressing improvement, and moved approval and publishing into the app (see "Implementation notes: human interface").

The last pass before release closed two guardrail gaps and three usability issues (see "Implementation notes: guardrails and pre-release fixes"). Guardrails now have a cumulative limit against the segment base next to the per-step one, and both are judged on a confidence interval like the primary metric. In simulation that cut false rejections of real wins by a noisy guardrail from 13.3% to 0.0%, with real regressions still rejected. Worker snapshots no longer commit build outputs (`[scope] ignore`), the new-study composer opens on the current project, and archiving a study can archive its study thread too.

After the release, a **Live** view was added (part 1 of 2): while a study runs, the study page opens on a Live tab, and the same view can sit beside the study thread in its split pane. Every change it shows is recorded as an event, so a later replay can rebuild it at any time (see "Implementation notes: live view (part 1)"). Part 2 added a CI band per measurement that narrows pair by pair to the sequential test's decision (computed from the samples with the decision's own seeded bootstrap, so it shows exactly the CI the verdict saw), a "last action" line per worker, a visible "best moved" moment, and a replay of any study with a timeline scrubber (see "Implementation notes: live view (part 2)").

Released as `bb-autoresearch` (plugin id `bb-autoresearch`, shown as **Autoresearch**), MIT licensed, at https://github.com/pascal-de-ladurantaye/bb-autoresearch. v0.1.0 shipped M0–M3, the human interface pass and the guardrail fixes; v0.2.0 adds the read-only Live view (a Live tab and a panel beside the study thread) with live CI bands and replay (see "Implementation notes: live view", parts 1 and 2); v0.2.1 fixes wording and one link: the Oracle tab's noise sentence per noise class (and "not measured" without a noise floor), guardrail losses that say why instead of showing a gain next to "lose", single-run wording for deterministic measurements, the status line's bench counts, a state-aware Overview, and worker lanes linked to their candidates through the plugin's own worker row (see "Implementation notes: v0.2.1 fixes"); v0.2.2 adds single-machine mode (gates take turns with measurements on a machine that is both edit and bench host, and an optional quiet bench that holds new worker turns while it measures) and commits in the studied repository as the repository's own git identity (see "Implementation notes: single-machine mode"); v0.2.3 fixes the UI issues found while capturing the marketplace screenshots, tells the strategist where best's code is, and stops archiving from spawning replacement workers (see "Implementation notes: v0.2.3"); v0.2.4 fixes what a 5.6-hour blind study on a large repository showed (bench time spent on candidates that could no longer win, on clear losses and on confirming big wins; drift pauses that were really shorter runs; measurements and promotions after a drift pause; harvest stacks whose layers didn't apply) and the UI issues found while capturing the store screenshots (see "Implementation notes: v0.2.4").

What has not been exercised live at all: GitHub publishing (only against a mock `gh`), provider usage windows (this machine's providers report none), rate-limit retries (no rate limit occurred), remote edit hosts (not built).

## Problem

We want an agent to improve one measurable property of a codebase over hours or days, for example p99 latency, test-suite runtime, or bundle size. It should keep only changes that really help.

The simple form is one long-lived agent that edits, benchmarks, and decides, in a loop. It fails in predictable ways:

- **The agent decides on its own results.** It runs the benchmark, reads the numbers, and chooses to keep. Noise, wishful reading, and edits to the benchmark all go unchecked.
- **Context grows without limit.** Every iteration adds to the transcript. Compaction loses detail, and the agent slowly forgets what it already tried.
- **It's serial.** One agent and one working tree. Most wall time is the agent thinking, while the benchmark machine sits idle.
- **Measurements are taken on the wrong hardware.** The benchmark runs wherever the agent runs, usually a laptop. That isn't the production architecture, and other work on the same machine adds noise.
- **The output is a messy branch.** Hundreds of commits and reverts that someone then has to untangle by hand.

BB already has the building blocks: worktrees, cheap threads, multiple providers, remote machines, plugins with a server, a host daemon and UI. A design built for BB can fix each of these.

## Goals

- A **study** runs unattended for days. The human sets its direction but doesn't drive it.
- Every keep or discard is a **statistical decision made by the plugin** against a pinned oracle, on suitable hardware.
- Agents think **in parallel**, and timing runs happen **one at a time** on quiet machines.
- **Nothing is lost.** Every attempt, win or lose, can be inspected and revisited.
- The result is **a set of reviewable PRs**. Each PR's contribution is measured by removing it from the final result and benchmarking again.

## Non-goals

- Hyperparameter sweeps with no code change. They can be expressed as a study, but they aren't the target.
- Multi-objective Pareto search. v1 optimizes one primary metric and treats others as guardrails.
- Studies that span projects, or that are shared across users.
- Replacing CI. Gates reuse your test commands, they don't replace your pipeline.

## Principles

1. **The plugin runs the loop; agents make the judgment calls.** Scheduling, retries, budgets, and verdicts are plugin code. There's no "never stop" prompt.
2. **The plugin owns the oracle.** Agents submit candidates. They can't edit the benchmark, can't keep a regression, and can't touch protected files.
3. **Many short-lived workers, not one long-lived agent.** One worker gets one idea, a fresh context, and its own worktree, and is archived when done. Long context stops being a problem.
4. **Edit in parallel, measure one at a time.** N worktrees edit at once, and each benchmark machine runs one measurement at a time.
5. **Git stores every experiment.** Every candidate is a commit kept under a ref. Nothing is lost to a revert.
6. **Humans steer the list of ideas, not a chat.** You change direction by editing the idea queue, scope, and budget. Chat is optional.
7. **Output is evidence.** PRs carry measured contributions with confidence intervals.

With concurrency 1, the same design reduces to a classic serial loop. It isn't a separate mode.

## Concepts

| Term | Meaning |
|---|---|
| **Study** | A long-running optimization effort: objective, metric, guardrails, scope, oracle, budget. |
| **Oracle** | How a commit is judged: `build`, `gate` (correctness), `measure` (metrics). Pinned by hash. |
| **Segment** | A period of a study with a fixed oracle version. Changing the oracle starts a new segment. |
| **Idea** | A queued thing to try, with a rationale, a theme, a priority, and a source. |
| **Worker** | A short-lived agent thread that works on one idea in its own worktree. |
| **Strategist** | The agent role that maintains the idea queue and the dossier. It runs in the study thread. |
| **Candidate** | One submitted attempt: a commit plus its samples and verdict. |
| **Verdict** | `win`, `lose`, `inconclusive`, `gate_failed`, `conflict`, or `rejected` (scope). |
| **Best** | The current best commit. Only the plugin advances it, by promoting a winning candidate. |
| **Finding** | What a worker learned: outcome, why, and when the idea would be worth revisiting. |
| **Dossier** | The strategist's running map of the codebase: hot paths, what's been learned, dead ends. |
| **Bench host** | A BB machine dedicated to measurement. It runs one measurement at a time. |
| **Harvest** | Turning base→best into reviewable PRs with contributions measured by removing each one (ablation). |

## Architecture

```mermaid
flowchart LR
  human([Human])
  subgraph bbserver["BB server"]
    plugin["autoresearch plugin<br/>scheduler · pipeline · stats · budget"]
    db[("SQLite<br/>bb.storage")]
    ui["Study page<br/>navPanel + header badge"]
  end
  subgraph edit["Edit host"]
    st["Study thread<br/>strategist"]
    w1["Worker 1<br/>worktree"]
    w2["Worker 2<br/>worktree"]
    w3["Worker N<br/>worktree"]
    ehost["host bundle<br/>snapshot · scope · gate"]
  end
  subgraph bench["Bench host"]
    bhost["host bundle<br/>build · measure"]
  end
  human --> ui
  human --> st
  ui <--> plugin
  plugin <--> db
  plugin -- spawn, verdicts --> w1 & w2 & w3
  w1 & w2 & w3 -- study_submit_candidate --> plugin
  plugin -- digest rounds --> st
  st -- study_queue_ideas, dossier --> plugin
  plugin -- host RPC --> ehost
  plugin -- host RPC, git bundle --> bhost
```

### Components

- **Plugin server.** The scheduler, the candidate pipeline, statistics, budget enforcement, the SQLite state, RPC for the UI, and the CLI. It's the only component allowed to advance `best`.
- **Host bundle (`bb.host`).** One full-trust Node entry that runs on every machine the study uses. On edit hosts it snapshots worktrees, checks scope, rebases, and runs gates. On bench hosts it builds, runs measurements, and reports machine health. It streams progress back to the server through host signals.
- **Study thread.** One visible thread per study. It starts as the conversation that creates the study. After that it's where strategist rounds run and where the human talks to the study.
- **Worker threads.** Hidden threads, one per idea. Each runs in its own managed worktree, branched from `best`.
- **Frontend.** A Studies nav panel, the study page, and a header badge on study and worker threads.

## Study lifecycle

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Calibrating: spec approved
  Calibrating --> Draft: oracle too noisy or gates red
  Calibrating --> Running: calibration approved
  Running --> Paused: human, budget, bench offline, drift
  Paused --> Running: resume
  Running --> Calibrating: oracle changed, new segment
  Running --> Harvesting: human or budget exhausted
  Paused --> Harvesting: human
  Harvesting --> Running: keep exploring
  Harvesting --> Archived: done
  Archived --> [*]
```

- **Draft.** The `study-create` skill interviews the human, reads the code, and drafts the spec and oracle commands. It submits them with `study_propose`. The plugin validates them and shows them on the study page for approval.
- **Calibrating.** The plugin runs the gates on the base commit, then runs repeated base-vs-base (A/A) measurements. The result is the noise floor, the smallest detectable effect, and the cost of one evaluation. The human approves, or tunes the oracle and calibrates again.
- **Running.** Workers are spawned, candidates evaluated, and the strategist runs rounds. The study stays in this state for days.
- **Paused.** No new workers start. Workers already running finish their current submission. A pause triggered by the system (budget, bench offline, noise drift) always notifies the human.
- **Harvesting.** Ablations run and PRs are drafted. The study can go back to Running afterwards.

## Candidate pipeline

Each submission goes through one pipeline, all in plugin code.

```mermaid
sequenceDiagram
  participant W as Worker
  participant P as Plugin
  participant E as Edit host
  participant B as Bench host
  W->>P: study_submit_candidate(summary)
  P->>E: snapshot commit, scope check
  E-->>P: sha, changed paths
  P->>E: rebase onto best, run gates
  E-->>P: gates passed
  P-->>W: queued (position, ETA)
  Note over W: turn ends, thread idle
  P->>B: git bundle, build best and candidate
  loop paired runs until decided
    P->>B: run A/B pair in random order
    B-->>P: samples
  end
  P->>P: verdict from CI vs MDE and guardrails
  alt win
    P->>B: confirmation pairs and holdout
    P->>E: fast-forward best branch
    P-->>W: verdict win with effect and CI
  else lose or inconclusive
    P-->>W: verdict with diagnostics
  end
  W->>P: study_record_finding, then refine or study_finish
```

1. **Snapshot.** The plugin commits the worker's worktree for it and records the SHA. It also writes the ref `refs/studies/<slug>/c/<n>`. Every submission gets a ref, whatever the verdict.
2. **Scope check.** Changed paths must all fall under `editable`, and none may fall under `protected`. Diff size must be within limits. If not, the verdict is `rejected` and nothing is measured.
3. **Rebase.** If `best` moved since the worker started, the plugin rebases the candidate onto the current `best`. A conflict returns verdict `conflict`, and the worker resolves it, since it has the context.
4. **Gate.** Correctness commands run on the edit host. They run in parallel across workers, since gates don't need a quiet machine, unless that machine is also a bench host: then they would compete for CPU with the timing runs, and single-machine mode (see [Scheduling](#scheduling)) queues them for the bench lock instead. A failure returns verdict `gate_failed` with the last lines of output.
5. **Queue.** The worker gets a ticket with its queue position and an estimated wait, then ends its turn. Waiting never holds a tool call open.
6. **Measure.** The bench host measures the candidate against the current `best` using the protocol in [The oracle](#the-oracle).
7. **Decide.** The plugin applies the decision rule, then the guardrails.
8. **Promote.** Wins get a confirmation measurement with fresh samples and a holdout check. The plugin then squashes the candidate into one commit and fast-forwards `studies/<slug>/best`. Running workers are told that `best` moved. They'll be rebased when they next submit.
9. **Report.** The plugin sends the verdict to the worker as a message, which starts its next turn. The message carries the effect, CI, guardrail deltas, and diagnostics.

Promotions are serialized per study, so `best` is a linear chain where each commit is one promoted idea.

## The oracle

### Spec

A study spec is authored as TOML and stored in plugin storage, versioned and hash-pinned. It isn't kept in the repo, so workers can't reach it. The benchmark harness can live in the repo, but those paths must be listed as `protected`. Their content hash is part of the oracle version.

```toml
[study]
slug = "routing-p99"
objective = "Reduce p99 latency of the routing filter under the replay workload."
base = "main"

[metric]
name = "p99_us"
unit = "us"
direction = "lower"

[[guardrail]]
name = "rss_mb"
max_regression = "5%"            # per step: a candidate vs the current best
max_total_regression = "10%"     # in total: best vs the segment base (default: max_regression)

[[guardrail]]
name = "throughput_rps"
direction = "higher"
max_regression = "2%"

[scope]
editable = ["source/filters/routing/**", "source/common/matcher/**"]
protected = ["bench/**", "test/**"]
ignore = ["bazel-*/", "*.pyc"]   # untracked build outputs snapshots never commit (default: common ones)

[oracle]
build = "bazel build //source/exe:envoy-static -c opt"
gate = ["bazel test //test/filters/routing/... -c opt"]
measure = "bench/replay.sh --workload=prod-sample"
noise = "noisy"                 # deterministic | noisy | expensive
bench_hosts = ["bench-x86-01"]
single_machine = "auto"         # auto | on | off: gates share the bench lock with measurements (see Scheduling)
quiet_bench = false             # hold new worker turns on a machine while it measures

[oracle.holdout]
measure = "/srv/holdout/replay.sh --workload=holdout-a"   # lives on the bench host only

[budget]
max_workers = 4
max_candidates = 200
max_bench_hours = 24
deadline = "2026-10-16"

[agents]
strategist = { provider = "claude-code" }
worker = { provider = "codex" }
max_submissions_per_worker = 3

[git]
identity = "repo"               # repo | plugin: who the plugin's commits in the repo are by
```

`measure` prints `METRIC name=value` lines, plus optional `DIAG` lines (phase timings, profile summaries) that are passed to agents as diagnostics.

### Noise classes

| Class | Examples | Protocol | Bench lock |
|---|---|---|---|
| `deterministic` | Bundle size, instruction counts, allocation counts | One run. Wins if strictly better beyond a tolerance. | No. Runs on any host. |
| `noisy` | Latency, test runtime, throughput | Paired, interleaved, sequential test against `best`. | Yes, one measurement per bench host. |
| `expensive` | Model training, long load tests | One run per candidate, compared against the calibrated noise floor. Wins are confirmed with k extra runs. | Yes. |

### Measurement protocol for `noisy`

- The plugin builds `best` once per promotion and caches the build on the bench host. Candidates are built fresh.
- Each side gets `w` warmup runs.
- **Paired, interleaved runs.** Each pair runs `best` and the candidate back to back, in random order. Machine drift hits both sides of a pair equally and cancels out.
- **Statistic.** The plugin takes the paired relative difference for each pair and computes a bootstrap confidence interval of the median.
- **Side runs.** Each side of a pair can be several runs of `measure`, keeping each metric's best value (`side_runs`, chosen at calibration so a side lasts at least `min_side_seconds`).
- **Sequential decision.** After `n_min` pairs, it stops early when the result is clear:
  - clearly worse (the CI is entirely on the regression side): `lose`
  - clearly better (the lower bound clears the minimum detectable effect): `win`
  - it can no longer win (the upper bound is below the minimum detectable effect): `inconclusive` (futility)
  - still ambiguous at `n_max` pairs: `inconclusive`

  Before `n_min`, a clear loss can stop it from 3 pairs, when a stricter interval is entirely below zero. Most candidates are clear losses, so stopping early saves most of the bench time.
- **Confirmation.** A `win` is measured again with fresh pairs before promotion. Many candidates against a noisy benchmark produce false wins by chance, and a false promotion compounds. A win whose CI's lower bound is several times the threshold skips it: no chance fluctuation gets that far.

### Calibration and drift

Calibration runs the full protocol with base against itself (A/A), several times. It produces a report like this:

> Detects changes of 1.8% or more with 20 pairs. About 6 minutes per evaluation, so about 10 evaluations per hour per bench host. Gates take 3 minutes on the edit host.

If the minimum detectable effect is larger than any plausible win, the study goes back to Draft. That costs minutes instead of a week of tokens.

During Running, a schedule repeats an A/A run on `best` every N evaluations. If noise grows past 2× the calibrated level, the study pauses and notifies the human. A disturbed bench machine would otherwise hand out random verdicts. While it is paused for drift, nothing more is measured on that machine.

Relative noise also grows when runs get shorter: a benchmark that got 5× faster is noisier relative to itself on the same, quiet machine. When best's runs drop well below their calibrated length, the plugin recalibrates on best by itself (a new segment with the same oracle) instead of pausing.

### Guardrails and holdout

- **Guardrails** are secondary metrics with two limits. **Per step**, a candidate may be at most `max_regression` worse than the current `best`. **In total**, `best` after the promotion may be at most `max_total_regression` (default: `max_regression`) worse than the segment base, so small regressions can't creep across many kept wins: ten promotions that each add 4.9% memory pass a 5% per-step limit and end 61% above the base. The total is the promotion chain base → best compounded, with the candidate's own step on top.
- Guardrails get the primary metric's statistics. A guardrail **breaks** only when its whole CI is beyond a limit, and then a win is a `lose` with the reason in words ("rss 3.1% worse than best, within the 5.0% limit; 5.4% worse than the segment base, beyond the 5.0% total limit"). When the CI straddles a limit it is **inconclusive**: not a rejection, but flagged in the verdict, on the page (warn state) and in the strategist's digest. The same rule applies to every noise class: paired bootstrap CIs for `noisy`, the tolerance band for `deterministic`, and t·σ bands from calibrated per-run noise for `expensive`.
- Calibration measures each guardrail's A/A noise and the CI half-width an evaluation gets, and warns when that exceeds the limit: such a guardrail can never be shown within it.
- Workers and the strategist see each guardrail's remaining headroom under its total limit.
- **Holdout** is a workload kept only on the bench host. It's evaluated on candidates about to be promoted. Workers never see its inputs or numbers, only pass or fail. It catches changes that special-case the benchmark input.

## Scheduling

### How many workers

Throughput depends on two durations: how long a worker thinks before it submits (T_think), and how long the bench takes per evaluation (T_eval). The scheduler aims for:

`W = min(max_workers, ceil(T_think / T_eval) + 1)`

It learns both durations online. It doesn't spawn a worker while the bench queue is at least `W` deep. This backpressure keeps workers from waiting hours for a verdict.

### One machine for everything

The common case is a laptop: the edit host is also the bench host. Gates (tests, type checks, renders) running next to a timing run add noise to it. **Single-machine mode** (`[oracle] single_machine`, default `"auto"`) removes that source of noise:

- Gates take the same per-host bench lock as measurements, in one queue with them, oldest first. A gate and a measurement never overlap on that machine.
- `"auto"` turns it on when a bench host is the edit machine (`"local"`, or the edit host's own name or id) and the noise class takes the bench lock; `"on"` and `"off"` force it.
- Gate spans are bench intervals: utilization counts them, and so does the overlap audit.
- `T_eval` becomes gate + measure time per candidate, because both occupy the bench. Candidates waiting to gate already count as bench queue for backpressure.
- Calibration runs the base gates under the lock too, and reports the time a candidate occupies the bench.

`quiet_bench = true` goes one step further: while a measurement runs on a machine, a worker turn that would start there waits (BB's `message.dispatch` hook). Turns already running are not interrupted, and a held turn waits for at most one measurement, so a busy bench never starves the workers.

Neither setting changes how a commit is judged, so neither is part of the oracle hash.

### What to try next

- Ideas are taken in strategist priority order. Ideas the human pins go first.
- **Diversity.** At most `ceil(W / 2)` workers run on the same theme at once.
- **No repeats.** An idea whose lineage already lost isn't assigned again unless the strategist explicitly re-queues it as a variation.
- **Ideas can start from a candidate.** An idea may name a losing candidate's ref as its base, for example "combine c/12 and c/19, both near misses". This works because nothing is reverted away.

### When the strategist runs

The plugin starts a strategist round in the study thread when one of these happens:

- K verdicts have arrived since the last round.
- Fewer ready ideas remain than `W`.
- **Stall:** no win in the last N verdicts. The round prompt then asks for structurally different directions.
- The human sends a message.

Only one round runs at a time. Each round prompt starts with a self-contained digest built by the plugin: recent verdicts, findings, the idea board, best's diagnostics, and budget. So the thread can be compacted without losing study state.

## Agents

### Strategist (study thread)

- **Model.** A strong reasoning model. It runs rarely and its decisions shape everything else.
- **Inputs.** The round digest, the dossier, and the findings, which it can search with tools. Its own environment can be any checkout of the project, so every round says where best is and how to read it through git without switching branches (see "Implementation notes: v0.2.3").
- **Responsibilities.**
  - keep the idea queue full and diverse
  - retire dead directions
  - maintain the dossier
  - draft harvest groupings
  - answer the human
- **Not responsible for.** Verdicts, scheduling, or editing code.

### Worker

- **Spawn.** The plugin spawns a hidden thread in a managed worktree, branched from `studies/<slug>/best` or from the idea's starting ref. It uses the spec's provider and model and is placed in the study's thread section. Its metadata is `{ study, role: "worker", idea }`.
- **Brief.** The spawn prompt includes:
  - the objective, scope, and rules
  - the dossier
  - best's diagnostics
  - the assigned idea with related findings
  - its limits: max submissions and turn cap
- **Loop.**
  1. Understand the code.
  2. Edit, then run a fast local check.
  3. Call `study_submit_candidate`, then go idle.
  4. Read the verdict message, then refine or stop.
- **Exit.** `study_finish` refuses until `study_record_finding` has been called. Once the worker finishes, the plugin archives the thread and removes the worktree. Candidate refs are kept.
- **Timeouts.** A worker idle past a deadline gets one nudge. If it's still idle after that, it's stopped and the idea is marked `abandoned`.

### Tools

| Tool | Role | Purpose |
|---|---|---|
| `study_submit_candidate` | worker | Submit the worktree with a summary. Returns a ticket. The verdict arrives later as a message. |
| `study_record_finding` | worker | Outcome, what was learned, when the idea would be worth revisiting, evidence. |
| `study_propose_idea` | worker | Add an idea it noticed but won't pursue. The strategist triages it. |
| `study_request_profile` | worker | Profile `best` or its own candidate on the bench host. This uses bench time and counts against the budget. |
| `study_finish` | worker | End the assignment. |
| `study_propose` | creator | Submit a spec and oracle for validation and approval. |
| `study_queue_ideas` | strategist | Add or reorder ideas, each with a rationale, theme, and optional starting ref. |
| `study_retire_idea` | strategist | Close a direction, with a reason. |
| `study_update_dossier` | strategist | Replace the dossier. |
| `study_search_findings` | strategist | Search findings and candidates by text, theme, or verdict. |
| `study_propose_harvest` | strategist | Propose how to group promotions into changesets. |

Every agent tool carries the `study_` prefix so it can't collide with another plugin's tools. No agent has a keep, discard, or promote tool. Concurrency, budget, the oracle, and pausing are human controls.

The tool set depends on the role. `bb.agents.configure` selects tools from the thread's metadata, and then the plugin checks the role again against its own `threads` table on every call. Thread metadata can be written by the thread's own agent, so it can't be the only check.

## Git model

| Ref | Contents |
|---|---|
| `studies/<slug>/best` | Branch. Linear. The first commit is the segment base. Each later commit is one promoted idea, squashed, with a message carrying the idea title, effect, CI, and candidate id. |
| `refs/studies/<slug>/c/<n>` | Every submitted candidate, win or lose. |
| `refs/studies/<slug>/segment/<k>` | The baseline commit of each oracle segment. |
| `studies/<slug>/w/<n>` | Each worker's worktree branch. Deleted when the worker is archived. |

- Workers' managed worktrees share the project's object store on the edit host, so candidates are visible locally without pushing.
- A remote bench host keeps its own clone of the project. Candidates reach it as a `git bundle` covering `best..candidate`, sent through host RPC. That's small for typical diffs and well under the 32 MiB input limit.
- **Nothing is pushed to origin before harvest.**
- **Commit identity.** The plugin's commits in the repository (worker snapshots, prepared candidates, promotions, harvest commits) are authored and committed as `[git] identity` says. `"repo"` (the default) is the identity git resolves in the repository on the edit host (`user.name` and `user.email`, repo-local config first, then global), so a work repo carries the user's work identity; with none configured the plugin falls back to `autoresearch <autoresearch@bb.local>` and says so in the calibration report and a notice. `"plugin"` always uses that identity. The server resolves it on the edit host and passes it explicitly to every commit, so bench clones, which only receive commits as bundles, see exactly the edit host's commits. It isn't part of the oracle hash.

## Harvest

Harvest turns base→best into reviewable PRs, and backs each one with a measurement.

1. **Group.** The strategist proposes changesets from the promotion commits on `best`, grouped by theme.
2. **Ablate.** For each changeset S, the plugin builds `best` with S reverted and measures it against `best`. The result is S's contribution with a CI.
   - If reverting S conflicts or breaks gates, something else depends on S. That edge is recorded.
   - If removing S costs nothing, S is dropped, unless it's a simplification the human wants anyway.
3. **Check alone.** The plugin applies each independent changeset to the base and runs gates on it.
4. **Draft PRs.** Independent changesets become one PR each. Dependent changesets become a stack in dependency order. Each PR body includes:
   - what changed and why
   - the contribution measured by ablation
   - the standalone effect
   - linked findings
   - a link to the study

   All PRs start as drafts.
5. **Report.** The plugin exports a Markdown study report: the trajectory, the wins, the notable losses and why they lost, the dossier, and the calibration.

The sum of the measured contributions should roughly equal the total gain. A large gap means the changes interact, and the report says so.

## Human surface

### Study page

A **Studies** nav panel lists every study with its state, what needs the human, best vs. base, and budget spent; its sidebar entry carries a count of what needs the human. The study page is the primary surface: what you see first is the state and what the study is doing now, then **Needs you** (pending approvals, system pauses, drift alarms, a failed calibration, a harvest ready for review), then best vs. base and what is running. The study page has these tabs:

- **Live.** The default tab while the study runs: workers picking up ideas and moving through their phases with their last action, candidate cards moving through tests and the bench to a verdict, each measurement's CI band narrowing to the decision, the bench hosts, the ideas up next in pick order, a feed of what just happened, and one worker's transcript at a time. Read only. The same view opens beside the study thread (see Threads), and any study can be replayed in it from its recorded events.
- **Overview.** Needs you, best vs. base in words with raw values and CI, what's running now, a trajectory chart (every candidate as a mark, best as a step line), secondary metrics and guardrails against their limits, budget, controls (pause, resume, concurrency, harvest, archive), and notices that each name the action they ask for.
- **Ideas.** A board: queued, running, won, lost, abandoned. You can add, reorder, pin, or veto.
- **Candidates.** A filterable table. Each row opens its diff, its measurement's CI band (how the verdict formed), samples, verdict, and worker thread.
- **Findings.** A searchable list.
- **Oracle.** The spec, its version history, calibration reports, and approval of specs and calibrations.
- **Bench.** Machines, queue, health, and drift checks.
- **Harvest.** Proposed changesets, their contributions as shares of the gain, dependencies in words, PR previews, keep/drop for droppable changesets, and publishing the drafted PRs.

Deliberate steps (approving a spec, approving a calibration and starting, publishing, archiving) run from the page behind a confirmation that states exactly what will happen, or from the CLI; both paths are equivalent and audited the same way (see the threat model).

Every number follows one convention: **better is positive, in the metric's own terms** ("74.7% fewer ops (4.0×)", "+74.7%"), with the raw values next to it ("210,802 → 53,300 opcodes"). See "Implementation notes: human interface".

Live updates use `bb.realtime` signals, and the page refetches through `bb.rpc`. The Live view also applies small typed deltas (stage changes, phases, pair progress, verdicts) locally, throttled per study.

### Threads

- The **study thread** is visible, and it's the one place to talk to the study. A header badge shows `run 84 · best −23.4% ±1.1 · 3 workers · queue 2`, and a **Live** button opens the Live view in the thread's right split pane, so the human can watch while talking to the strategist.
- **Worker threads** are hidden and grouped in a thread section per study. The study page links to them. Their header badge shows `routing-p99 · idea #31 · submission 2/3 · queued 4th`.
- Workers aren't children of the study thread. Otherwise child lifecycle notices would start a strategist turn every time a worker exits.

### CLI

```bash
bb study list
bb study show routing-p99
bb study calibrate routing-p99
bb study start|pause|resume routing-p99
bb study ideas add routing-p99 "Precompile header matchers into a trie"
bb study workers routing-p99
bb study harvest routing-p99
bb study archive routing-p99
```

### Notifications

Milestones reach the human as notices: a new best, a stall, a budget threshold, a broken oracle, noise drift, a rate limit, and a harvest that is ready. Each notice shows on the study page and in `bb study show`, marks the study thread unread (without starting a turn), and rides along in the next strategist round. BB gives plugins no push or Slack channel (see the M3 notes).

## Data model

SQLite through `bb.storage.database()`:

| Table | Key columns |
|---|---|
| `studies` | id, slug, project_id, state, spec_version, best_sha, budget, created_at |
| `spec_versions` | study_id, version, spec_toml, oracle_hash, approved_at |
| `segments` | study_id, k, baseline_sha, oracle_hash, noise_floor, mde, eval_seconds |
| `ideas` | id, study_id, title, rationale, theme, source, priority, status, start_ref |
| `threads` | thread_id, study_id, role, idea_id, state, submissions, spawned_at |
| `candidates` | id, study_id, idea_id, thread_id, sha, parent_sha, against_sha, verdict, effect, ci_lo, ci_hi, metrics_json |
| `samples` | candidate_id, pair, side, metric, value, host_id, at |
| `findings` | id, study_id, idea_id, candidate_id, outcome, learned, revisit_if |
| `events` | Append-only audit log of every state change and decision; the Live view and its replay are built on it |

The dossier is stored as a versioned text blob per study. Git refs are the source of truth for code, and SQLite for everything else.

## BB integration map

| Need | BB surface | Stability |
|---|---|---|
| Role-specific agent tools | `bb.agents.registerTool`, `bb.agents.configure` | Public |
| Workers in their own worktrees | `bb.sdk.threads.spawn` with a host environment and managed worktree from a named base branch, `visibility: "hidden"`, `sectionId`, `pluginMetadata`, `providerId`, `model` | Public |
| Deliver verdicts | `bb.sdk.threads.send` with `mode: "auto"` | Public |
| React to idle, failure, rate limits | `thread.idle`, `thread.failed`, `turn.failed` events; `bb.sdk.threads.retry` with `sendAt` | Public |
| Pause a study's threads | `message.dispatch` hook returning `wait`; `recheck` on resume | Experimental |
| Git, gates, builds, benchmarks on machines | `bb.host` entry with `bb.hosts.experimental_client`, host signals for progress | Experimental |
| State | `bb.storage.database()` (SQLite), `bb.storage.kv` | Public |
| Drift checks, sweeps, reconciliation | `bb.background.schedule`, `bb.background.service` | Public |
| UI | `navPanel`, `threadHeader`, `threadPanelAction`; `bb.rpc`, `bb.realtime`; `ThreadChat` (`variant="timeline"`) for a worker's transcript | Public |
| What a worker is doing now (live view) | `experimental_thread.events` and `bb.sdk.threads.events.list` (tool items only) | Experimental |
| CLI | `bb.cli` | Public |
| Study creation and harvest prompts | `skills/study-create`, `skills/study-harvest` | Public |
| Keep the study thread small | `bb.sdk.threads.compact` | Public |
| Clean up workers | `bb.sdk.threads.archive` | Public |

## Failure handling

| Failure | Behavior |
|---|---|
| Bench host offline | The pipeline pauses at the measure step. Workers keep editing until backpressure stops new spawns. The human is notified after a grace period. |
| Host worker restarts mid-measurement | The plugin reconciles from SQLite. The in-flight measurement restarts from scratch, and partial samples are discarded. |
| Plugin reload or server restart | On load, the plugin registers handlers, then reconciles every study: running workers, queued candidates, in-flight host calls. Handlers are idempotent. |
| Gates fail on `best` | The oracle or the environment is broken. The study pauses and the human is notified. |
| Flaky gate | One automatic retry. The flake rate is tracked and shown on the Bench tab. |
| Noise drift | The study pauses after a failed A/A check. The human is notified. |
| Worker stuck or looping | One nudge, then the worker is stopped, the idea marked `abandoned`, and the worktree removed. |
| Provider rate limit | `turn.failed` with a rate-limit category triggers a retry at the window reset. The scheduler lowers `W` while limits are tight. |
| Budget exhausted | No new workers start. Running workers finish their current submission. The study pauses and proposes a harvest. |

## Security and trust

- **Oracle commands are arbitrary code.** Build, gate, and measure run with full trust on edit and bench hosts. Bench hosts should be dedicated machines without credentials beyond what the build needs.
- **Scope is enforced at submission, not at edit time.** Workers can read anything in their worktree, the same as any agent thread, so keep secrets out of the project.
- **Metadata can be forged.** Tool gating checks the plugin's own `threads` table, not only thread metadata.
- **Holdout data never enters agent context.** Workers only see a pass or fail.
- **Nothing leaves the machine before harvest,** and harvest PRs start as drafts.

### Threat model

**What the plugin protects against.** Accidental or casual metric gaming by agents through the tools and context they are given:

- editing the benchmark, tests, or harness: scope check at submission, protected paths hashed into the oracle;
- keeping a regression or a lucky number: the plugin owns every verdict, with paired sequential tests and confirmation runs;
- special-casing the benchmark input: the holdout, whose inputs and numbers never enter agent context (only pass or fail);
- widening their own resources: control RPCs are clamped to the approved spec (concurrency can only go down);
- approving their own oracle: a revised spec from the study thread stays pending until it is approved, the CLI's approval commands refuse a study's own worker and strategist threads, and every approval (in the app or the CLI) names the exact spec version it approves and is audited;
- doing any of this unnoticed: every human control is an append-only `control.*` event with the caller information BB provides and the study agent turns running at that moment, plus a notice (and an unread study thread when an agent turn was running).

**What it cannot protect against on a full-access local machine.** An agent with a shell running as the user can do anything the user can:

- BB gives plugins no caller-thread identity for RPC: the app, the `bb` CLI, and agents are all `client`, so an agent can call the plugin's RPC with `bb plugin rpc call`.
- The CLI's thread id comes from the invoking shell's environment; an agent can drop it and look like the human.
- Plugin forms (`bb.ui.requestInput`) can be answered with `bb thread interactions respond`, so a form is no stronger an approval channel.
- With a `local` bench host, the holdout's files sit on the same disk the agents can read.
- Nothing stops it from editing the plugin's SQLite database or source, or pushing.

**In-app and CLI approval are equivalent.** Approving a spec, approving a calibration and starting, and publishing a harvest can be done on the Studies page (RPC with an explicit `confirm: true`, sent only from a dialog that states what will happen) or with the CLI. Neither path is stronger: BB cannot tell an agent from a human on any of them (RPC callers are all `client`, the CLI's thread id comes from the shell, forms can be answered from a shell), so a CLI-only rule only made the human's path longer. What makes approval trustworthy is the same on both paths: the action is deliberate (a confirmation, or a typed command), it approves a specific version (a stale page is refused), it is recorded as an append-only `control.*` event with the caller information BB gives and the study agent turns running at that moment, and it raises a notice the human sees on the page.

There, the defenses are detection (the audit trail above) and isolation: a separate bench machine that holds the holdout, and agent permission modes and sandboxes that don't allow arbitrary shell access. A study whose results matter should run its bench on a machine its workers can't reach.

## Budget and cost

- **Limits.** `max_workers`, `max_candidates`, `max_bench_hours`, `deadline`, and `max_tokens` (BB exposes per-thread token usage to plugins; dollar cost is not exposed per thread, see the M3 notes).
- **Cost per evaluation.** Calibration estimates bench time per evaluation up front, so the study page can project spend before Running starts.
- **Where tokens go.** Workers dominate token spend, because each one relearns part of the codebase. The dossier and brief are the main lever. Track tokens per accepted win as the efficiency metric.
- **Cheap rejections.** Scope rejection, rebase conflicts, and gate failures all cost no bench time. Stopping early cuts bench time on clear losers.

## Phasing

### M0: test the main assumption

The main assumption: short-lived workers with good briefs, judged by the plugin, match or beat one long-lived agent on the same token budget.

- [x] Spec import, approval, and A/A calibration on the local host
- [x] Pipeline: snapshot, scope check, gate, paired measurement against `best`, verdict, promotion
- [x] Worker spawn, brief, verdict message, `study_record_finding`, `study_finish`, archive
- [x] Strategist rounds in the study thread from plugin-built digests
- [x] `bb study show` and `bb study ideas add`
- [ ] Head-to-head on a reference benchmark against a serial single-agent loop

**Exit:** equal or better improvement at equal tokens, and a measured false-win rate.

### M1: parallel

- [x] `W > 1` workers, bench queue, backpressure, adaptive `W`
- [x] Rebase on submit, `conflict` verdict handled by the worker
- [x] Sequential testing and confirmation runs
- [x] Diversity and no-repeat rules
- [x] Study page v1: Overview, Ideas, Candidates
- [ ] Exit criterion on a real workload (the toy smoke tests are too short to show it; see the M1 notes)

**Exit:** bench busy more than 80% of Running time. Time to target clearly below M0 at similar tokens per win.

### M2: remote bench and trust

- [x] Bench hosts through `bb.host`, `git bundle` transfer, cached `best` builds
- [x] Machine health checks, drift checks, holdout, guardrails
- [x] Oracle versioning and segments
- [ ] Exit criterion: not run, because only one BB machine exists (see the M2 notes)

**Exit:** a study runs a full day on a remote x86 bench host without a human stepping in.

### M3: harvest and operations

- [x] Ablation, dependency detection, draft PRs and stacks, study report
- [x] Budgets, usage-window awareness, notifications
- [x] Findings, Oracle, Bench, and Harvest tabs
- [ ] Exit criterion on a real workload (met on a toy; see the M3 notes)

**Exit:** a harvested PR set where measured contributions add up to the total gain within the CI.

## How we know it works

| Measure | Target |
|---|---|
| Time to a target improvement vs. a serial single-agent loop on the same benchmark | Clearly lower from M1 |
| Tokens per accepted win | Equal or lower than the serial loop |
| False-win rate: promotions that fail a later independent measurement | Below 5% |
| Bench utilization while Running | Above 80% |
| Harvest accuracy: sum of ablation contributions vs. total gain | Within the CI |
| Human interventions per day of Running | Trending to zero apart from steering |

## Alternatives considered

1. **One long-lived agent, re-prompted when idle.** Rejected. The agent owns its verdicts, its context grows without limit, and it can't run in parallel.
2. **An LLM director that spawns delegates.** Rejected for control flow. Scheduling, retries, and budgets expressed as prompts are fragile and cost tokens at every step. LLM judgment stays where it pays off, in the strategist.
3. **Spec and oracle as files in the repo.** They'd be reviewed with the code. But they'd sit within the workers' reach and show up in diffs. Chosen instead: plugin storage, plus `protected` paths for any harness code in the repo.
4. **Agents run the benchmark themselves.** Rejected. Parallel workers would compete for the machine, the hardware would be wrong, and the numbers couldn't be verified.
5. **A dedicated merge worker for rebase conflicts.** Deferred. The submitting worker already has the context to resolve its own conflict.
6. **Workers as child threads of the study thread.** Rejected. Child lifecycle notices would start a strategist turn on every worker exit. Thread sections and metadata group them instead.

## Open questions

1. ~~Can plugins read per-thread token or cost usage?~~ Answered in M3: tokens yes (the thread's `thread/tokenUsage/updated` events, read with `bb.sdk.threads.events.list`), dollars no. `budget.max_tokens` and tokens per win are built on it.
2. ~~What notification channel should be the default?~~ Answered in M3: study-thread attention is the only channel. The SDK has no push, notification, or Slack API for plugins; `bb.sdk.system.attention()` only reads the global "needs attention" flag.
3. ~~What are the host RPC limits for long calls?~~ Answered in M2: a call is capped at 30 minutes, input at 32 MiB and output at 8 MiB. Long commands run as host background jobs polled in short calls, cancelled through `jobCancel`, with progress through host signals (see the M2 notes).
4. Do hidden threads count against concurrency limits? Is a link from the study page enough for users to find them?
5. Is `threads.compact` enough for the study thread, or should the plugin replace it with a fresh thread that starts from a digest?
6. Does mixing providers across workers improve idea diversity enough to justify the setup? Test this in M1.
7. Where should gates run by default: the edit host (parallel, no extra machine) or a separate gate pool (keeps laptops quiet)?
8. For `expensive` oracles, what's the right number of confirmation runs, given that a single evaluation can take an hour? M2 chose k = 3 with Student-t thresholds (simulated: 1.4% false wins, 71% of 3σ effects found, 1.15 runs per no-effect candidate). Revisit with real long-running benchmarks.

## Implementation notes

What M0 built, and every place it differs from the design above. Checked against BB 0.45.0 and `@get-bb/plugin-sdk` 0.6.14.

### Platform

- **SDK pin.** `bb plugin types` selects 0.6.15, which is not published to npm. The plugin pins 0.6.14, the newest published version (`engines.bbPluginSdk: ">=0.6.14"`). Every API used exists in both.
- **Host RPC is the only path to the machine.** Git, gates, builds and measurements run through the `bb.host` entry (`host.ts`) via `bb.hosts.experimental_client`, targeting `bb.sdk.system.config().primaryHostId`. The server never touches the repo with `child_process`. The same ops also run in-process behind the `HostRunner` interface (`LocalHostRunner`), which the tests use. M2 adds remote bench hosts by pointing a `HostRunner` at another host id.
- **Call duration.** A host call is capped at 30 minutes, so one `build`, `gate` or `measure` command is capped at 29 (`oracle.timeout_minutes`, default 20). A paired measurement is many calls, so a whole evaluation can run longer. Benchmarks that need more than 29 minutes per run need a background job on the host that reports through signals (open question 3, M2). *(M2: built as host jobs; see the M2 notes.)*
- **Repo location.** The study's repo is the project's checkout on the server's machine (`projects.get().sources`). Projects without one are refused in M0.

### Git model

- **One commit per candidate, built without a checkout.** `prepareCandidate` applies the worker's changes since its fork point onto the current `best` with `git merge-tree --write-tree` and `git commit-tree`. The result is a single commit whose parent is `best`: it is both the rebase (step 3) and the squash (step 8). Gates and measurements run on that commit, and promotion re-messages it and compare-and-swaps `studies/<slug>/best` onto it. A failed merge is the `conflict` verdict. This needs git 2.38 or newer.
- **Plugin-owned checkouts.** Gates and measurements run in detached worktrees under the host bundle's data directory (`<slug>-gate`, `<slug>-best`, `<slug>-cand`), never in the worker's worktree. `bb study archive` removes them.
- **Worker branches.** BB's managed-worktree provider names the worker's branch itself (for example `<user>/<slug>-idea-1-…-thr_x`). The spawn API takes only a base branch, so `studies/<slug>/w/<n>` isn't used. When a worker ends, the plugin archives and stops the thread, deletes its environment once no live thread uses it (`environments.delete`, instead of waiting for core's retirement grace period), and deletes the branch. Candidate refs keep the commits.
- **Starting from a candidate.** An idea with `start_ref = "c/12"` gets a branch `studies/<slug>/start/<idea>` at that candidate. Its fork point is the candidate's own fork point, so its changes carry forward onto the current `best`.

### Pipeline and statistics

- **Snapshot and scope run inside `study_submit_candidate`.** Both are fast, so the tool call does them. A scope rejection comes back as the tool result instead of a later message. Everything after that (rebase, gate, measure, verdict, promotion) is asynchronous, and the verdict arrives through `threads.send({ mode: "auto" })`.
- **Stages are persisted.** Candidates move through `submitted → gating → queued → measuring → confirming → promoting → decided`, and `reported_at` records delivery. Each stage reruns safely. A host error is retried on later passes. After three failures the study pauses (system pause, human notified) and the candidate stays parked until `resume`.
- **Flaky gates.** A failed gate command runs once more. A pass on the retry is recorded as a `gate.flaky` event.
- **MDE definition.** Calibration runs `calibration_pairs` A/A pairs. The MDE is `max(min_effect, q)`, where `q` is the `confidence` quantile of |median| over bootstrap resamples of `n_max` centered A/A differences: the effect A/A noise alone can fake at `n_max` pairs. A win needs the CI lower bound above the MDE, so the report also gives "detectable", which is MDE plus that half-width. Calibration fails, and the study returns to Draft, when the MDE is above `max_mde` or the A/A CI excludes zero (the two checkouts aren't equivalent).
- **Confirmation.** For `noisy`, a win is measured again with a full fresh sequential test, which must also be a win. Otherwise the verdict becomes `inconclusive` or `lose`, with the reason attached. The holdout check is M2.
- **Deterministic class.** Best is run once per promotion and cached. A candidate within ± tolerance is `inconclusive`, not `lose`.
- **Expensive class** is minimal: calibration takes 3 baseline runs, a candidate gets 1 run, and a run that clears the MDE is confirmed with `confirm_runs` more.
- **Guardrails** take a `direction` field (default `lower`), because "regression" means opposite things for memory and for throughput.
- **A broken oracle pauses the study.** If best fails to build or to measure, the study pauses. If the candidate does, its verdict is `gate_failed`.

### Agents

- **Role gating.** `bb.agents.configure` is synchronous, and so is better-sqlite3, so `configure` checks both the metadata and the `threads` table. Worker metadata selects worker tools only when it matches a live worker row (by thread id, or by `spawnToken` while the spawn call is still in flight). Strategists are known only by their row. A thread with no row gets `study_propose` and the two skills. Every tool call checks the role against the table again. Forged metadata gets no tools.
- **`threads` has a surrogate id and a `spawn_token`.** The thread id isn't known until `threads.spawn` returns, and `configure` (or a fast first tool call) can run before that. The token in the worker's metadata ties the thread to its row. Reconciliation uses it to adopt or fail spawns that were interrupted.
- **Strategist tools need a fresh session.** Tool sets apply when a provider session starts. The study thread is created as an ordinary thread, so `bb study start` stops its runtime (when idle) and the first strategist round opens a new session that has the strategist tools. The smoke test confirmed this.
- **Human-message trigger.** BB has no "a human sent a message" event. A `thread.active` on the study thread that the plugin didn't cause counts as the human trigger. If there are new verdicts or findings, the digest is sent with `mode: "auto"`, which steers it into the human's turn. Plugin-sent notifications (calibration results, system pauses) count as rounds so they don't look like human messages. *(M1: notifications no longer start turns; see Notices below.)*
- **Round triggers** are K verdicts (`agents.strategist_every`), queue low (fewer ready ideas than W, only after something changed, so an unproductive round doesn't loop), stall (`agents.stall_after` verdicts without a win, once per window), the human, and a first round at start.
- **Idle handling.** Idle time starts at `thread.idle` and doesn't count while a verdict is pending. One nudge comes after `idle_nudge_minutes`. A worker still idle at `idle_abandon_minutes` is stopped and archived, and its idea is marked `abandoned`. A new submission clears the nudge.
- **Rate limits.** `turn.failed` with category `rate-limit` is retried at the window reset plus 15 s, up to 3 times.
- **Permission mode.** `[agents].worker.permission_mode` is passed to the spawn call. When it's absent, the project default applies. A hidden worker that asks for approval stalls until the idle timeout.
- **`study_request_profile`** runs the optional `oracle.profile` command inside the tool call, holding the bench lock, and adds the time to the bench budget.
- **`study_propose_harvest`** only records the proposal (M3).

### Human surface

- **No frontend.** The Study page, Studies nav panel, and header badges are deferred (M1/M3). The CLI is the M0 surface. *(M1: the Studies panel, study page v1, and the header badge exist; see M1 below.)*
- **Approval is in the CLI.** `bb study calibrate` approves the current spec version and calibrates. `bb study start` approves the calibration. Also built: `list`, `show`, `pause`, `resume`, `ideas add`, `ideas list`, `workers`, and `archive`. `harvest` prints a placeholder. Human controls are refused when they come from a study's own worker or strategist thread. The strategist may run `ideas add`.
- **Pause** stops new spawns. In-flight candidates finish and running workers keep their submission. Holding worker messages with the experimental `message.dispatch` hook isn't used.

### Data model

- All design tables exist, with implementation columns added (pipeline stage, attempts, prepared/promoted shas, round bookkeeping, cached best run). There are two extra tables: `dossiers` (versioned text) and `harvest_proposals`. `events` is append-only, enforced by triggers.
- Studies use state names `draft | calibrating | running | paused | harvesting | archived` and calibration status `running | ready | failed`. `harvesting` is unused in M0.

### Spec additions

`scope.max_files` and `scope.max_lines`; `oracle.profile`, `oracle.timeout_minutes`, and `oracle.protocol.{warmup, n_min, n_max, confidence, min_effect, max_mde, tolerance, confirm, confirm_runs, calibration_pairs, bootstrap}`; `guardrail.direction`; `agents.{strategist,worker}.permission_mode`, `agents.strategist_every`, `agents.stall_after`, and `agents.idle_nudge_minutes`/`idle_abandon_minutes`. Unknown keys are rejected. `oracle.bench_hosts` must be empty or `["local"]` until M2. `oracle.holdout` is accepted but not evaluated yet. `budget.max_workers > 1` is accepted, but M0 runs W = 1 (`EngineConfig.workerCeiling`). *(M1: W > 1 runs; `workerCeiling` is now only an emergency cap, default 64.)*

### Not in M0

The serial-loop head-to-head; W > 1, backpressure, and adaptive W (the `targetWorkers` formula exists but is capped at 1); drift checks; holdout; oracle segments after start (re-calibrating before the first candidate keeps segment 1); remote bench hosts and git bundles; harvest and ablation; token budgets; and the UI.

## Implementation notes: M1

What M1 added, and every place it differs from the design or from M0. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Concurrency

- **Pipeline jobs.** The M0 pump ran stages one after another. M1's `Pipeline.launch()` starts one job per candidate with work and re-runs whenever a job ends. There are three kinds of job:
  - gates run in parallel, at most the study's effective `max_workers` at once, each in its own checkout slot (`<slug>-gate-<k>`), and never take the bench lock;
  - measurement runs as one job per bench lock key (the bench host for `noisy` and `expensive`, host plus study for `deterministic`), oldest `queued_at` first across studies;
  - verdict reports retry every 30 s when delivery fails.
- **A rebased candidate keeps its place in the queue.** A candidate sent back to gating because best moved keeps its original `queued_at`.
- **Submissions are serialized per study.** This keeps candidate numbers dense and unique. Promotions are serialized per study by a mutex, and promotion still compare-and-swaps `studies/<slug>/best`.
- **Retries back off.** Host errors are retried after `retryDelayMs × attempts` (15 s by default) instead of immediately. If best fails to build or measure, the candidate is parked (attempts set to the limit) until the human resumes. Before this, a paused study could retry a broken oracle in a loop.
- **Bench intervals.** Every span the bench lock is held (measurement, profile, calibration) is a row in `bench_intervals`. Utilization, the overlap audit, and the Bench numbers on the page come from it. Reconciliation closes intervals left open by a crash.

### Scheduling

- **Adaptive W.** `W = min(max_workers, ceil(T_think / T_eval) + 1)`:
  - `T_think` is the mean time from a worker's spawn, or from the delivery of its previous verdict, to each submission, over the last 20 submissions.
  - `T_eval` is the mean bench seconds of the last 20 measured candidates. Until one exists, it's the calibration estimate.
  - With no submissions yet, `W = max_workers`.
  - Each change of W is a `scheduler.target` event, and the value is stored on the study.
  - The human can override `max_workers` with `bb study concurrency <slug> <n|auto>` or the page's concurrency control.
  - Lowering W during provider rate limits isn't built.
- **Backpressure.** The bench queue depth counts candidates in `gating`, `queued`, `measuring`, or `confirming`. No worker spawns while that depth is at least W.
- **Budget reservation.** Each live worker reserves one submission against `max_candidates`, so the study never spawns a worker that has no budget left to submit. A submission past the budget is refused.
- **Spawning fills slots.** One control-loop pass spawns up to `W - live` workers. A kick during a pass schedules another pass (M0 dropped it).
- **(a) Finishing race.** Finishing workers count as live, so a new worker never starts while the previous one is still wrapping up. A worker whose turn doesn't end within `finishingTimeoutMs` (3 min) of `study_finish` is stopped and archived.
- **Diversity.** At most `ceil(W / 2)` workers run one theme at a time. This is also checked at W = 1, where it makes no difference.
- **No repeats.** Ideas now have `variation_of` and `lineage`, where the lineage is the root idea of a chain of variations.
  - A non-human idea whose normalized title matches a lost idea is skipped, unless it's an explicit variation.
  - `study_queue_ideas` returns "Skipped: … repeats lost idea #N; queue it with variation_of=N" for such ideas instead of queueing them.
  - An idea with `start_ref = "c/N"` is automatically a variation of candidate N's idea. The ref must name an existing candidate.
  - Human ideas are exempt, because the human steers.
  - Lost and abandoned ideas never go back to `queued`.
- **Human idea controls.** The Ideas board can add ideas (with theme, rationale, and start ref), reorder them (written as priorities 100, 99, …), pin or unpin them, and veto them. A veto retires the idea with the reason "vetoed by the human".

### Rebase, conflict, and promotion

- **Rebase on submit** is the M0 `git merge-tree` preparation at gate time onto the current best. If best moved while a candidate was queued, the measure step sends it back to be prepared and gated again. This is recorded as `candidate.rebased` with the old and new best.
- **Fork point.** The snapshot now computes the fork point as `merge-base(HEAD, best)`. A worker that rebased by hand after a `conflict` is diffed, scope-checked, and prepared against the new best, not its original fork. The worker's `fork_sha` moves with it.
- **Conflict counting (decision).** A `conflict` is refunded: it doesn't count against `max_submissions_per_worker`, up to `CONFLICT_REFUNDS = 2` per worker. After that, conflicts count. The verdict says which case applies and tells the worker to `git rebase studies/<slug>/best`, resolve, and resubmit. In both smoke-test conflicts, the worker read the verdict, saw that its idea was already in best, recorded a `no_effect` finding, and finished. That's a legitimate resolution.
- **Best moves mid-measurement (decision).** A candidate is measured against the best at the start of its measurement, and `against_sha` records which one.
  - If the result is a **win** and best has moved by the time the measurement ends, the candidate is prepared, gated, and measured again against the new best before it can be promoted.
  - **Non-wins stand** against the best they were measured on. Re-measuring likely losers would cost bench time for nothing.
  - A compare-and-swap failure at promotion also sends the candidate back to be measured again (`best branch moved … during promotion`). M0 threw an error here.
  - With one bench host per study this can't happen in M1. It's built for M2's multiple bench hosts, and tests simulate it.
- **Confirmation.** Confirmation runs in the same bench session against the same best.

### Notifications (fix b)

- **No push without a turn.** The SDK can't post a message into a thread without starting or steering a turn: `threads.send` modes are `start`, `steer`, `auto`, and the queue variants.
- **Notices instead.** Milestones (calibration ready or failed, system pauses including budget exhaustion) are rows in `notices`:
  - shown on the study page and in `bb study show`, and counted on the Studies list;
  - the study thread is marked unread with `threads.markUnread`;
  - the text rides along in the next strategist round under "Notices for the human".
- **Before Running.** There are no rounds yet, so undelivered notices are steered into the human's own next turn in the study thread. This is how the creating agent hears about calibration results.
- **Best moved.** Workers are told without new turns:
  - a worker mid-turn, with no candidate pending, gets the notice steered into that turn;
  - any other worker gets it prepended to the next plugin message it receives (verdict or submission ticket).
  - `worker.notified` records which path was taken.

### Other fixes

- **(c) Bench time.** Budget lines and reports format durations as s, min, or h, so short runs no longer show 0.00 h.
- **(d) Tool prefix.** Every agent tool is prefixed: `study_submit_candidate`, `study_record_finding`, `study_propose_idea`, `study_request_profile`, `study_finish`, `study_queue_ideas`, `study_retire_idea`, `study_update_dossier`, `study_search_findings`, `study_propose_harvest`, and `study_propose`.
- **Worktree cleanup.** A worker that never submitted had no environment id recorded, because the spawn response can omit it while the worktree is provisioning. Its worktree was left for core's retirement. `endWorker` now looks the environment up from the thread before archiving.
- **Spec warning.** The "max_workers > 1 runs W = 1" warning is gone.

### Human surface

- **Studies nav panel** (`navPanel`, path `studies`). It lists studies with state, best vs. base, budget spent, workers, queue, and new notices. A study page lives at `studies/<slug>[/<tab>[/<n>]]`.
  - **Overview:** the trajectory chart (SVG; every measured candidate is a dot at its position relative to base, and best is a step line); best vs. base with an approximate CI (the promoted candidates' CI bounds, compounded); state and pause reason; budget; W, think and eval times; bench utilization; controls (pause, resume, concurrency, open study thread); live workers with their phase and queue position; the bench queue; notices; and recent events.
  - **Ideas:** the board (queued, running, won, lost, abandoned or vetoed) with add, reorder, pin, and veto.
  - **Candidates:** a table filterable by verdict, stage, and text. A row opens the verdict and reasons, the summary, samples per pair, gate output, diagnostics, and a diff summary. The diff comes from the new `diffSummary` host op, rendered per file with `experimental_Diff`. There's a link to the worker thread.
  - The Findings, Oracle, Bench, and Harvest tabs are still M3.
- **Thread header badge** (`experimental_threadHeaderAction`). On the study thread it reads `run N · best −x% ±y · W workers · queue Q`, prefixed with the state when not running. On a worker thread it reads `<slug> · idea #N · submission k/max · <phase>`, where the phase is working, gating, queued Nth, measuring, or confirming. Clicking it opens the study page. Other threads render nothing.
- **Data plane.** The page reads everything through `bb.rpc`: `studies.list`, `study.overview`, `study.ideas`, `study.candidates`, `study.candidate`, and `thread.badge`. It writes through `study.pause`, `study.resume`, `study.concurrency`, `ideas.add`, `ideas.update`, `ideas.reorder`, and `ideas.veto`. It refetches on the `study-changed` realtime signal (debounced), on reconnect, and on a 5 s poll. The plugin publishes that signal at every stage change.
- **Branding.** The plugin ships its flask glyph (`assets/flask.svg`), registered as the app icon `autoresearch-flask`.
- **Security gap.** RPC writes refuse other plugins as callers (`experimental_caller.kind === "plugin"`). The RPC context doesn't say which thread called, though, so an agent could still call them through `bb plugin rpc call`. They're bounded human controls (pause, resume, concurrency, the idea board), not verdicts or promotion. Closing this gap needs caller-thread identity from BB.
- **CLI.** New: `bb study concurrency`, and `ideas add --start-ref --variation-of`. `show` adds a Scheduler line (W, queue, think, eval), a Bench line (utilization and overlaps), and notices.

### Data model

M1's migrations are append-only:

- `candidates`: `queued_at`, `lines_added`, `lines_deleted`, `rebases`;
- `threads`: `conflict_refunds`, `pending_notice`, `finishing_at`;
- `ideas`: `variation_of`, `lineage`;
- `studies`: `max_workers_override`, `target_workers`, `running_since`, `running_seconds`;
- new tables `bench_intervals` and `notices`.

New events: `measure.started` and `measure.finished`, `candidate.rebased`, `scheduler.target`, `worker.notified`, `study.concurrency`, `notice.added`, and `idea.pinned`.

### Smoke test (BB 0.45, local host, toy repo under /tmp)

Three studies ran on one toy Python pipeline with a `noisy` metric. All had `max_workers = 3`, `max_candidates = 6`, and 2 submissions per worker, and all used the default agent provider.

| Study | Shape | Peak concurrent workers | Mean think | Mean eval | W | Bench busy / Running | Since first submission | Overlapping measurements | Rebases / conflicts |
|---|---|---|---|---|---|---|---|---|---|
| `toy-m1` | eval ≈ think, and eval collapses as wins land | 3 | 22 s | 18 s | 3 → 2 | 53% | 67% | 0 of 9 | 3 / 0 |
| `toy-m1b` | untimed setup keeps eval expensive | 3 | 17 s | 36 s | 3 → 2 | 74% (81% mid-run) | 85% | 0 of 9 | 3 / 1 |
| `toy-m1c` | think > eval | 3 | 18 s | 5 s | 3 | 21% | 28% | 0 of 7 | 1 / 1 |

- **No overlaps.** Measurements never overlapped (`bench_intervals` self-join). Every sample's timestamp fell inside its own candidate's measurement interval.
- **No notification turns.** No notification started a turn: the study threads went unread, and the notices arrived in the next round.
- **Live in the app.** The study page and the badge rendered in the BB app (checked with in-app browser screenshots).
- **What the numbers say.** Utilization follows the formula. When eval takes longer than think, the bench saturates (85% in steady state). When think takes longer than eval, W wants `ceil(18/5) + 1 = 5`, the cap of 3 starves the bench, and utilization drops to 21%. Short studies also pay for the first think period while the bench sits idle. Meeting the > 80% exit criterion on a real workload needs `max_workers` at least `T_think / T_eval + 1`, and a study long enough to amortize the start. That claim isn't proven yet.
- **Agents were fast.** Workers on this toy thought for only 17–22 s and mostly finished after one submission.

### Not in M1

- **Exit criterion and head-to-head.** The M1 exit criterion on a real benchmark, and the M0-vs-M1 time-to-target comparison.
- **Rate limits.** Lowering W while provider rate limits are tight.
- **Mixed providers.** Mixing providers across workers (open question 6).
- **Tabs.** The Findings, Oracle, Bench, and Harvest tabs.
- **Remote bench hosts.** Remote bench hosts and everything else in M2 (the `HostRunner` seam and per-key bench queues are ready for them).

## Implementation notes: M2

What M2 added, and every place it differs from the design or from M1. Same platform pins (BB 0.45.x, SDK 0.6.14). Only one BB machine existed while building it, so remote bench hosts are exercised for real against the local machine in clone mode (below), and with fake hosts in unit tests.

### Bench hosts

- **Two modes, chosen by the spec entry.**
  - `"local"` (or an empty list) is the M1 path: plugin checkouts of the project repo on the edit host, no transfer.
  - Any other entry is a BB machine name or host id, resolved against `bb.sdk.hosts.list()` when `study_propose` runs. Unknown or ambiguous names are spec errors that list the known machines. That machine gets **clone mode**, even when it is the server's own machine: this is how the live smoke test took the full remote path.
  - The resolved list is stored per spec version (`spec_versions.bench_json`) and becomes the study's `bench_hosts` rows when that version is approved.
- **Edit host.** Workers, snapshots, gates, and promotion refs stay on the server's machine. Remote edit hosts aren't built.
- **Bench clone.** Each clone-mode host keeps a bare clone per study at `<dataDir>/bench/<slug>/repo.git`, where `dataDir` is the host entry's `experimental_paths.dataDir` (on the test machine, `~/.bb/plugins/bb-autoresearch/host-data/`). Measurement checkouts are worktrees of that clone, `<dataDir>/checkouts/<slug>-bench-{best,cand,drift,profile}`. Every received commit is pinned as `refs/bench/s/<sha>`, and `gc.auto` is off. `bb study archive` cancels the study's jobs, removes the checkouts, and deletes the clone.
- **Per-study clone (decision).** A clone per project would save bootstrap transfers across studies, but a per-study clone can be deleted safely when the study is archived.

### Transfer

- **What a bundle carries.** The edit host bundles the commit minus everything reachable from the bench's pinned tips (newest 4,096) into a temp file. The server relays it in chunks of 4 MiB raw (5.33 MiB base64): under the 8 MiB output cap on `bundleRead` and far under the 32 MiB input cap on `bundleWrite`. The bench checks the sha256, runs `git bundle verify`, fetches, and pins the commit.
- **Size limit.** A bundle above `oracle.max_bundle_mib` (default 256) fails before any chunk moves. For a candidate that's verdict `rejected`, with the size and limit in the reason. For best or the baseline it's a system pause. Failed transfers are recorded too.
- **Bootstrap by bundle (decision).** The first transfer carries the baseline's full history, instead of a `git clone` from origin. That works for repos without a remote and keeps "nothing leaves the machine". A very large repo needs a larger `max_bundle_mib` (open issue below).
- **Promotion.** The promoted commit has the same tree as the measured candidate, so refreshing best on a bench host is a one-commit bundle.
- **Audit.** Every transfer is a row in `transfers` (bytes, chunks, ms) and a `bench.transfer` event. `bb study bench` lists them.

### Long commands, progress, cancellation

- **Host jobs.** Build, gate, each measure run, holdout, and profile run as host background jobs:
  - `jobStart` returns at once.
  - `jobWait` blocks at most 60 s; the server polls every 20 s with a 30 s call timeout.
  - `jobCancel` kills the process group.
  - A running job holds an `experimental_retainWorker` lease, so the host worker's idle stop doesn't kill it.
  - No host call comes near the 30-minute cap. `oracle.timeout_minutes` is per command and may now go up to 1,440.
- **Progress.** A job's last output line goes to the server as a `progress` host signal, at most every 5 s, and also comes back with each poll. The pipeline adds the pair and side, and the Overview shows them on the bench host's row.
- **Cancellation.** Every measurement has an AbortController. Cancelling it cancels the current host job. Three things cancel measurements:
  - an oracle change (the candidate is sent back to the gate);
  - archiving the study;
  - a host worker exit (the measurement restarts).

### Dispatch, caches, calibration

- **Dispatch.** Queued candidates are sorted oldest first. Each goes to the first of its study's bench hosts (in spec order) that is free, online, and not deferred. Each host has its own bench lock, so hosts measure in parallel, one measurement per host.
- **Calibration on every host.** Calibration runs on all bench hosts in parallel. Each host records its own noise floor, MDE, and eval cost. The segment takes the worst host (decision: a win must clear every host's noise), and drift checks compare a host against its own floor.
- **Calibration checks.** Calibration on an unhealthy host fails calibration (decision: a noise floor measured on a disturbed machine is wrong). With a holdout configured, calibration also runs the holdout once per host to check that it works there.
- **Cached best builds.** Each bench host caches its build of best, recorded as `best_build_sha` plus the checkout path in memory. While the cache is valid the checkout isn't touched, so untracked build outputs survive.
  - Every promotion invalidates it on all hosts (`bench.cache_invalidated`).
  - So does reconciliation: a new process doesn't trust the old one's checkouts.

### Health checks

- **When.** The `health` host op runs before every measurement, drift check, calibration, and profile.
- **What it reports.**
  - Load averages.
  - The busiest processes: on Linux from two `/proc` samples 500 ms apart, because `ps` gives lifetime averages there; on macOS from `ps`. Only the host worker itself is excluded: gates on the same machine are real competing load.
  - Linux: the CPU governor, and turbo from `intel_pstate/no_turbo` or `cpufreq/boost`.
  - macOS: AC or battery power, and the pmset CPU speed limit.
  - What the platform can't report is listed as not detectable (on macOS: governor, turbo, and on Apple Silicon the speed limit), not guessed.
- **Policy.** `[oracle.health]` sets per-CPU load, competing-process CPU, an optional required governor, turbo off, AC power, and the CPU speed limit.
- **Deferral.** A failing check leaves the candidate queued in its place. The host waits `retry_seconds` (60). A notice goes out once per unhealthy streak, after `notify_after_minutes` (15).
- **Where it shows.** `bb study show` and `bb study bench` show the last report per host, and `health_checks` keeps the history.

### Drift checks

- **Engine-timed, not a cron schedule (decision).** The design asks for a check every N evaluations, and a `bb.background.schedule` cron can't count evaluations.
- **When.** Every `oracle.drift.every` evaluations per host (default 10, 0 turns it off), the host's next free slot runs an A/A check on best. A drift check takes priority over queued candidates.
- **noisy.** `pairs` pairs of best against a second built checkout of best. The statistic is the robust SD of the paired differences, the same statistic as the calibrated noise floor.
- **expensive.** `pairs` runs of best, compared with the host's baseline as the RMS relative deviation.
- **deterministic.** No drift checks.
- **Result.** Above `max_ratio` (2) × the calibrated level, the study pauses with the numbers in the reason. `bb study drift` requests a check now. Drift runs are kept in `drift_checks`, not as samples.
- **Finding from the smoke test.** Relative noise grows when runs get much shorter. After a 99% speedup, the 6 ms best was 4.9× noisier relative to itself than the calibrated 600 ms baseline. The drift check paused the study, and the fix was an oracle change (more pairs) with recalibration on best: exactly the path the design intends.

### Holdout

- **When.** It runs only for wins (after confirmation, for `noisy`), on the bench host, before promotion.
- **Protocol.** `runs` paired best/candidate runs (default 3). It passes when the median paired change is no worse than `max_regression` (default 1%).
- **"No worse", not "better" (decision).** Genuine wins often help the holdout less than the benchmark, and requiring an improvement would fail them on noise.
- **Outcomes.** A fail is a `lose` with a fixed reason text. A holdout that fails on best itself means the oracle is broken: the study pauses, and the reason carries no output.
- **Secrecy.**
  - The numbers go only to the private `holdout_results` table.
  - The holdout's output is never stored: no samples, DIAG lines, gate output, or progress lines.
  - Verdicts, events, notices, views, and RPC carry only pass or fail.
  - `bb study show` prints "holdout: configured (hidden from agents)", and no view exposes the spec TOML.
  - A test checks every agent-reachable surface for the holdout's numbers, command, and DIAG text.
- **Limits.** The creating agent drafts the spec, so it knows the command. A `local` bench host's holdout files are readable by agents on that machine (see the threat model).

### Guardrails

- **Already enforced since M0.** Guardrails relative to best were enforced in `decideVerdict` for all three noise classes, and inside confirmation: per-pair medians for `noisy`, and the candidate's median against the baseline's for `expensive`.
- **M2 completes them.** The verdict message now carries the deltas, for example "Guardrails vs best: precision_digits 0.20% worse (limit 5.00% worse) ok", or BROKEN. There's a pipeline-level test of a primary-metric win turned into a `lose` by a guardrail.

### Expensive class

- **Calibration.** `calibration_runs` (default 5) baseline runs give σ: the sample SD of the runs around their median.
- **Screening.** Each candidate gets one screening run against the median of the host's m baseline runs. It is promising above max(min_effect, t·σ·√(1 + 1/m)), and a lose below the negative of that.
- **Confirmation.** A promising run gets k = `confirm_runs` (default 3) fresh runs. The screening run is excluded from the decision, because it was selected for looking good. A win needs the k-run mean above max(min_effect, t·σ·√(1/k + 1/m)).
- **t, not z (decision).** t is the one-sided Student-t quantile with `calibration_runs − 1` degrees of freedom. σ comes from a handful of runs, and a normal quantile with a robust σ gave 5.3% false wins in simulation.
- **Simulation** (σ estimated from 5 runs, 4,000 candidates per effect size):

  | True effect | Win rate | Candidate runs per evaluation |
  |---|---|---|
  | 0 | 1.4% | 1.15 |
  | 1σ | 11.5% | 1.57 |
  | 2σ | 39.3% | 2.33 |
  | 3σ | 71.4% | 3.18 |
  | 4σ | 91.6% | 3.75 |

- **Baselines.** The winner's k confirmation runs become the new best's baseline on that host, so a promotion costs no extra baseline run. Another host with no baseline for the new best runs best once.

### Oracle versions and segments

- **The oracle hash** covers the metric, the guardrails, the oracle (commands, protocol, noise class, bench hosts, holdout, timeout) and the protected globs, plus the content hash of the protected paths at the segment baseline.
- **Bench operations aren't part of it (decision).** `[oracle.health]`, `[oracle.drift]`, `max_bundle_mib`, and `offline_grace_minutes` don't change how a commit is judged, so tuning them is not a new segment.
- **A spec revised after the study has run** (`study_propose` from the study thread) is **pending**. The study keeps running on the active spec, and a notice says which approval applies:
  - **Oracle unchanged:** `bb study approve <slug>` applies it in place.
  - **Oracle changed:** `bb study calibrate <slug>` (lifecycle Running → Calibrating) does the following:
    - cancels in-flight measurements;
    - sends queued candidates back to the gate, keeping their queue position;
    - activates the spec;
    - calibrates on the current best on every bench host.
  - `bb study start` then opens segment k+1, with `segments.spec_version` set and `refs/studies/<slug>/segment/<k+1>` pointing at best.
  - Workers keep editing during recalibration. Their submissions are accepted and wait at the gate.
  - If the new oracle fails calibration, the study goes back to the previous spec and segment and pauses, instead of dropping to Draft.
- **"Has run"** is decided from the append-only state log, not from `running_seconds`, which a fast test clock leaves at 0.

### Failure handling, as in the design's table

- **Bench host offline.**
  - BB's host status (`bb.sdk.hosts.get`, cached 15 s) is refreshed every control-loop pass, and offline hosts get no new measurements.
  - A measurement that fails while its host is disconnected restarts from scratch and isn't counted as a pipeline error.
  - The human is notified after `offline_grace_minutes` (10). The study isn't paused: workers keep editing until backpressure stops new spawns.
- **Host worker restart mid-measurement.**
  - `experimental_onWorkerExit` cancels the in-flight measurements on that host.
  - A `jobWait` that answers `unknown`, because the job registry died with the worker, is the same case.
  - The measurement restarts from scratch, and its partial samples are deleted. `measure_restarts` counts restarts; after 6 the study pauses.
- **Plugin restart.** Reconciliation requeues measuring and confirming candidates, deletes their samples, aborts drift checks that were running, and drops build caches.

### Trust

- **Threat model.** The threat model above is new.
- **Controls are clamped.** `study.concurrency` (RPC and CLI) can only lower `max_workers` below the approved spec; asking for more is clamped, with a message saying so. Idea priorities were already clamped to ±100, and reorders to 200 ids.
- **Controls are audited.** Every control is audited: pause, resume (with the pause reason it cleared), concurrency, the idea board, calibrate, approve, start, drift, and archive. Each is a `control.<kind>` event whose actor is `rpc:client`, `rpc:plugin:<id>`, `cli:human`, or `cli:thread:<id>`, with the study agent turns that were running at that moment. Each also raises a notice. The study thread is marked unread only when an agent turn was running.
- **Approval is CLI-only.** *(Superseded by the human interface pass: approval is also in the app, with the same audit; see the threat model.)* Oracle and spec approval (calibrate, approve, start) exist only in the CLI, and the CLI refuses a study's own worker and strategist threads. The SDK gives no reliable way to tell an agent from a human: RPC callers are all `client`, the CLI thread id comes from the shell environment, and plugin forms can be answered with `bb thread interactions respond`. So approval can't be made impossible from an agent shell, only refused for the cooperative case and audited.
- **Smoke-test evidence.** The audit recorded `cli:thread:<id>` for CLI calls made from the building agent's own thread, and `rpc:client` for a `bb plugin rpc call`.

### Profiles

- **How `study_request_profile` runs.** It runs `oracle.profile` on the first online, non-deferred bench host, under that host's bench lock, after a health check. A candidate profile transfers the commit there first.
- **Bench budget.** Its time counts against the bench budget, and it is refused when the remaining budget can't cover one evaluation.
- **Cap.** It is capped per worker (`agents.max_profiles_per_worker`, default 2).
- **Output.** It returns a bounded summary: DIAG lines first, then the last 60 lines, at most 6,000 characters.

### Human surface

- **Overview.** It gains a Bench hosts section. Each host shows its mode, online status, health with problems and summary, what it's measuring with live progress, the shared queue depth, drift status with evaluations since the last check, the cached best build, and bundles sent. It also shows the current segment and oracle hash, and a banner for a pending spec that says which command applies it.
- **The full Bench/Oracle tabs are M3.**
- **CLI.** New: `bb study approve`, `bb study bench` (transfers, health history, drift checks, segments), and `bb study drift`. `show` gains segment, pending-spec, and bench host lines, and marks the holdout as hidden.
- **Candidates.** Rows carry the bench host and holdout pass or fail.

### Data model

M2's migrations are append-only:

- `studies`: `pending_spec_version`, `prev_spec_version`;
- `spec_versions`: `bench_json`;
- `segments`: `spec_version`, `details_json` (per-host calibration);
- `candidates`: `bench_host_id`, `holdout` (pass, fail, or null), `measure_restarts`;
- `threads`: `profiles`;
- new tables `bench_hosts`, `health_checks`, `drift_checks`, `transfers`, and `holdout_results` (private).

New events: `bench.transfer`, `bench.unhealthy`, `bench.healthy`, `bench.offline`, `bench.online`, `bench.worker_exit`, `bench.cache_invalidated`, `measure.deferred`, `measure.restarted`, `drift.checked`, `drift.requested`, `holdout.checked`, `spec.applied`, `segment.recalibrating`, `segment.started`, and `control.*`.

### Smoke test (BB 0.45, one MacBook, toy repo under /tmp)

- **Setup.**
  - A Python midpoint-rule integration (about 600 ms per run at the start), on a temporary project.
  - Bench host `<host>`, named by its host id, so clone mode on the server's own machine.
  - A holdout script outside the repo (a different interval), and the guardrail `precision_digits` (higher is better, 5%).
  - `max_workers = 2`, `max_candidates = 5`, `drift.every = 2`.
- **Spec v2, no oracle change.** Spec v1 asked for worker permission mode `auto`, which the default provider (pi) refuses. The study thread proposed spec v2 without it, `bb study approve` applied it without recalibration, and `bb study resume` continued.
- **Bundles.** All bundles went to the bench-owned clone `~/.bb/plugins/bb-autoresearch/host-data/bench/toy-m2/repo.git`, a bare repository with no alternates, outside `/tmp/ar-m2-toy`, with checkouts as its own worktrees. Each bundle was one chunk and took about 0.4–0.5 s.

  | Bundle | Size |
  |---|---|
  | Bootstrap (baseline) | 2,136 B |
  | Candidates c/1, c/2, c/3, c/5 | 701, 944, 802, 716 B |
  | Best refreshes | 1,040 and 1,443 B |
  | Segment-2 baseline | 1,173 B |

- **Health.** 7 health checks were recorded, all passing: calibration ×2, measurement ×4, drift ×1. The reports said governor and turbo are not detectable on macOS.
- **Drift.** 1 drift check ran after 2 evaluations. It measured A/A noise 7.96% per pair against the calibrated 1.64% (4.85×, over 6 pairs), and the study paused itself.
- **Oracle change.** The study thread proposed spec v3 (calibration_pairs and n_max 10 → 16), and it went pending. `bb study calibrate` recalibrated on best `8e90d2e` and created segment 2 (oracle `d4aa483b…`, noise floor 3.66%, MDE 2.86%), with `refs/studies/toy-m2/segment/1` and `segment/2` in the repo. `bb study start` resumed in segment 2.
- **Holdout.** It passed on all 4 promotions (c/1, c/2, c/3, c/5; only the private table holds the numbers).
- **Results.** Verdicts were 4 wins and 1 conflict. Best vs base was +99.6% (616 ms → about 2.7 ms).
- **No guardrail-driven `lose`.** Two human ideas meant to trade precision for speed, "10x fewer steps" and "3,000 steps, no extrapolation", were handled by the workers anticipating the guardrail. One used Richardson extrapolation instead and won. The other recorded a `not_attempted` finding ("certain to break the precision guardrail"). Guardrail rejection is covered by unit tests.
- **Audit.** A `bb plugin rpc call autoresearch study.concurrency {maxWorkers: 10}` was clamped to 2 and audited as `control.concurrency` by `rpc:client`.
- **Code version.** The smoke test ran on commit `ed044fe`. The later changes (the expensive class switched to t thresholds, bench tuning moved out of the oracle hash, and a transfer label) don't touch the noisy path it exercised.
- **Cleanup.** The study and every thread were archived, and archive deleted the bench clone. The temporary project and worktree, the `/tmp` files, and the empty bench directory were deleted. The plugin is left installed from the M2 worktree, disabled.

### Not in M2

- **Exit criterion.** "A full day on a remote x86 bench host" wasn't run: only one BB machine exists, and enrolling machines was out of bounds. Multi-host behavior (parallel hosts, per-host dispatch, offline, worker exit) is covered by fake-host unit tests only.
- **Remote edit hosts.** Workers and gates run on the server's machine.
- **Bootstrap without a big bundle.** A very large repo would need a large `max_bundle_mib` or a bench clone from origin.
- **Health tuning.** Health thresholds aren't calibrated per machine: the defaults suit a quiet dedicated host, and a busy laptop needs looser `[oracle.health]` limits.
- **Caller identity.** Approval from an agent shell can't be prevented without caller identity from BB (see the threat model).
- **M3 tabs.** The Findings, Oracle, Bench, and Harvest tabs.

## Implementation notes: M3

What M3 added, and every place it differs from the design or from M2. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Harvest

- **Lifecycle.** `bb study harvest <slug>` (or the Harvest tab's dry-run button) moves Running or Paused to **Harvesting**. `bb study resume` is "keep exploring" (back to Running; a harvest still in progress is cancelled, a ready one stays for review). `bb study archive` ends the study and cancels a running harvest. A new harvest after a ready, failed or cancelled one needs `--restart`.
- **Waiting (decision).** Harvest doesn't cancel anything. While Harvesting no worker spawns, submissions are refused with "record a finding, then finish", and the pipeline still finishes candidates already in flight. Only then is best frozen (`base_sha`, `best_sha`, and the promotion list from `git rev-list --first-parent base..best`, mapped to candidates by the `Autoresearch-Candidate` trailer).
- **Grouping.** The plugin sends one strategist turn, `[autoresearch] Harvest h<N>`, listing the promotions (candidate, idea, effect, files). `study_propose_harvest` now validates against that list: every promoted candidate in exactly one group, unknown or duplicated numbers rejected with the reason so the strategist can retry; promotions it leaves out get a changeset of their own. Fallback, one changeset per promotion: when the study thread is missing, when its turn ends without a valid proposal (after `harvestGroupGraceMs`, 60 s), after `[harvest].group_timeout_minutes` (10), for a single promotion, or on request with `--one-per-promotion` (deterministic, no strategist turn). Changesets are ordered by their earliest commit on best.
- **Git without checkouts.** A new host op `composeCommits` replays or reverts a list of commits onto a commit with one `git merge-tree` per step and returns one commit (or the conflicting step and paths). `commitLog` lists first-parent commits with their paths. Ablation commits, standalone commits and probes are dangling commits in the project repo; only the PR branches get refs.
- **Ablation.** For each changeset S: revert S's commits from best (newest first), run the gates on the edit host, then measure best-without-S against best on the first online, healthy bench host with the study's noise-class protocol under the bench lock. For `noisy` the full `n_max` pairs run (no early stop: harvest needs an estimate, not a decision). The **contribution** is how much worse best gets without S, relative to best: `−effect`, CI flipped. The **total gain** is measured the same way, with the base as the "candidate", so every term is on the same scale and they add. The report also gives the total relative to base (`t / (1 + t)`).
- **Scale (decision).** Contributions are relative to best, not base, because that is what ablation measures and it makes them additive. After big wins the numbers get large: on the toy, best is a quarter of base, so the total is +291% relative to best (−74% relative to base). The Harvest tab and report show both.
- **Droppable.** A measured changeset whose contribution CI reaches zero (for `deterministic`, not above `tolerance`) is flagged droppable; the human decides.
- **Dependencies (decision, changed during the smoke test).** A revert conflict or gate failure means a later changeset depends on S. Which one is found with git probes: revert S together with every later candidate (those sharing files with S, else all later ones); if that works, a candidate T is a dependent when keeping T in place makes S's revert fail again. Gate failures run the gates for each probe. If the failure can't be isolated (it fails even with all of them reverted, or no single one is to blame), every candidate is treated as dependent, because stacking is always safe. The first version attributed by shared file paths; on the one-file toy that stacked all six changesets together (harvest h2 below), so path overlap is now only the pre-filter.
- **Stacks.** Dependency edges are grouped into connected components; each component is one **stack**, linearized in best order. A stack with a member that couldn't be ablated alone (conflict or gate failure) is ablated as a whole, and that joint contribution stands in for its members in the sum. A stack covering every changeset is the base itself, so it reuses the total measurement instead of measuring the same thing twice (h2 measured it twice and the two bootstrap CIs disagreed enough to raise a false interaction warning).
- **Standalone check.** Each changeset is applied to its PR base: the segment base for an independent one, the previous layer's commit for a stacked one. Gates always run; the effect against the PR base is measured unless `[harvest].measure_standalone = false` or `--no-measure-standalone`. An independent changeset that doesn't apply to the base reveals an earlier dependency (found with the same probes, forward); the plugin adds the edge, restacks, and checks again.
- **Accounting.** Sum of contributions (independent changesets, stack members when all were measured, otherwise the stack's joint ablation) vs the total gain. The gap's CI half-width is the root sum of squares of the terms' half-widths and the total's (independent errors). An **interaction warning** is raised when |gap| exceeds it, or when a term could not be measured at all. Small-sample bootstrap CIs of the median undercover, so expect occasional false warnings at `n_max` ≈ 10.
- **PR drafting.** Drafting creates one local branch per changeset, `studies/<slug>/harvest/h<N>/<kk>-<title>`, whose tip is its standalone commit. Each commit message carries `Autoresearch-Study` and `Autoresearch-Changeset` trailers. A stacked branch sits on the branch below it. The PR body has:
  - what (the promoted candidates' summaries and their effects when promoted) and why (the group rationale);
  - the ablation contribution with CI and n, and the droppable flag;
  - the standalone effect on its PR base;
  - depends-on and needed-by;
  - linked findings;
  - a study link (`bb.server.experimental_appUrl` when configured, otherwise the page path).
- **Publishers (`src/publisher.ts`, behind `PrPublisher`).**
  - `dry-run` is the only mode harvest itself runs. It writes `report.md`, `prs/<kk>-<title>.md`, and `manifest.json` through a new `writeExport` host op under `<dataDir>/exports/<slug>-harvest-h<N>/` on the edit host. Nothing is pushed.
  - `github` runs only through `bb study harvest <slug> --publish` on a **ready** harvest (decision: always review a dry run first). It is CLI-only, like approval: the RPC can start dry runs but cannot publish. *(Superseded by the human interface pass: the Harvest tab publishes behind a confirmation that lists every branch, remote and draft PR.)*
  - The `github` publisher refuses when the flag is missing, when the repo has no remote named `[harvest].remote` (default `origin`), when that remote isn't GitHub, or when `gh` is missing. Otherwise it pushes each branch and runs `gh pr create --draft`, with stacked PRs based on the branch below. A failed push skips the PRs stacked on it.
  - It was tested against a mock `gh` only; no PR was ever opened.
- **Report (`src/report.ts`, `bb study report`, `study.report`).** Trajectory table, wins, notable losses with their reasons and findings, the dossier, calibration and segments, drift checks, and the latest harvest (changesets, stacks, droppable, the sum-vs-total section). It never reads holdout data: a test checks the report and the new views for the holdout command and numbers.
- **Reconciliation.** Every phase persists per-changeset results; a plugin restart resumes a harvesting study's harvest where it stopped.

### Budgets and provider usage

- **What the SDK exposes (investigated).**
  - `turn.failed` carries `errorInfo.category` and the provider's `rateLimits` (windows with `resetsAtMs` and status).
  - `bb.sdk.threads.retry({ sendAt })` queues a retry on the clock.
  - `bb.sdk.system.usageLimits()` returns each provider's subscription windows (`usedPercent`, `resetsAt`).
  - **Per-thread tokens are readable:** the latest `thread/tokenUsage/updated` event (`bb.sdk.threads.events.list`) has cumulative `totalTokens`. Dollar cost per thread is not exposed.
- **Rate limits.** A rate-limited turn of a worker or of the study thread is retried at the latest blocked window's reset plus 15 s (or now + 1 min × attempt when no reset is known), at most `agents.max_rate_limit_retries` (3) times per thread. Then the plugin gives up with a notice, and an idle worker is later abandoned. The study records `rate_limited_until`; until then no new worker spawns (W shown as 1).
- **Usage windows.** Usage windows are read every 2 min for the providers the study's threads use. A window at or above `agents.usage_tight_percent` (90) halves W, recorded in the `scheduler.target` event. On the smoke-test machine `usageLimits` returned no providers (the default provider, pi, reports no windows), so this path is unit-tested only.
- **Tokens.** Each live thread's total is read at most once a minute and once more when a worker ends. Study tokens are the workers' totals plus the study thread's growth since its first reading after start. `budget.max_tokens` (optional) is enforced like the other limits, and tokens per win show on the Overview, in `bb study show`, and in the report.
- **All limits.** `max_candidates`, `max_bench_hours`, `deadline`, and `max_tokens` pause the study when reached and propose a harvest (decision: the design's lifecycle allows "budget exhausted → Harvesting"; the plugin pauses and asks, because harvest spends bench time). `budget.notify_at` (50 and 80 by default) raises one notice per dimension per threshold, the deadline counting time from the first start. The Overview projects the bench time the remaining candidate budget would take at the calibrated cost per evaluation. Harvest bench time counts toward the bench budget but is never blocked by it.

### Notifications

- **One mechanism.** M1's notices: a row in `notices`, the study page and `bb study show`, `markUnread` on the study thread (unless quiet), and the text in the next strategist round. Kinds:
  - `best.new`;
  - `stall` (quiet; the stall round itself follows);
  - `budget.threshold` and `budget.exhausted`;
  - `oracle.broken` (best fails to build or measure, the holdout fails on best, best can't be sent to a bench host) and `drift`;
  - `rate_limit` and `usage.tight` (quiet);
  - `harvest.ready` and `harvest.failed`;
  - plus M1/M2's calibration, bench health, offline, spec and `control.*` notices.
- **No push.** The SDK has no notification, push, or Slack API for plugins. `bb.sdk.system.attention()` only reads the global flag, and `threads.send` always starts or steers a turn. The unread study thread is what reaches the human, plus the Studies list's "new" count.

### Human surface

- **New tabs (data from `src/views.ts` view models over RPC).**
  - **Findings:** search, outcome, theme, and verdict filters; links to candidates and worker threads.
  - **Oracle:** the active spec as TOML with `[oracle.holdout]` removed (agents can call RPC), version history, calibration report per host, segments, and a pending spec with its line diff and the CLI command that approves it. Approval stays CLI-only. *(Superseded: see the human interface notes.)*
  - **Bench:** hosts, queue, utilization, health-check history, drift checks, bundle transfers, recent bench intervals, and flaky and failed gate counts.
  - **Harvest:** state, total, sum, gap and the interaction warning, changesets with ablation, standalone, dependencies, stack, PR branch and expandable PR body, stacks, the export dir, the publish command (no button), history, an on-demand report, and a dry-run start/restart button.
  - **Overview:** a provider-usage line and a Harvest link.
- **New RPC.** `study.findings`, `study.oracle`, `study.bench`, `study.harvest`, `study.report`, and the audited control `study.harvest.start` (dry run only).
- **CLI.** `bb study harvest [--wait] [--restart] [--one-per-promotion] [--no-measure-standalone] [--publish]` and `bb study report`. `show` gains a Usage line (tokens, tokens per win, rate limit, usage window, projected bench time) and the harvest line.
- **Skills.** `skills/study-harvest` from the integration map wasn't added: the grouping round's prompt carries the instructions, and the `autoresearch` skill documents harvest, budgets and limits.

### Spec additions

- **Budget:** `budget.max_tokens` and `budget.notify_at`.
- **Agents:** `agents.max_rate_limit_retries` and `agents.usage_tight_percent`.
- **Harvest:** a new `[harvest]` section with `measure_standalone`, `group_timeout_minutes`, and `remote`. None of these are part of the oracle hash.

### Data model

M3's migrations are append-only:

- new tables `harvests` and `changesets`;
- `harvest_proposals.harvest_id`;
- `threads`: `tokens`, `tokens_base`, `tokens_at`, `provider_id`, `rate_limit_retries`;
- `studies`: `rate_limited_until`, `usage_json`, `usage_at`, `budget_notices_json`.

New events:

- harvest: `harvest.started`, `.phase`, `.frozen`, `.grouped`, `.grouping_fallback`, `.total`, `.ablation`, `.dependency`, `.standalone`, `.drafted`, `.ready`, `.failed`, `.resumed`, `.publishing`, `.published`;
- usage and budget: `turn.rate_limit_gave_up`, `usage.tight`, `budget.threshold`;
- controls: `control.harvest` and `control.publish`.

### Hermetic tests (fix from the M2 review)

The M2 end-to-end test failed on a loaded laptop because `LocalHostRunner` probed the real machine: at load 6 the health policy deferred the measurement. `LocalHostRunner` now takes an injected health probe, and every test uses `localRunner()` from `test/helpers.ts`, which returns fixed healthy readings and counts probes. Fixed sleeps and short polling loops in tests were replaced with bounded condition polling (`waitFor`, 10 s), including one test that relied on an 80 ms timing window. The full suite (17 files, 169 tests) passed three times in a row at load average 4.5–6.

### Smoke test (BB 0.45, one MacBook, toy repo under /tmp)

- **Toy.** `src/toy.py` has `slow_sum`, a naive `fib`, and a `dedupe` built on a linear `contains()` scan and a `bubble_sort`. The metric is the Python opcodes executed by `toy.run()` plus a fixed workload, counted with `sys.settrace` in the protected `bench/measure.py`, with 0.5% synthetic Gaussian noise, so the `noisy` protocol (real CIs) runs on a deterministic count. The gate is `bench/test_toy.py`. Calibration: noise floor 0.96%, MDE 1.00%, 0.9 s per evaluation, local bench.
- **First attempt (`toy-m3`, discarded).** The repo had no `.gitignore`. Workers ran the tests, the snapshot's `git add -A` committed `src/__pycache__/*.pyc`, and two candidates got `conflict` verdicts on the binary. That is a real usability issue (below). The study was archived and the toy got a `.gitignore`.
- **Study `toy-m3b`.** Settings: `max_workers = 2`, `max_candidates = 6`, default provider pi. Study thread `<thread>`; workers `<thread>`, `<thread>`, `<thread>`, `<thread>`, `<thread>`, `<thread>`.
  - All 6 candidates won: 4 human-seeded ideas (set membership, iterative fib, `sorted()`, closed-form sum) and 2 strategist ideas (items via `map`, `sorted(set(items))`).
  - Best vs base −74.4% (measured) after about 3 minutes of Running.
  - The candidate budget ran out: the study paused itself with "harvest them with `bb study harvest`".
  - Tokens: 295,901 in total (about 24k per worker, 149,883 for the study thread since start), so 49,317 per win.
  - Notices: `best.new` ×6, `budget.threshold` ×2 (50% and 80% of candidates), `budget.exhausted`, `harvest.ready` per harvest, `control.*`.
- **Harvest h1 (strategist grouping).**
  - The study thread answered with `study_propose_harvest`, grouping the three dedupe promotions (c/1, c/3, c/6) into one changeset next to fib, sum, and items: 4 independent changesets, no edges.
  - Total +292.57% (CI +291.34..+294.78%) relative to best; sum of contributions +291.05% ± 1.62%; gap +1.52% (half-width 2.36%): they add up.
- **Harvest h2 (`--one-per-promotion`, first dependency code).** Path-level attribution put all six changesets into one stack (one file). The stack's separate measurement of base vs best gave a false interaction warning (gap −2.78%, half-width 1.52%). Both issues were fixed as described above.
- **Harvests h3 and h4 (`--one-per-promotion`, final code).**
  - Reverting c/1 or c/3 from best conflicts in `src/toy.py`; the probes isolate c/6 as the dependent of both. That gives **edges #6 → #1 and #6 → #3** and a stack `#1 → #3 → #6`, ablated together at +236.9%.
  - The other three are independent:

    | Changeset | Contribution (CI) |
    |---|---|
    | fib | +29.76% (+29.34..+30.08%) |
    | sum | +20.38% (+19.98..+21.36%) |
    | items | +3.65% (+3.14..+3.95%) |
    | #6 | +3.75% (+2.90..+4.67%) |

  - **h4 total** +293.91% (CI +289.32..+296.22%), **sum** +290.68% ± 1.39%, **gap** +3.23% (half-width 3.72%): "The contributions add up to the total gain within the CI." (h3: gap +0.03%, half-width 2.49%.)
  - Standalone effects on each PR base:

    | Changeset | PR base | Effect |
    |---|---|---|
    | #1 | base | +30.65% |
    | #2 | base | +7.25% |
    | #3 | #1 | +42.03% |
    | #4 | base | +4.90% |
    | #5 | base | +0.87% |
    | #6 | #3 | +1.82% |

  - Harvest bench time: 11 s.
  - Six local branches; the stacked ones are chained (`06 → 03 → 01 → base`). The PR bodies and `report.md` were exported, and `--publish` was refused: "the repository has no remote named origin".
- **UI.** All seven tabs rendered in the BB app; there are in-app browser screenshots of Overview, Findings, Oracle, Bench and Harvest.
- **Cleanup.** Both studies and their threads were archived, and the temporary project, `/tmp` files, and toy exports were deleted. The plugin is left installed from the M3 worktree, disabled.

### Not in M3, and known issues

- **Exit criteria on real workloads.** Not run for any milestone (see Status). M3's criterion holds only on a toy with additive effects.
- **GitHub publishing.** Never run against GitHub.
- **Provider limits live.** Neither usage-window W-lowering nor rate-limit retries have been seen live.
- **Snapshots commit build outputs.** `git add -A` in worker worktrees picks up untracked build outputs when the repo lacks a `.gitignore` (the `toy-m3` failure). Scope globs don't exclude them because they sit under `editable`. *(Fixed: `[scope] ignore`; see "Implementation notes: guardrails and pre-release fixes".)*
- **Attribution limits.** Dependency attribution is pairwise. A failure that needs two later changesets together to explain it falls back to "all later", and a stack is linearized in best order, so a member can be stacked under another it doesn't depend on (#3 under #1 on the toy).
- **Gate dependencies only.** A changeset that is semantically needed but doesn't break the gates when reverted (no test covers it) is not detected as a dependency.
- **Interaction warnings.** They rely on bootstrap CIs that undercover at small n.
- **Dollar budgets.** Dollar cost per thread isn't exposed by BB, so there are no dollar budgets.

## Implementation notes: human interface

A pass after M3 over every human step, with no new engine features. Same platform pins (BB 0.45.x, SDK 0.6.14). It started with a walk through the whole journey in the BB app on the M3 code, logging every confusing moment, dead end and forced trip to the CLI (18 of them, from "three different signs for the same number" to "approval needs a terminal"), and ended with the same journey on the new code.

### One way to express improvement

- **The convention (`src/present.ts`).** An improvement is a fraction relative to a reference, **positive = better in the metric's own direction**. It is written signed where space is short ("+74.7%", tables, the chart axis, the badge) and in words where it is the headline ("74.7% fewer ops (4.0×)", "12.0% higher throughput", "3.1% higher p99 (worse)"). Counts get "fewer/more", other metrics "lower/higher". A factor is added from 1.5× up. The raw values travel with it ("210,802 → 53,300 opcodes").
- **Magnitudes are unsigned.** Noise floor, MDE, guardrail limits and CI half-widths are magnitudes ("1.00%"), never signed; a CI is always written low to high ("CI +73.7% to +75.6%").
- **Everywhere the same.** The Overview cards, chart, candidates, findings, verdict messages, strategist digests, notices, PR bodies, the report and the CLI all use these helpers; the only raw relative-to-best numbers left are in `--json` output and one "for the record" line in PR bodies and the report.
- **Harvest contributions are shares of the gain.** Ablation measures each changeset relative to best, which makes terms additive but huge after big wins (+128,672% on the before toy). The page, CLI, PR bodies and report now show each contribution as its **share of the base→best gain** with the CI as shares ("81.3% of the gain (CI 81.0% to 81.6%)"), in points of the headline ("81.3 of the 99.9 points") and in metric units ("≈ 171,548 fewer opcodes"). The accounting reads "Explained by the changesets 100% ± 0.3%" and "Unexplained 0.2% (noise allows ± 0.6%)".
- **Two view-model fixes for higher-is-better metrics.** Compounding promoted effects used 1 − Π(1 − e), which is right only for lower-is-better; higher-is-better now uses Π(1 + e) − 1 (`compound`). Harvest's relative-to-base total used t / (1 + t); for higher-is-better it is t / (1 − t) (`vsBaseFromVsBest`). Neither changes a verdict: they only affected displayed best-vs-base numbers and notices. The stored `total_vs_base` column is no longer read.

### The study page

- **Hierarchy.** The header gives the state, a one-sentence status ("Running: 2 workers editing, measuring c/4.") and a "needs you (n)" chip. The Overview leads with **Needs you**, then best vs base (in words, raw values, CI), Now (workers and queue), Budget; then the trajectory, live workers and bench queue (only while there are any), secondary metrics, controls, bench hosts, notices, and a collapsed event log. A draft shows no running-state clutter.
- **Needs you (`needsYou` in views.ts).** Derived from state on every read, so it can't go stale: a draft spec to approve, a failed calibration (with the problems and "ask the study thread to revise the spec"), a finished calibration to approve, a pending spec, a system pause (budget exhausted → harvest; drift or broken oracle → Bench, then resume), a bench host unhealthy or offline past its grace period, a harvest ready for review, a failed harvest or publish. Alerts sort first. Each item has the in-app action that resolves it and the CLI equivalent. A pause by the human needs nothing.
- **Badges.** The nav panel's `experimental_sidebarAccessory` shows the number of needs-you items across studies (`studies.attention`); the study list marks each study; the study thread's header badge leads with the count and the first item ("draft · needs you: approve spec"). Notices count as new until the human has had the Overview open for 3 s (`study.notices.seen`, new column `studies.notices_seen_at`); the human's own control notices are an audit trail and never count.
- **Notices name their action.** Every notice text was rewritten to "what happened. Next: what to do (where, or the CLI command)". `noticeAction` maps each kind to a tab and a label ("Review calibration and start", "Start harvest", "Open Bench"), and the Overview shows that button next to the notice; control notices fold into "Audit trail: n human controls".
- **Inline help.** A "?" next to each statistical term opens one or two sentences (`GLOSSARY`): improvement convention, CI, MDE, noise floor, calibration, ablation, dependency edge, stack, standalone, droppable, unexplained, guardrail, drift, holdout, segment, utilization.
- **States.** Every tab has a layout-keeping skeleton while loading, an error line with Retry, an empty state that says what will fill it, and keeps the last data while refetching (no flicker). The status line reserves its height; the chart's hover card has a fixed position.
- **Tabs.** Oracle: approval buttons, MDE explained as "a win must improve by more than 1.00% with confidence (in practice changes of about 1.27% or more are detected)", the segment marked "awaiting your approval" until calibration is approved. Ideas: veto with an inline reason form (`window.prompt` doesn't exist in the desktop app, so veto was broken there), pinned shown in words, read-only when archived. Candidates: an Improvement column, CIs in order, a guardrail column, and in the detail a metrics table of every recorded metric. Findings: counts on every facet (outcome, theme including "no theme", verdict including "no candidate"), a finding's idea falls back to its candidate's idea, paging by 50. Bench: host names everywhere and the latest health check of each host marked.

### Secondary metrics and guardrails

- **One status function.** `guardrailStatus` in views.ts is the only place the UI decides a guardrail's state: pass, warn (more than 80% of the limit used), broken, or missing, with a text that carries the state without color. It takes values and limits (and prefers the regression the verdict recorded), and already has slots for a CI and a cumulative limit against the segment base, so the follow-up that adds `max_total_regression` and CI-based guardrail decisions can fill them without touching components. Verdict semantics are unchanged. *(Filled by the guardrails pass: cumulative position, CI, an inconclusive state and headroom; see below.)*
- **Where it shows.** The candidate detail has a metrics table (primary, guardrails with limit and status, informational metrics with a raw change and "no direction"); the candidates list has a guardrail column ("ok (1)", "rss near limit", "rss BROKEN"); the Overview shows each secondary metric of best against the segment base, the guardrail's position against its limit as a bar plus a word, the worst single promotion, and a small trend of best's value after each promotion.

### In-app actions (decision 1)

- **RPC.** `study.spec.approve {slug, version, confirm}` (draft: approve and calibrate; pending, oracle unchanged: apply; pending, oracle changed: approve and recalibrate), `study.start {slug, confirm}` (only from a finished calibration), `study.harvest.plan` (read: remote, URL, each branch → base, skips, and whether the preflight passes), `study.harvest.publish {slug, harvestId, confirm}`, `study.harvest.choice` (keep or drop a changeset nothing builds on), `study.archive {slug, confirm}`, plus `study.harvest.start` gained `onePerPromotion`.
- **Deliberate.** Without `confirm: true` each refuses with what it would do ("confirmation required: this pushes 3 branch(es) of harvest h1 to origin and opens draft PRs on GitHub…"). Approval names the version the human reviewed; a stale page is refused. Plugins are refused as callers. Every action is a `control.*` event and a notice; a refused publish is audited too, kept on the harvest (`publish_state = failed`, the error), and becomes a needs-you item.
- **Dialogs.** Each action's dialog states exactly what happens and shows the CLI equivalent. Publish loads the plan first, lists every branch and the draft PR it opens, and disables the confirm button with the reason when the preflight fails. Results (PR URLs, push or `gh` errors, skipped ones) stay on the Harvest tab.
- **Dropping a changeset.** A droppable changeset gets Keep/Drop; a dropped one is skipped when publishing (new column `changesets.human_choice`). A changeset that others build on can't be dropped.
- **CLI unchanged.** `calibrate`, `approve`, `start`, `harvest --publish` and `archive` behave as before and are audited the same way.

### Harvest review

- Each changeset shows its title, the contribution as above, the dependency explanation in words ("Reverting this from best conflicts with #6 (in src/toy.py), so it can't be measured alone…", "Builds on #1 and #3…", "Ships in stack 1 (#1 → #3 → #6), as a PR stacked on #3"), the standalone result in the convention, the PR base in words (no more "base base"), the PR body rendered with the host `Markdown` component, and the keep/drop choice.
- A progress line shows the phases. A small gap beyond the noise (within 2× its CI half-width, common with bootstrap CIs at n ≈ 20) is an info callout that says so; a large one or an unmeasured term is an alert.
- Fallback rationale says why: "Promotion c/1 as its own changeset (one changeset per promotion, as you asked)".
- With zero promotions the start button is disabled with the reason next to it.

### Study thread messages (decision 2)

- **Agent-only detail.** `threads.send` input blocks accept `visibility: "agent-only"` (SDK 0.6.14, `promptInputSchema`). Verdicts, strategist digests and the harvest grouping round are now an `AgentMessage`: a one-line summary the human sees, and the full detail as an agent-only block. Live check: the human timeline showed only "[autoresearch] Verdict for c/2: WIN: promoted to best, 62.9% fewer ops than best (CI +62.6% to +63.3%)." and the worker still quoted the medians and guardrail from the hidden detail.
- **Summaries.** A strategist round reads "[autoresearch] Strategist round 2 (new verdicts): 5 new verdicts (4 win, 1 inconclusive), best now 98.8% fewer ops (82×) vs base · 3 ideas queued · 1 worker · 9 notices for you on the Studies page." The digest asks the strategist to answer the human in two or three short lines.
- **Tool results** (a scope rejection, the submission ticket) stay one text, since a tool result has no visibility.

### CLI

- `--json` on every command, one JSON document from the same view models as the page; errors use the SDK envelope with a `hint` that names the command to run next.
- New `bb study needs [slug]`.
- `list` is a table with a NEEDS YOU column (active studies first), `show` gains a Needs you section, `harvest` prints shares, explanations and PR bases in the page's words. Same numbers and wording as the UI.

### Accessibility and theming

- The tabs are a WAI-ARIA tablist with roving focus (arrow keys, Home, End). Every control has a visible focus ring and an accessible name; chart marks are focusable and open their candidate.
- Color never carries meaning alone: verdicts carry a glyph and a word, chart marks differ by shape (● win, × lose, ○ other), guardrails and health checks carry words.
- **Theme tokens only.** Tailwind `dark:` variants in a plugin bundle compile to `prefers-color-scheme`, so they follow the OS, not BB's theme (a light BB theme on a dark OS rendered light-on-light text). All `dark:` variants were removed in favor of host tokens (`text-success`, `text-warning-text`, `bg-warning/10`, `text-destructive`, `bg-muted`). Light theme was checked by switching the tab's root class to `light` (screenshots), not through BB's settings.
- New vendored components from the BB registry (desktop-v0.45.0): `dialog`, `popover` and their support files; `@radix-ui/react-dialog` and `-popover` are type-only dev dependencies at the host's range.

### Data model

Append-only migrations: `changesets.human_choice`, `studies.notices_seen_at`. New events: `harvest.choice`, `harvest.publish_refused`; new control kinds `control.harvest_choice` and the in-app `control.calibrate|approve|start|publish|archive`; new notice kind `harvest.published`.

### Usability check (BB 0.45, one MacBook, toy repo under /tmp)

The same toy as M3 (`src/toy.py`, opcodes counted by the protected `bench/measure.py` with 0.5% noise), with a guardrail `src_lines` (≤ 30% worse per promotion) and an informational `wall_ms`; `max_workers = 2`, `max_candidates = 5`, local bench. Clicks were driven through the in-app browser; times are wall time from the action to the next state.

| Step | Before (M3 code) | After |
|---|---|---|
| Create (study-create conversation) | no entry point; a typed request; 87 s to a draft | New study (1 click, prompt prefilled) + project (2) + send (1); 23 s to a draft |
| Find the study | sidebar → Studies → row | the thread's header badge ("needs you: approve spec"): 1 click |
| Approve the spec and calibrate | CLI `bb study calibrate` (twice: the first calibration failed on laptop load, visible only below the fold) | Needs you → Approve and calibrate… → confirm: 2 clicks; 3 s to ready |
| Seed ideas | Ideas tab, 2 ideas | Ideas tab + 3 adds: 4 clicks, 7 s |
| Steer (reorder, veto with reason, unpin, concurrency and back, pause, resume) | veto used `window.prompt`, absent in the desktop app | 8 clicks plus typing, all in-app |
| Approve calibration and start | CLI `bb study start` | Approve and start… → confirm: 2 clicks (+1 for the tab) |
| Run to the budget | 140 s | 122 s |
| Harvest (dry run) | Harvest tab button; 33 s | Needs you → Start harvest… → confirm: 2 clicks; 27 s |
| Review changesets | "+128,672%" next to "−99.9%", "base base" | shares, points, units, dependency text; Review harvest: 1 click |
| Publish | CLI only, no preview | Publish draft PRs… → plan with the refusal ("no remote named origin"), confirm disabled; Cancel: 2 clicks |
| Archive | CLI only | Archive… → confirm: 2 clicks; 2 s |

Main path after: 21 clicks and no trip to the CLI (before: five forced CLI trips). Screenshots of every tab and flow, before and after, are in the building thread's storage (`shots/before`, `shots/after`, `shots/after-same-data` for the before study re-rendered by the new code).

### Remaining friction and not done

- **New study composer.** It opens with "No project" selected and placeholders to edit; `toCompose` takes no project, so the human picks it (2 clicks). *(Fixed in the guardrails pass.)*
- **Audit alarms for the human's own controls.** In-app controls used while workers run are flagged as "made while study agent turns were running", and the strategist relays that ("if that wasn't you…"). That is the threat model working (RPC can't identify the caller), but it reads as an alarm after ordinary steering.
- **Old notices keep their old text.** Texts are stored; only notices raised after this pass follow the new wording.
- **Archiving a study leaves its study thread** (the conversation) unarchived; the human archives it like any thread. *(Fixed in the guardrails pass: an option, on by default in the app.)*
- **Interaction warnings** still rest on bootstrap CIs that undercover at small n; the info callout only softens the wording.
- **Light theme** was checked by switching the root class in the browser tab, not by changing BB's theme setting; real light-theme contrast with a custom palette is untested.
- **The creating agent** in the live run still listed CLI next steps (from the old `study_propose` result text, fixed after the run) and the updated skill wasn't re-run live.

## Implementation notes: guardrails and pre-release fixes

The last pass before release. It fixes two guardrail correctness gaps and three usability issues the earlier smoke tests found. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Guardrails: a cumulative limit

- **The gap.** Guardrails compared each candidate only with the current best. Ten promotions that each add 4.9% memory pass a 5% limit and leave best 61% above the segment base.
- **Spec.** `[[guardrail]] max_total_regression` (a fraction like `max_regression`, default `max_regression`) limits how much worse best may get than the segment base over all promotions. A value below `max_regression` is accepted with a warning (the total limit then binds first). It is part of the guardrail entry, so it is in the oracle hash: changing it is an oracle change and starts a new segment. Spec versions stored before this pass are read with the default filled in (`normalizeSpec`), so their hashes stay comparable.
- **Where best stands (decision).** Best's position against the segment base is the promotion chain base → best (followed through `promoted_sha` and `against_sha`), compounded from each promotion's recorded guardrail estimate, with the candidate's own step on top. Steps compound in the metric's own terms (values multiply by 1 + r for lower-is-better, by 1 − r for higher-is-better); CI half-widths combine as a root sum of squares in log space, the same independence assumption as harvest's gap. Alternatives rejected: measuring the segment base as a third side of every pair (a third checkout and 50% more bench time per candidate), or comparing unpaired medians of the base's calibration runs with today's candidate (machine drift between the two times is not paired away).
- **Both limits on every win.** The verdict checks the step against `max_regression` and the total against `max_total_regression`; either one broken makes the win a `lose`. The reason says which, in words: "guardrail rss: 4.9% worse than best, within the 5.0% limit; 21.1% worse than the segment base, beyond the 20.0% total limit".
- **Segments.** A new segment starts the chain again from its baseline (best at recalibration).

### Guardrails: statistics

- **The gap.** A guardrail was the median of the paired differences with no CI: a noisy secondary metric could reject a real win by chance.
- **The rule (`src/guardrails.ts`).** Each guardrail gets a CI of its regression. **Broken** when the CI is entirely beyond a limit, **ok** when it is entirely within, **inconclusive** when it straddles. Inconclusive is not a rejection: the verdict lists it ("…inconclusive against the 5.0% limit (the CI straddles it; flagged, not a rejection)"), the worker's summary line says "Guardrail rss inconclusive (flagged)", and the page shows an inconclusive state with the warn tone.
- **Per class.**
  - `noisy`: a percentile bootstrap CI of the median of per-pair regressions, the primary metric's method and confidence. A confirmation measurement judges guardrails on the pairs of both measurements (decision: guardrails didn't select the candidate, so pooling isn't biased, and one test on more pairs replaces two separate chances to reject). The first measurement can already reject.
  - `deterministic`: one run per side; the CI is ± max(`tolerance`, the calibrated repeat difference). With tolerance 0 the exact value decides, as before.
  - `expensive`: the candidate's confirmation runs against the host's baseline runs, with a half-width t·σ_g·√(1/k + 1/m), σ_g the guardrail's calibrated per-run noise and t the same Student-t quantile as the primary metric. Without calibration it is estimated from the runs at hand when there are enough of them.
  - Old candidates have point estimates only; the chain uses them as exact.
- **Simulation** (test/guardrails.test.ts; noisy class, n_min 6, n_max 20, confirmation on, a 20% primary win, a 5% guardrail limit; "before" is the old rule applied to each measurement):

  | True guardrail change | Per-run noise (per-pair SD) | Rejected before | Rejected after | Flagged inconclusive after |
  |---|---|---|---|---|
  | 0 (400 trials) | 5% (≈ 7%, above half the limit) | 13.3% | 0.0% | 46.5% |
  | +12% (200 trials) | 5% | 100% | 82.0% | 18.0% |
  | +15% (200 trials) | 2% | 100% | 100% | 0% |

  The price is power: a noisy guardrail that really regresses is sometimes flagged instead of rejected, never silently passed.

### Guardrails: calibration, views, messages, report

- **Calibration.** Every strategy measures each guardrail: the A/A per-pair noise and CI half-width at `n_max` (noisy), the per-run σ and the half-width for k confirmation runs (expensive), the repeat difference (deterministic). The report gains a line per guardrail ("mem_kb: noise 1.99% per pair (A/A), CI half-width 0.76%: rejected beyond about 9.8% worse, ok below about 8.2% worse, inconclusive in between"). A guardrail whose half-width reaches its limit raises a calibration **warning** (not a failure): it can never be shown within the limit. The worst bench host decides, as for the MDE. Results are stored in the calibration report (`guardrails`, `warnings`) and the segment's `details_json`; verdicts read the segment's guardrail noise.
- **Views.** `guardrailStatus` (views.ts) checks the step and the total with the same rule as the verdict and returns both checks with their headroom; the label says when only the total is the problem ("BROKEN (total)", "inconclusive (total)"). Components only display it: the candidate list's guardrail column, the candidate detail's metrics table (step and total with CIs), and the Overview's best-vs-base position against the total limit, with the room left and the number of promotions compounded. The Oracle tab shows each guardrail's noise and any warning.
- **Messages.** Verdicts carry, in the agent-only detail, both checks with their CIs and the headroom left now; the human line names a broken or flagged guardrail only. Strategist digests and worker briefs carry the headroom per guardrail; the digest's summary line mentions a guardrail only when less than a fifth of its total limit is left.
- **Report and harvest.** The study report has a Guardrails section: best's position with CI, headroom, every promotion's step, the wins a guardrail rejected and the promotions it flagged, and the calibrated noise. Harvest's base-vs-best and ablation measurements already had guardrail samples; they are now kept (`harvests.total_guardrails_json`, `changesets.guardrails_json`), so the report also gives best vs base measured directly next to the verdicts' compounded estimate, and each changeset's cost to each guardrail.

### Pre-release fixes

- **Snapshots and build outputs.** `[scope] ignore` lists untracked build outputs and caches the worker snapshot never commits, gitignore-style: a pattern without a slash matches at any depth, a leading or inner slash anchors it at the root, a trailing slash means a directory. Defaults: `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/`, `node_modules/`, `dist/`, `build/`, `target/`, `.DS_Store`, `coverage/`, `.coverage`, `.nyc_output/`, `htmlcov/`; setting the key replaces them, `[]` turns it off. The snapshot stages tracked changes with `git add -u`, then untracked files with exclude pathspecs, and reports what it left out (the submission ticket says so). Changes to tracked files under a pattern always commit. A candidate that still adds a matching file (the worker committed it itself) is `rejected` with what to do (`git rm -r --cached`, or ask the human to change the list). Calibration warns when the base tracks files that match (a `build/` of sources, say), because new files next to them would be left out. Not part of the oracle hash.
- **New study.** The Studies page opens bb's own new-thread composer (`experimental_NewThreadComposer`) in a dialog, seeded with the study-create prompt and a project: the route's project, else the project of the most recently updated active study (only if it still exists), else none. The plugin spawns the thread from the composer's request and opens it. Before, `toCompose` took no project and opened with "No project".
- **Archive with the thread.** The archive dialog has "Also archive the study thread" (on by default); `study.archive` takes `archiveThread`, the CLI `--archive-thread`. The study thread is archived and stopped after the study, recorded as `study_thread.archived`; asking again on an archived study archives just the thread. Worker threads were already archived.

### Data model

Append-only migrations: `harvests.total_guardrails_json`, `changesets.guardrails_json`. A decided candidate's `metrics_json` gains `guardrailCi` (per guardrail: lo, hi, n) and `guardrailJudgement` (the step and total checks, best's prior position, the text). The calibration report and segment details gain `guardrails` and `warnings`. New event: `study_thread.archived`; `control.archive` records `archiveThread`; `candidate.submitted` records how many files the snapshot left out.

### Smoke test (BB 0.45, one MacBook, toy repo under /tmp without a `.gitignore`)

- **Toy.** `src/toy.py` with a naive `slow_sum`, recursive `fib`, and a `dedupe` built on a linear `contains()` and a `bubble_sort`; a gate test; the primary metric `ops` (opcodes of `toy.run()` counted with `sys.settrace`, 0.5% synthetic noise). The guardrail `mem_kb` is a synthetic memory model that creeps with every win: it grows by about 7% per halving of ops, plus 1.2% per-run noise. Limits: 9% per step, 12% in total. Noisy class, `max_workers = 2`, `max_candidates = 6`, local bench, default provider (pi).
- **Calibration** (after one A/A attempt failed the existing equivalence check by chance: median 0.48%, CI 0.42% to 0.87%): ops noise floor 0.83% per pair, MDE 1.00%; "mem_kb: noise 1.99% per pair (A/A), CI half-width 0.76%: rejected beyond about 9.8% worse, ok below about 8.2% worse, inconclusive in between".
- **Verdicts.** Five wins and one guardrail rejection, 68.5% fewer ops (3.2×) in a few minutes of Running:

  | Candidate | Primary | mem_kb step vs best (CI) | mem_kb vs segment base (CI) | Outcome |
  |---|---|---|---|---|
  | c/1 set-based dedupe | +38.8% | 5.1% worse (4.4 to 5.8) | 5.1% | win |
  | c/2 `sorted()` | +61.1% | 9.8% worse (8.4 to 10.9): inconclusive | 15.4% (13.7 to 16.9): beyond 12% | **lose on the total limit** |
  | c/3 closed-form sum | +9.3% | 0.1% better | 5.0% | win |
  | c/4 iterative fib | +28.5% | 3.0% worse | 8.1% | win |
  | c/5 data as a constant | +2.8% | no change | 8.1% | win |
  | c/6 guardrail-aware sort | +18.4% | 1.9% worse (0.6 to 2.6) | 10.1% (8.0 to 13.0): inconclusive | **win, flagged** |

  The c/6 worker read the headroom in its brief ("only ~3.5% headroom left") and kept a cheaper bubble sort instead of `sorted()`. After c/2 the strategist, whose digest carried the headroom line, queued micro-optimizations rather than more `sorted()` variants.
- **No build outputs.** Every submission left one or two `__pycache__/*.pyc` files out (recorded on `candidate.submitted`); no candidate ref and no commit on best contained one.
- **Harvest h7** (`--one-per-promotion`): best measured directly 12.1% worse than base on mem_kb (CI 10.6% to 12.9%), against the chain's 10.1% (CI 8.0% to 13.0%); per changeset 6.8%, 1.1%, 5.0%, 1.0%, 2.7%. The model's true value is 12.2%, inside both CIs. The chain underestimated it because noisy small steps were recorded as "no change" (the price of compounding estimates).
- **App.** Screenshots of the calibration's guardrail noise (Oracle tab), the Overview's cumulative position and headroom, the candidate list's guardrail column, the c/2 and c/6 details, the new-study composer with the project preselected, and the archive dialog are in the building thread's storage (`shots/`).
- **Cleanup.** The study was archived from the dialog with its study thread (all eight threads archived); the temporary project, `/tmp` files and the harvest export were deleted. The plugin is left installed from this pass's worktree, disabled.

### Not done, and known issues

- **Power with noisy guardrails.** The chain's CI grows about with √(promotions), so a noisy guardrail's total can stay inconclusive long after the point estimate passed the limit. Flagged, but not rejected.
- **No extra pairs for an inconclusive guardrail.** The sequential test stops on the primary metric; it doesn't keep measuring to settle a straddling guardrail.
- **The chain is an estimate.** It compounds per-step estimates; harvest's direct base-vs-best measurement is the better number when it exists, and the report shows both.
- **Reconciliation** re-checks scope for a crashed submission from its recorded paths, without the added-files list, so the ignore rule isn't applied there.
- **The composer's "current project"** falls back to the latest active study's project because the Studies panel isn't a project route; with no active study the human picks it.

## Implementation notes: live view (part 1)

A Live view for watching a running study: workers picking up ideas, editing and pushing candidates through tests and the bench, with verdicts arriving. Part 1 is the live surfaces and the event log they stand on; part 2 adds a CI band per measurement, a "last action" line per worker, a visible "best moved" moment, and a replay of finished studies. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Decisions taken before building

- **Two surfaces, one component.** A **Live** tab on the study page, which is the default tab while the study is Running (other states keep Overview), and a **Live panel** in the study thread's right split pane (`threadPanelAction`), so the human can watch while talking to the strategist. Both render `LiveStudy` (`src/app/live/`), in a wide and a compact layout.
- **Read only.** No stop, steer or reprioritize controls. The view opens things (a candidate, a worker's transcript or thread, the Overview); Pause stays on the Overview.

### Step 0: the transcript spike

- **Question.** Does `ThreadChat` with `variant="timeline"` (a transcript without a composer) render a hidden, plugin-spawned thread live, and do agent-only blocks stay hidden?
- **Setup.** A scratch plugin spawned a hidden thread in a managed worktree with a slow, multi-step prompt, rendered it with `ThreadChat variant="timeline"` in a nav panel and in a `threadPanelAction` tab, and sent it a message with a one-line summary and an agent-only block holding a secret word.
- **Result: it works.** The timeline streamed as the agent ran (commands appearing as they ran, "Working…" while busy). The human view showed only the summary line; the agent's reply quoted the secret word, so the agent-only block reached the agent and stayed out of the human view. The worker's brief (its first user message) is shown in full, as in the worker thread itself.
- **Also found.** `useBbNavigate().openThreadPanel` returns false on a plugin page, even right after `toThread` (the hook belongs to the page, not the thread). From a component mounted on the thread surface (the header badge) it opens the panel on the first try. That decided how "Open beside the study thread" works (below).

### Every visible change is an event

The Live view shows nothing that isn't in `events`, so a replay can rebuild it at any time t. Realtime deltas are a throttled projection of the same rows.

| Event | Recorded | Payload | Shows |
|---|---|---|---|
| `candidate.stage` | on every stage change, by the store (`insertCandidate`, `updateCandidate`): one choke point, so none is missed | candidate, n, from, to, the verdict when decided | which column a card is in, and since when |
| `worker.phase` | by the live recorder whenever a worker's derived phase changes | worker (the `threads` row id), thread, idea, from, to, candidate, reason (when done) | the lanes |
| `measure.started` | at the start of each measurement (now with `of`) | candidate, n, host, of | bench strip, card |
| `measure.progress` | for the first completed pair, then at most once per 2 s per candidate, and the last pair of each run | candidate, n, run (measure or confirm), pairs, of, host | pair i of n |
| `measure.finished` | at the end (now with `pairs`, `run`, `measure_pairs`, `confirm_pairs`) | | feed |
| `drift.started` | when a drift check takes a host | host | bench strip |
| `idea.added` | now with `theme`, `priority`, `pinned` | | Up next |
| `candidate.verdict`, `best.promoted`, `idea.status`, `worker.spawned/finished/abandoned`, `candidate.queued/rebased/requeued`, `measure.restarted` | as before | | cards, feed, Up next |

- **Replay.** `replaySkeleton(events, until)` (`src/live-model.ts`) rebuilds the state the view shows (live workers and their phases, every candidate's stage, verdict and pair progress, best, queued ideas, what each bench host measures) from these rows alone. `skeletonFromDb` builds the same from the tables. Tests compare the two at several points of simulated studies (including a replay up to an earlier t), and the smoke test compared them on the live database (below).
- **Pair progress is shared.** `reducePairs` turns a candidate's events into "pair i of n"; the live view and replay both use it, so they show the same numbers.

### Worker phases

- **From plugin state, not transcripts.** `deriveWorkerPhase` reads the thread row, the worker's latest candidate, and its activity: starting (spawning) → reading, editing or testing (before the first submission, by activity) → waiting for the bench (submitted, gating, queued) → being measured (measuring, confirming, promoting) → verdict received (decided) → refining (activity after the verdict was delivered) → finishing → done.
- **Activity.** BB announces new thread events at most once a second per thread (`experimental_thread.events`). For a live worker, the engine reads the `item/started` rows after the last one it read (`bb.sdk.threads.events.list`, at most 100 per page, which is BB's cap) and keeps only each item's kind, command and tool name, never message text. `classifyItem` maps them: file reads and searches are reading; file changes and shell edits (`sed -i`, scripts that write files, redirects into files, `apply_patch`) are editing; other commands are testing, unless every part of a compound command only reads. `threads.activity`, `activity_at` and `activity_seq` hold the result.
- **Recording.** The `LiveRecorder` (`src/live.ts`) listens to every appended event (`Store.onEvent`) and, on a microtask after the transaction, syncs the study's workers: a changed phase updates `threads.phase` and `phase_at` and appends `worker.phase`. A flip between reading, editing and testing is recorded at most every 3 s per worker (`liveDwellMs`); the latest activity wins. The control loop also syncs every tick as a safety net.

### Realtime deltas

- **Channel `study-live`.** A message is `{ s: studyId, d: [...] }`, each delta ids and small numbers only (`stage`, `phase`, `pair`, `verdict`, `best`, `idea`), carrying its event id and time. Data still comes from RPC (`study.live`).
- **Throttled per study (decision: ~4 messages/s).** `DeltaBus` sends at most one message per 250 ms per study, keeps only the latest delta per key within a window (a card that went gating → queued → measuring sends "measuring"), and turns a burst of more than 40 into `{ refetch: true }`.
- **Applied locally.** `applyDeltas` (shared, pure) moves cards, counts pairs, updates phases and removes picked ideas; a delta for a card, worker or idea the view doesn't know yet, a new best, a decided card or a newly queued one asks for a refetch. Deltas at or below the snapshot's `lastEventId` are ignored. The view refetches at most once a second, on `study-changed` (still published for the other pages), on reconnect, and every 5 s.

### Surfaces

- **Live tab.** The route without a tab opens Live while Running and Overview otherwise, decided once per visit so a study that pauses doesn't pull the page away. An explicit tab always wins. When the tab's area is narrower than 760 px (a narrow window, or the page beside an open side panel) it uses the compact layout.
- **Live panel.** `threadPanelAction` `study-live` (flush layout, "Study live view" in a thread's right-panel launcher). It resolves its study from the thread with the `thread.study` RPC: the study thread, or a worker thread (whose transcript is then selected). `params.slug`, when given, is validated and wins. On any other thread it says so and links to the Studies page.
- **Open beside the study thread.** The study thread's header badge gets a **Live** button that opens the panel there. The Live tab's button records a request and navigates to the study thread; the badge, mounted on that thread surface, takes the request and opens the panel (retrying briefly while the surface settles). The request lives in the app window's memory for 15 s.
- **Not running.** A calm state says why (draft, calibrating, paused, harvesting, archived), points to the Overview, and shows the last verdicts. A paused study with workers still finishing shows the full view.

### What the view shows

- **Header.** Live or not running (a dot that pings while running, and the word), the status line, best vs. base in the improvement convention (highlighted with "best moved" for a moment when it moves), candidates used, workers and W.
- **Worker lanes.** Idea number, title and theme; the phase in words with its glyph; time in phase and since spawn; submissions used of the maximum; the candidate it waits on and where (for example "c/4 queued, 2nd for the bench"); a row of step segments with the current one marked. Selecting a lane shows that worker's transcript (`ThreadChat`, timeline variant, read only), one at a time; Escape or Close hides it, and it stays readable after the worker finishes.
- **Pipeline.** Submitted → Tests → Queue → Bench → Verdict / Promoted. In-flight cards plus the last five verdicts and four promotions. Cards carry the stage in words, time in stage or queue position, pair progress on the bench, and the verdict with its glyph and the improvement ("23.4% fewer ops") once known. A card opens the candidate.
- **Bench strip.** Per host: health in words, what it measures (candidate, measuring or confirming, pair i of ≤n, elapsed), or a drift check, or idle; how busy it was over the last 10 minutes of running time (this study's bench intervals); the shared queue behind it.
- **Up next.** The next six queued ideas in board order (pinned, priority, age), with a count of the rest.
- **What just happened.** Plain sentences from events ("c/14 tests passed in 41 s, queued for the bench", "c/13 lost: 0.4% more ops (worse)", "Best moved: c/12 promoted, workers notified"), grouped by candidate with the newest group last, auto-scrolling unless the human scrolled up.

### Motion and accessibility

- **Motion.** Cards glide between columns and an idea glides from Up next into its worker's lane (FLIP with the Web Animations API, keyed by `card-<n>` and `idea-<id>`, positions relative to the view so scrolling isn't motion); new items fade in; pair bars and utilization ease; the running dot pings; the current phase segment pulses; a verdict briefly rings its card.
- **Reduced motion.** Under `prefers-reduced-motion` nothing moves (WAAPI is skipped, CSS uses `motion-safe:`/`motion-reduce:`). Animations are also skipped when the page renders no frames (a one-per-second animation-frame heartbeat): a hidden tab would otherwise leave items frozen at their first keyframe.
- **State in words and shapes.** Phases, stages and verdicts carry a word and a glyph; color is never the only signal. Lanes, cards, queue chips and buttons are keyboard reachable with focus rings and labels that read the state ("Worker on idea #3, Memoize fib: being measured for 42 seconds, submission 1 of 2, c/2 measuring. Show its transcript."). The feed is a `log` region (not announced on every line); the status lines are polite live regions.

### Data model

Append-only migrations: `threads.phase`, `phase_at`, `activity`, `activity_at`, `activity_seq`. New events `candidate.stage`, `worker.phase`, `measure.progress`, `drift.started`; extended payloads of `measure.started`, `measure.finished` and `idea.added` (above). New RPC `study.live` and `thread.study`; the thread badge view gains `state`.

### For part 2

- **Replay.** Build a view at time t from `store.eventsAsc(studyId, { untilAt })`: `replaySkeleton` gives phases, stages, verdicts, pairs, best, queued ideas and bench occupancy; `feedItems` turns any slice of events into the feed; titles come from `idea.added` (or the ideas table), effects from `candidate.verdict`. Times in stage and phase come from the same events (`candidate.stage`, `worker.phase`).
- **CI band per measurement.** Samples have per-pair values with timestamps (`samples.at`, run, pair, side) for every finished measurement; `measure.progress` marks the coarse steps. Samples of a measurement that restarted are deleted with it.
- **Last action per worker.** The port already reads each item's kind, command (first 300 characters) and tool name; only the class is stored. Persisting a short label (for example `threads.last_item` plus an event when it changes, rate-limited like phases) gives part 2 its line.
- **Best moved.** The `best` delta and the header highlight exist; a bigger moment can hang off the same delta.

### Smoke test (BB 0.45, one MacBook, toy repos under /tmp, a temporary project)

- **Toy.** The M3 toy: `src/toy.py` with a naive sum, a recursive fib and a quadratic dedupe; the metric is opcodes of `toy.run()` counted by a protected `bench/measure.py` with 1% synthetic noise; the gate is a protected test. Noisy class, `n_min` 5, `n_max` 12, `max_workers` 3, local bench, health checks off (a busy laptop), default provider. Studies 2 and 3 added a 6 s gate and 1 s per run so every stage stays on screen for a while.
- **Runs.**

  | Study | Candidates | Verdicts | Best vs base | Events replayed |
  |---|---|---|---|---|
  | `toy-live` | 6 | 4 wins, 1 inconclusive, 1 conflict | 99.5% fewer ops (210×) | 161 |
  | `toy-live2` | 6 | 4 wins, 2 inconclusive | 97.3% fewer ops (38×) | 200 |
  | `toy-live3` | 8 | 6 wins, 2 conflicts after best moved (one measurement restarted by a plugin reload) | 100.0% fewer ops (35,057×) | 279 |

- **Replay parity on the live database.** For all three studies, `replaySkeleton` over the recorded events equaled `skeletonFromDb` on a copy of the plugin database, including the measurement that a plugin reload restarted.
- **Seen in the app.** The Live tab opened by default once the study ran (and Overview while calibrating or paused); lanes went starting → reading → testing → editing → waiting → being measured → verdict → refining → finishing; cards moved Tests → Queue → Bench → Promoted or Verdict, with queue positions and pair counts; the bench strip showed pair i of ≤12 and utilization; "Open beside the study thread" opened the panel beside the study thread, which survived a reload; "Study live view" appeared in the thread's right-panel launcher; selecting a lane showed the hidden worker's transcript live.
- **Found and fixed during the run.** BB caps a thread events page at 100 rows (the first build asked for 200 and got HTTP 400, so no activity was recorded); workers edit through shell heredocs, which the first classifier read as reading; animations started in the hidden automation tab froze cards at their first keyframe (now skipped without rendered frames); the Live tab's six columns overflowed beside an open side panel (now compact under 760 px); the feed said "Best moved" before "won" (promotion is recorded first; the feed now tells the win first).
- **Evidence.** Screenshots, timelapses built from timed screenshots, and contact sheets are in the building thread's storage (`shots/`). They were captured from a hidden automation tab, which doesn't repaint animated layers, so they were taken with `prefers-reduced-motion` emulated; the motion itself is covered by tests.
- **Cleanup.** All three studies and their threads were archived, the temporary project and `/tmp` files deleted, and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Activity is a heuristic.** A provider that edits through a tool name the classifier doesn't know, or a worker whose thread emits no tool items, stays at "reading" until it submits. Short activities can be skipped by the 3 s dwell.
- **Coarse pair progress.** At most one progress event per 2 s per candidate, so a fast benchmark jumps by several pairs.
- **Up next is approximate.** It shows board order; the scheduler's theme-diversity cap can pick a later idea first.
- **Utilization** counts this study's bench intervals only, not other studies sharing the host.
- **Open beside** relies on the header badge mounting in the same app window within 15 s.
- **Visual motion** is checked in tests (jsdom with stubbed layout and animation frames); it was not watched or recorded in a visible window, because the only window available to the build was a hidden automation tab.
- **Reload during a measurement** logs "The database connection is not open" from the old instance's in-flight jobs before the new instance reconciles (pre-existing; the measurement restarts cleanly).

## Implementation notes: live view (part 2)

Part 2 of the Live view: a CI band per measurement, a "last action" per worker, a visible "best moved" moment, replay of any study, and two fixes from part 1's list. Same platform pins (BB 0.45.x, SDK 0.6.14). The view stays read only.

### The CI band

- **What it shows.** For each measurement on the bench (and for 30 s after one ends, so its decision stays on screen), the estimate and its CI after every pair against the zero line and the win threshold (the measurement's MDE). The sequential test's regions are shaded: below zero (a CI entirely there is a loss), between zero and the threshold (continue), above the threshold (a CI whose low end gets there is a win). Pairs before `n_min` are hatched ("no decision before pair 6"); their CI is drawn faintly, for orientation. Where the test stopped is marked on the chart and said in words: "Decided after 9 of 20 pairs: win · CI +2.1% to +7.9%". The confirmation run is a second panel with its own band. The sentence under each chart is also the chart's accessible name.
- **Consistency with the real decision (decision).** The decision's bootstrap used the study's shared generator, so nothing could recompute its CI later. The sequential test now takes a generator seeded per (candidate, run, pair) (`ciSeed`, FNV-1a of the three, passed to the noisy strategy as `ciRng`). Recomputing from the stored samples with the same seed and the same number of resamples gives the decision's CI to the bit at every pair from `n_min` on (tested at every pair of simulated measurements, and live: the band's last point equals the candidate's stored CI). A seeded bootstrap per step is as valid as one stream; only reproducibility changed. Before `n_min` the decision computes no CI; the band's preview CI there uses at most 400 resamples. Alternatives rejected: storing the CI at each step as an event (more events for nothing the samples don't already say), or a cheap approximate CI (it would disagree with the verdict at the moment that matters).
- **Cheap enough to be live.** `LiveRecorder.band` keeps a per-candidate cache: it loads only samples after the last one read, and reuses the points already computed (a point is recomputed only when its pair is new). A restarted measurement (its samples deleted and new ones written) is noticed by its lowest sample id and starts over. When a measurement ends, its band is stored with the candidate (`candidates.band_json`, with the verdict's guardrail checks), so later views and replays read it instead of recomputing. Bands of measurements decided before this change are recomputed from their samples, marked "recomputed: can differ slightly from the verdict's CI", and cached in memory (views are read only, so nothing is written back).
- **Pair by pair.** Each completed pair pushes a `band` delta with the new point (no event: bands come from samples). It is applied whatever the snapshot's event id (a point is idempotent by its pair number) and advances the card's and the bench strip's pair count, so the count no longer jumps by the 2-second progress events; on refetch, pair progress is the larger of the events' count and the band's (`mergeProgress`), so it never steps back.
- **Other classes.** Deterministic: the one run against the tolerance, as a number line with lose / within tolerance / win zones and the raw values. Expensive: the baseline runs (relative to their median), the screening run against the ±z·σ·√(1 + 1/m) band, then the confirmation runs' running mean against the tighter ±z·σ·√(1/k + 1/m) band, with the same thresholds the strategy uses.
- **Guardrails, compactly.** Under each band, one row per guardrail: the step's CI as a bar against its limit and the total's against its own, with the state in words (ok, inconclusive, BROKEN; "so far" while running). While a noisy measurement runs, the estimate comes from the per-pair regressions so far (pooled over both runs during the confirmation, like the verdict) with 400 resamples; once it ends, the verdict's own checks replace it.

### Last action per worker

- **The label (`src/action.ts`).** From the same tool items the phase classifier reads, plus the file paths an item names (`fileChange` changes, `fileRead` and `search` paths, a tool call's path arguments), never message text: "editing src/toy.py", "editing 3 files", "reading 3 files" (consecutive reads are summed), "searching the code", "running pytest -q", "submitting a candidate". Shell commands are unwrapped (`bash -lc`, leading `cd`), heredoc bodies and inline scripts are dropped, a compound command is labelled by its strongest part (an edit, then a program run, then reads).
- **Sanitized.** At most 80 characters; paths relative to the worker's worktree (other absolute paths keep their last two segments); environment assignments dropped; values of secret-looking flags (`--token`, `-pSECRET`, `--password=`), key=value pairs named like secrets, bearer tokens, known token prefixes (GitHub, OpenAI, Slack, AWS, Google, GitLab, npm, JWTs) and long hex/base64 runs replaced by "…"; URLs reduced to their host. Tested against a list of hostile commands.
- **Recorded.** The latest label is stored on the thread row (`threads.last_action`); the recorder appends a `worker.action` event when it changes, at most one per 3 s per worker (`liveActionMs`), the latest label winning after the wait. The view shows the recorded label (with "0:12 ago"), so live and replay agree; the delta carries the label (at most 80 characters).

### The "best moved" moment

- When a candidate is promoted: its card lands in Promoted (the existing glide), the header's best-vs-base number counts up to the new value over 0.9 s and says "best moved: c/N" for 4 s, the trajectory sparkline (best vs base after each promotion) steps, and the lanes of the other live workers say "best moved: rebases on next submit" for 6 s. The view model carries `best.value`, `best.movedAt`, `best.history` and `best.rebases` (live workers past spawning and not finishing, except the winner's); the moment is derived from the view's own clock, so a replay shows it at the right time too.
- Calm by design: no confetti, one highlight color, everything stated in words. Under `prefers-reduced-motion`, or when the page draws no frames, the number jumps and nothing moves.

### Replay

- **Data (`study.replay`, `replayBundle`).** The event rows replay reads (payloads trimmed to the fields used), every measurement's band, and immutable metadata: ideas (title, theme, source), worker rows (lane key, thread, spawn time), candidates (idea, thread, title), bench hosts and their busy intervals. About 120 bytes per event. New `submission.refunded` events (a conflict refund) keep the submission count right; `measure.finished` now carries the effect.
- **Model (`src/replay.ts`, pure, runs in the app).** `ReplayModel` reduces the events once, keeping a copy of the reduced state every 256 events. The view at time t restores the nearest keyframe at or before t and applies at most 256 events; playing forward applies only the events since the last frame. `viewAt(t)` returns the same `LiveView` the live page renders, so the same components draw it: lanes with phases and last actions, cards with their pair counts, the bench strip with utilization, Up next in pick order, the feed (told once over the whole study and cut at t), the bands cut at t (`bandAt`), and the best-moved moment. Synthetic 10k-event study: build 6.5 ms, a random seek 0.15 ms (p95), a 600× playback frame 0.06 ms (p95) on this machine; the test's budgets are 1.5 s, 16 ms and 8 ms.
- **Parity.** A recorded run in the tests (three workers, two promotions, last actions, a pause) took a live view snapshot at 30+ moments; the replay at each moment's time equals it on every compared field (lanes, cards, queue, bench, bands, Up next, feed, best and its history, counts), forwards and in a scrambled order. Live: in the smoke test, 155 of 155 `study.live` snapshots of one study and 111 of 116 of another equalled the replay at their times; the 5 differences were all during a measurement interrupted by a plugin reload, whose samples were deleted (below).
- **Player and scrubber (`src/app/live/Replay.tsx`).** A timeline with event density (120 bins), milestone markers (wins, best moves, pauses and resumes, segment and harvest starts; thinned when they would overlap), the position, and wins as thin lines; click or drag to seek. Play/pause, 1×, 10×, 60× (default) and 600×, "Next win" (lands 3 s before it so the moment plays), and the keyboard: Space or K, ←/→ (1% of the span, Shift 10%), Home/End, N/P, 1-4 for the speed, Escape to leave. Playback is time-based (animation frames, with a timer when the page draws none); the board re-renders at most every 120 ms or when an event lands, while the scrubber follows every frame; glides, the band's growth and the count-up play only while playing at 60× or slower, never on a seek.
- **URL.** `studies/<slug>/live/replay[/<ms since the study's first event>]`, updated with `replace` on pause and seeks and every 2 s while playing, so a moment can be reopened and back doesn't step through positions. Without a position the replay starts at the beginning and plays.
- **Entry points.** The Live header's Replay button (a running study rewound; "Back to live" and "Update" to load what happened since), the not-running state's "Replay this study", the Overview's Replay button, and a Live/Replay switch in the side panel (the panel keeps its own position and links to the page at it).
- **Transcripts.** Not time-synced. In a replay, the selected worker's transcript is its current `ThreadChat` timeline with the note "Current transcript, not at this moment". Checked live: it renders for archived worker threads too.
- **What replay can't show.** A measurement that restarted (reload, host worker exit, best moved during it) had its partial samples deleted, so replay shows that attempt's pair count from events but no band; health readings and the next health check time aren't events (the bench strip shows online/offline and the last health result from `bench.*` events); the status line is a shorter one built from the replayed state.

### Fixes from part 1's list

- **Up next follows the scheduler.** `scheduler.upNext` applies `pickIdea` repeatedly, each pick counted as running for the next, so the theme cap and the no-repeat rule order the list as spawns will; ideas the policy skips follow in board order with the reason ("waits: 1 running on algo", "repeats an idea that lost"). Tested against successive real picks.
- **No database access after dispose.** On reload, BB disposes the old instance, then closes its database; the old instance's measurement jobs were still awaiting bench runs and logged "The database connection is not open" when they resumed. `Engine.dispose` (a `bb.onDispose` hook) now marks the context disposed, aborts in-flight measurements and harvests, stops the live recorder, and closes the store: any later access throws a quiet `StoreClosedError`, the pipeline's catch paths return without writing, and the old instance's log is dropped. Tested with the SDK harness (`lifecycle.reload` during a blocked measurement: no log, no write, the new instance restarts the measurement) and live (a reload mid-measurement logged only the new instance's reconcile).
- **Pair progress** moves pair by pair (the band deltas above), though `measure.progress` events stay coarse.

### Motion, found in the smoke test

- **Frozen glides.** A BB browser tab that isn't composited still runs an animation frame about once a second, which fooled part 1's heartbeat; animations started there stayed at their first keyframe (cards invisible or far away). The heartbeat now requires two frames within 100 ms, and every animation is finished by a timer shortly after it should have ended.
- **Runaway glides.** A glide measured an element's position through a glide still in flight, so at 8 renders a second each new offset included the previous one (6.7e7 px after a few seconds of replay). Positions are now measured without the in-flight translation, a move restarts from where the element is seen, and an element that didn't move keeps its glide.

### Data model

Append-only migrations: `threads.last_action`, `last_action_at`, `action_recorded`, `action_recorded_at`; `candidates.band_json`. New events: `worker.action` (worker, thread, label, item time), `submission.refunded`; `measure.finished` gains `effect`. New RPC `study.replay`. New realtime deltas `action` and `band`. The noisy strategy takes `ciRng`.

### Smoke test (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** A program whose cost is spread over parts of 0.4% to 42% of the opcodes (a bubble sort, a linear `contains`, a loop sum, a recursive fib, a character-by-character parser, a string join), so ideas have small and large effects. Metric: opcodes of `toy.run()` with 4% synthetic noise per run (3.6% per pair after pairing; MDE 2.0-2.4% at 20 pairs); guardrail `mem_kb` (tracemalloc peak, 1% noise; limits 10% per step, 15% total). Noisy, `n_min` 6, `n_max` 20, about 1 s per run. `max_workers` 3; `max_candidates` 8 and 7.
- **Runs.** `toy-live4`: 8 candidates, 5 wins, 2 losses on the guardrail (set-based dedupe and `sorted()` at +24-51% memory), 1 inconclusive after 20 pairs; 95.8% fewer ops (24×). `toy-live5` (only moderate ideas): 2 wins at 5.5% and 4.4% (decided after 11 and 18 pairs, then confirmed with 9 and 7 fresh pairs), 4 inconclusive after 20 pairs, 1 guardrail loss; 9.7% fewer ops.
- **Band equals verdict.** For all 15 measured candidates of both studies, the stored band's last point equals the candidate's CI to 1e-12, and the confirmation band's last point equals the confirmation CI in the verdict's reasons.
- **Seen.** Bands narrowing pair by pair to "decided after 18 of 20 pairs: win" and "decided after 20 of 20 pairs: inconclusive", confirmation panels, guardrail rows going BROKEN; last actions ("submitting a candidate 0:30 ago", "running python3 -c …"); best moving with the count-up (5.5% → 9.0% → 9.7%), the sparkline step and the rebase chips; Up next with "waits: 1 running on data"; the side panel live and switched to Replay; replays at 60× and 600×; a reload mid-measurement with no database error.
- **Evidence.** Screen recordings (CDP screencast frames encoded with ffmpeg) and contact sheets in the building thread's storage (`video/`, `shots/`): the CI band narrowing (live), a win with its confirmation (live), the best-moved moment (live), a whole run, the side panel live and in replay, and replays at 60× and 600×. The screencast makes the hidden automation tab draw frames, so unlike part 1 the motion itself was recorded.
- **Cleanup.** Both studies were archived with all 16 threads, the temporary project and `/tmp` files deleted (including scratch files the workers wrote to `/tmp`), and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Replay of restarted measurements** has no band for the interrupted attempt (its samples are gone).
- **Huge effects flatten the band.** A 90% win makes the scale span 0 to 98%, so its (tiny) CI is a line; the words carry the numbers.
- **Event density only, no zoom.** A study of many hours puts minutes into one scrubber pixel; seeking by keyboard steps 1% or 10%.
- **Last action is per batch of items.** BB announces thread events about once a second; a worker that does three things in that second shows the last one.
- **Workers write outside their worktree.** Agents in the smoke test left scratch files in `/tmp`; the plugin doesn't sandbox them.

## Implementation notes: v0.2.1 fixes

Small fixes before the marketplace submission; no new features. Same platform pins (BB 0.45.x, SDK 0.6.14).

- **Noise per class (Oracle tab).** `noiseFloorText` (`src/present.ts`) says the calibrated noise for the oracle's class: per pair (noisy), the σ of one run (expensive), or none (deterministic: single runs judged against the tolerance, so no MDE sentence). Without a noise floor (an imported study has no A/A calibration) it says "not measured"; the old sentence took `Math.max` over a null floor and printed "0.00% per pair". The view's host and segment floors are null when missing or not finite.
- **Why a verdict isn't the primary metric's.** `verdictCause` reads the verdict's own reasons: a primary-metric win that broke a guardrail is "lost on guardrail mem_kb (27.6% worse)" (or "… than the segment base" when only the total limit broke), a holdout failure "lost on the holdout check", and failed gates, conflicts and scope rejections their reason. Pipeline cards, the Candidates list and detail, Findings, the feed ("c/3 lost on guardrail mem_kb (27.6% worse), despite 43.3% fewer ops"), the CLI and replay show it instead of, or next to, the primary number. The `verdict` delta carries it; replay bundles carry it precomputed (their reasons are trimmed to the first one).
- **Single runs.** A point CI (deterministic) reads "single run, no CI" and "+20.0% (single run)" in tables, never "+20.0% to +20.0%". Measurement progress is per class (`progressText`): pairs for noisy, "running best" / "running the candidate" / "run 1 of 1" for deterministic, "run 2 of ≤4" for expensive; the live view carries the noise class (`LiveView.noise`, the replay bundle's `spec.noise`). The deterministic band reads "Single run: +2.00% vs best, better by more than the 0.50% tolerance: win", and the feed says "measured: one run each".
- **Status line and Overview.** A candidate on the bench is counted as measured, not queued: "Running: 2 workers editing, measuring c/1, 1 queued for the bench, 1 in tests." (`runningStatusText`, shared by the live status line and replay). The Overview's "Now" hint depends on the state: "no workers before the study starts" only for draft and calibrating; paused, harvesting and archived say what they mean.
- **Lanes link through the worker row.** `candidates.worker_id` (append-only migration) records the `threads` row that submitted a candidate; the live view, the recorder's phases, the Overview's workers and replay link lanes to candidates through it, with the BB thread id as the fallback. The migration backfills existing rows from the BB thread id, then from `worker.phase` events (which record each worker's latest candidate). A worker row without a BB thread id now shows its submissions and "c/N measuring" (it showed "submission 0 of 1" and never its candidate). The submit event carries `worker_row`.

## Implementation notes: single-machine mode

v0.2.2. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Why

On a laptop the edit host is also the bench host. Gates (tests, type checks, renders) ran in parallel outside the bench lock, so a 2-3 minute gate could run next to a 15 s timing run and add noise to it. The health check before a measurement only defers it when the machine is already loaded; it can't stop a gate that starts a second later.

### The shared lock

- **Detection** (`src/single-machine.ts`). `[oracle] single_machine = "auto"` (default) is on when one of the study's resolved bench hosts is the edit host (`"local"`, the default, or the edit machine's own name or id) and the noise class takes the bench lock (`noisy`, `expensive`). Before the bench hosts are resolved (a draft), the spec entries decide: empty or `"local"` means the same machine. `"on"` forces it (gates take the edit host's lock key even when no bench host shares it, which only serializes gates with each other; a spec warning says so), `"off"` disables it. Deterministic oracles stay off under `auto` (their measurements don't take the machine-wide lock) and get a warning under `"on"`.
- **One queue** (`Pipeline.launch`). Gating candidates of single-machine studies join the bench work list with the queued candidates of every study. The list is sorted by when each candidate started waiting: `queued_at` for a measurement (and for a candidate re-gated after best moved, which keeps its place), `submitted_at` for a first gate. Each lock key gets one holder per pass: a gate takes its edit host's key, a measurement the first free, online, healthy host of its study. A key is busy while a measurement, a drift check or a serialized gate is launched on it. Calibration, profiles and harvest measurements take the same `HostMutex`, so they never overlap either.
- **The whole gate stage holds the lock.** Rebase (`prepareCandidate`) and gates run inside `withBench(..., "gate", candidate)`, so a candidate is never gated against a best that moved while it waited. Gate-less specs don't take the lock.
- **Calibration and harvest.** The base gates in calibration and every harvest gate run through `withGateLock`: under the lock in single-machine mode, directly otherwise. The calibration report says how long a candidate occupies the bench (gate + one evaluation) and what the mode does.
- **Bench intervals.** Gate spans are `bench_intervals` rows of kind `gate`. Utilization counts them (the views also report how much of the busy time was gates) and the overlap audit checks them against measurements on the same lock key. `gate.started` and `gate.finished` events (single-machine mode only) let the live view and replay show "testing c/N" on the bench host.
- **Scheduling.** `evalTimes` (pipeline.ts): with serialized gates, `T_eval` is the mean of gate + measure seconds over the last 20 decided candidates that used the bench (gate failures included: their gate occupied it), falling back to calibration's eval + gate seconds. `candidates.gate_seconds` records gate time always. Backpressure already counted gating candidates as bench queue; in single-machine mode they are the part of the queue waiting to test. Gate time doesn't count against `max_bench_hours` (that budget stays measurement time).

### Quiet bench

- **What it does.** `[oracle] quiet_bench = true`: while a measurement (or calibration, drift, harvest or profile run) of such a study holds a machine's bench lock, the `message.dispatch` hook answers `wait` for a new turn (`attempt: "start-turn"`) of an autoresearch worker whose environment is on that machine, with a reason naming the candidate, the host and the study, and a 10-minute `sendAt` as a safety net. `withBench` calls `bb.experimental_hooks.recheck("message.dispatch")` when the measurement ends; reconciliation calls it once on load.
- **What it doesn't.** Running turns (`join-turn`) are never held, and nothing else is: the study thread, human threads, other plugins' threads. It holds turn starts only; a turn already running keeps running its tools.
- **Bounded wait (decision).** A held turn starts once any measurement on that machine has ended since it was first held, even if the next one already began. Without that, a saturated bench would hold workers until the queue drained (no submissions, so it would, but only then). Each held thread's first hold time is kept in memory; a plugin reload forgets it, which at worst holds a turn for one more measurement.
- **Spawns (found in the smoke test).** A worker's first turn is dispatched while `threads.spawn` is still in flight, before the worker row knows its thread id, so the first version proceeded for every spawn. The hook now also holds a thread whose `originPluginId` is this plugin (only workers are spawned by the plugin). `quiet.held` and `quiet.released` events record each hold.
- Neither setting is part of the oracle hash: toggling them applies with `bb study approve`, without recalibration.

### Surfaces

The Oracle tab has a "Single-machine mode: on/off" section with the reason and what it does; the calibration report, `bb study show` ("Single machine" and the scheduler line's "tests + measurement") and the Overview say the same. Bench hosts on the Overview and Bench tab read "testing c/N (single-machine mode: tests hold the bench)" while a gate holds them; the status line says "testing c/N on the bench"; the Live bench strip shows the gate as the host's current work, marks queued candidates waiting to test ("c/4 tests"), and its feed says "c/4 waits to run its tests on the bench", then "tests started on <host>, holding the bench".

### Commit identity

`[git] identity = "repo" | "plugin"` (default `"repo"`, not part of the oracle hash). The host ops used to force `autoresearch <autoresearch@bb.local>` on every commit they made in the studied repository. Now the snapshot, prepare, reword (promotion) and compose (harvest) ops take an explicit identity. `Pipeline.commitIdentity` resolves it on the edit host with a new `gitIdentity` host op (`git config user.name` / `user.email` in the repo, without the plugin's environment: repo-local, then global), caches it for a minute, and passes it to every commit. No identity configured: the plugin's, a calibration warning, and one `git.identity` notice. Bench hosts never commit; they receive the edit host's commits as bundles, so their clones carry exactly the same author and committer (tested with real git).

### Fix: protected paths in the oracle hash

The oracle hash is meant to fold in the content of the `[scope] protected` paths at the baseline, so that editing a protected benchmark starts a new segment. Calibration ran `git ls-tree -r <base> -- ':(glob)bench/**'`, but `git ls-tree` doesn't support glob pathspec magic (it exits with "pathspec magic not supported by this command"). The output was empty, so every study hashed the same empty content and editing the benchmark never changed the oracle hash. The smoke test above showed it: two studies calibrated before and after an edit to the protected `bench/measure.sh` got the same hash.

A new host op, `protectedHash`, now lists the whole tree at the baseline (`git ls-tree -r -z --full-tree`), filters it with the scope check's own glob matcher (so `bench/**`, `bench/*.sh`, `**/*.txt` and a bare `bench` mean the same as in scope checks), and hashes the sorted `mode sha path` lines. Protected globs that match nothing hash as a distinct value, and calibration warns about them (probably a typo). A spec without protected globs hashes as before. Studies calibrated before the fix get a new oracle hash the next time they recalibrate. Checked live on a toy repo with `protected = ["bench/**"]`: calibrating before and after a commit that edits the protected `bench/measure.sh` gave two different oracle hashes (`c8ef369f…` and `4b572b37…`).

### Data model

Append-only migrations: `candidates.gate_seconds`, and an index on `bench_intervals (host_id, ended_at)` for the hook's open-interval lookup. New events: `gate.started`, `gate.finished`, `quiet.held`, `quiet.released`, `git.identity`. New bench interval kind: `gate`.

### Smoke test (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** A Python `toy.run()` (a bubble sort, a list-based unique count, a recursive fib). Metric: wall-clock ms, the best of as many runs as fit in about 1 s (about 16 s per evaluation, noise floor 1.6-3.8% per pair). Gate: the unit tests, then every core burning CPU for 3 s (about 3.2 s). Noisy, `n_min` 4, `n_max` 8; `max_workers = 2`; `max_candidates` 4-5; `single_machine` left at `auto`, `quiet_bench = true`. A repo-local git identity was set in the toy repo.
- **Three studies.** `toy-sm` (0.25 s measurements, to check the path quickly), `toy-sm2` and `toy-sm3` (16 s measurements). 14 candidates: 12 wins, 2 conflicts.
- **No overlaps.** Across the three studies, 34 bench intervals on one lock key (3 calibration gates, 3 calibrations, 15 candidate gates, 13 measurements; a re-gate after best moved, the measurement it cut short, and two conflicted candidates' sub-second gates included): a self-join on the lock key finds 0 overlapping pairs, and `bb study show` reports 0 overlapping bench intervals.
- **FIFO, live.** In `toy-sm`, c/2 was submitted while c/1 was being measured; its gate started 2 ms after the measurement ended. In `toy-sm2`, c/2 arrived during c/1's gate and gated right after it, before c/1's measurement (queued later); after c/1 won, c/2 was re-gated against the new best. In `toy-sm3`, c/2 arrived 0.5 s after c/1 was queued, so c/1's measurement went first and c/2's gate waited 21 s.
- **Utilization.** `toy-sm`: busy 26.5% of Running time (44.4% since the first submission), 13 s of the 21 s busy were gates. `toy-sm2`: 67.2% (85.0% since the first submission), 16 s of 101 s gates. `toy-sm3`: 60.1% (75.6%), 13 s of 97 s gates. The scheduler line read "eval ≈ 24 s (tests 3.2 s + measurement 21 s, single-machine mode)".
- **Quiet bench.** `toy-sm2` ran on the first build and held nothing: two workers spawned during measurements started at once (the spawn case above). After the fix, in `toy-sm3` both workers spawned during a measurement were held (17.4 s and 19.0 s) and started within 50 ms of the measurement's end.
- **Identity.** Every commit on the three `studies/<slug>/best` branches and under `refs/studies/<slug>/c/*` was authored and committed as the toy repo's own identity.
- **Cleanup.** The studies were archived with their threads, the temporary project and `/tmp` files deleted, and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Gates run one at a time** in single-machine mode, even though gates don't disturb each other's results. A readers-writer lock (gates share, measurements exclusive) would let several gates run between measurements; one queue is simpler and is what the measurements need.
- **Quiet bench holds turn starts only.** A worker whose turn is already running (and runs its own tests) keeps competing with the measurement; the health check before each measurement is still the guard for that.
- **Replay shows today's setting.** The replay bundle carries the current single-machine setting, not the one in force at each moment (gate events are only recorded when it was on, so the bench strip is still right).
- **A held spawn is attributed by origin.** BB's hook context doesn't carry plugin metadata, so a thread is recognized as a spawning worker by `originPluginId` alone.

## Implementation notes: v0.2.3

Fixes from capturing the marketplace screenshots, plus two found right after: the strategist didn't know where best's code was, and archiving a running study could spawn replacement workers. Same platform pins (BB 0.45.x, SDK 0.6.14). UI, wording and view models, except the two engine fixes at the end; no statistics change.

### Live view

- **Status line by phase.** It said "N workers editing" whatever the workers did. `runningStatusText` (present.ts) now takes the workers' recorded phases and says what they do: "Running: 2 workers: 1 editing, 1 being measured; measuring c/9, 1 queued for the bench." (one phase: "2 workers editing"; none: "no live workers"). The server status line, the Live view and replay all pass phases; a worker row without a recorded phase counts by its state (starting, finishing) or as "working".
- **Worker count against W.** "3 workers (up to 2)" read like a bug: live workers include finishing ones, and W can drop below the live count (nobody is stopped for it). The header now reads "2 workers + 1 finishing · target 2", or "3 workers · target now 2 (no new worker until fewer)" (`workerCountText`). The Overview's hint says "target 2 now (W), max 3" and, when more are live, that no new worker starts until fewer than W are.
- **One queue position.** The lane counted the measurement on the bench as ahead ("c/2 queued, 2nd for the bench") while the Queue card counted the queue ("1st in line"). `benchQueueOrder` and `queuePosition` (live-model.ts) are now the one place the order and the position are decided; the lanes, cards, bench strip, Overview worker list and worker badges read them (1 = next for the bench, "1st in line"), and the lane prefers the view's queue over the server's number so a refetch can't make them disagree.
- **CI band labels.** The region names (win, continue, lose) moved into a right margin outside the plot, so they never cover the band or the decision line; the y-axis labels (0, the threshold, the domain's ends) and the region names are placed by `layoutLabels` (src/chart.ts): by priority, at least 11 px apart, a label that can't fit near its spot is dropped (0 always stays). Tests check the computed positions for four scales, including a +1.0% threshold a pixel above 0. The "pairs" axis title sits in the margin too, and the decision label no longer jumps down at the right edge.
- **Before the first pair.** The band's box was empty at "pair 0": it now says "Running best and the candidate for the first pair (in random order) of up to 20; the band starts once that pair is done" (and the same for the confirmation), and progress text says "first pair of ≤20 running" instead of "pair 0 of ≤20".
- **Expensive band in pixels.** It used a stretched viewBox, so its text was scaled; it now draws at the box's width like the noisy band (`useBoxWidth`), with column labels that shorten when columns get narrow.
- **Guardrail rows.** "no change than best vs the 10.0% limit" became "no change from best (CI 0.3% better to 0.4% worse), within the 10.0% limit · in total 2.1% worse than the segment base, within the 15.0% total limit" (`limitCheckWords`, guardrails.ts). `guardrailStatus`'s text reads "than best"/"than the segment base" (and "no change from …") instead of "vs best".

### Notices and the Overview

- **The human's own controls aren't notices for them.** The strategist's first round said "13 notices for you" when most were `control.idea_added` from the human's own CLI calls. The digest's summary counts only notices that need the human; controls are listed apart in the agent-only detail as an audit trail ("mention one only if it looks like something the human wouldn't have done"). Pre-start notices steered into the human's turn separate them the same way. All are still marked delivered.
- **State-aware actions.** A notice is stored once, but its step may be done: `noticeAction` now takes the study's state (and the latest harvest). `budget.exhausted` offers "Start harvest" only while the study is paused; while harvesting it is "Open Harvest" or "Review harvest", when running again "See budget", when archived nothing (or "Open Harvest"). `calibration.ready` after the start reads "See calibration"; `spec.proposed` without a pending spec "See the spec".
- **Trajectory chart.** It drew in a stretched 640-wide viewBox (text scaled with the width) with ticks at fifths of the data range (−7.9%, +19.1%) and no x axis. It now draws at its box's width with a fixed 10 px font, nice y ticks (1, 2, 2.5 or 5 × 10ⁿ, the domain widened to them; `niceTicks`) and labelled candidate numbers on x, spaced for the width (`trajectoryAxes`).
- **Guardrail trend.** The small trend line stretched any range to the full height, so a 0.02% wobble looked like a drop. `trendDomain` gives it at least 5% of the values' size, so a near-constant guardrail draws flat.

### Candidate detail

- **How the verdict formed.** The candidate detail shows the measurement's CI band with the Live view's component (`Measurement`, without its header): the stored `band_json` once measured (recomputed from samples for older candidates, marked as such), the live band while it is on the bench. `LiveRecorder.bandFor` picks which.
- **Which statistic.** The headline says what it is ("median of the per-pair changes, the verdict's estimate"; "single run of each side"; for expensive, "mean of the confirmation runs (or the screening run) against the median of best's runs"). The metrics table is titled "median of each side" and, when its primary change differs from the headline (6.20% vs 5.72%), a line under it says why.
- **Samples.** No inner scroll box: the first 12 rows, then "Show all 30 pairs". Rows come from `sampleTableRows` (src/sample-rows.ts) per noise class: noisy pairs numbered from 1, a deterministic measurement as one "single run" row (never "pair 0"), an expensive one as baseline runs, the screening run and confirmation runs.

### Harvest

- **No cut words or open code spans.** PR bodies clipped titles, summaries and dependency reasons mid-word and inside code spans ("Byte-i…", "a cheap `lin…"). `clipWords` (present.ts) cuts at the last word boundary and before an opening backtick whose code span the limit would cut; PR titles, bodies and the report's tables use it. Bodies are stored when drafted, so harvests drafted before v0.2.3 keep their old text.
- **Signs.** "best with this change reverted is +22.00% worse than best" is now "… is 22.00% worse than best" (or "better", or "measures the same") (`revertedWords`).
- **"It".** "Builds on #5: reverting it from best fails while this one stays" named neither; it now reads "Builds on #5: reverting #5 from best fails while this changeset stays."

### Replay: health checks

Replay showed every bench host as "not checked yet": only unhealthy streaks were events. Every health check now appends a `bench.health` event (host, ok, context; append-only), replay applies it, and the bench strip says "health checks off" when the spec disables them, "health not recorded" in replays of studies from before v0.2.3 (no `bench.health` event at all), and "not checked yet" only when none has run yet. `benchHealthText` (live-model.ts) is the one place it is worded; the replay bundle's spec carries `healthChecks`.

### The strategist reads best through git

- **The gap.** The study thread's environment is whatever was picked when the study was created: often a managed worktree branched from the project's default branch, or the project checkout on any branch. Nothing told the strategist where best was, so as promotions landed it kept reading base and its dossier and ideas drifted from best. Workers were fine (they branch from `studies/<slug>/best`).
- **The Code block.** Every strategist round and the harvest grouping round now carry a short "Code" section (`codeLines`, prompts.ts; `Engine.codeInfo`): the study base with its commit, `studies/<slug>/best` with its commit and the promotions so far, the sentence "Your own checkout may be on another commit; read code at best this way. Don't check out or commit in your own checkout.", and the commands that read best without switching branches from any checkout of the repository (refs are shared by its worktrees): `git show studies/<slug>/best:<path>`, `git grep -n <pattern> studies/<slug>/best`, `git diff --stat <base sha>..studies/<slug>/best`, `git log --oneline <base sha>..studies/<slug>/best`.
- **Another repository.** Detecting whether the strategist's environment is a worktree of the study's repository would need the thread's environment path and a git call on its host per round, so instead the block always also gives the `git -C <study repo path> …` form, with a line saying when to use it (a different `git rev-parse --git-common-dir`, or no repository).
- **Skills.** The `autoresearch` skill's strategist section says the same; `study-create` says the study thread may run in any environment of the project, because it only reads code and reads best through git.

### Archiving a running study spawned replacement workers

- **Seen live.** `control.archive` at t, the two live workers marked abandoned 0.2 ms later, then `worker.spawned` twice at t + 0.3-0.7 s (new ideas, new threads), and `study.state running → archived` only at t + 43 s, after the bench checkouts were removed. Each ended worker kicks the control loop, and the loop still saw a Running study with free slots and queued ideas. The two new workers kept running until stopped by hand.
- **Fix.** `archiveStudy` changes the state first, in one transaction with finishing the strategist row, before cancelling the harvest, stopping workers or removing checkouts. The control loop re-reads the study after its awaits before deciding to spawn (it used the row read at the start of the pass). `spawnWorker` re-checks the state after its own awaits and before asking BB for a thread (the row is marked failed and its idea re-queued), and again when the spawn resolves: if the study left Running meanwhile (paused, harvesting, archived), the new thread is stopped and archived at once (`worker.spawn_discarded`; the idea goes back to the queue unless the study is archived), and if the row was ended while the spawn was in flight (the archive ends spawning rows too) its late thread is stopped and archived the same way. Reconciliation finishes stopping live workers of an archived study (an archive interrupted mid-cleanup).
- **Pause and harvest** already changed the state synchronously before anything else; they shared only the late-spawn race, which the same check covers. A pause still lets running workers finish.
- **Tests.** Archiving with free slots and five queued ideas records no `worker.spawned` after it starts, and its `study.state` event comes before the first `worker.abandoned`; a spawn held until after the archive (and one held until after a pause) ends with its thread stopped and archived and no second `worker.spawned`. All three fail on v0.2.2.

### Live check (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** `src/toy.py` (a loop sum, a recursive fib, a quadratic dedupe, a bubble sort); the metric is opcodes of `toy.run()` counted with `sys.settrace` and 1% synthetic noise, guardrail `src_lines`; noisy, `n_min` 4, `n_max` 10; single-machine mode on (auto). Study 1: `max_workers` 3, `max_candidates` 6, four ideas added from the CLI. Study 2: `max_workers` 2, `max_candidates` 20, six ideas, archived as soon as two workers were live.
- **Status line.** Read every few seconds: "Running: 3 workers: 1 reading the code, 1 being measured, 1 reading a verdict; measuring c/3.", "… 1 refining, 1 waiting for the bench, 1 being measured; measuring c/4, 1 in tests.", "Running: 1 worker finishing." The view's counts carried `finishing` (2 of 3 at one point).
- **Before the first pair.** A measurement at pair 0 had a band with no points (the placeholder case) and progress "first pair of ≤10 running".
- **Notices.** Round 1 said "1 notice for you" (calibration ready) with six control notices (four ideas added from the CLI, calibrate, start) listed apart as the audit trail. On the Overview, `calibration.ready` offered "See calibration" once started; `budget.exhausted` offered "Start harvest" while paused on the budget and "Open Harvest" once the harvest ran.
- **Code block.** Rounds 1 and 2 carried it with the base commit, then best's new commit and "2 promotions so far", and the `git -C <study repo path>` form.
- **Candidate detail and replay.** `study.candidate` returned the stored band (10 pairs, exact) and "median of the per-pair changes, the verdict's estimate"; the replay bundle carried 12 `bench.health` events and `healthChecks: true`.
- **PR bodies.** A long summary was clipped at a word boundary with its code spans closed ("… `list(dict.fromkeys(xs))` … dedupe order…"), and the ablation read "best with this change reverted is 100.00% worse than best". Findings in PR bodies used the old clip and were switched to `clipWords` after the run.
- **Archive.** Study 2: `control.archive` at t, `study.state running → archived` at t + 3 ms, the two workers abandoned at t + 3 ms and t + 2.1 s, no `worker.spawned` after t; both worker threads and the study thread ended archived.
- **Seen, not fixed.** The toy's tracer stopped counting on the promoted best (0 opcodes, a bug in the toy's bench under Python 3.13 that the workers themselves reported), which made harvest's shares degenerate (two changesets each "100% of the gain") and the Overview call a zero-width CI of a noisy oracle "single runs, no CI". Both are what the numbers say for a metric of 0; neither occurs with a working bench.
- **Not checked live:** the rendered pages (screenshots are re-captured separately; the components are covered by jsdom tests), a spawn resolving after an archive (tested with a held spawn only), and an expensive-class band.
- **Cleanup.** Both studies archived with their threads, the temporary project and `/tmp` files deleted, and the released plugin reinstalled from GitHub (its database kept every study).

### Data model

No migrations. New events: `bench.health` (every health check), `worker.spawn_discarded`. The replay bundle's `spec` gains `healthChecks`; `LiveBenchHost` gains `healthRecord`; `LiveView.counts` gains `finishing`; the candidate detail gains `band`, `noise`, `effectStatistic` and `hostName`.

## Implementation notes: v0.2.4

Fixes from a real study and from capturing the store screenshots. Same platform pins (BB 0.45.x, SDK 0.6.14).

The study: 5.6 hours, blind, on a large repository, bench-bound (35 candidates, a median of 426 s of bench per candidate). A median candidate used 7 pairs; 15 of 35 stopped at `n_min` = 6 and 9 ran the full 20 pairs, mostly to an inconclusive. Every win also ran a confirmation (183 pairs over 23 candidates) and a 3-run holdout, and gates took 30 s under the bench lock. Two drift pauses came from the code getting about 5× faster: with single runs, per-pair relative noise rose from 2.0% to 8.8% on the same quiet machine, and a human switched the oracle to 3 rounds per side (noise 0.49%).

### Sequential test: futility and early losses

- **Futility (`[oracle.protocol] futility = true`).** After `n_min`, a measurement whose CI upper bound is below the win threshold stops as `inconclusive`: more pairs could narrow the CI but not move it above the threshold with any confidence. It is checked after the lose rule (a CI entirely below 0 is still a `lose`) and before the cap. The verdict says "effect +0.4% (CI −1.0% to +1.5%, 8 pairs) can no longer clear the 2.0% win threshold: stopped early (futility: the CI's high end is below it)". The confirmation run uses the same rule.
- **Early losses (`early_lose_from = 3`, `early_lose_confidence = 0.99`).** From 3 pairs until `n_min`, a candidate whose 99% interval is entirely below 0 is a `lose` ("… stopped early, the whole CI is below 0 before pair 6"). Before `n_min` nothing else can stop it (no early win: false wins compound). `0` turns it off.
- **Which interval (decision).** The early check uses a Student-t interval of the mean of the per-pair improvements, with an exact t quantile (`tQuantileExact`, the finite series of the t CDF for integer degrees of freedom, inverted by bisection; the Cornish-Fisher `tQuantile` is 12% low at 2 degrees of freedom). The bootstrap percentile CI of the median the test uses after `n_min` is badly miscalibrated at 3-5 pairs: a "99%" bootstrap CI of 3 pairs is [min, max], which covers the true median only 75% of the time, so "all three pairs worse" would have been an early loss. The first version did exactly that and called 5.0% of true +MDE effects a loss in simulation (v0.2.3: 1.3%). The t interval is deterministic (no resampling), valid at small n for roughly normal pair noise, and conservative with outliers, which inflate the SD. It catches large regressions only: with 2.8% per-pair noise, 98% of −8×MDE candidates stop at 3-4 pairs, 13% of −2×MDE ones.
- **The band follows (`band.ts`).** Points from `early_lose_from` to `n_min` carry the early interval (`early`), computed exactly as the decision does; `pointStop` returns why a point stops the test (`win`, `lose`, `early`, `futility`, `cap`) with the same rule as `sequentialDecision`, and `runDecision` carries the reason. The decision marker is tagged ("6 of 20 · can't win", "3 of 20 · early"), an early stop draws the interval it was decided on, and the words say why: "Decided after 6 of 20 pairs: inconclusive. Estimate +0.2%, CI −1.5% to +1.4%: the CI's high end is below the +2.0% threshold, so more pairs can't make it a win (stopped early)." Bands stored before v0.2.4 have no `futility` field and are read with the old rule, as they were decided.

### Confirmation skipped far beyond the threshold

- **The rule (`skip_confirm_factor = 3`, `confirmationSkip` in pipeline.ts).** A noisy win whose CI lower bound is at least 3× the win threshold skips the confirmation; `0` always confirms. The verdict records it ("confirmation skipped: the CI's lower bound +13.6% is 6.8× the 2.0% win threshold (skip_confirm_factor 3)"), as does a `confirm.skipped` event and the `measure.finished` payload (the feed: "c/4 measured: 6 pairs in 2 min (confirmation skipped: far beyond the win threshold)"). Guardrails are then judged on the measurement's pairs alone, and the holdout still runs.
- **Why it's safe.** A false win this far out needs the whole CI to be wrong by several half-widths at once; in simulation no candidate below 2× the threshold skipped, and at 10× the threshold all of them did (half the pairs of v0.2.3).

### Simulation

`test/v024-sim.test.ts` runs both rule sets on the same noise (common random numbers: the same noise stream and pair order per trial, and the pipeline's seeded bootstrap per pair), per-run noise 2% (2.8% per pair), threshold calibrated from 400 A/A pairs (MDE 1.35%), `n_min` 6, `n_max` 20, confirmation on; effects in units of the threshold. 1,000 candidates per cell (`SIM_TRIALS=1000`):

| True effect (×MDE) | Wins v0.2.3 → v0.2.4 | Losses v0.2.3 → v0.2.4 | Pairs per candidate v0.2.3 → v0.2.4 | Futility stops | Early losses | Confirmations skipped |
|---|---|---|---|---|---|---|
| −8 | 0.0% → 0.0% | 100.0% → 100.0% | 6.0 → 3.9 | 0.0% | 97.8% | |
| −4 | 0.0% → 0.0% | 100.0% → 96.1% | 6.1 → 5.1 | 3.9% | 51.4% | |
| −2 | 0.0% → 0.0% | 96.9% → 56.9% | 8.3 → 6.2 | 43.0% | 13.3% | |
| −1 | 0.0% → 0.0% | 63.1% → 22.0% | 13.6 → 8.0 | 74.8% | 4.3% | |
| 0 | 0.0% → 0.0% | 14.4% → 6.8% | 18.4 → 13.4 | 60.6% | 1.1% | |
| +1 | 1.7% → 1.7% | 1.1% → 0.8% | 21.0 → 19.4 | 15.0% | 0.3% | 0.0% |
| +1.5 | 13.3% → 13.4% | 0.2% → 0.4% | 22.3 → 21.7 | 5.0% | 0.2% | 0.1% |
| +2 | 44.4% → 44.5% | 0.0% → 0.1% | 21.8 → 21.6 | 1.4% | 0.1% | 0.3% |
| +4 | 100.0% → 100.0% | 0.0% → 0.0% | 12.8 → 11.5 | 0.0% | 0.0% | 20.2% |
| +10 | 100.0% → 100.0% | 0.0% → 0.0% | 12.0 → 6.0 | 0.0% | 0.0% | 100.0% |

- **False wins** (no true effect): 0.0% under both rules (the confirmation already made them rare; skipping never fires near zero).
- **False losses on true +MDE effects**: 0.8% (v0.2.3: 1.1%). Early losses alone: 0.3%.
- **Missed wins**: none measurable; win rates are the same within a trial or two at every effect (futility stops 1.4% of +2×MDE candidates, which v0.2.3 would mostly not have promoted either).
- **Bench pairs saved**: 18% over these ten cells (142 → 117 pairs per candidate summed); 27% on a null effect, 35-41% on modest regressions, 50% on 10× wins. A bench-bound study whose candidates are mostly no-effect ideas, clear losses and large wins saves more than the average.
- **The price**: a modest regression (−1 to −2× the threshold) more often ends `inconclusive` (futility: its CI still reaches above 0) than `lose`; the worker still gets the estimate and CI, and the reason says it could no longer win. The test asserts these bounds at 150 candidates per cell on every run.

### Side runs and automatic recalibration

- **Side runs (`side_runs = "auto" | N`, `min_side_seconds = 5`).** Noisy oracles only: each side of a pair is N runs of `measure`, combined by `combineRuns` into each metric's best value in its own direction (the minimum for the primary metric and guardrails when lower is better, the maximum when higher is better, the minimum for informational metrics; the usual best-of-N for timings). "auto" times one warm run of each side at calibration, after the warmup, and picks N = ⌈min_side_seconds / run⌉, at most 30 (`AUTO_SIDE_RUNS_MAX`; a faster benchmark should loop itself). The count and one run's median seconds are stored per bench host (`bench_hosts.side_runs`, `run_seconds`), in the calibration report ("Each side of a pair is 5 runs of the measure command (best of 5 per metric; one run takes about 1.0 s, so 5 make a side of at least 5.0 s)"), on the Oracle tab's segments and in `bb study bench`. Measurements, drift checks and harvest measurements use the host's count (`BenchSite.bench`); a segment calibrated before v0.2.4 has none, so it keeps single runs until it recalibrates. Expensive and deterministic oracles always run once.
- **When best's runs get much shorter (`[oracle.drift] recalibrate_below = 0.6`).** Three triggers compare one run's median time with the host's calibration, and schedule an automatic recalibration below 60% (`recalibrationTrigger`): a promotion (the winner's candidate-side runs are the new best's), any measurement (its best side), and a drift check over its limit (its best runs). The drift check's case is the one the study hit: noise up because runs got shorter is recorded as `drift.explained` and recalibrates instead of pausing; noise up at the same run time still pauses. `0` turns it off. It is a bench setting, not part of the oracle hash.
- **The recalibration (`runAutoRecalibration`, calibration.ts).** `studies.recalibrate_due` holds why. While it is due, the study starts no measurement or drift check; once none of its measurements is on the bench (in-flight ones finish), the pipeline's `recal:<study>` job calibrates best on every bench host, each under its own lock (side runs chosen again when "auto"), and opens segment k+1 with the same oracle hash and spec version, `details_json.auto = true`, without gates (best passed them), approval or a state change. An A/A median that excludes zero is a warning here (both checkouts are best), not a failure. If the new win threshold exceeds `max_mde`, the hosts keep their old calibration and the study pauses ("automatic recalibration failed (…): …"; a needs-you item "recalibrating on best's shorter runs failed"). A `segment.recalibrated` notice (informational) gives per host the side runs, one run's time, the noise floor and the win threshold before and after. Replay labels the milestone "Segment 2: recalibrated (same oracle)".
- **Guardrails across automatic segments (decision).** A new segment used to restart the guardrails' total limit at its baseline. An automatic one doesn't change the oracle, so `guardrailChainBase` counts from the first segment of the current run of segments with the same oracle hash; otherwise every recalibration would give the total limit its full room back. An oracle change still resets it.
- **Stale measurements.** A measurement whose candidate reconciliation restarted elsewhere (`measure_restarts` moved on) now stops writing (`StaleMeasurementError`): a test simulating a restart without disposing the old engine showed the old job's futility stop deciding the candidate first.

### Measurements wait while paused for drift

A drift pause left the study `paused`, and the pipeline still measured paused studies' queued candidates, so candidates already in flight were measured on the disturbed host and promoted. Now a host whose `drift_status` is `drift` starts no measurement (of that study's), and an in-flight one on that host is cancelled and restarts from scratch later. Resume clears the host's drift status; a recalibration does too.

### Best vs base across segments

The headline compounds every promotion, whatever its segment, but the raw values shown were the current segment's baseline ("3.619 → 2.039 s" next to "81.8% lower"). With more than one segment the headline now says "81.8% lower time (5.5×) across 3 segments" and the raw values "this segment 3.62 → 2.04 s" ("this segment: 2.04 s, no promotion yet" right after a recalibration): `bestHeadlineText` and `segmentRawText` (present.ts), used by the Overview, the Studies list, `bb study show`, the Live header (which now shows the raw line too) and the report. Replay counts segments from `segment.started` events. The raw values come from `metricSnapshotOf` (new `src/snapshot.ts`, shared by the views and the report).

### Live view and pages

- **Tests waiting for the bench (single-machine mode).** A gating candidate that waits for the bench lock read "tests running · 1:19" on its card while its lane said "waiting for the bench" and the queue "c/2 tests". `gatingText`/`stageText` (live-model.ts) word the Tests stage from the view's `queueTests`: "waiting for the bench to run tests" until its gates hold the bench, then "tests running", on the card, the lane and their accessible names.
- **Up next.** "waits: 1 running on algorithms" counted the idea queued ahead as running. `themeWait` (scheduler.ts) counts what really runs apart from the ideas that go first: "waits: 1 running on algo", "waits: #12 first on algo (1 at a time)", "waits: 1 running and #12 first on algo".
- **Notices "for you".** Four `best.new` notices made "4 notices for you" while nothing needed the human. Strategist digests count only actionable notices (`isActionableNotice`, prompts.ts); informational ones (`best.new`, `budget.threshold`, `stall`, `rate_limit`, `usage.tight`, `harvest.published`, `segment.recalibrated`) are listed apart under "Updates (n, informational)", and controls stay an audit trail.
- **The confirmation's placeholder.** The band's confirmation panel appeared only after its first pair. The confirmation now starts with a `measure.progress` event at 0 pairs (`run: "confirm"`), so the card says "confirmation: first pair of ≤20 running" and the band keeps the confirmation's place with its placeholder; replay sees the same event.
- **"No change".** The Overview's guardrail column said "0.0% better than the segment base" and "worst single promotion 0.0% worse"; both use the Live rows' rule now (`changeWords`: under 0.05% is "no change"), "worst single promotion: no change".
- **Trajectory.** A conflict, a failed gate or a rejection had no mark although the legend lists "○ other verdicts": unmeasured verdicts are ○ marks on the best line at the time, and say "not measured".
- **Verdict reasons.** Reasons read "primary metric improved 17.8% (CI +13.6% to +22.0%, 6 pairs)" (`measuredCiText`: "single run" for deterministic, "4 runs" for expensive, "at 99%" for an early loss) instead of "(CI 13.58%..21.99%, n=6)"; the candidate detail and the CLI rewrite older reasons the same way (`reasonText`).
- **Smaller.** Guardrail sentences under a band wrap instead of being cut ("within the 1…" with two bands side by side); when the "continue" label can't fit (the threshold next to 0), a legend under the band names the regions; the panel header's "no win yet" lines up with the counts under it; the Oracle tab marks automatic segments and shows side runs per host; the status line says when a recalibration is due.

### Harvest

- **Stacks in dependency order (A6).** Stack layers used to follow `k` (earliest commit), so a strategist group {c/3, c/20} came before {c/10} even when c/20 builds on c/10, and its PR didn't apply on its base. Layers are now ordered topologically (`planStacks`) from the detected dependency edges plus commit-level file overlap: X needs Y when a commit of X and an earlier commit of Y (first-parent order on best) touch the same path. Overlap only orders inside a stack; it never makes one. A cycle (commits interleaved on the same files, or dependencies both ways) is one coupled group, folded up front into one PR hosted by its smallest k ("#1 and #4 need each other: their commits interleave on src/c.txt, so neither applies without the other"). Ties go by k.
- **Attribution by commit order.** Reverting S from best can be blocked by any changeset with a commit after one of S's, and a changeset can need any other with a commit before one of its own, whatever their k (`laterDependents`, `earlierDependencies`).
- **Every PR applies (decision).** Each layer is composed onto its PR base (the previous layer's commit; the first layer and independent changesets: the study base) and gated. A layer that conflicts or fails its gates is merged with the next layer(s) in order ("#6 needs src/x.py, which #7 adds or changes, so it doesn't apply on #5 alone"). If no later layer fixes it, it folds into the previous layer and the check resumes there (`fitLayers`). Before any fold the whole stack is squashed onto the base. If even that fails, the stack needs something outside it: the other changesets are probed on the base (with gates for a gate failure), then shrunk newest first to a minimal set that still works, so of two interchangeable helpers the earlier is kept. The edges are added and the stacks recomputed. Each fold removes a layer and each probe merges groups, so this terminates. A branch is drafted only for a layer that applies and passes its gates on a drafted PR base; otherwise it is reported. Compose and gate results are cached per run, so re-checks after a fold cost nothing. Standalone effects are measured once the layers are final.
- **Folds keep the accounting.** A folded changeset keeps its row and its ablation result, and the sum of contributions is unchanged. Its host's PR includes the folded commits in best order, its candidates, rationale and findings, and "Also includes #4 …: why". The Harvest tab, PR body, report (table in PR order, a "Folded" list, stacks as `#3 → #2 (with #5)`), `bb study harvest` and the harvest-ready notice all say which PR ships it and why. The publish plan lists it as "ships inside #1's PR", and it can't be dropped on its own.
- **PR preview (B8).** Long PR bodies start collapsed behind a fade with "Show more" / "Show less" (no inner scroll). "Depends on" is one line per dependency with its own reason ("Depends on #3 Shrink c: reverting #3 from best conflicts in src/c.txt…"), parsed from the stored `depends on #k: …` list; older rows show the whole text on each dependency.
- **Numbers per study (B9).** A study's first harvest showed as "h5" (the global id). Harvests are numbered per study (`h<seq>`) everywhere a person or agent sees them: tab, dialogs, notices, CLI, grouping round, audit texts, PR bodies, commit trailers (`Autoresearch-Changeset: h<seq>/#k`), branches `studies/<slug>/harvest/h<seq>/…`, export directory `<slug>-harvest-h<seq>`. The RPC's `harvestId` and DB keys stay the global id.
- **Data model.**
  - `harvests.seq`: per-study number, backfilled with `ROW_NUMBER()` per `study_id` ordered by id; new rows get max+1 per study.
  - `changesets.folded_into`: id of the changeset whose PR ships it.
  - `changesets.fold_reason`: why, in words.
  - `changesets.layer`: position in its stack's PR order.
  - `StackRecord.layers` (in `stacks_json`): hosts and members bottom first; `members` is now in PR order.
  - New standalone statuses `applied` (applies and passes gates, effect not measured yet) and `folded`.
  - New event `harvest.folded` (harvest, changesets, into, reason); `harvest.started` now carries `seq`.

### Data model

Append-only migrations: `bench_hosts.side_runs`, `bench_hosts.run_seconds`, `studies.recalibrate_due`. New events: `recalibration.due`, `recalibration.started`, `recalibration.failed`, `drift.explained`, `confirm.skipped`; `segment.started` and `calibration.ready` gain `auto`; `measure.finished` gains `stop` and `confirm_skipped`; `measure.progress` is also recorded at 0 pairs when a confirmation starts. A measured candidate's `metrics_json` gains `stop`, `confirmSkipped`, `runSeconds` (median seconds of one run per side) and `sideRuns`; calibration reports and segment details gain `sideRuns` and `runSeconds` per host. New notice kind `segment.recalibrated`. New spec keys: `[oracle.protocol] futility`, `early_lose_from`, `early_lose_confidence`, `skip_confirm_factor`, `side_runs`, `min_side_seconds` (part of the oracle hash, left out of it at their defaults so stored segments keep their hash), `[oracle.drift] recalibrate_below` (not hashed). Stored specs are read with the defaults filled in (`normalizeSpec`).

### Live check (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** `src/toy.py` runs three stages that wait for fixed times (parse 1.2 s, sort 1.0 s, render 0.8 s); the metric is the wall time of one `run()` in ms with 2% synthetic noise (protected `bench/measure.py`), the gate a correctness test. Noisy, `n_min` 4, `n_max` 10, `calibration_pairs` 6, `min_side_seconds` 2.5, local bench (single-machine mode on), health checks off, `max_workers` 1, `max_candidates` 6, the default provider; five pinned ideas: move the stages into a new `src/steps.py` and halve parse, two deliberately tiny changes, and two big cuts.
- **Calibration.** One run takes 3.1 s, so `side_runs = "auto"` kept one run per side ("One run per side (a run takes about 3.1 s, at least the 2.5 s a side needs)"); noise floor 2.23% per pair, win threshold 1.55%.
- **Verdicts.** c/1 (new module, parse halved) won 18.5% after 4 pairs and skipped its confirmation ("the CI's lower bound +17.0% is 11.0× the 1.6% win threshold"). c/2 (render 0.8 → 0.79 s) looked like a win at 4 pairs (CI +1.9% to +5.1%) and failed its confirmation after 7 fresh pairs: a lose. c/3 (sort 1.0 → 0.1 s) won 38.4%, skipped its confirmation, and made best's runs 51% as long as at calibration. c/4 (render 0.8 → 0.2 s) won 39.6%. c/5 (parse 0.6 → 0.597 s) stopped after 7 of 10 pairs: "effect −1.1% (CI −3.1% to +2.0%, 7 pairs) can no longer clear the 2.6% win threshold: stopped early (futility…)". c/6 (parse → 0.1 s) won 54.1%, again without a confirmation. Best vs base: 86.1% lower (7.2×) in about 6 minutes of Running; the feed said "c/5 measured: 7 pairs in 27 s (stopped: it could no longer win)" and "c/6 measured: 4 pairs in 12 s (confirmation skipped: far beyond the win threshold)".
- **Automatic recalibration, twice, no pause.** After c/3's promotion `recalibration.due` (source: promotion), then segment 2 41 s later, same oracle hash, side runs 1 → 2 (one run 3.06 → 1.56 s, noise 2.23% → 1.92%, threshold 1.55% → 2.65%), and c/4 measured in it. After c/6, segment 3: side runs 6 (one run 0.46 s). The study never paused for drift; the notice read "recalibrated itself on best (c/3 made best's runs 51% as long as at calibration …): segment 2 started, same oracle … Nothing to do." with the per-host before and after. c/4's own runs took 61% of segment 2's calibration, just above the 60% trigger, so it didn't recalibrate there.
- **Across segments.** `bb study show`, the Live view's `best` and the report read "86.1% lower t_ms (7.2×) across 3 segments · this segment: 414.9 ms, no promotion yet". The harvest's line read "414.9 → 414.9 ms" (the segment's baseline, not the study base); fixed during the check to "≈ 3,053 → 414.9 ms" from the harvest's own base-vs-best measurement.
- **Notices.** Strategist round 2 (2 wins, a recalibration) said no "notices for you"; round 1 said 1 (calibration ready), round 4 1 (budget used up).
- **Harvest h1 (the strategist's grouping, as asked: {c/1, c/4} and {c/3, c/6}).** The two groups' commits interleave on `src/steps.py`, so they were folded into one PR: "#1 and #2 need each other: their commits interleave on src/steps.py, so neither applies without the other"; #2 "ships inside #1's PR". One branch, its parent `main`, the gate passing in a checkout of it. The study's first harvest was numbered h1.
- **Harvest h2 (one changeset per promotion).** A stack #1 → #2 → #3 → #4 in dependency order; four branches, each one's parent the branch below it (the first's `main`), the gate passing on every tip; contributions 23.3% and 18.8% of the gain for the two that could be ablated alone, the stack together 100.0% (CI 90.8% to 108.8%).
- **Other studies.** The plugin database was backed up first; after reinstalling the released plugin, every other study's row and event count matched the backup (`render-perf-bb2`, harvesting, included).
- **Cleanup.** The study was archived with its seven threads, the temporary project, `/tmp` files and the harvest exports deleted, and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Early losses are rare on modest regressions.** The t interval catches large regressions at 3-4 pairs; a regression of one or two thresholds still runs to `n_min` and often ends `inconclusive` by futility rather than `lose`.
- **The recalibration trigger is noisy-only** and compares one run's median time; a benchmark whose runs got longer, or an expensive oracle, keeps its calibration.
- **Auto side runs cap at 30.** A benchmark faster than `min_side_seconds` / 30 should repeat itself internally.
- **The confirmation skip** uses only the primary metric's CI; guardrails are then judged on the first measurement's pairs.
- **Replay** shows the headline across segments but not the segment's raw values.
- **Harvest attribution.** Reverting from best still isolates blockers one at a time (else all later ones); only the forward probe shrinks to a minimal set. Fold reasons say a file was "added or changed" (telling them apart needs a new host op). No real-git test triggers a forward or backward fold inside an already ordered stack; the pure model tests cover that loop.


## Credits

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).
