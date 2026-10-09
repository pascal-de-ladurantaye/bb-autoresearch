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
| `bb study ideas add <slug> "<title>" [--rationale --theme --priority --no-pin]` | Queue (and pin) an idea |
| `bb study ideas list <slug>` | The idea board |
| `bb study workers <slug>` | Worker threads and their state |
| `bb study archive <slug>` | Stop workers, archive their threads, remove bench checkouts (git refs kept) |
| `bb study harvest <slug>` | Placeholder until harvest lands (M3) |

`calibrate`, `start`, `pause`, `resume`, and `archive` are human controls: the plugin refuses them from a study's own worker or strategist thread. If the user asks you to run one, you may, from an ordinary thread.

## Lifecycle

Draft (spec proposed with `study_propose`) → Calibrating (`bb study calibrate`) → Running (`bb study start`) ⇄ Paused → Archived. Calibration failing (gates red on base, oracle too noisy) returns the study to Draft. The system pauses a running study itself when the budget is exhausted, the oracle breaks (best fails to build or measure), the host keeps failing, or the study thread goes away; it says why in the study thread.

## Verdicts

`win` (promoted: squashed onto `studies/<slug>/best`), `lose` (worse, or broke a guardrail), `inconclusive` (did not clear the minimum detectable effect), `gate_failed`, `conflict` (no longer applies onto best), `rejected` (touched protected or out-of-scope paths, or too large). Every candidate is kept as `refs/studies/<slug>/c/<n>`. Nothing is pushed.

## If you are the strategist (the study thread)

Messages starting with `[autoresearch] Strategist round` carry a digest: recent verdicts, findings, the idea board, best's diagnostics, the dossier, budget. Each round:

- keep the idea queue full and diverse: `queue_ideas` (title, rationale, theme, priority, optional `start_ref` like `c/12`)
- retire dead directions: `retire_idea`
- keep the dossier current: `update_dossier` (workers get it in their brief)
- look things up: `search_findings`
- reply briefly and end your turn

You never edit code, run benchmarks, or decide verdicts. Concurrency, budget, the oracle, and pausing belong to the human.

## Constraints (M0)

- One worker at a time; the server's own machine is both edit host and bench host.
- `noisy` and `expensive` oracles take the bench lock: one measurement at a time.
- The spec lives in plugin storage, not the repo. Changing it after start (new oracle segment) is not supported yet: archive and create a new study.
