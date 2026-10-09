---
name: autoresearch
description: "How the autoresearch plugin works: the `bb study` commands, the study lifecycle, verdicts, the strategist role in a study thread, and the rules agents must follow. Use when the user asks about a study's status, wants to pause, resume, or add ideas, or when you receive an [autoresearch] strategist round."
---

# Autoresearch plugin

A **study** improves one metric of a codebase over hours or days. The plugin runs the loop: it spawns short-lived hidden **worker** threads (one idea each, in their own worktree branched from the study's best), measures every submitted candidate against `best` on its own oracle, and promotes only statistically real wins. Agents propose; the plugin decides.

## Commands (humans run these)

| Command | What it does |
|---|---|
| `bb study list` | Studies with state, best vs base, budget |
| `bb study show <slug> [--events N]` | Spec, calibration, best, ideas, last candidates, workers, recent events |
| `bb study calibrate <slug> [--wait]` | Approve the current spec; run gates on base and A/A noise measurement |
| `bb study start <slug>` | Approve calibration and start running (or resume) |
| `bb study pause <slug>` / `resume <slug>` | Pause: no new workers; running workers finish their submission |
| `bb study concurrency <slug> <n\|auto>` | Override `max_workers` (1-64), or return to the spec's value |
| `bb study ideas add <slug> "<title>" [--rationale --theme --priority --start-ref c/N --variation-of ID --no-pin]` | Queue (and pin) an idea |
| `bb study ideas list <slug>` | The idea board |
| `bb study workers <slug>` | Worker threads and their state |
| `bb study archive <slug>` | Stop workers, archive their threads, remove bench checkouts (git refs kept) |
| `bb study harvest <slug>` | Placeholder until harvest lands (M3) |

The same controls (and the idea board, candidate details, and worker links) are on the **Studies** page in the BB sidebar; study and worker threads show a header badge with live status.

`calibrate`, `start`, `pause`, `resume`, `concurrency`, and `archive` are human controls: the plugin refuses them from a study's own worker or strategist thread. If the user asks you to run one, you may, from an ordinary thread.

## Lifecycle

Draft (spec proposed with `study_propose`) → Calibrating (`bb study calibrate`) → Running (`bb study start`) ⇄ Paused → Archived. Calibration failing (gates red on base, oracle too noisy) returns the study to Draft. The system pauses a running study itself when the budget is exhausted, the oracle breaks (best fails to build or measure), the host keeps failing, or the study thread goes away. It records a notice (study page, `bb study show`), marks the study thread unread without starting a turn, and includes the notice in the next strategist round.

## Verdicts

`win` (promoted: squashed onto `studies/<slug>/best`), `lose` (worse, or broke a guardrail), `inconclusive` (did not clear the minimum detectable effect), `gate_failed`, `conflict` (no longer applies onto best; the worker rebases and resubmits, and the first two conflicts don't count against its submission limit), `rejected` (touched protected or out-of-scope paths, or too large). Candidates are rebased onto best automatically when best moves; a win measured against a best that moved is measured again before promotion. Every candidate is kept as `refs/studies/<slug>/c/<n>`. Nothing is pushed.

## If you are the strategist (the study thread)

Messages starting with `[autoresearch] Strategist round` carry a digest: recent verdicts, findings, the idea board, best's diagnostics, the dossier, budget. Each round:

- keep the idea queue full and diverse: `study_queue_ideas` (title, rationale, theme, priority, optional `start_ref` like `c/12`, optional `variation_of`). At most ceil(W/2) workers run one theme at once.
- lost ideas are never assigned again; an idea that repeats a lost one's title is skipped unless you set `variation_of` to the lost idea's id and say what is different
- retire dead directions: `study_retire_idea`
- keep the dossier current: `study_update_dossier` (workers get it in their brief)
- look things up: `study_search_findings`
- relay any "Notices for the human" in one or two lines
- reply briefly and end your turn

You never edit code, run benchmarks, or decide verdicts. Concurrency, budget, the oracle, and pausing belong to the human.

## Constraints (M1)

- Up to `max_workers` workers at once; W adapts as min(max_workers, ceil(think/eval)+1), and no worker spawns while the bench queue is at least W deep.
- The server's own machine is both edit host and bench host (remote bench hosts arrive in M2).
- `noisy` and `expensive` oracles take the bench lock: one measurement at a time per bench host; gates run in parallel outside it.
- The spec lives in plugin storage, not the repo. Changing it after start (new oracle segment) is not supported yet: archive and create a new study.
