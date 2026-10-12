# v1: agents own commits, harvest and publishing

Implementation notes for workstream B of 1.0. The integrator (or workstream C)
folds this file into `docs/release-notes.md`; the "Harvest", "Git model",
"Agents" and "Tools" sections of `docs/design.md` are superseded by what
follows.

## Why

The plugin was doing work that belongs to agents: it wrote commit messages
(a candidate's PR inherited the wrong title from its idea), grouped and
ablated promotions, drafted branches and PR bodies, and published to GitHub
only. It couldn't split a candidate that bundled two changes, consolidate two
studies on one repository into one stack, or publish to a repository that
uses another review tool.

The plugin now owns only the trust boundary: measurements and gates, verdicts
and promotion, budgets, bench machines, and the evidence record. Commit
messages, harvest (grouping, splitting, stacking, PR descriptions) and
publishing belong to agents, with skills and the repository's own tools.

## 1. Worker-written commit messages

- `study_submit_candidate` takes `title` (required: one line, at most 72
  characters after trimming) and `body` (optional, at most 4000 characters).
  `summary` is gone; the candidate's `summary` column now stores
  `title\n\nbody` so every view that read it keeps working.
- `src/commit.ts` checks the message (`checkCommitMessage`) and builds it
  (`candidateCommitMessage`): the title and body verbatim, then the plugin's
  two trailers, `Autoresearch-Study: <slug>` and
  `Autoresearch-Candidate: c/<n>`. The same message is used for the worker
  snapshot, the candidate rebased onto best, and the promotion squash on
  best. The promotion no longer carries the idea title, the effect, the CI,
  the verdict reasons or the `Autoresearch-Source` trailer: the numbers live
  in the evidence, and the source sha is the candidate ref.
- A body containing an `Autoresearch-*:` line is refused (the plugin's
  trailers map commits back to candidates, and to a study when several share
  a repository). A refused message commits nothing and tells the worker why.
- Candidates submitted before v1 (in flight at the upgrade) keep the old
  message source: the idea title, or the summary's first line, with the
  summary as the body (`commitParts`).
- The worker brief has a "Commit message" section: the title says what the
  change does (not the idea's name or the hoped-for result) in the
  repository's style; the body says why, what was checked, and trade-offs, and
  no measured numbers.
- The host contract's snapshot message limit went from 4096 to 8192 (title +
  body + trailers).
- Candidate pages show the worker's commit message (`candidateDetail().commit`,
  `candidateRow().title`); the evidence carries it.

## 2. Primitives: `bb study measure`, `gate`, `results`, `evidence`

All in `src/primitives.ts` and `src/evidence.ts`, wired through the engine
(`requestMeasure`, `requestGate`, `adhocRun`) and the CLI.

### `bb study measure <slug> <A> <B> [--pairs N] [--host H] [--detach] [--timeout D] [--json]`

- Measures B against A (A is the reference: "best" side; better is positive)
  with the study's noise-class strategy, guardrails and calibrated side runs,
  on one of the study's bench hosts, under that host's bench lock (bench
  interval kind `adhoc`), with a health check first (deferred and retried
  like a candidate, at most `adhocHealthTries` times).
- An estimate, not a sequential decision: a fixed number of pairs, the
  study's `n_max` (or `--pairs N`, noisy oracles only), with early stops off.
  Deterministic: one run each. Expensive: the strategy's runs.
