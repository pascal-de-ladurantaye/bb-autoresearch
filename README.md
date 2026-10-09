# bb-plugin-autoresearch

A BB plugin for long-running, measured code-optimization studies. Short-lived
agent workers propose changes; the plugin owns the loop, the measurements, and
every keep or discard decision.

Design: [docs/design.md](docs/design.md) (see "Implementation notes" for where
the code differs from the design).

Status: **M0** (one worker at a time, the BB server's own machine as edit and
bench host). M1 (parallel workers), M2 (remote bench hosts, drift, holdout,
segments) and M3 (harvest, UI) are not built yet.

## Use it

1. In a thread of the project you want to optimize, ask the agent to set up a
   study. The `study-create` skill interviews you, drafts the spec (TOML) and
   oracle commands, and submits them with the `study_propose` tool. That thread
   becomes the study thread.
2. `bb study show <slug>`: review the spec.
3. `bb study calibrate <slug> [--wait]`: approve the spec; gates run on the base
   commit, then A/A measurement finds the noise floor and minimum detectable
   effect.
4. `bb study start <slug>`: approve calibration. Workers spawn (hidden threads in
   managed worktrees from `studies/<slug>/best`), submit candidates, and get
   verdicts as messages. The study thread gets strategist rounds.
5. Steer with `bb study ideas add <slug> "<idea>"`, `bb study pause|resume`, and
   stop for good with `bb study archive <slug>`.

Wins are squashed onto the local branch `studies/<slug>/best`, one commit per
promoted idea. Every candidate is kept under `refs/studies/<slug>/c/<n>`.
Nothing is pushed.

## Layout

| Path | What |
|---|---|
| `server.ts` | Factory: storage, host client, tools, CLI, events, the engine service (reconcile, then tick) |
| `host.ts` | `bb.host` entry: git and command execution on the edit/bench host |
| `src/host/` | Host RPC contract, host-side ops, server-side `HostRunner` (RPC or in-process) |
| `src/spec.ts` | TOML spec parsing, validation, oracle hash, ref names |
| `src/scope.ts` | Scope check (globs, protected paths, diff limits) |
| `src/stats.ts` | Paired relative differences, bootstrap CI of the median, sequential test, A/A calibration |
| `src/noise.ts` | Noise-class strategies: `noisy`, `deterministic`, `expensive` |
| `src/verdict.ts` | Verdict rules, guardrails, confirmation |
| `src/pipeline.ts` | Candidate pipeline stages: snapshot → scope → rebase/squash → gate → measure → decide → confirm → promote → report |
| `src/calibration.ts` | Gates on base + A/A calibration → segment |
| `src/scheduler.ts` | Pure policy: W, idea choice, budget, strategist triggers, idle nudge/abandon |
| `src/engine.ts` | Study lifecycle, control loop, worker/strategist tool behavior, reconciliation |
| `src/prompts.ts` | Worker brief, verdict messages, strategist digest |
| `src/tools.ts` | Role-gated agent tools and `bb.agents.configure` |
| `src/cli.ts` | `bb study` |
| `src/db/` | SQLite schema (append-only migrations) and typed store |
| `skills/` | `study-create` and `autoresearch` (usage) skills |

## Develop

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
bb plugin build
bb plugin install . && bb plugin reload autoresearch
```
