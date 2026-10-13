---
name: study-harvest
description: "Turn a frozen autoresearch study (or several studies on one repository) into reviewable pull requests: read `bb study evidence`, group and split the promoted changes, build branches or stacks, have the plugin measure and gate every PR with `bb study measure` and `bb study gate`, write PR descriptions in the repository's own style, and publish with the repository's own tools only when the human asks. Use when the user says \"harvest <study>\", \"turn the study's wins into PRs\", \"make PRs from the autoresearch results\", or wants two studies' results combined into one stack."
---

# Harvest an autoresearch study into PRs

A study ends with `studies/<slug>/best`: a linear chain of promoted commits, each one candidate that won on the study's bench. Harvesting turns that chain into pull requests a reviewer can take. **You own the judgment and the prose**: how to group and split, what to stack, the branch and commit names, the PR descriptions, and (only when asked) publishing. **The plugin owns every number**: effects, confidence intervals, guardrails and gates come from `bb study measure`, `bb study gate` and `bb study evidence`, never from your own benchmark runs or estimates. A PR that cites a number cites the plugin run it came from.

Never push, open a PR, or post anywhere until the human says so. Never edit `studies/<slug>/*` branches or `refs/studies/*` refs: they are the study's record.

## 1. Find the study and check it is frozen

- `bb study list`, then `bb study harvest <slug>`. You want **Harvesting** with harvest h<N> **frozen**: best is pinned as `refs/studies/<slug>/harvest/h<N>` and stays there even if the study resumes. Use that ref (or its sha), not `studies/<slug>/best`, as "best" from now on.
- Not frozen yet? Freezing stops the study's workers, so it is the human's call: ask them to press **Freeze best for harvest** on the Harvest tab (or run `bb study harvest <slug>`). A Paused study also takes measurements, but its best can move if it resumes, and a paused study whose bench is remote only has no machines until it is frozen.
- A harvest the plugin drafted before 1.0 (it shows changesets, contributions and PR drafts, marked "before 1.0") is a fine starting point: reuse its grouping and branches `studies/<slug>/harvest/h<N>/*` if they still make sense, and re-measure anything you change.

## 2. Read the evidence and the repository's conventions

```sh
bb study evidence <slug> --json > /tmp/<slug>-evidence.json   # if it prints {"file": ...}, read that file instead
```

