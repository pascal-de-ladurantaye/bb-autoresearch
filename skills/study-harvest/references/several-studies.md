# Combining studies

Read before combining two or more studies into one stack. The main skill’s human-approval and publication boundaries still apply.

## One repository, one stack

Two studies on the same repository (say one on latency, one on memory) each freeze their own best, on their own base, with their own oracle. To ship them as one stack:

1. **Freeze both** and read both evidence documents. Their commits are told apart by the `Autoresearch-Study` trailer; refs are shared across the repository's worktrees (fetch first if the studies use different clones).
2. **Pick one base**: the target branch's current tip, usually newer than either study's base.
3. **Plan one stack across both**: order by dependency and file overlap (changes from both studies touching the same code go in one PR or adjacent layers); merge duplicates (two studies often find the same fix: keep one, from whichever study's version is simpler, and say so); keep the rest independent where possible.
4. **Build it** on the common base (cherry-pick or rebuild per PR, as above), and check nothing was lost against each study's frozen best (diff per study, since neither frozen tree contains the other's changes).
5. **Measure each layer with the study whose metric it targets**: `bb study measure <latency-study> <layer-base> <layer-head>`. Then check cross-effects: measure each layer (or at least the stack top against the common base) with the other study's oracle too, because a latency win can cost memory. Each study measures on its own bench hosts with its own protocol and guardrails; both must be frozen or paused (or idle) to take measurements. Gate each layer with every study whose gates apply.
6. **Describe** each PR with the measurements of both studies that apply to it, naming each study and run (`latency r4`, `memory r2`).
