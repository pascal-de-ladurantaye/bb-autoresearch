# Stability

What bb-autoresearch 1.0 keeps stable, for the people and tools that build on it: specs you write, bench provider plugins, scripts that call `bb study … --json`, and agents that read a study's evidence. Everything not listed here can change in any release.

## What 1.0 commits to

### Spec TOML

Every key the 1.0 spec schema accepts ([`src/spec.ts`](../src/spec.ts); the README and [guide](guide.md) describe them) keeps its name, type and meaning in every 1.x release:

- A spec that 1.0 accepts is accepted by every 1.x release, and judged the same way.
- Its **oracle hash** stays the same, so an upgrade never forces a recalibration or a new segment by itself. Defaults of keys that are part of the oracle hash don't change within 1.x; a new hashed key is left out of the hash when it is unset, as `remote_bench` was in v0.3.0.
- New keys may be added, always optional, with defaults that keep 1.0 behavior. The schema is strict (an unknown key is an error), so a spec that uses a newer key needs that newer release.

### Bench provider contract v1

The eleven `benchProvider.*` methods, their input and output schemas, the error codes and the rules in [bench-providers.md](bench-providers.md) ([`src/bench-provider/contract.ts`](../src/bench-provider/contract.ts)) are frozen as `contractVersion: 1`:

- Every 1.x release talks to a provider that implements v1.
- The schemas are strict on both sides, so v1 never gains a field, a method or an error code. Any change is a new contract version, and 1.x keeps accepting v1 providers alongside it.
- What bb-autoresearch does with a provider (which labels it sets, when it creates, lists and destroys machines, the layout it uses under the remote home) is behavior, not contract: a provider must not depend on it beyond what bench-providers.md says.

### CLI commands and `--json`

The `bb study` commands and flags of 1.0 (the README's CLI table) keep working in 1.x, and each command's `--json` document keeps its fields:

- A field keeps its name, type and meaning. New fields may appear anywhere, so a consumer must ignore fields it doesn't know.
- Errors keep their shape (a message, a `code`, and a `hint` with the next command).
- The human-readable text output is not stable: parse `--json`, not the text.

### The evidence JSON

`bb study evidence <slug> --json` is the record an agent reads to turn a study into PRs: candidates (refs, commit messages, diff stats), verdicts, samples, guardrails, findings, segments, best and base. Within 1.x its fields follow the `--json` rule above: kept, never renamed, only added to. Units and the sign convention (better is positive, in the metric's own terms) don't change.

### Your data

Database migrations are append-only: upgrading within 1.x keeps every study, candidate, sample and event. Candidate refs (`refs/studies/<slug>/c/<n>`), segment refs and the `studies/<slug>/best` branch keep their names. Downgrading is not supported.

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