The document (format `bb-autoresearch/evidence`, version 1) has: `study` (objective, metric and direction, noise class, guardrails, scope, gates), `git` (`base`, `best`, `frozen.ref`/`frozen.best`), `promotions` (first-parent commits base..best, oldest first: `sha`, candidate `n`, the worker's commit `title`/`body`, `paths`), `candidates` (every candidate: refs and shas, `commit` message, `stats`, `verdict`, `reasons`, `effect` with `ciLo`/`ciHi` against the best it was measured on, `guardrails`, `findings`), `findings` (what workers learned and why things won or lost), `segments` (calibration per oracle segment: `threshold`, `evalSeconds`), `benchHosts`, `harvests`, and `runs` (measurements and gates already asked for). Effects are better-is-positive in the metric's own direction.

For each promotion, read the diff: `git show --stat <sha>` then `git show <sha>`. Its effect in `candidates` was measured against the best before it, so it is a step, not a standalone number.

Then learn how this repository takes changes, before you write any branch or prose:

- The target branch and whether it moved past the study base (`git log --oneline <base>..origin/<target> | head`).
- Commit and PR style: `git log --oneline -20 origin/<target>`, `CONTRIBUTING*`, `.github/pull_request_template.md` (or `docs/`), recent merged PR titles if a CLI is available.
- The review tool and how stacks are published: GitHub (`gh`), Graphite (`gt`), Sapling (`sl`), Gerrit (`.gitreview`, `refs/for/*`), Phabricator (`.arcconfig`), a merge-request host, or plain branches. If you can't tell, ask the human.

## 3. Plan the PRs (and show the plan first)

Aim for PRs a reviewer can take or revert alone:

- **Group** promotions that are one idea refined across several candidates, or that only make sense together.
- **Keep apart** unrelated wins, even when the study found them back to back.
- **Split** a candidate that bundles unrelated changes (one commit touching two subsystems, a refactor plus an optimization): by file when that separates them, by hunk when it doesn't (`git checkout -p <sha> -- <path>`, `git add -p`, or edit the file).
- **Stack** a change on the one it needs (it touches the same lines, or builds on an API the other adds); base the rest on the target branch.
- **Drop** nothing on your own. A change with no measurable effect may still be worth keeping (a simplification); say so and let the human decide.
- If the target branch moved, plan to rebuild on its tip and measure there (the study's base is then only history).

Write the plan as a short table (PR, what it contains: promotions or hunks, its base, why grouped or split) plus the measurements you intend to ask for and their rough bench cost (pairs × `segments[-1].evalSeconds` per measurement). Show it to the human and wait, unless they told you to go ahead.

## 4. Build the branches

- Work in a worktree of your own: `git worktree add -b <branch> ../<slug>-harvest <base>`. Never commit in the plugin's checkouts.
- Rebuild each PR from the frozen best's commits: `git cherry-pick <sha>` for a whole promotion, `git checkout <sha> -- <paths>` or `git checkout -p <sha> -- <path>` for a part. Resolve conflicts yourself; you have the context.
- Commit messages: a promotion carried over whole keeps the worker's message (it is in `promotions[].title/body`); a split or merged commit gets a new one in the repository's style. The `Autoresearch-Study`/`Autoresearch-Candidate` trailers are provenance: keep them if the repository doesn't mind trailers, otherwise put the provenance in the PR description.
- Check nothing was lost: when every change is kept, the top of the stack (or all branches merged together) has the frozen best's tree: `git diff <frozen-best> <stack-top> --stat` prints nothing. When the base moved, compare the diffs instead (`git range-diff` or `git diff <base>..<frozen-best>` vs `git diff <new-base>..<stack-top>`).

## 5. Measure every PR with the plugin

`bb study measure <slug> <A> <B>` measures **B against A** with the study's protocol (a fixed number of pairs: the study's `n_max`, or `--pairs N` on noisy oracles) and its guardrails, under the bench lock, on the quietest free bench host, judged with that host's own win threshold; the time counts toward the study's bench budget. Leave `--host` out unless the human asks for a host: the plugin picks, and never uses a host it left out for its noise. A frozen study whose bench is remote only brings machines up only for requested runs and releases them after `idle_release_minutes` (10) idle: a run asked while none is ready waits for one (its progress says so), so the first measurement after a pause can take a few minutes longer. Queue related measurements together (`--detach`) rather than one every quarter hour. Refs: a sha, a branch or tag of the repository, `best`, `base`, `c/<n>`, `refs/studies/<slug>/harvest/h<N>`, or rev syntax (`<branch>~1`).

```sh
bb study measure <slug> <pr-base> <pr-head> --json           # the PR's own effect on its base (always)
bb study measure <slug> <best-without-X> <frozen-best> --json  # X's contribution at the top (when changes may interact)
bb study measure <slug> base <frozen-best> --json            # the whole study's gain (the reference total)
bb study gate <slug> <pr-head> --json                         # the study's gates on the PR (every PR, every stack layer)
```

- The result (`run.result`): `effect` with `ciLo`/`ciHi`, `n` pairs or runs, `threshold` (the win threshold of the host that measured it; hosts differ, so quote the host with the number), `classification` (`win`: B better than A beyond the threshold; `lose`: B worse; `inconclusive`), `reasons`, per-guardrail `state` (`ok`, `inconclusive`, `broken`) and `text`, `metrics` medians per side, `host`, and a one-line `text`. Its id is `r<N>`.
- Long runs: add `--detach`, then `bb study results <slug> r<N> --wait`. Each bench host measures one thing at a time; queue several with `--detach` and collect them.
- "Best without X" is a commit you make: revert X's commits from the frozen best in a scratch branch (`git revert --no-edit <shas>`), newest first.
- Relative effects measured on different bases don't add up: each PR shrinks (or grows) the denominator of the others. Quote the raw values next to every percentage (`metrics.a` → `metrics.b`, "727 → 418 bytes"), and give the whole study's gain (`base` against the frozen best) as the reference. Contributions measured at the top share best as the reference; if they are far from the total, the changes interact: say so in the PRs.
- An `inconclusive` PR is reported as such. Don't re-measure until it looks better; merge it into the change it supports, or ask the human.
- The plugin refuses while the study runs workers and its bench is busy, and for a study's own workers. Refusals name the fix.

Run the repository's usual fast checks too (lint, type check) where its CI would; the study's gates are the correctness bar the study used, not necessarily the repository's whole CI.

## 6. Write the PR descriptions

Follow the repository's template and tone. Each description says:

- what changed and why, in plain words (from the commit messages and `findings`: what workers learned is often the best "why");
- the measured effect, exactly as the plugin reported it, with where it came from: "12.4% lower p99_us (CI +10.9% to +13.8%), 20 pairs on bench-x86-01, against `main@abc1234`: `bb study measure routing-p99 abc1234 def5678` (r7)". Better is positive, in the metric's own terms;
- guardrails that weren't `ok`, in words;
- what was measured: the study's metric on its benchmark (from `study.objective` and the spec), so a reviewer knows what the number means. The study optimized that benchmark and nothing else; don't claim production gains it didn't measure;
- its place in the stack (depends on, needed by) and the study it came from (slug, harvest h<N>, candidates `c/<n>`).

No raw JSON, no numbers you computed yourself, no claims beyond what was measured.

## 7. Publish only when asked

When the human approves, publish with the repository's own tool, as drafts unless told otherwise: `gh pr create --draft --base <base> --head <branch>` per layer (bottom first), `gt submit --draft`, `sl pr submit`, `git push origin HEAD:refs/for/<target>` for Gerrit, `arc diff`, or whatever this repository uses. Push only your harvest branches. Then give the human the links. Archiving or resuming the study is their call (`bb study archive <slug>`, `bb study resume <slug>`).

## Several studies on one repository: one stack

Two studies on the same repository (say one on latency, one on memory) each freeze their own best, on their own base, with their own oracle. To ship them as one stack:

1. **Freeze both** and read both evidence documents. Their commits are told apart by the `Autoresearch-Study` trailer; refs are shared across the repository's worktrees (fetch first if the studies use different clones).
2. **Pick one base**: the target branch's current tip, usually newer than either study's base.
3. **Plan one stack across both**: order by dependency and file overlap (changes from both studies touching the same code go in one PR or adjacent layers); merge duplicates (two studies often find the same fix: keep one, from whichever study's version is simpler, and say so); keep the rest independent where possible.
4. **Build it** on the common base (cherry-pick or rebuild per PR, as above), and check nothing was lost against each study's frozen best (diff per study, since neither frozen tree contains the other's changes).
5. **Measure each layer with the study whose metric it targets**: `bb study measure <latency-study> <layer-base> <layer-head>`. Then check cross-effects: measure each layer (or at least the stack top against the common base) with the other study's oracle too, because a latency win can cost memory. Each study measures on its own bench hosts with its own protocol and guardrails; both must be frozen or paused (or idle) to take measurements. Gate each layer with every study whose gates apply.
6. **Describe** each PR with the measurements of both studies that apply to it, naming each study and run (`latency r4`, `memory r2`).

## Don't

- Don't run the benchmark yourself to produce a number for a PR, or quote one the plugin didn't measure.
- Don't push, publish, comment, or open PRs before the human says so.
- Don't touch `studies/<slug>/*` or `refs/studies/*`, or commit in the plugin's checkouts.
- Don't freeze, resume, pause, or archive a study yourself: ask the human.
