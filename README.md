# bb-plugin-autoresearch

A BB plugin for long-running, measured code-optimization studies. Short-lived
agent workers propose changes; the plugin owns the loop, the measurements, and
every keep or discard decision.

Design: [docs/design.md](docs/design.md) (see "Implementation notes" for where
the code differs from the design).

Status: **M1** (parallel workers with a serialized bench queue, adaptive W,
rebase/conflict handling, the Studies page and thread badge). The BB server's
own machine is still both edit and bench host. M2 (remote bench hosts, drift,
holdout, segments) and M3 (harvest, remaining tabs) are not built yet.

## Use it

1. In a thread of the project you want to optimize, ask the agent to set up a
   study. The `study-create` skill interviews you, drafts the spec (TOML) and
   oracle commands, and submits them with the `study_propose` tool. That thread
   becomes the study thread.
2. `bb study show <slug>`: review the spec.
3. `bb study calibrate <slug> [--wait]`: approve the spec; gates run on the base
   commit, then A/A measurement finds the noise floor and minimum detectable
   effect.
4. `bb study start <slug>`: approve calibration. Up to `max_workers` workers
   spawn (hidden threads in managed worktrees from `studies/<slug>/best`; W
   adapts to think and eval times), submit candidates, and get verdicts as
   messages. Gates run in parallel; the bench measures one candidate at a
   time. The study thread gets strategist rounds.
5. Watch and steer on the **Studies** page (sidebar): Overview (trajectory,
   budget, utilization, pause/resume/concurrency), Ideas (add, reorder, pin,
   veto), Candidates (verdicts, samples, diffs, worker threads). Study and
   worker threads carry a header badge. The CLI has the same controls:
   `bb study ideas add <slug> "<idea>"`, `bb study concurrency <slug> <n|auto>`,
   `bb study pause|resume`, and `bb study archive <slug>` to stop for good.

Wins are squashed onto the local branch `studies/<slug>/best`, one commit per
promoted idea. Every candidate is kept under `refs/studies/<slug>/c/<n>`.
Nothing is pushed.

## Layout

| Path | What |
|---|---|
| `server.ts` | Factory: storage, host client, tools, RPC, CLI, events, the engine service (reconcile, then tick) |
| `app.tsx` | Frontend entry: Studies nav panel and the thread-header badge |
| `src/app/` | Study page (Overview, Ideas, Candidates), trajectory chart, badge, rpc data hooks |
| `components/`, `lib/` | Vendored UI source from the BB registry (button, card, input, icon) |
| `host.ts` | `bb.host` entry: git and command execution on the edit/bench host |
| `src/host/` | Host RPC contract, host-side ops, server-side `HostRunner` (RPC or in-process) |
| `src/spec.ts` | TOML spec parsing, validation, oracle hash, ref names |
| `src/scope.ts` | Scope check (globs, protected paths, diff limits) |
| `src/stats.ts` | Paired relative differences, bootstrap CI of the median, sequential test, A/A calibration |
| `src/noise.ts` | Noise-class strategies: `noisy`, `deterministic`, `expensive` |
| `src/verdict.ts` | Verdict rules, guardrails, confirmation |
| `src/pipeline.ts` | Candidate pipeline stages (snapshot → scope → rebase/squash → gate → measure → decide → confirm → promote → report) and the job launcher: parallel gates, one measurement per bench lock key |
| `src/rpc.ts` | `bb.rpc` contract and handlers for the study page and badge |
| `src/views.ts` | Read models: study summary, overview, trajectory, utilization, ideas, candidates, badge |
| `src/calibration.ts` | Gates on base + A/A calibration → segment |
| `src/scheduler.ts` | Pure policy: adaptive W, backpressure, idea choice (diversity, no repeats), budget, strategist triggers, idle nudge/abandon |
| `src/engine.ts` | Study lifecycle, control loop, worker/strategist tool behavior, reconciliation |
| `src/prompts.ts` | Worker brief, verdict messages, strategist digest |
| `src/tools.ts` | Role-gated agent tools and `bb.agents.configure` |
| `src/cli.ts` | `bb study` |
| `src/db/` | SQLite schema (append-only migrations) and typed store |
| `skills/` | `study-create` and `autoresearch` (usage) skills |

## Develop

```sh
pnpm install
pnpm test          # vitest (backend, rpc, and jsdom frontend tests)
pnpm typecheck     # tsc --noEmit
bb plugin build
bb plugin install . && bb plugin reload autoresearch
```