- The classification is the candidate verdict rules applied to B against A
  (`decideVerdict`): `win` (B better beyond the threshold), `lose`,
  `inconclusive`. The threshold is the one a candidate on that host gets
  (`measurementMde`, so workstream A's per-host thresholds apply here too).
  Guardrails are judged against A with the per-step limit (the total limit
  applies to the step alone: A is not the segment base).
- Refs (validated: no option-like or `..` refs): a sha, a branch or tag of
  the repository, `best`, `base`, `c/<n>` (the candidate ref), or rev syntax
  (`best~1`, `<branch>^`). Resolved on the edit host.
- `--host` takes a bench host's name or id; the default is the first online,
  healthy, idle host, then any healthy one, then any online one.
- Waits for the result (up to `--timeout`, default 25 min, max 30) unless
  `--detach`; the run continues past the timeout either way.

### `bb study gate <slug> <ref> [--detach] [--timeout D] [--json]`

The study's gates on any commit, on the edit host, in a checkout keyed
`<slug>-adhoc-gate`. A failing command is retried once (`flaky` when the retry
passes, as for candidates). In single-machine mode the gates take the edit
host's bench lock and their time counts as bench time; otherwise they don't
(as for candidates). Remote gate machines (`gates = true`) are not used here.

### `bb study results <slug> [r<N>] [--wait] [--json]`

The runs asked for, newest first, or one in full. Runs are numbered per study
(`r<seq>`).

### Records, audit, budget

- Each request is a row in the new `adhoc_runs` table (kind, refs as asked and
  the shas they resolved to, host, pairs, state `queued|running|done|failed|cancelled`,
  progress, `result_json`, error, actor, bench seconds, times).
- Audit: the request is a `control.measure` / `control.gate` event with the
  caller (the CLI's thread id, else `human`); the result is
  `measure.adhoc_finished` / `gate.adhoc_finished` (or `*.adhoc_failed`). No
  notice per request: an agent asks for many, and they are not control
  changes. These event names don't collide with the candidate pipeline's
  `measure.*` events the live view replays.
- Bench seconds go to the study's budget (`addBenchSeconds`) and the run's
  row. A spent bench budget doesn't refuse a request: harvest follows an
  exhausted budget by design (the old harvest's measurements weren't blocked
  either); a Running study whose budget runs out this way pauses as usual.

### Who may ask, and when (decision)

- Any thread except a study's own workers (a worker measuring its own
  candidates would spend the bench budget outside the pipeline). The study
  thread may: it is where a human most often asks for a harvest. Not human
  controls, so the CLI's human-control guard doesn't apply.
- Refused for a draft, calibrating or archived study, or one without a
  calibrated segment.
- **Refused while any of the study's workers is live and its bench is busy**
  (a candidate testing, queued or measuring). That covers Running, and the
  workers finishing their last submission after a pause or a freeze. With an
  idle bench a request is taken even while workers run: it holds the bench
  lock, so a candidate arriving meanwhile waits for it, and verdicts are never
  mixed with it. Paused and Harvesting studies without live workers always
  take requests. The refusal names the fix (`bb study pause`, `bb study harvest`).
- Paused studies release their remote machines, so a remote-only bench has
  no host until the study is frozen for harvest (Harvesting keeps them); the
  refusal says so.
- CLI only, no agent tools: harvesting is done by whichever agent the human
  asks (an ordinary thread or the study thread), and agent tools are
  role-gated to study threads; the CLI works from any thread with a shell. No
  RPC either: the app shows the runs but doesn't start them.

### Reload

Runs are background jobs of the plugin instance. Dispose aborts them; the next
instance's reconcile marks queued or running rows `failed` with "interrupted by
a plugin reload; run it again" (`Primitives.reconcile`). Archive cancels a
study's runs.

## The evidence document (`bb study evidence <slug> --json`)

Stable within a version: fields are only added; a field that changes meaning
or goes away bumps `version`. Options: `--samples` adds each candidate's raw
samples; `--candidates 3,7` (or `c/3`) limits the candidates. When the
document is larger than one CLI response (200,000 characters), it is written
whole to `<plugin data dir>/exports/<slug>-evidence/evidence.json` on the edit
host and stdout is `{ "format", "version", "file", "bytes" }`, never a trimmed
document. Holdout data never appears (only `study.holdout: true|false` and a
candidate's `holdout: "pass"|"fail"|null`). The text form (without `--json`)
is a short summary.

```jsonc
{
  "format": "bb-autoresearch/evidence",
  "version": 1,
  "generatedAt": "2026-…Z",
  "study": {
    "slug", "state", "objective", "repoPath", "baseBranch",
    "metric": { "name", "unit", "direction": "lower|higher" },
    "noise": "deterministic|noisy|expensive",
    "guardrails": [{ "name", "direction", "maxRegression", "maxTotalRegression" }],
    "scope": { "editable": [], "protected": [] },
    "gates": ["…"],
    "protocol": { "nMin", "nMax", "minEffect", "confidence" },
    "holdout": false,
    "specVersion": 2
  },
  "git": {
    "base": "<sha>", "best": "<sha>",
    "bestBranch": "studies/<slug>/best",
    "candidateRefs": "refs/studies/<slug>/c/<n>",
    "segmentRefs": "refs/studies/<slug>/segment/<k>",
    "frozen": { "harvest": 1, "state": "frozen", "ref": "refs/studies/<slug>/harvest/h1", "base", "best", "at" } // or null
  },
  // first-parent commits base..best, oldest first; title/body are the commit's (v1: the worker's), trailers removed
  "promotions": [{ "sha", "n": 1, "title", "body", "paths": [] }],
  "promotionsError": null,           // git log failure, if any
  "segments": [{ "k", "baseline", "oracleHash", "specVersion", "noiseFloor", "threshold", "evalSeconds", "startedAt", "auto" }],
  "benchHosts": [{ "id", "name", "mode": "shared|clone|remote", "active", "noiseFloor", "threshold", "sideRuns" }],
  "candidates": [{
    "n", "ref", "sha", "parentSha", "preparedSha", "againstSha", "promotedSha",
    "idea": { "id", "title", "theme" },          // or null
    "commit": { "title", "body", "fromWorker": true },
    "summary",
    "stats": { "files", "linesAdded", "linesDeleted", "paths": [] },
    "stage", "verdict", "reasons": [],
    "effect", "ciLo", "ciHi",                    // primary metric vs what it was measured against, better is positive
    "pairs", "threshold", "stop", "confirmSkipped",
    "metrics": { "best": {}, "candidate": {} },  // medians per side
    "guardrails": { "<name>": { "regression", "lo", "hi", "state": "ok|inconclusive|broken|missing|null", "text" } },
    "holdout": "pass|fail|null",
    "benchHost", "benchSeconds", "gateSeconds", "rebases",
    "findings": [3],                             // finding ids about this candidate
    "submittedAt", "decidedAt",
    "samples": [{ "run": "measure|confirm", "pair", "side": "best|candidate", "metrics": {}, "host" }]  // with --samples only
  }],
  "findings": [{ "id", "candidate", "idea", "outcome", "learned", "revisitIf", "evidence", "at" }],
  "ideas": [{ "id", "title", "theme", "status", "source" }],
  "harvests": [{ "seq", "state", "base", "best", "startedAt", "finishedAt", "legacy" }],
  "runs": [{ "id": "r1", "kind": "measure|gate", "a": { "ref", "sha" }, "b": { "ref", "sha" }, "state", "error", "result", "requestedBy", "requestedAt", "finishedAt" }],
  "budget": { "candidates", "maxCandidates", "benchSeconds", "maxBenchHours" }
}
```

A run's `result` is `MeasureResult` (`kind: "measure"`, `a`, `b`, `host`,
`noise`, `n`, `effect`, `ciLo`, `ciHi`, `threshold`, `classification`,
`reasons`, `guardrails` per name `{ regression, lo, hi, n, state, text }`,
`metrics` `{ a, b }`, `diag` `{ a, b }`, `samples` `[{ pair, side: "a"|"b", metrics }]`,
`seconds`, `text`) or `GateResult` (`kind: "gate"`, `ref`, `sha`, `host`, `ok`,
`commands` `[{ command, ok, exitCode, flaky, seconds, tail }]`, `benchLock`,
`seconds`, `text`). `bb study measure|gate|results <id> --json` print
`{ run }` with the same `result`.

## 3. Harvest is a freeze

- `bb study harvest <slug>` (or the Harvest tab, or Needs you after the budget
  runs out) moves Running or Paused to Harvesting as before: no new workers,
  submissions refused, in-flight candidates finish (`waiting`). Then the
  harvest is `frozen`: base, best, segment and the promotions (first-parent
  log, mapped to candidates by the trailers, with each commit's subject and
  body) are recorded, and best is pinned as `refs/studies/<slug>/harvest/h<N>`.
  A `harvest.frozen` notice says what was frozen and how to ask an agent.
- Removed: the strategist's grouping round and `study_propose_harvest`,
  ablation, dependency probes, stacks and folds, standalone checks, branch
  drafting, PR bodies (`prBody`), the dry-run export, the GitHub publisher
  (`src/publisher.ts`), publish plans and keep/drop choices, `--publish`
  (it now fails with `removed` and a hint naming the study-harvest skill),
  `--restart`, `--one-per-promotion`, `--no-measure-standalone`, and the RPC
  methods `study.harvest.plan`, `study.harvest.publish`,
  `study.harvest.choice`. `study.harvest.start` takes `{ slug }` only.
  `src/harvest-math.ts` became `src/harvest-legacy.ts`: only the display
  helpers old records still need.
- `bb study harvest` while a harvest is waiting or frozen shows it (a read:
  the study thread may ask). Starting one is a human control as before. When
  the latest harvest is an old one (ready, failed, cancelled), it starts a new
  freeze; no `--restart`. `--harvest N` shows an older harvest.
- `bb study resume` cancels a harvest still waiting; a frozen one keeps its
  ref. `bb study archive` as before.
- `[harvest]` spec keys (`measure_standalone`, `group_timeout_minutes`,
  `remote`) are still accepted, so stored specs keep parsing, and have no
  effect. They were never part of the oracle hash.
- **Harvests from before v1 stay readable**, read only: changesets,
  contributions and accounting, stacks, folds, PR previews, branches, export
  directory and publish results, on the Harvest tab (selectable from the
  history), in `bb study harvest --harvest N`, the report, and the evidence's
  `harvests` (`legacy: true`).
- **A harvest the plugin was still running at the upgrade** (grouping,
  ablating, checking or drafting) can't continue. On load it becomes `frozen`
  on the best it had frozen, with "stopped while <phase> when the plugin moved
  to agent-run harvests (v1)"; what it measured and drafted so far stays
  readable, and an agent takes over. A legacy `waiting` harvest simply
  continues as a v1 freeze. Mid-harvest studies on a machine that upgrades
  lose the remaining automatic phases: finish them with an agent.
- Needs you: a frozen harvest (or an old `ready` one) is one item, "Best is
  frozen (harvest hN): ask an agent to harvest it", opening the Harvest tab,
  CLI `bb study evidence <slug>`. Kinds `harvest_ready` and `publish_failed`
  are gone; `harvest_frozen` is new.

## 4. The `study-harvest` skill

`skills/study-harvest/SKILL.md`, enabled for ordinary threads and the study
thread (`skillsForRole`). It tells an agent how to: check the study is frozen
(and ask the human to freeze it otherwise), read the evidence and the
repository's conventions (target branch, commit and PR style, templates, the
review tool), plan PRs (group, keep apart, split by file or hunk, stack, drop
nothing alone) and show the plan, build branches in its own worktree and
check nothing was lost against the frozen tree, measure each PR on its base
and contributions at the top with `bb study measure`, gate with
`bb study gate`, write descriptions that cite the plugin runs, and publish
with the repository's own tool (gh, Graphite, Sapling, Gerrit, Phabricator, …)
only when asked. It also covers consolidating several studies on one
repository into one stack, and a short "don't" list (no self-measured numbers,
no pushing before asked, no touching `studies/*` or `refs/studies/*`, no
lifecycle controls).

