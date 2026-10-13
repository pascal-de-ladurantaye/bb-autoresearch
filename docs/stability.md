# Stability

What bb-autoresearch 1.0 keeps stable, for the people and tools that build on it: specs you write, bench provider plugins, scripts that call `bb study … --json`, and agents that read a study's evidence. Everything not listed here can change in any release.

It doesn't promise that a study's result means anything outside its benchmark: a study optimizes the benchmark it is given, and whether that benchmark represents production is the user's responsibility.

## What 1.0 commits to

### Spec TOML

Every key the 1.0 spec schema accepts ([`src/spec.ts`](../src/spec.ts); the README and [guide](guide.md) describe them) keeps its name, type and meaning in every 1.x release:

- A spec that 1.0 accepts is accepted by every 1.x release, and judged the same way.
- Its **oracle hash** stays the same, so an upgrade never forces a recalibration or a new segment by itself. Defaults of keys that are part of the oracle hash don't change within 1.x; a new hashed key is left out of the hash when it is unset, as `remote_bench` was in v0.3.0.
- New keys may be added, always optional, with defaults that keep 1.0 behavior. The schema is strict (an unknown key is an error), so a spec that uses a newer key needs that newer release.

Keys new in 1.0 that are not part of the oracle hash:

| Key | Default | What it does |
|---|---|---|
| `[oracle] max_host_noise_ratio` | `2` | A bench host whose calibrated noise floor is more than this times the median of the other hosts' (and beyond what chance gives equal hosts) is left out: a remote machine is replaced, a local or BB host measures nothing until the next calibration. `0` turns it off; otherwise 1-100. |
| `[oracle.health] recalibration_retries` | `30` | Health-check retries of an automatic recalibration, `retry_seconds` apart, before it pauses the study. |

And one that is part of the oracle hash, left out of it when absent or empty so specs without it keep their hash:

| Key | Default | What it does |
|---|---|---|
| `[[oracle.remote_bench]] machine` | none | Provider-specific machine options (an inline table), passed verbatim to `benchProvider.create` for every machine of the entry. |

Deprecated in 1.0: the `[harvest]` keys (`measure_standalone`, `group_timeout_minutes`, `remote`) are still accepted, so stored specs keep parsing, and have no effect since harvest became a freeze. They will be removed in 2.0.

### Bench provider contract v1

The eleven `benchProvider.*` methods, their input and output schemas, the error codes and the rules in [bench-providers.md](bench-providers.md) ([`src/bench-provider/contract.ts`](../src/bench-provider/contract.ts)) are frozen as `contractVersion: 1`:

- Every 1.x release talks to a provider that implements v1.
- The schemas are strict on both sides, so from 1.0 on v1 gains no field, method or error code. Any change is a new contract version, and 1.x keeps accepting v1 providers alongside it.
- 1.0 completed v1 with two optional fields: `create`'s `machine` (at most 32 keys matching `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, values strings of at most 256 characters, numbers or booleans) and `describe`'s `machineOptions` (`[{ name, description }]`). They are part of contract v1 as frozen for 1.x, with their rule: a provider rejects a machine option it doesn't understand with `[invalid] unknown machine option <key>`. bb-autoresearch sends `machine` only when a spec sets options, so a provider written before them works until a study asks for machine options; a provider that lists `machineOptions` needs bb-autoresearch 1.0 or newer (earlier releases' strict schema refuses the field).
- What bb-autoresearch does with a provider (which labels it sets, when it creates, lists and destroys machines, the layout it uses under the remote home) is behavior, not contract: a provider must not depend on it beyond what bench-providers.md says.

### CLI commands and `--json`

