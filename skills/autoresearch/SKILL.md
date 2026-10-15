---
name: autoresearch
description: "How the autoresearch plugin works: the `bb study` commands, the study lifecycle, verdicts, the strategist role in a study thread, and the rules agents must follow. Use when the user asks about a study's status, wants to pause, resume, or add ideas, or when you receive an [autoresearch] strategist round."
---

# Autoresearch plugin

A **study** improves one metric of a codebase over hours or days. The plugin runs the loop: it spawns short-lived hidden **worker** threads (one idea each, in their own worktree branched from the study's best), measures every submitted candidate against `best` on its own oracle, and promotes candidates that pass its measurement rules. Agents propose; the plugin decides.

## Start with the current task

- **Status:** read `bb study needs [slug]`, then `bb study show <slug> --json` if detail is needed. Reply with the outcome and what needs the human; do not repeat the full output. For watching or replay, point to Studies → the study → Live.
- **Strategist round:** follow the instructions below. Keep the idea queue useful; do not take study controls.
- **Create:** read the `study-create` skill.
- **Harvest:** read the `study-harvest` skill before branching, measuring or preparing PRs.
- **Commands, lifecycle, verdicts or UI navigation:** read [usage](references/usage.md). It contains the command reference, JSON contracts, lifecycle and all verdict meanings.
- **Budget, scheduling, drift or bench-host questions:** read [operations](references/operations.md) before explaining or proposing a change.

## Who decides

Agents propose; the plugin measures and decides verdicts. The human controls approval, starting, pausing, resuming, concurrency, drift checks, freezing and archiving. Study workers and the strategist must ask the human to take those actions. An ordinary thread may run a control only when the human asks. Showing an existing frozen harvest is read-only; freezing one is not.

The strategist or an ordinary thread may request `bb study measure` and `bb study gate`; a study’s workers may not. Every measurement uses the plugin’s protocol and bench budget. Read the harvest skill for busy-bench and remote-host constraints. Never publish unless asked.

Write measured improvements with their metric and reference: better is positive ("12% lower p99 vs previous best"). Label worker explanations as hypotheses, not plugin measurements. Do not hide an inconclusive result or a flagged guardrail behind a positive percentage.

## If you are the strategist (the study thread)

Messages starting with `[autoresearch] Strategist round` carry a digest: recent verdicts, findings, the idea board, best's diagnostics, the dossier, budget. Each round:

- read code at best, not in your own checkout: your environment is whatever was picked when the study was created (often a worktree of the project's default branch), so it may be on another commit. Each round's "Code" block names the study base and `studies/<slug>/best` with their commits. Read best without switching branches, from any checkout of the same repository (refs are shared across its worktrees): `git show studies/<slug>/best:<path>`, `git grep -n <pattern> studies/<slug>/best`, `git diff --stat <base>..studies/<slug>/best`, `git log --oneline <base>..studies/<slug>/best`. If your checkout isn't a worktree of the study's repository, add `-C <study repo path>` (the block gives that form). Don't check out or commit in your own checkout.
- keep the idea queue full and diverse: `study_queue_ideas` (title, rationale, theme, priority, optional `start_ref` like `c/12`, optional `variation_of`). At most ceil(W/2) workers run one theme at once.
- lost ideas are never assigned again; an idea that repeats a lost one's title is skipped unless you set `variation_of` to the lost idea's id and say what is different
- retire dead directions: `study_retire_idea`
- keep the dossier current: `study_update_dossier` (workers get it in their brief)
- look things up: `study_search_findings`
- watch the guardrail headroom line: each guardrail's room left under its total limit against the segment base. With little room left, prefer ideas that don't cost that guardrail, or that win some of it back; a win that would push best beyond the total limit is rejected
- relay any "Notices for the human" in one or two lines, pointing to the Studies page for anything that needs them
- reply in three short lines: **Changed:** one plugin-reported result; **Queued:** what you actually changed; **Needs you:** the decision, or nothing. Do not repeat the digest. End your turn.
- write improvements the way the plugin does: better is positive, in the metric's own terms ("12% lower p99")

When the human asks you to harvest the study (turn its wins into PRs), follow the `study-harvest` skill: you do the grouping, branches and PR descriptions with the repository's own tools, and every number and check comes from `bb study measure` and `bb study gate`. Publish only when the human says so.

You never edit code, run benchmarks, or decide verdicts. Concurrency, budget, the oracle, and pausing belong to the human.

The holdout is secret: verdicts say only "passed/failed the holdout check". Never try to find or reproduce the holdout workload.

## Harvest

Harvest freezes best: in-flight candidates finish, new submissions are refused, and best is pinned as `refs/studies/<slug>/harvest/h<N>` (it stays pinned if the study resumes). The plugin does nothing more: an agent turns the frozen best into PRs with the `study-harvest` skill, reading `bb study evidence`, measuring with `bb study measure`, gating with `bb study gate`, and publishing with the repository's own tools only when the human asks. The study optimized its benchmark, nothing more: whether that benchmark represents production is the human's call, so PRs say what was measured. Harvests the plugin ran itself before 1.0 (changesets, ablations, PR drafts) stay readable on the Harvest tab and with `bb study harvest <slug> --harvest N`.

## Reference

[Operations](references/operations.md) preserves the full budget, scheduling, remote-host and spec-version rules. Read it when those mechanisms affect the current task.
