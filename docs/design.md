---
eyebrow: BB plugin design
title: Autoresearch for BB
subtitle: A BB plugin for long-running, measured code-optimization studies. Short-lived agent workers propose changes in parallel. The plugin owns the loop, the measurements, and every keep or discard decision.
brand: AR
brandLabel: autoresearch
brandSublabel: BB plugin design
pills: Draft | M0-M2 built | M3 to do
cards: Unit of work=Study | Agents=Strategist + workers | Verdicts=Plugin-owned | Output=PRs with measured gains
---

# Autoresearch for BB

> Autoresearch works like a merge queue. The CI is a benchmark, and the authors are short-lived agents. The plugin runs the loop, measures every candidate, and decides what to keep. Agents only propose changes and explain what they learned.

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
4. **Gate.** Correctness commands run on the edit host. They run in parallel across workers, since gates don't need a quiet machine. A failure returns verdict `gate_failed` with the last lines of output.
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
max_regression = "5%"

[[guardrail]]
name = "throughput_rps"
max_regression = "2%"

[scope]
editable = ["source/filters/routing/**", "source/common/matcher/**"]
protected = ["bench/**", "test/**"]

[oracle]
build = "bazel build //source/exe:envoy-static -c opt"
gate = ["bazel test //test/filters/routing/... -c opt"]
measure = "bench/replay.sh --workload=prod-sample"
noise = "noisy"                 # deterministic | noisy | expensive
bench_hosts = ["bench-x86-01"]

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
- **Sequential decision.** After `n_min` pairs, it stops early when the result is clear:
  - clearly worse (the CI is entirely on the regression side): `lose`
  - clearly better (the lower bound clears the minimum detectable effect): `win`
  - still ambiguous at `n_max` pairs: `inconclusive`

  Most candidates are clear losses, so stopping early saves most of the bench time.
- **Confirmation.** A `win` is measured again with fresh pairs before promotion. Many candidates against a noisy benchmark produce false wins by chance, and a false promotion compounds.

### Calibration and drift

Calibration runs the full protocol with base against itself (A/A), several times. It produces a report like this:

> Detects changes of 1.8% or more with 20 pairs. About 6 minutes per evaluation, so about 10 evaluations per hour per bench host. Gates take 3 minutes on the edit host.

If the minimum detectable effect is larger than any plausible win, the study goes back to Draft. That costs minutes instead of a week of tokens.

During Running, a schedule repeats an A/A run on `best` every N evaluations. If noise grows past 2× the calibrated level, the study pauses and notifies the human. A disturbed bench machine would otherwise hand out random verdicts.

### Guardrails and holdout

- **Guardrails** are secondary metrics with limits relative to `best`. A candidate that wins on the primary metric but breaks a guardrail is a `lose`, and the reason is attached.
- **Holdout** is a workload kept only on the bench host. It's evaluated on candidates about to be promoted. Workers never see its inputs or numbers, only pass or fail. It catches changes that special-case the benchmark input.

## Scheduling

### How many workers

Throughput depends on two durations: how long a worker thinks before it submits (T_think), and how long the bench takes per evaluation (T_eval). The scheduler aims for:

`W = min(max_workers, ceil(T_think / T_eval) + 1)`

It learns both durations online. It doesn't spawn a worker while the bench queue is at least `W` deep. This backpressure keeps workers from waiting hours for a verdict.

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
- **Inputs.** The round digest, the dossier, and the findings, which it can search with tools.
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

A **Studies** nav panel lists every study with its state, best vs. base, and budget spent. The study page has these tabs:

- **Overview.** A trajectory chart (every candidate as a dot, best as a step line), best vs. base with CI, state, budget, and controls (pause, resume, concurrency, harvest).
- **Ideas.** A board: queued, running, won, lost, abandoned. You can add, reorder, pin, or veto.
- **Candidates.** A filterable table. Each row opens its diff, samples, verdict, and worker thread.
- **Findings.** A searchable list.
- **Oracle.** The spec, its version history, calibration reports, and approval for oracle changes.
- **Bench.** Machines, queue, health, and drift checks.
- **Harvest.** Proposed changesets, ablation results, and the drafted PRs.