### Worked example: two studies on one repository into one stack

Not run on real studies; this is how an agent following the skill does it.
Say `svc-latency` (p99, noisy) and `svc-memory` (RSS, noisy) both ran on
`acme/svc`, from bases `a1` and `b2`, and the human asks for one stack.

1. The human freezes both (`bb study harvest svc-latency`, `bb study harvest svc-memory`).
   The agent reads `bb study evidence svc-latency --json` and `… svc-memory --json`.
   Their promotions are told apart by `Autoresearch-Study`; both repositories
   are the same, so `refs/studies/svc-latency/harvest/h1` and
   `refs/studies/svc-memory/harvest/h1` resolve in either.
2. Common base: `origin/main` at `c3`, newer than both bases.
3. Plan: latency c/4 (a header cache) and memory c/7 (a smaller header struct)
   both edit `src/headers.rs`: adjacent layers, the struct first because the
   cache builds on it. Latency c/9 and memory c/2 are the same fix (drop a
   per-request clone): one PR, from c/2 (the smaller diff), noted in both
   descriptions. Latency c/11 bundles an allocator tweak with a logging
   change: split by hunk; the logging hunk is its own PR at the bottom.
   The agent shows this table and the measurements it plans, with their bench
   cost from each study's `segments[-1].evalSeconds`.
