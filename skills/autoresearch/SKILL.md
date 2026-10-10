---
name: autoresearch
description: "How the autoresearch plugin works: the `bb study` commands, the study lifecycle, verdicts, the strategist role in a study thread, and the rules agents must follow. Use when the user asks about a study's status, wants to pause, resume, or add ideas, or when you receive an [autoresearch] strategist round."
---

# Autoresearch plugin

A **study** improves one metric of a codebase over hours or days. The plugin runs the loop: it spawns short-lived hidden **worker** threads (one idea each, in their own worktree branched from the study's best), measures every submitted candidate against `best` on its own oracle, and promotes only statistically real wins. Agents propose; the plugin decides.

## Commands (humans run these)

| Command | What it does |
|---|---|
| `bb study list` | Studies (active first): state, what needs the human, best vs base, candidates, bench time |
| `bb study needs [slug]` | What needs the human (approvals, system pauses, failures, a ready harvest), one line each with the command that resolves it |
| `bb study show <slug> [--events N]` | Needs you, best vs base, spec, budget, guardrails, bench, calibration, ideas, last candidates, workers, notices, recent events |
| `bb study calibrate <slug> [--wait]` | Approve the current (or pending) spec; run gates and A/A noise measurement on every bench host. Mid-run this is an oracle change: new segment |
| `bb study approve <slug>` | Apply a pending spec whose oracle is unchanged (budget, agents), without recalibration |
| `bb study start <slug>` | Approve calibration and start running (or resume) |
| `bb study bench <slug>` | Bench hosts: health checks, git bundle transfers, drift checks, segments |
| `bb study drift <slug>` | Run a drift check (A/A on best) on every bench host at its next free slot |
| `bb study pause <slug>` / `resume <slug>` | Pause: no new workers; running workers finish their submission |
| `bb study concurrency <slug> <n\|auto>` | Lower the worker limit below the spec's `max_workers` (requests above it are clamped), or return to the spec's value |
| `bb study ideas add <slug> "<title>" [--rationale --theme --priority --start-ref c/N --variation-of ID --no-pin]` | Queue (and pin) an idea |
| `bb study ideas list <slug>` | The idea board |
| `bb study workers <slug>` | Worker threads and their state |
| `bb study archive <slug> [--archive-thread]` | Stop workers, archive their threads, remove bench checkouts (git refs kept); `--archive-thread` also archives the study thread |
| `bb study harvest <slug> [--wait] [--restart] [--no-measure-standalone]` | Harvest (dry run): group the wins into changesets, measure each one's contribution by ablation, check each alone, draft local branches and PR bodies. Shows progress when one is running |
| `bb study harvest <slug> --publish` | Push the ready harvest's branches and open DRAFT PRs with `gh` (refuses without a GitHub remote) |
| `bb study report <slug>` | The study report in Markdown |

Every command takes `--json` and then prints one JSON document built from the same view models as the Studies page (`list` → `{ studies }`, `show` → the overview, `needs` → `{ total, studies: [{ slug, needs }] }`, `bench`, `harvest`, `ideas list` → `{ ideas }`, `workers` → `{ workers }`, `report` → `{ markdown }`, controls → `{ ok, message, study }`). Errors come as `{ ok: false, error: { code, message, hint } }`; the hint names the command to run next. Improvements read the same everywhere: positive is better in the metric's own direction ("20.0% lower size", "c/3 win +4.2% (CI +3.7% to +5.2%)"); harvest contributions are shares of the gain.

The **Studies** page in the BB sidebar is the primary surface: every control above is there too, including the deliberate steps (approve a spec and calibrate, approve the calibration and start, start a harvest, publish draft PRs, archive), each behind a dialog that says exactly what will happen. Its Overview leads with **Needs you** (pending approvals, system pauses, drift alarms, failed calibration, a ready harvest); the sidebar entry and the study thread's header badge show how many items wait. In-app and CLI approval are equivalent and audited the same way. Study and worker threads show a header badge with live status. While a study runs, the page opens on its read-only **Live** tab (worker lanes and phases, candidates moving through tests and the bench, verdicts, the bench, the ideas up next, a feed, one worker's transcript at a time); the study thread's header badge has a **Live** button that opens the same view beside the thread (also "Study live view" in a thread's right-panel launcher). If the human asks how to watch the study, point them there. Workers' phases (reading, editing, testing) come from the tool calls their threads make, never from message text.

In the study thread, plugin messages show one line to the human (for example "Strategist round 3 (new verdicts): 2 new verdicts (1 win, 1 lose), best now 47% fewer ops vs base · 4 ideas queued"); the full digest or verdict detail is an agent-only block that you still receive in full.

`calibrate`, `approve`, `start`, `pause`, `resume`, `concurrency`, `drift`, `harvest`, and `archive` are human controls: the plugin refuses them from a study's own worker or strategist thread. If the user asks you to run one, you may, from an ordinary thread. Every control change is recorded as a `control.*` event and a notice, with the caller and any study agent turns running at that moment.

## Lifecycle