The `bb study` commands and flags of 1.0 (the README's CLI table) keep working in 1.x, and each command's `--json` document keeps its fields:

- A field keeps its name, type and meaning. New fields may appear anywhere, so a consumer must ignore fields it doesn't know.
- Errors keep their shape: `{ "ok": false, "error": { "code", "message", "hint" } }`, where the hint names the command to run next.
- The human-readable text output is not stable: parse `--json`, not the text.

| Command | `--json` prints |
|---|---|
| `list` | `{ studies }` |
| `needs [slug]` | `{ total, studies: [{ slug, needs }] }` |
| `show <slug>` | the study overview |
| `calibrate`, `approve`, `start`, `pause`, `resume`, `concurrency`, `drift`, `archive` | `{ ok, message, study }` |
| `ideas add` / `ideas list` | `{ ok, message, idea }` / `{ ideas }` |
| `workers <slug>` | `{ workers }` |
| `bench <slug>` | the bench view: `slug`, `state`, `segment`, hosts, health, transfers, drift, `segments`, `artifacts` |
| `harvest <slug> [--harvest N]` | the harvest view (plus `message` when this call started a freeze) |
| `evidence <slug>` | the evidence document below, or `{ format, version, file, bytes }` when it is larger than one CLI response (the whole document is in that file, never trimmed) |
| `measure <slug> <A> <B>`, `gate <slug> <ref>`, `results <slug> r<N>` | `{ run }`, below |
| `results <slug>` | `{ runs }`, newest first |
| `report <slug>` | `{ markdown }` |

New in 1.0: `evidence`, `measure`, `gate` and `results`. `measure` and `gate` options: `--detach` (return at once), `--timeout` (how long to wait, default 25 minutes; the run continues after it), and for `measure`, `--pairs N` (noisy oracles) and `--host H`. `harvest --publish`, `--restart`, `--one-per-promotion` and `--no-measure-standalone` were removed in 1.0 (`--publish` fails with code `removed` and a hint).

A run (`{ run }`, and each of `{ runs }`):

```jsonc
{
  "id", "seq": 3,                        // shown as r3
  "kind": "measure|gate",
  "refA", "refB", "shaA", "shaB",        // as asked, and the commits they resolved to (gate: refB/shaB only)
  "hostId",                              // the bench host it ran on (measure; null until the run starts), or the edit host (gate)
  "pairs",                               // --pairs, or null for the study's n_max
  "state": "queued|running|done|failed|cancelled",
  "progress", "error", "actor",          // actor: the caller's thread id, or "human"
  "benchSeconds", "requestedAt", "startedAt", "finishedAt",
  "line",                                // one line: what was asked and what came out (text, not stable)
  "result"                               // MeasureResult or GateResult, once done (below)
}
```

### The evidence JSON

`bb study evidence <slug> --json` is the record an agent reads to turn a study into PRs. Its `format` is `bb-autoresearch/evidence` and its `version` is `1`. Within 1.x its fields follow the `--json` rule above: kept, never renamed, only added to; a field that changes meaning or goes away bumps `version`. Units and the sign convention (better is positive, in the metric's own terms) don't change. Holdout data never appears (only `study.holdout` and a candidate's `holdout: "pass"|"fail"|null`). `--samples` adds each candidate's raw samples; `--candidates 3,7` limits the candidates.

```jsonc
{
  "format": "bb-autoresearch/evidence",
  "version": 1,
  "generatedAt": "2026-…Z",
  "study": {
    "slug", "state", "objective", "repoPath", "baseBranch",
    "metric": { "name", "unit", "direction": "lower|higher" },
    "noise": "deterministic|noisy|expensive",
    "guardrails": [{ "name", "direction", "maxRegression", "maxTotalRegression" }],
    "scope": { "editable": [], "protected": [] },
    "gates": ["…"],
    "protocol": { "nMin", "nMax", "minEffect", "confidence" },
    "holdout": false,
    "remoteBench": [{ "provider", "hosts", "cores", "memoryGb", "machine" }],  // machine: the options passed to create, or null
    "specVersion": 2
  },
  "git": {
    "base": "<sha>", "best": "<sha>",
    "bestBranch": "studies/<slug>/best",
    "candidateRefs": "refs/studies/<slug>/c/<n>",
    "segmentRefs": "refs/studies/<slug>/segment/<k>",
    "frozen": { "harvest": 1, "state": "frozen", "ref": "refs/studies/<slug>/harvest/h1", "base", "best", "at" } // or null
  },
  // first-parent commits base..best, oldest first; title/body are the commit's (1.0: the worker's), trailers removed
  "promotions": [{ "sha", "n": 1, "title", "body", "paths": [] }],
  "promotionsError": null,           // git log failure, if any
  // noiseFloor/threshold: the noisiest measuring host's (each host's own are in benchHosts)
  "segments": [{ "k", "baseline", "oracleHash", "specVersion", "noiseFloor", "threshold", "evalSeconds", "startedAt", "auto" }],
  // each host's own win threshold (never below min_effect); excluded: why a host much noisier than its peers measures nothing until the next calibration (or null)
  // remote machines also have remote: { provider, cores, machine (the options it was created with, or null), reported (benchProvider.info's answer) }
  "benchHosts": [{ "id", "name", "mode": "shared|clone|remote", "active", "noiseFloor", "threshold", "sideRuns", "excluded", "remote" }],
  "candidates": [{
    "n", "ref", "sha", "parentSha", "preparedSha", "againstSha", "promotedSha",
    "idea": { "id", "title", "theme" },          // or null
    "commit": { "title", "body", "fromWorker": true },
    "summary",
    "stats": { "files", "linesAdded", "linesDeleted", "paths": [] },
    "stage", "verdict", "reasons": [],
    "effect", "ciLo", "ciHi",                    // primary metric vs what it was measured against, better is positive
    "pairs", "threshold", "stop", "confirmSkipped",
    "metrics": { "best": {}, "candidate": {} },  // medians per side
    "guardrails": { "<name>": { "regression", "lo", "hi", "state": "ok|inconclusive|broken|missing|null", "text" } },
    "holdout": "pass|fail|null",
    "benchHost", "benchSeconds", "gateSeconds", "rebases",
    "findings": [3],                             // finding ids about this candidate
    "submittedAt", "decidedAt",
    "samples": [{ "run": "measure|confirm", "pair", "side": "best|candidate", "metrics": {}, "host" }]  // with --samples only
  }],
  "findings": [{ "id", "candidate", "idea", "outcome", "learned", "revisitIf", "evidence", "at" }],
  "ideas": [{ "id", "title", "theme", "status", "source" }],
  "harvests": [{ "seq", "state", "base", "best", "startedAt", "finishedAt", "legacy" }],
  "runs": [{ "id": "r1", "kind": "measure|gate", "a": { "ref", "sha" }, "b": { "ref", "sha" }, "state", "error", "result", "requestedBy", "requestedAt", "finishedAt" }],
  "budget": { "candidates", "maxCandidates", "benchSeconds", "maxBenchHours" }
}
```


A run's `result` is `MeasureResult` (`kind: "measure"`, `a`, `b`, `host`,
`noise`, `n`, `effect`, `ciLo`, `ciHi`, `threshold`, `classification`,
`reasons`, `guardrails` per name `{ regression, lo, hi, n, state, text }`,
`metrics` `{ a, b }`, `diag` `{ a, b }`, `samples` `[{ pair, side: "a"|"b", metrics }]`,
`seconds`, `text`) or `GateResult` (`kind: "gate"`, `ref`, `sha`, `host`, `ok`,
`commands` `[{ command, ok, exitCode, flaky, seconds, tail }]`, `benchLock`,
`seconds`, `text`). `bb study measure|gate|results <id> --json` print
`{ run }` with the same `result`.

Effects are relative: `effect` is B against A (a candidate against the best it was measured on), positive when B is better in the metric's direction, with `ciLo`/`ciHi` its confidence interval; a guardrail's `regression` is positive when B is worse. `threshold` is the win threshold of the bench host that measured it.

### Your data

Database migrations are append-only: upgrading within 1.x keeps every study, candidate, sample and event. Candidate refs (`refs/studies/<slug>/c/<n>`), segment refs, frozen harvest refs (`refs/studies/<slug>/harvest/h<N>`), the `studies/<slug>/best` branch and the `Autoresearch-Study` / `Autoresearch-Candidate` commit trailers keep their names. Downgrading is not supported.

## Not covered

- The study page, the Live view and every other UI surface.
- The plugin's `bb.rpc` methods (they serve its own page) and its host contract (between its own server and host bundle, always the same version).
- Agent tools (`study_*`) and the bundled skills: they ship together and change together.
- Event kinds and payloads in the audit log, except as they appear in the evidence JSON.
- Statistical defaults that are not part of the oracle hash, scheduling (worker counts, dispatch order), notices and their wording.
- Bench provider plugins themselves, including the example provider in `examples/`.

## Versioning

bb-autoresearch follows [semantic versioning](https://semver.org/) from 1.0.0:

- **Major** (2.0): anything above that breaks: a spec key removed or changed in meaning, a `--json` field removed or renamed, bench provider contract v1 dropped.
- **Minor** (1.x): new features, new optional spec keys, new commands and `--json` fields, a new bench provider contract version next to v1.
- **Patch** (1.x.y): fixes that keep everything above.

Something to be removed in the next major is deprecated first, for at least one minor release: spec validation warns about the key, and the command or field says what replaces it. Releases before 1.0 (v0.1.0 to v0.3.1) made none of these promises; their changes are in the [release notes](release-notes.md).

The plugin declares the BB and plugin SDK versions it needs in `package.json` (`engines`). Raising the minimum BB version is a minor release, and the release notes say so.
