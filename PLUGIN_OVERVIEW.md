## What you get

- **Studies.** A study optimizes one number: test runtime, render time, request latency, bundle size, instruction counts. Describe the goal in a thread; the `study-create` skill reads the code and drafts the spec: the metric, the benchmark command, the tests that must keep passing, the files agents may edit, and optional guardrail metrics.
- **An orchestrated loop.** Short-lived worker agents each take one idea, edit in their own git worktree and submit a candidate with their own commit message. A strategist agent in the study thread keeps the idea queue full and keeps a map of what has been learned. The plugin schedules everything; there is no prompt telling an agent to never stop.
- **Verdicts the plugin decides.** Agents never run the benchmark or choose what to keep. The plugin runs the tests, measures one candidate at a time per bench machine with paired, interleaved runs, and keeps a change only when its confidence interval clears the smallest effect calibration says it can detect. Wins are confirmed with fresh runs before they land.
- **Guardrails.** Secondary metrics have a per-change limit and a limit against the starting point, both judged on a confidence interval, so small regressions can't pile up.
- **Bench machines.** Measure on this machine (tests take turns with timing runs), on another BB machine, or on short-lived remote machines lent by a bench provider plugin. Each machine is calibrated and judged with its own threshold, candidates go to the quietest one, and a much noisier one is left out. Remote machines survive a plugin update.
- **Live view and replay.** Watch workers, candidates and each measurement's confidence band narrowing pair by pair, beside the study thread if you like. Any study can be replayed from its recorded events.
- **Harvest with your agent.** Freeze the study and ask your agent to turn the result into reviewable PRs with the `study-harvest` skill. It groups and splits the changes and writes descriptions in your repository's style; every number comes from the plugin (`bb study evidence`, `measure`, `gate`), and it publishes with your own tools only when you ask.

## How it works

1. Describe what to make faster or smaller. The skill drafts the spec and you approve it on the Oracle tab.
2. Calibration runs the benchmark against itself to measure its noise and the smallest change it can detect.
3. Start the study. Workers and the strategist run until the budget you set (candidates, bench hours, tokens, deadline) is used.
4. Steer from the Ideas tab: add, pin, reorder or veto ideas.
5. Harvest: freeze best and have your agent make PRs from it.

Every candidate is kept as a git ref, wins and losses alike, so nothing an agent tried is lost.

## You own the benchmark

A study optimizes the benchmark you give it. The plugin owns the measurements and every keep-or-discard decision; whether the benchmark represents your production workload, inputs and hardware is your call. An optional holdout workload, kept away from the agents, can catch changes that special-case one input.

## Requirements

- BB 0.45 or newer, and git 2.38 or newer on every machine a study uses.
- The build, test and benchmark commands are your repository's own and run with full trust on the bench machine. Timing-sensitive studies want a quiet machine, ideally of the production machine's shape.
- Remote bench machines need a bench provider plugin; the repository has an example one and the contract.
- Version 1.0. It has run on toy repositories and on real-world performance tasks, including a blind comparison against another autoresearch loop from the same starting commit (5.4× on that benchmark against 3.9×, in about 3.6× the wall time; one run each).

## Credits

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch) and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).