Draft (spec proposed with `study_propose`) → Calibrating (`bb study calibrate`) → Running (`bb study start`) ⇄ Paused → Harvesting (`bb study harvest`) → Running again (`bb study resume`: keep exploring) or Archived. Running → Calibrating again when the human approves an oracle change; that starts a new **segment** (`refs/studies/<slug>/segment/<k>` pins its baseline). Calibration failing (gates red on base, oracle too noisy) returns a new study to Draft; a failed mid-run recalibration keeps the old spec and pauses. The system pauses a running study itself when the budget is exhausted, the oracle breaks (best fails to build or measure, the holdout fails on best), a drift check finds noise above 2× the calibrated level, the host keeps failing, or the study thread goes away. A bench host that fails its health check or goes offline only defers measurements on that host; the human is notified after a grace period. It records a notice (study page, `bb study show`), marks the study thread unread without starting a turn, and includes the notice in the next strategist round.

## Verdicts

`win` (promoted: squashed onto `studies/<slug>/best`; it passed confirmation and, when configured, the hidden holdout), `lose` (worse, broke a guardrail, or failed the holdout; a guardrail breaks when its CI is entirely beyond its per-step limit against best or its total limit against the segment base; a CI that straddles a limit is flagged inconclusive, not a rejection), `inconclusive` (did not clear the minimum detectable effect), `gate_failed`, `conflict` (no longer applies onto best; the worker rebases and resubmits, and the first two conflicts don't count against its submission limit), `rejected` (touched protected or out-of-scope paths, or too large). Candidates are rebased onto best automatically when best moves; a win measured against a best that moved is measured again before promotion. Every candidate is kept as `refs/studies/<slug>/c/<n>`. Nothing is pushed.

## If you are the strategist (the study thread)

Messages starting with `[autoresearch] Strategist round` carry a digest: recent verdicts, findings, the idea board, best's diagnostics, the dossier, budget. Each round:

- keep the idea queue full and diverse: `study_queue_ideas` (title, rationale, theme, priority, optional `start_ref` like `c/12`, optional `variation_of`). At most ceil(W/2) workers run one theme at once.
- lost ideas are never assigned again; an idea that repeats a lost one's title is skipped unless you set `variation_of` to the lost idea's id and say what is different
- retire dead directions: `study_retire_idea`
- keep the dossier current: `study_update_dossier` (workers get it in their brief)
- look things up: `study_search_findings`
- watch the guardrail headroom line: each guardrail's room left under its total limit against the segment base. With little room left, prefer ideas that don't cost that guardrail, or that win some of it back; a win that would push best beyond the total limit is rejected
- relay any "Notices for the human" in one or two lines, pointing to the Studies page for anything that needs them
- reply to the human in two or three short lines (what changed, what you queued, anything they should decide) and end your turn
- write improvements the way the plugin does: better is positive, in the metric's own terms ("12% lower p99")

A message starting with `[autoresearch] Harvest` asks you to group the promotions on best into changesets: call `study_propose_harvest` once, every promoted candidate in exactly one group, grouped by theme (one idea refined twice belongs together; unrelated wins stay separate so each PR can be reviewed alone). The plugin measures and drafts the PRs; if you don't answer it uses one changeset per win.

You never edit code, run benchmarks, or decide verdicts. Concurrency, budget, the oracle, and pausing belong to the human.

The holdout is secret: verdicts say only "passed/failed the holdout check". Never try to find or reproduce the holdout workload.

## Harvest

Harvest freezes best (in-flight candidates finish; new submissions are refused), then for each changeset reverts it from best and measures that against best with the study's protocol: the **contribution** with a CI. A revert that conflicts or breaks the gates means a later changeset depends on it; dependent changesets become a **stack** of PRs. Each changeset is then applied alone to its PR base (the study base, or the layer below in its stack) and gated (and measured unless `--no-measure-standalone`). Dry run: local branches `studies/<slug>/harvest/h<N>/*`, PR bodies and `report.md` under the plugin's data dir. The report compares the sum of contributions with the measured total gain and warns when the gap exceeds its CI (the changes interact). Changesets with no measurable contribution are flagged droppable: the human decides.

## Budgets and provider limits

`max_candidates`, `max_bench_hours`, `deadline`, and optional `max_tokens` (per-thread token usage as BB reports it) are enforced; reaching one pauses the study and proposes a harvest. Shares in `notify_at` raise a notice once. A rate-limited turn is retried at the provider window's reset (up to `max_rate_limit_retries`), and no new worker starts until then; a provider usage window above `usage_tight_percent` halves W.

## Constraints

- Up to `max_workers` workers at once; W adapts as min(max_workers, ceil(think/eval)+1), and no worker spawns while the bench queue is at least W deep.
- The server's own machine is the edit host (workers, gates). Bench hosts are `local` (plugin checkouts here) or BB machines with their own clone, fed by git bundles; queued candidates go oldest first to whichever bench host is free, online and healthy.
- `noisy` and `expensive` oracles take the bench lock: one measurement at a time per bench host; gates run in parallel outside it.
- The spec lives in plugin storage, not the repo. Proposing a revised spec after start makes it pending until the human approves it (`approve` without an oracle change, `calibrate` with one).