4. It rebuilds the stack on `c3` in its own worktree (`git cherry-pick`,
   `git checkout -p`), resolves conflicts, and checks the union against each
   frozen best with `git diff` per study.
5. Measurements, each by the study whose metric the layer targets, plus the
   cross-check: `bb study measure svc-memory <layer-1 base> <layer-1>` (the
   struct, memory's metric), `bb study measure svc-latency <layer-1> <layer-2>`
   (the cache, latency's metric), … and at the end
   `bb study measure svc-latency c3 <top>` and `bb study measure svc-memory c3 <top>`
   so each study's oracle sees the whole stack; any layer the cross-check
   flags (`guardrails` or `classification: lose` on the other metric) gets
   its own measurement with the other study too. `bb study gate` with each
   study on each layer. Both studies are frozen, so neither has live workers
   and both take the requests; each runs on its own bench hosts with its own
   protocol.
6. Descriptions cite both studies' runs where both apply ("p99 12.4% lower
   (CI …), svc-latency r4; RSS unchanged within its 2% limit, svc-memory r2").
   Publishing waits for the human, then uses `gt submit --draft` or
   `gh pr create --draft --base <layer below>` bottom first, whichever the
   repository uses.

## 5. UI

- **Harvest tab**: without a harvest, what harvest does now and *Freeze best
  for harvest…*. A frozen harvest shows its state, base → best and the pinned
  ref, the promotions (candidate link, the worker's commit title, its effect
  when promoted, files, the full commit message on demand), and while
  Harvesting an **Ask an agent to harvest it** box: the prompt (copyable),
  *Ask in a new thread…* (BB's composer, prefilled, in the study's project),
  *Open the study thread*, and the four commands. Every page shows
  **Measurements and gates agents asked for** (newest 20: run, state, what
  was asked, the result line or error, bench time). The history lists every
  harvest (old ones marked "before v1") and opens any of them. Old harvests
  render read only, without the publish dialog or keep/drop radios. Resume,
  archive and *Freeze best for a new harvest…* where they apply.
- **Candidates**: the detail's "Summary" became "Commit message (the
  worker's)" with title, body and a line saying it is used verbatim; the list
  shows the commit title under the idea.
- Overview harvest line, Needs you, notices and the freeze dialog reworded.

## Also fixed

- A win that passed the holdout lost its guardrail judgement (the holdout
  step rebuilt the verdict without it), so its `metrics_json` had no
  `guardrailJudgement`. The verdict now keeps it (`{ ...result, … }`).

## Data model

Append-only migrations: `candidates.commit_title`, `candidates.commit_body`;
table `adhoc_runs` (+ index). Harvest states gain `frozen`
(`HARVEST_STATES`; `LEGACY_ACTIVE_HARVEST_STATES` names the old in-progress
ones). Bench interval kind `adhoc`. Checkout roles `adhoc-a`, `adhoc-b`
(the old `hbase`/`harvest` roles are gone). Config `harvestGroupGraceMs` removed,
`harvestHealthTries` renamed `adhocHealthTries`. New events: `control.measure`,
`control.gate`, `measure.adhoc_finished`, `gate.adhoc_finished`,
`measure.adhoc_failed`, `gate.adhoc_failed`; `harvest.frozen` (with `legacy`
when an old harvest was stopped). No longer emitted: `harvest.grouped`,
`harvest.grouping_fallback`, `harvest.total`, `harvest.ablation`,
`harvest.dependency`, `harvest.folded`, `harvest.standalone`,
`harvest.drafted`, `harvest.ready`, `harvest.publishing`, `harvest.published`,
`harvest.publish_refused`, `harvest.choice`, `harvest.proposed`,
`harvest.phase`. The `harvest_proposals` table stays (unused).

## Tests

Removed with the code: `test/harvest.test.ts` (real-git ablation, stacks,
drafting), `test/harvest-order.test.ts` (stack planning and folds), the
grouping/attribution/publisher parts of `test/m3.test.ts`, and the app and RPC
tests of publishing and keep/drop. Updated: every caller of
`study_submit_candidate` (title instead of summary), harvest UI/CLI/RPC
tests (freeze, legacy read-only view, Needs you). `FakeHost` gained a
`commitLog` and resolves known shas. New `test/v1-agent-harvest.test.ts`:
commit message checks and building; the worker's message verbatim on the
candidate, rebased and promoted commits; the freeze (promotions, pinned ref,
notice, read access for the study thread, resume keeps the ref); `measure`
(classification both ways, guardrails, samples, audit events, bench time,
results, refused refs/hosts/`--pairs`); `gate` (pass, flaky, failure tail,
workers refused); the busy-bench refusal and `--detach`; the evidence
document (exact top-level keys, commit messages, promotions, runs, findings,
never the holdout, `--samples`, `--candidates`, the file fallback);
reconciliation of interrupted runs and of a mid-flight legacy harvest; and a
real-git end to end where a bundled win is frozen, split into two commits by
"an agent" with plain git, and each part measured and gated by the plugin.
App tests: the freeze from the empty Harvest tab through promotions and the
agent guide, the runs list, the read-only old harvest, the candidate's commit
message.

## Live check (a second BB instance, a toy repository under /tmp, a temporary project)

See the PR description for the run; summary: a second BB server with its own
data directory (the installed plugin and its studies untouched), the plugin
installed there from this branch, a deterministic toy study (output bytes of a
status report, a `lines` guardrail) with Claude workers. Workers wrote their
own commit messages, used verbatim on best; one win bundled two unrelated
changes. After the freeze, an agent given the Harvest tab's prompt followed
the study-harvest skill: it split the bundled candidate, regrouped it with a
later win into two PRs, measured each on its base and gated it through the
plugin, and wrote PR descriptions citing the runs, without pushing.

## Not done, and known issues

- The Live view's bench strip and the Bench tab's host lines don't say a host
  is busy with a requested measurement (the interval is recorded with kind
  `adhoc` and shows in the Bench tab's interval list).
- `bb study measure` doesn't reuse a host's cached best build unless A is
  best; B is always built fresh.
- No RPC or app button starts a measurement or gate: agents do, with the CLI.
- `docs/design.md` still describes the plugin-run harvest; workstream C
  replaces those sections with this file at integration.