Live updates use `bb.realtime` signals, and the page refetches through `bb.rpc`.

### Threads

- The **study thread** is visible, and it's the one place to talk to the study. A header badge shows `run 84 · best −23.4% ±1.1 · 3 workers · queue 2`.
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

Milestones reach the human through the study thread: a new best, a stall, a budget threshold, a broken oracle, or noise drift. The plugin posts them as part of a strategist round, and the thread then shows as unread. A direct push or Slack channel is an open question.

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
| `events` | Append-only audit log of every state change and decision |

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
| UI | `navPanel`, `threadHeader`, `threadPanelAction`; `bb.rpc`, `bb.realtime` | Public |
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
- widening their own resources: control RPCs are clamped to the approved spec (concurrency can only go down), and the spec and oracle can't be approved over RPC at all;
- approving their own oracle: approval commands refuse a study's own worker and strategist threads, and a revised spec from the study thread stays pending until a human approves it;
- doing any of this unnoticed: every human control is an append-only `control.*` event with the caller information BB provides and the study agent turns running at that moment, plus a notice (and an unread study thread when an agent turn was running).

**What it cannot protect against on a full-access local machine.** An agent with a shell running as the user can do anything the user can:

- BB gives plugins no caller-thread identity for RPC: the app, the `bb` CLI, and agents are all `client`, so an agent can call the plugin's RPC with `bb plugin rpc call`.
- The CLI's thread id comes from the invoking shell's environment; an agent can drop it and look like the human.
- Plugin forms (`bb.ui.requestInput`) can be answered with `bb thread interactions respond`, so a form is no stronger an approval channel.
- With a `local` bench host, the holdout's files sit on the same disk the agents can read.
- Nothing stops it from editing the plugin's SQLite database or source, or pushing.

There, the defenses are detection (the audit trail above) and isolation: a separate bench machine that holds the holdout, and agent permission modes and sandboxes that don't allow arbitrary shell access. A study whose results matter should run its bench on a machine its workers can't reach.

## Budget and cost

- **Limits.** `max_workers`, `max_candidates`, `max_bench_hours`, `deadline`. Token or dollar limits too, if BB exposes per-thread usage to plugins (see [Open questions](#open-questions)).
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

- [ ] Ablation, dependency detection, draft PRs and stacks, study report
- [ ] Budgets, usage-window awareness, notifications
- [ ] Findings, Oracle, Bench, and Harvest tabs

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

1. Can plugins read per-thread token or cost usage? Token budgets and tokens per win depend on it.
2. What notification channel should be the default: study-thread attention only, or a push or Slack path a plugin can use directly?
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
- **Bench clone.** Each clone-mode host keeps a bare clone per study at `<dataDir>/bench/<slug>/repo.git`, where `dataDir` is the host entry's `experimental_paths.dataDir` (on the test machine, `~/.bb/plugins/autoresearch/host-data/`). Measurement checkouts are worktrees of that clone, `<dataDir>/checkouts/<slug>-bench-{best,cand,drift,profile}`. Every received commit is pinned as `refs/bench/s/<sha>`, and `gc.auto` is off. `bb study archive` cancels the study's jobs, removes the checkouts, and deletes the clone.
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
- **Approval is CLI-only.** Oracle and spec approval (calibrate, approve, start) exist only in the CLI, and the CLI refuses a study's own worker and strategist threads. The SDK gives no reliable way to tell an agent from a human: RPC callers are all `client`, the CLI thread id comes from the shell environment, and plugin forms can be answered with `bb thread interactions respond`. So approval can't be made impossible from an agent shell, only refused for the cooperative case and audited.
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
- **Bundles.** All bundles went to the bench-owned clone `~/.bb/plugins/autoresearch/host-data/bench/toy-m2/repo.git`, a bare repository with no alternates, outside `/tmp/ar-m2-toy`, with checkouts as its own worktrees. Each bundle was one chunk and took about 0.4–0.5 s.

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
