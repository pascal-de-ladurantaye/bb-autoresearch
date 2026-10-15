# Evidence fields

Read when interpreting `bb study evidence --json`; these fields are plugin evidence, not estimates to recompute in prose.

The document (format `bb-autoresearch/evidence`, version 1) has: `study` (objective, metric and direction, noise class, guardrails, scope, gates), `git` (`base`, `best`, `frozen.ref`/`frozen.best`), `promotions` (first-parent commits base..best, oldest first: `sha`, candidate `n`, the worker's commit `title`/`body`, `paths`), `candidates` (every candidate: refs and shas, `commit` message, `stats`, `verdict`, `reasons`, `effect` with `ciLo`/`ciHi` against the best it was measured on, `guardrails`, `findings`), `findings` (what workers learned and why things won or lost), `segments` (calibration per oracle segment: `threshold`, `evalSeconds`), `benchHosts`, `harvests`, and `runs` (measurements and gates already asked for). Effects are better-is-positive in the metric's own direction.
