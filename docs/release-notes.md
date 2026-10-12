# Release notes

How each version was built: what it added, the decisions taken on the way, every place it differs from the [design](design.md), the live checks, and the known issues. Newest first. The user guide is [guide.md](guide.md); what 1.0 keeps stable is [stability.md](stability.md).

| Version | What it added |
|---|---|
| [1.0](#10-unreleased) | Unreleased. Remote machines survive a plugin reload; unused seeds and base bundles are deleted; CI on every pull request; these docs split into design, guide and release notes. |
| [v0.3.1](#v031-large-uploads-in-parts) | Large uploads to remote machines travel in 32 MiB parts (BB's 75-second RPC limit). |
| [v0.3.0](#v030-remote-bench-hosts) | Remote bench hosts lent by bench provider plugins: short-lived machines that can't be BB machines, driven by the server over a small RPC contract, each calibrated on arrival and rotated before its lifetime ends. |
| [v0.2.4](#v024) | Fixes from a 5.6-hour blind study on a large repository: bench time spent on candidates that could no longer win, on clear losses and on confirming big wins; drift pauses that were really shorter runs; measurements and promotions after a drift pause; harvest stacks whose layers didn't apply. And the UI issues found while capturing the store screenshots. |
| [v0.2.3](#v023) | UI fixes found while capturing the marketplace screenshots; the strategist is told where best's code is; archiving no longer spawns replacement workers. |
| [v0.2.2](#v022-single-machine-mode) | Single-machine mode (gates take turns with measurements on a machine that is both edit and bench host, and an optional quiet bench), and commits as the repository's own git identity. |
| [v0.2.1](#v021-fixes) | Wording and link fixes: the noise sentence per noise class, guardrail losses that say why, single-run wording for deterministic measurements, the status line's bench counts, a state-aware Overview, worker lanes linked to their candidates. |
| [v0.2.0](#v020-live-view-part-2) | The read-only Live view (a Live tab and a panel beside the study thread) with live CI bands and replay, in two parts. |
| [v0.1.0](#v010-guardrails-and-pre-release-fixes) | The first release: milestones M0 to M3, the human interface pass, and the guardrail and pre-release fixes. |

## 1.0 (unreleased)

<!-- The measurement and agent-harvest notes of 1.0 (docs/notes/v1-*.md) are folded in here when the release is assembled. -->

### Remote machines across a plugin reload

- **Why.** Unloading destroyed every remote machine, so a plugin update in the middle of a study (or of a harvest measuring on remote machines) cost one join and one calibration per slot, and cancelled whatever the machines were measuring for good.
- **Unload keeps calibrated machines.** Their `remote_hosts` rows stay `ready` (nothing new is persisted: the rows already hold the provider id, home, seed, expiry and calibration, and the bench host row its noise floor and threshold). The old instance stops using them at once: its runners are marked lost, so a command in flight is cancelled on the machine before the next instance measures there. Machines that were creating, joining, calibrating or retiring are still destroyed (best effort, bounded), since they hold no calibration worth keeping.
- **Load re-adopts them (decision: verify before use).** Each kept machine starts inactive with the phase "re-adopting after a plugin reload". It is re-adopted when its provider's `status` says `ready` and a probe on the machine finds the bench repository and the seed the row recorded; its bench host row is then active again (`remote.readopted`). A machine the provider no longer knows, one that isn't ready, or one whose repository or seed is gone leaves and is destroyed; its slot fills as usual. Rows in any other state end ("plugin restarted"), and the orphan sweep destroys every listed machine no live row uses.
- **A provider that isn't loaded yet.** On a BB restart the provider plugin may load after this one. A call that never reached a provider (`ProviderMissingError` in the client, still code `not_found` for everything else) doesn't count as a lost machine during adoption: the machine waits, is asked again every 15 s, and leaves after 10 minutes. Status polls skip machines that are still being adopted. A study's restarted calibration waits for them too.
- **What still destroys machines.** Pause (once idle), archive, a lifetime that ends, a provider that reports the machine gone. A disabled plugin's machines are not destroyed: the provider ends them with their lifetime, or the next load re-adopts or destroys them.
- **Measurements in flight** at unload restart from scratch, as before (the pipeline's reconcile); best is built again on each machine (in-memory build caches don't survive a reload).

### Seeds and base bundles

- **Garbage collection.** A new host op, `artifacts`, lists the packed seeds (`<dataDir>/seeds`) and shallow base bundles (`<dataDir>/bundles`) on the edit host and, with `gc`, deletes the ones the server didn't ask to keep. The server keeps, for every non-archived study on that host, the seed of each spec entry for its current baseline and inputs (and the newest one built), and the base bundle of its base. It runs at load (in the background) and when a study is archived, and records `remote.artifacts_deleted`. Files younger than 10 minutes are kept (a seed being packed has no row yet); leftover temporary files older than a day are removed. Deleting a file that was still wanted costs a rebuild, not a wrong result: a seed is checked on disk before reuse, and a missing base bundle is built again.
- **Size report.** `bb study bench` (and its `--json`, as `artifacts`) reports the seeds and base bundles on the edit host, what this study uses, and what the last cleanup deleted.
- **No rebuild for an unchanged seed.** A seed was keyed by its baseline and the spec version, so any approved spec change (a budget, say) built and uploaded it again for the next machine. It is now keyed by its baseline and its inputs: the seed command, `seed_allow` and the cores it is told about. A refused seed stays blocked until one of those (or the baseline) changes.

### CI

`.github/workflows/ci.yml` runs on pull requests and on `main`: `pnpm install --frozen-lockfile`, `tsc --noEmit`, the test suite, and `bb plugin build` with the bb CLI from npm (`bb-app`, pinned to 0.45.0, the oldest BB the plugin supports; the build needs no running BB server).

### Docs

`docs/design.md` is the design alone. The implementation notes of every version moved here, newest first (the v0.3.1 notes had landed after "Credits"). `docs/guide.md` is a short user guide, the README points at the three, and `docs/stability.md` says what 1.0 keeps stable and how versions change.

### Live check (BB 0.45, one MacBook, a second BB instance with its own data dir, the example provider, a toy repo under /tmp)

The installed plugin was left alone: a second BB server and host daemon (`bb-app --data-dir …` on other ports) ran this branch and the example provider. Toy: `src/cost.txt` holds a number, a protected measure prints it, a seed of 2 MB, `setup` runs a tool from it; remote only, 2 machines, noisy, `n_min` 3.

- **Calibration and a first run.** Both machines joined and calibrated in seconds; two candidates (one win, one loss) used the budget, and the pause destroyed both machines.
- **Seed reuse.** Spec v2 raised the budget only (approved without recalibration). On resume, two new machines joined with the seed built for v1: no `remote.seed_building` event.
- **Reload.** `bb plugin reload bb-autoresearch` with both machines ready: one second later both were `remote.readopted` with the same provider ids, no machine was created or destroyed, and nine seconds later the next candidate was measured on one of them. A second reload re-adopted them again.
- **Cleanup.** A stale 3 MB seed file aged past the grace period was deleted at that reload (`remote.artifacts_deleted`, `bb study bench` showed "last cleanup (plugin loaded) deleted 1 file(s), 2.9 MiB"). Archiving destroyed both machines and, with the study's own seed and base bundle aged past the grace period, deleted them too: nothing was left under the data dir's `seeds/` and `bundles/`.
- **Found.** The example provider keeps its registry at one default root under the OS temp dir, shared by every BB instance on the machine; two instances smoke-testing at once overwrite each other's `state.json` (each keeps its own machines in memory, so nothing was destroyed). Start a second instance with its own `TMPDIR` to keep them apart.

### Known issues

- A kept machine that is re-adopted keeps the calibration it had; it is not recalibrated after the reload (the code and the machine are the same, and drift checks continue).
- Status polls of a machine whose provider plugin is missing during the run (not at load) still treat it as gone, as before.

## v0.3.1: large uploads in parts

- **Large uploads travel in parts.** BB gives a plugin RPC 75 seconds, and a provider's `putFile` is one RPC: a 551 MB seed on a 7 MB/s link timed out on the first real study, so calibration failed on every remote machine. Files above `PUT_CHUNK_BYTES` (32 MiB; `RemoteRunnerOptions.chunkBytes` in tests) are copied part by part to the staging directory, each part is uploaded and its sha256 checked, then the parts are joined on the machine and the whole file's sha256 is compared with the local one. Smaller files still go in one call. The contract is unchanged.

## v0.3.0: remote bench hosts

Remote bench hosts through provider plugins. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Why

Studies are bench-bound on one laptop: one machine measures one candidate at a time, and it is also where the agents and gates run. Cloud machines can run a real benchmark unchanged, and as quietly as a laptop or more, but the ones that are cheap to lend often can't be BB machines: they only allow outbound connections, so the laptop has to drive them. A **bench provider** is a separate BB plugin that lends such machines through a small RPC contract. This release is the generic side: any provider, nothing specific to one in this repository.

### The contract

- **Shape.** `src/bench-provider/contract.ts` (zod) and [bench-providers.md](bench-providers.md): eleven `benchProvider.*` methods (describe, create, status, list, destroy, info, putFile, getFile, execStart, execPoll, execCancel), called with `bb.sdk.plugins.callRpc`. The provider is a thin transport; git, seeding, calibration and scheduling stay here and run as ordinary shell commands on the machine.
- **Errors.** A bracketed code in the message (`[not_found]`, `[capacity]`, `[auth]`, `[invalid]`, `[transient]`, `[internal]`). BB prefixes what a provider throws (`HTTP 500: [invalid] …`), so the client reads the first known code anywhere in the message; none is `[internal]`; a provider plugin that isn't installed is `[not_found]`. `[capacity]` and `[transient]` are retried a few times with backoff (`BenchProviderClient`), and a transient `execPoll` failure is retried while the process keeps running.
- **Lost processes.** `execPoll` may end a process with `signal: "LOST"` (it died without an exit record, after a suspend say): the runner treats it like a lost machine.
- **The example.** `examples/bench-provider-local/` implements the contract against local temp directories and child processes (detached, output in files, a registry that survives a reload). A BB plugin can't import outside its directory, so it carries a copy of the schemas; a test keeps the copy identical.

### Spec

`[[oracle.remote_bench]]` (at most 4 entries): `provider`, `hosts` (1-16), `cores`, `memory_gb`, `lifetime_minutes` (default 120, capped by `describe`), `rotate_before_minutes`, `seed`, `seed_allow`, `setup`, `env`, `gates`. With remote entries and an empty `bench_hosts`, no local host measures (`resolveBenchHosts(…, { remote: true })`, and a spec version's stored `[]` is now read as deliberate); `bench_hosts = ["local"]` adds the edit machine.

- **Oracle hash (decision).** What the machine is and how it is prepared judges a commit: provider, cores, memory, seed and setup commands, env. How many, how long they live, when they rotate, the seed allowlist and where gates run are operations. The key is left out of the hash when empty, so a spec without it (or stored before it existed) keeps its hash (tested against the hash v0.2.4 computed). The seed's *content* is not hashed: it is rebuilt per segment from a command in the hash.
- **Validation** runs against `describe` when the human approves the spec (calibration): available, contract version, `hosts` within `maxHosts` (a warning when `2 × hosts` exceeds it: a replacement may wait for capacity), cores within range, the lifetime capped (a warning). A provider that doesn't answer is a calibration problem naming the plugin.

### The runner

`RemoteBenchRunner` (`src/bench-provider/runner.ts`) implements what measurement needs from `HostRunner`; edit-host operations throw. Layout on the machine: `~/bb-autoresearch/repo.git` (bare, shallow), `checkouts/<key>` (worktrees, reused: `checkout --detach --force` then `clean -fdq`, so ignored build outputs survive like on BB hosts), `seed/<sha256>`, `incoming/`.

- **Processes.** `exec` and `run` are one `execStart` with `bash -lc`, then `execPoll` from 50 ms up to `execPollMs` (1 s), keeping output tails like a host job; progress is the last complete line; an abort is `execCancel`. Every command gets the entry's `env` plus `AUTORESEARCH_REMOTE`, `AUTORESEARCH_CORES` and `AUTORESEARCH_SEED`.
- **Repository (decision).** A shallow bundle of the **study base** alone (`host/base.ts`: a depth-1 fetch into a scratch repository, then `git bundle create`), built once on the edit host and cached by commit, is `putFile`d and fetched after writing the base into `shallow`. Best and every candidate then reach the machine through the existing `ensureCommit` relay as delta bundles whose prerequisite is the base (the runner stages the chunks in a local file and uploads it with `putFile`). The study base, not the segment baseline, is the shallow root: harvest measures the study base itself, which a later segment's shallow clone wouldn't have. Rejected: a full-history bootstrap (gigabytes for a large repository, sent again for every replacement).
- **Files.** `putFile` paths are on the BB server's machine. The edit host is always the server's own machine, so the host bundle's files (bundles, seeds) are passed to the provider by path.
- **Health** is a portable shell probe (procfs or sysctl, `ps`, cgroup `cpu.max`). Inside a container the load average and the visible CPU count usually describe the whole physical host; `[oracle.health]` applies as written, so a shared host may need looser limits.

### Lifecycle (`src/remote/fleet.ts`)

One row per machine in `remote_hosts`: `creating → joining → calibrating → ready → retiring → gone`, and a bench host row (`mode = "remote"`, `host_id = remote-<n>`) that holds its calibration and is active only while it is ready. The fleet ticks with the engine and never waits on the provider: joins, status polls and destroys are background jobs.

- **Join.** The seed and the base bundle first (on the edit host; a refused seed costs no machine), then `create` (idempotency key per row, labels `owner`, `study`, `slot`), `status` until ready, `info`, the seed, the repository, best, `setup` in a checkout of best. Typical join on the example provider: 1.2-1.9 s.
- **Calibration on arrival (decision).** During the study's calibration, it waits for every slot to join and calibrates the machines with every other bench host (the segment takes the worst, as before). A machine that joins later runs `calibrateHost` (A/A on best) alone under its own lock; it then measures with `max(segment MDE, its own)`: its own noise floor, drift checks and win threshold, never a lower threshold than the segment's, so a win means the same everywhere. A machine whose own MDE exceeds `max_mde` leaves and is replaced. Calibrated machines wait up to 30 minutes for the human to approve a finished calibration, then go.
- **Rotation.** A replacement starts `rotate_before_minutes` before a machine's end (default `max(lifetime / 5, 1.5 × (last join + one evaluation))`, at most half the lifetime). Once it has calibrated, the old machine becomes `retiring` (its bench row inactive: no new measurement, gate or drift check) and is destroyed when nothing runs or waits on its bench lock. Cost guard: one machine per slot, plus one replacement.
- **Leaving.** Lifetime over, a provider status of `suspended`, `gone` or `failed` (polled every 15 s), `[not_found]` or `LOST` from an exec, or a failed join. The machine is never reused (a suspended one may come back on other hardware), its bench row goes inactive, and in-flight measurements on it are cancelled with a reason, so they restart from scratch on another host (the pipeline's existing restart path, plus `RemoteHostLostError`). A gate on it is retried elsewhere without counting as a failure. Joins that keep failing back off (30 s × failures, then 10 minutes after 3) with one notice per streak.
- **Paused, archived, unloaded.** Pausing retires the machines (measurements in flight finish; queued candidates wait for resume, unless a local host takes them). Archiving destroys them. Unload (reload, disable, shutdown) destroys every machine (decision: BB doesn't say whether an unload is a reload, and after it nothing uses them; a reload then pays one join per slot). On load, live rows of the previous instance are ended, and each provider is asked to `list` this plugin's machines: anything no live row uses is destroyed. The same sweep runs every 10 minutes (a provider that wasn't loaded yet at startup), on pause and on archive; it spares a create still in flight and doesn't count machines of rows that already left as orphans.
- **Gates on remote hosts (`gates = true`).** Gating candidates join the bench queue and take a ready machine of such an entry under its bench lock: prepare on the edit host, the prepared commit as a delta bundle into the machine's `gate` checkout, the gates there. Single-machine mode is then off under `auto` (no gates on the edit machine), and T_eval counts gate plus measurement time. Calibration runs the baseline gates on a joined machine. Harvest gates stay on the edit host.

### Seeds

- **Build.** Once per segment baseline and spec version, on the edit host, in a checkout of the baseline: the command's last line is the path. Replacements reuse it.
- **Scan** (`host/seed.ts`): file names (`.netrc`, `.git-credentials`, gem credentials, `.pypirc`, SSH keys and `.ssh/`, AWS, gcloud, Azure, kube and docker configs, `.env*` except templates, keystores), config files by content (npm and yarn auth tokens, host-keyed bundler credentials, AWS secret keys), content patterns (PEM private keys, AWS key ids, GitHub, GitLab, Slack, npm, Google, Stripe, `sk-` API keys, JWTs) in the first 8 MiB of each file, one level inside `.gem` and tarballs, never through symlinks. Findings carry path, rule and line, never the text. `seed_allow` globs move findings aside.
- **Refused.** No machine is created, a notice lists what matched, a needs-you item points to the Bench tab, and the entry waits for a spec change.
- **Pack.** A clean directory is packed as a tarball named by a content hash (sorted paths, modes and file hashes: macOS tar can't make byte-identical archives); a tarball is copied as is. The upload is checked against the archive's own sha256.

### Surfaces

The Bench tab's *Remote bench hosts* section (each entry with its shape, lifetime and rotation lead, the seed's state or what refused it, the repository bundle; each machine with its state in words, expiry, rotation, its own calibration, what it measures, how many it measured, and a warning when the visible CPU count differs from the cores asked for; recently gone machines and why), the bench host lists, the Live bench strip (joining and retiring machines included; "testing (gates on this machine)") and its feed (`remote.requested`, `remote.ready`, `remote.retiring`, `remote.left`), notices (`remote.failed`, `remote.seed_refused`; `remote.lost` informational), and `bb study bench` / `bb study show`.

### Data model

Append-only migrations: new tables `remote_hosts` and `remote_artifacts` (base bundles and seeds: path, sha256, size, state, detail). `bench_hosts.mode` gains `remote`; `syncBenchHosts` leaves remote rows alone. New events: `remote.requested`, `.created`, `.joined`, `.ready`, `.retiring`, `.left`, `.failed`, `.shape`, `.seed_building`, `.seed_built`, `.seed_refused`, `.orphan_destroyed`, `gate.restarted`. New host ops: `baseBundle`, `seedPack`. New port method: `callPlugin`.

### Live check (BB 0.45, one MacBook, the example provider, a toy repo under /tmp, a temporary project)

- **Toy.** `src/cost.txt` holds a number; the protected measure prints it after sleeping (1 s, or 3 s on the remote machines through `env`); a gate checks it is a positive integer; the seed is a directory with a stand-in tool; `setup` runs that tool on the machine. Noisy, `n_min` 3, `n_max` 5, 4 calibration pairs, health checks off, two workers on the default provider.
- **Study 1: local plus 2 remote machines, 5-minute lifetime.** Calibration took 16 s: both machines joined, and the report covered 3 bench hosts, each with its own noise floor and MDE. All six candidates went to the local host (first free in spec order, one candidate at a time), the budget ran out after 3 minutes, and the pause retired both machines and ended their replacements, which were joining: every machine was destroyed. Seen and fixed: the replacement rebuilt the seed (it was keyed by best, not the segment baseline), and the sweep counted machines whose destroy was in flight as orphans.
- **Study 2: remote only, gates on remote, 4-minute lifetime, rotation 2 minutes before the end.** Calibration took 32 s, with the baseline gates run on a machine. Ten candidates in 6.7 minutes of Running, all gated and measured on remote machines; eight machines (each slot rotated three times), never more than two per slot; the seed built once. Each replacement joined in 1.2-1.9 s and calibrated on the best of its time before the old machine retired. In the last rotation both old machines were measuring (c/9 and c/10) when their replacements became ready: they retired, finished those measurements on the old machines 4 and 15 s later, and only then left; no measurement restarted in the study. Delta bundles: 0.6-2.2 KB per candidate, best 1.2-4.3 KB, the shallow base 1.4 KB.
- **Cleanup.** Both studies archived with their threads; the provider's registry listed 12 machines, all gone, and no machine directory remained. The temporary project, `/tmp` files and the example provider were removed, and the released plugin reinstalled from GitHub; every other study's rows and event counts matched the backup taken first.

### Live check with a cloud sandbox provider (BB 0.45, one MacBook, a provider plugin kept outside this repository)

The same textkit-style toy as earlier releases (a Python pipeline, `METRIC wall_ms`, a peak-memory guardrail, unit tests as the gate), with a seed command that packs a 6 MB tarball and a `setup` that unpacks a toolchain from it and runs it. The provider lends 4-core sandboxes that only allow outbound calls; their CPU is a weighted share of a 32-CPU host, so every machine showed the "32 CPUs visible for 4 cores" note.

- **Joining.** Request to joined: 6.6-10.9 s over 13 machines (the provider answers `create` with a ready machine in about 1-2 s; the seed uploads at 6.9-7.9 MB/s, 0.8-0.9 s; the shallow base bundle is 9 KB, best 1-8 KB, each candidate 0.7-1.6 KB).
- **Calibration per host.** The remote machines calibrated at MDE 1.0-1.9% (noise floor 0.4-3.1% per pair; sandboxes on the same kind of host differed by 3×); the laptop, busy with other work, at 2.2%, and the segment took it. An arrival calibration (A/A on best on a machine alone) took 1.8-2.1 minutes.
- **Study 1: local plus 1 remote machine, 20-minute lifetime.** 12 candidates, measured on both (the laptop took most: it comes first in spec order). Rotation: the replacement joined in 11 s and calibrated in 2 minutes, then the old machine retired and was destroyed at once; never more than 2 machines per slot. With `rotate_before_minutes = 17` the next rotation was due a minute after each replacement became ready (now a spec warning).
- **Study 2: remote only, 2 machines, `gates = true`, 15-minute lifetime.** Every gate and measurement ran on the machines, an automatic recalibration ran on both, and one slot rotated while the provider was at its 3-machine cap. A machine destroyed through the provider's API mid-measurement (a host drain, as far as bb-autoresearch can tell) restarted its measurement on the other machine and its slot refilled at once; but until the next status poll (15 s) the scheduler kept sending the dead machine a gate (about 70 attempts in 12 s) and counted a pipeline error on the requeued candidate. Fixed: a `[not_found]` or `LOST` from any call ends the machine immediately. Rerun: it left within a second, the measurement restarted once elsewhere, no error was counted, and the replacement joined in 6.6 s.
- **Cleanup.** Pause, budget end and archive retired and destroyed every machine; the provider's records were empty afterwards and a direct status query showed each of the 13 sandboxes destroyed.
- **Also fixed.** With several bench hosts the calibration report quoted the first host's threshold, not the segment's (the worst host's); `remote.joined` reported 0 s.

### Not done, and known issues

- **Seeds are rebuilt per spec version.** Any approved spec change (a budget, say) builds and uploads the seed again for new machines, even when the seed command didn't change.
- **Seeds and base bundles stay on disk.** Packed seeds and shallow base bundles (content-addressed, possibly shared between studies) stay in the plugin's data directory after the study is archived; a seed command whose output isn't byte-identical (macOS tar) leaves one tarball per build.
- **Dispatch order.** A candidate goes to the first free bench host in spec order (local before remote), so with one candidate at a time a local host takes everything; there is no preference for the quieter machine.
- **One threshold for all hosts.** A quiet remote machine measures with the segment's threshold when that is larger than its own (decision above), so it doesn't detect smaller wins than the noisiest host.
- **Unload destroys machines** even on a reload; a reload costs one join and one calibration per slot.
- **Health in containers** sees the physical host's load average and CPU count; there is no per-cgroup pressure check.
- **Nested archives** are scanned one level deep; zip files and compressed files other than tarballs and gems are not looked into.
- **Harvest gates** stay on the edit host even with `gates = true`.

## v0.2.4

Fixes from a real study and from capturing the store screenshots. Same platform pins (BB 0.45.x, SDK 0.6.14).

The study: 5.6 hours, blind, on a large repository, bench-bound (35 candidates, a median of 426 s of bench per candidate). A median candidate used 7 pairs; 15 of 35 stopped at `n_min` = 6 and 9 ran the full 20 pairs, mostly to an inconclusive. Every win also ran a confirmation (183 pairs over 23 candidates) and a 3-run holdout, and gates took 30 s under the bench lock. Two drift pauses came from the code getting about 5× faster: with single runs, per-pair relative noise rose from 2.0% to 8.8% on the same quiet machine, and a human switched the oracle to 3 rounds per side (noise 0.49%).

### Sequential test: futility and early losses

- **Futility (`[oracle.protocol] futility = true`).** After `n_min`, a measurement whose CI upper bound is below the win threshold stops as `inconclusive`: more pairs could narrow the CI but not move it above the threshold with any confidence. It is checked after the lose rule (a CI entirely below 0 is still a `lose`) and before the cap. The verdict says "effect +0.4% (CI −1.0% to +1.5%, 8 pairs) can no longer clear the 2.0% win threshold: stopped early (futility: the CI's high end is below it)". The confirmation run uses the same rule.
- **Early losses (`early_lose_from = 3`, `early_lose_confidence = 0.99`).** From 3 pairs until `n_min`, a candidate whose 99% interval is entirely below 0 is a `lose` ("… stopped early, the whole CI is below 0 before pair 6"). Before `n_min` nothing else can stop it (no early win: false wins compound). `0` turns it off.
- **Which interval (decision).** The early check uses a Student-t interval of the mean of the per-pair improvements, with an exact t quantile (`tQuantileExact`, the finite series of the t CDF for integer degrees of freedom, inverted by bisection; the Cornish-Fisher `tQuantile` is 12% low at 2 degrees of freedom). The bootstrap percentile CI of the median the test uses after `n_min` is badly miscalibrated at 3-5 pairs: a "99%" bootstrap CI of 3 pairs is [min, max], which covers the true median only 75% of the time, so "all three pairs worse" would have been an early loss. The first version did exactly that and called 5.0% of true +MDE effects a loss in simulation (v0.2.3: 1.3%). The t interval is deterministic (no resampling), valid at small n for roughly normal pair noise, and conservative with outliers, which inflate the SD. It catches large regressions only: with 2.8% per-pair noise, 98% of −8×MDE candidates stop at 3-4 pairs, 13% of −2×MDE ones.
- **The band follows (`band.ts`).** Points from `early_lose_from` to `n_min` carry the early interval (`early`), computed exactly as the decision does; `pointStop` returns why a point stops the test (`win`, `lose`, `early`, `futility`, `cap`) with the same rule as `sequentialDecision`, and `runDecision` carries the reason. The decision marker is tagged ("6 of 20 · can't win", "3 of 20 · early"), an early stop draws the interval it was decided on, and the words say why: "Decided after 6 of 20 pairs: inconclusive. Estimate +0.2%, CI −1.5% to +1.4%: the CI's high end is below the +2.0% threshold, so more pairs can't make it a win (stopped early)." Bands stored before v0.2.4 have no `futility` field and are read with the old rule, as they were decided.

### Confirmation skipped far beyond the threshold

- **The rule (`skip_confirm_factor = 3`, `confirmationSkip` in pipeline.ts).** A noisy win whose CI lower bound is at least 3× the win threshold skips the confirmation; `0` always confirms. The verdict records it ("confirmation skipped: the CI's lower bound +13.6% is 6.8× the 2.0% win threshold (skip_confirm_factor 3)"), as does a `confirm.skipped` event and the `measure.finished` payload (the feed: "c/4 measured: 6 pairs in 2 min (confirmation skipped: far beyond the win threshold)"). Guardrails are then judged on the measurement's pairs alone, and the holdout still runs.
- **Why it's safe.** A false win this far out needs the whole CI to be wrong by several half-widths at once; in simulation no candidate below 2× the threshold skipped, and at 10× the threshold all of them did (half the pairs of v0.2.3).

### Simulation

`test/v024-sim.test.ts` runs both rule sets on the same noise (common random numbers: the same noise stream and pair order per trial, and the pipeline's seeded bootstrap per pair), per-run noise 2% (2.8% per pair), threshold calibrated from 400 A/A pairs (MDE 1.35%), `n_min` 6, `n_max` 20, confirmation on; effects in units of the threshold. 1,000 candidates per cell (`SIM_TRIALS=1000`):

| True effect (×MDE) | Wins v0.2.3 → v0.2.4 | Losses v0.2.3 → v0.2.4 | Pairs per candidate v0.2.3 → v0.2.4 | Futility stops | Early losses | Confirmations skipped |
|---|---|---|---|---|---|---|
| −8 | 0.0% → 0.0% | 100.0% → 100.0% | 6.0 → 3.9 | 0.0% | 97.8% | |
| −4 | 0.0% → 0.0% | 100.0% → 96.1% | 6.1 → 5.1 | 3.9% | 51.4% | |
| −2 | 0.0% → 0.0% | 96.9% → 56.9% | 8.3 → 6.2 | 43.0% | 13.3% | |
| −1 | 0.0% → 0.0% | 63.1% → 22.0% | 13.6 → 8.0 | 74.8% | 4.3% | |
| 0 | 0.0% → 0.0% | 14.4% → 6.8% | 18.4 → 13.4 | 60.6% | 1.1% | |
| +1 | 1.7% → 1.7% | 1.1% → 0.8% | 21.0 → 19.4 | 15.0% | 0.3% | 0.0% |
| +1.5 | 13.3% → 13.4% | 0.2% → 0.4% | 22.3 → 21.7 | 5.0% | 0.2% | 0.1% |
| +2 | 44.4% → 44.5% | 0.0% → 0.1% | 21.8 → 21.6 | 1.4% | 0.1% | 0.3% |
| +4 | 100.0% → 100.0% | 0.0% → 0.0% | 12.8 → 11.5 | 0.0% | 0.0% | 20.2% |
| +10 | 100.0% → 100.0% | 0.0% → 0.0% | 12.0 → 6.0 | 0.0% | 0.0% | 100.0% |

- **False wins** (no true effect): 0.0% under both rules (the confirmation already made them rare; skipping never fires near zero).
- **False losses on true +MDE effects**: 0.8% (v0.2.3: 1.1%). Early losses alone: 0.3%.
- **Missed wins**: none measurable; win rates are the same within a trial or two at every effect (futility stops 1.4% of +2×MDE candidates, which v0.2.3 would mostly not have promoted either).
- **Bench pairs saved**: 18% over these ten cells (142 → 117 pairs per candidate summed); 27% on a null effect, 35-41% on modest regressions, 50% on 10× wins. A bench-bound study whose candidates are mostly no-effect ideas, clear losses and large wins saves more than the average.
- **The price**: a modest regression (−1 to −2× the threshold) more often ends `inconclusive` (futility: its CI still reaches above 0) than `lose`; the worker still gets the estimate and CI, and the reason says it could no longer win. The test asserts these bounds at 150 candidates per cell on every run.

### Side runs and automatic recalibration

- **Side runs (`side_runs = "auto" | N`, `min_side_seconds = 5`).** Noisy oracles only: each side of a pair is N runs of `measure`, combined by `combineRuns` into each metric's best value in its own direction (the minimum for the primary metric and guardrails when lower is better, the maximum when higher is better, the minimum for informational metrics; the usual best-of-N for timings). "auto" times one warm run of each side at calibration, after the warmup, and picks N = ⌈min_side_seconds / run⌉, at most 30 (`AUTO_SIDE_RUNS_MAX`; a faster benchmark should loop itself). The count and one run's median seconds are stored per bench host (`bench_hosts.side_runs`, `run_seconds`), in the calibration report ("Each side of a pair is 5 runs of the measure command (best of 5 per metric; one run takes about 1.0 s, so 5 make a side of at least 5.0 s)"), on the Oracle tab's segments and in `bb study bench`. Measurements, drift checks and harvest measurements use the host's count (`BenchSite.bench`); a segment calibrated before v0.2.4 has none, so it keeps single runs until it recalibrates. Expensive and deterministic oracles always run once.
- **When best's runs get much shorter (`[oracle.drift] recalibrate_below = 0.6`).** Three triggers compare one run's median time with the host's calibration, and schedule an automatic recalibration below 60% (`recalibrationTrigger`): a promotion (the winner's candidate-side runs are the new best's), any measurement (its best side), and a drift check over its limit (its best runs). The drift check's case is the one the study hit: noise up because runs got shorter is recorded as `drift.explained` and recalibrates instead of pausing; noise up at the same run time still pauses. `0` turns it off. It is a bench setting, not part of the oracle hash.
- **The recalibration (`runAutoRecalibration`, calibration.ts).** `studies.recalibrate_due` holds why. While it is due, the study starts no measurement or drift check; once none of its measurements is on the bench (in-flight ones finish), the pipeline's `recal:<study>` job calibrates best on every bench host, each under its own lock (side runs chosen again when "auto"), and opens segment k+1 with the same oracle hash and spec version, `details_json.auto = true`, without gates (best passed them), approval or a state change. An A/A median that excludes zero is a warning here (both checkouts are best), not a failure. If the new win threshold exceeds `max_mde`, the hosts keep their old calibration and the study pauses ("automatic recalibration failed (…): …"; a needs-you item "recalibrating on best's shorter runs failed"). A `segment.recalibrated` notice (informational) gives per host the side runs, one run's time, the noise floor and the win threshold before and after. Replay labels the milestone "Segment 2: recalibrated (same oracle)".
- **Guardrails across automatic segments (decision).** A new segment used to restart the guardrails' total limit at its baseline. An automatic one doesn't change the oracle, so `guardrailChainBase` counts from the first segment of the current run of segments with the same oracle hash; otherwise every recalibration would give the total limit its full room back. An oracle change still resets it.
- **Stale measurements.** A measurement whose candidate reconciliation restarted elsewhere (`measure_restarts` moved on) now stops writing (`StaleMeasurementError`): a test simulating a restart without disposing the old engine showed the old job's futility stop deciding the candidate first.

### Measurements wait while paused for drift

A drift pause left the study `paused`, and the pipeline still measured paused studies' queued candidates, so candidates already in flight were measured on the disturbed host and promoted. Now a host whose `drift_status` is `drift` starts no measurement (of that study's), and an in-flight one on that host is cancelled and restarts from scratch later. Resume clears the host's drift status; a recalibration does too.

### Best vs base across segments

The headline compounds every promotion, whatever its segment, but the raw values shown were the current segment's baseline ("3.619 → 2.039 s" next to "81.8% lower"). With more than one segment the headline now says "81.8% lower time (5.5×) across 3 segments" and the raw values "this segment 3.62 → 2.04 s" ("this segment: 2.04 s, no promotion yet" right after a recalibration): `bestHeadlineText` and `segmentRawText` (present.ts), used by the Overview, the Studies list, `bb study show`, the Live header (which now shows the raw line too) and the report. Replay counts segments from `segment.started` events. The raw values come from `metricSnapshotOf` (new `src/snapshot.ts`, shared by the views and the report).

### Live view and pages

- **Tests waiting for the bench (single-machine mode).** A gating candidate that waits for the bench lock read "tests running · 1:19" on its card while its lane said "waiting for the bench" and the queue "c/2 tests". `gatingText`/`stageText` (live-model.ts) word the Tests stage from the view's `queueTests`: "waiting for the bench to run tests" until its gates hold the bench, then "tests running", on the card, the lane and their accessible names.
- **Up next.** "waits: 1 running on algorithms" counted the idea queued ahead as running. `themeWait` (scheduler.ts) counts what really runs apart from the ideas that go first: "waits: 1 running on algo", "waits: #12 first on algo (1 at a time)", "waits: 1 running and #12 first on algo".
- **Notices "for you".** Four `best.new` notices made "4 notices for you" while nothing needed the human. Strategist digests count only actionable notices (`isActionableNotice`, prompts.ts); informational ones (`best.new`, `budget.threshold`, `stall`, `rate_limit`, `usage.tight`, `harvest.published`, `segment.recalibrated`) are listed apart under "Updates (n, informational)", and controls stay an audit trail.
- **The confirmation's placeholder.** The band's confirmation panel appeared only after its first pair. The confirmation now starts with a `measure.progress` event at 0 pairs (`run: "confirm"`), so the card says "confirmation: first pair of ≤20 running" and the band keeps the confirmation's place with its placeholder; replay sees the same event.
- **"No change".** The Overview's guardrail column said "0.0% better than the segment base" and "worst single promotion 0.0% worse"; both use the Live rows' rule now (`changeWords`: under 0.05% is "no change"), "worst single promotion: no change".
- **Trajectory.** A conflict, a failed gate or a rejection had no mark although the legend lists "○ other verdicts": unmeasured verdicts are ○ marks on the best line at the time, and say "not measured".
- **Verdict reasons.** Reasons read "primary metric improved 17.8% (CI +13.6% to +22.0%, 6 pairs)" (`measuredCiText`: "single run" for deterministic, "4 runs" for expensive, "at 99%" for an early loss) instead of "(CI 13.58%..21.99%, n=6)"; the candidate detail and the CLI rewrite older reasons the same way (`reasonText`).
- **Smaller.** Guardrail sentences under a band wrap instead of being cut ("within the 1…" with two bands side by side); when the "continue" label can't fit (the threshold next to 0), a legend under the band names the regions; the panel header's "no win yet" lines up with the counts under it; the Oracle tab marks automatic segments and shows side runs per host; the status line says when a recalibration is due.

### Harvest

- **Stacks in dependency order (A6).** Stack layers used to follow `k` (earliest commit), so a strategist group {c/3, c/20} came before {c/10} even when c/20 builds on c/10, and its PR didn't apply on its base. Layers are now ordered topologically (`planStacks`) from the detected dependency edges plus commit-level file overlap: X needs Y when a commit of X and an earlier commit of Y (first-parent order on best) touch the same path. Overlap only orders inside a stack; it never makes one. A cycle (commits interleaved on the same files, or dependencies both ways) is one coupled group, folded up front into one PR hosted by its smallest k ("#1 and #4 need each other: their commits interleave on src/c.txt, so neither applies without the other"). Ties go by k.
- **Attribution by commit order.** Reverting S from best can be blocked by any changeset with a commit after one of S's, and a changeset can need any other with a commit before one of its own, whatever their k (`laterDependents`, `earlierDependencies`).
- **Every PR applies (decision).** Each layer is composed onto its PR base (the previous layer's commit; the first layer and independent changesets: the study base) and gated. A layer that conflicts or fails its gates is merged with the next layer(s) in order ("#6 needs src/x.py, which #7 adds or changes, so it doesn't apply on #5 alone"). If no later layer fixes it, it folds into the previous layer and the check resumes there (`fitLayers`). Before any fold the whole stack is squashed onto the base. If even that fails, the stack needs something outside it: the other changesets are probed on the base (with gates for a gate failure), then shrunk newest first to a minimal set that still works, so of two interchangeable helpers the earlier is kept. The edges are added and the stacks recomputed. Each fold removes a layer and each probe merges groups, so this terminates. A branch is drafted only for a layer that applies and passes its gates on a drafted PR base; otherwise it is reported. Compose and gate results are cached per run, so re-checks after a fold cost nothing. Standalone effects are measured once the layers are final.
- **Folds keep the accounting.** A folded changeset keeps its row and its ablation result, and the sum of contributions is unchanged. Its host's PR includes the folded commits in best order, its candidates, rationale and findings, and "Also includes #4 …: why". The Harvest tab, PR body, report (table in PR order, a "Folded" list, stacks as `#3 → #2 (with #5)`), `bb study harvest` and the harvest-ready notice all say which PR ships it and why. The publish plan lists it as "ships inside #1's PR", and it can't be dropped on its own.
- **PR preview (B8).** Long PR bodies start collapsed behind a fade with "Show more" / "Show less" (no inner scroll). "Depends on" is one line per dependency with its own reason ("Depends on #3 Shrink c: reverting #3 from best conflicts in src/c.txt…"), parsed from the stored `depends on #k: …` list; older rows show the whole text on each dependency.
- **Numbers per study (B9).** A study's first harvest showed as "h5" (the global id). Harvests are numbered per study (`h<seq>`) everywhere a person or agent sees them: tab, dialogs, notices, CLI, grouping round, audit texts, PR bodies, commit trailers (`Autoresearch-Changeset: h<seq>/#k`), branches `studies/<slug>/harvest/h<seq>/…`, export directory `<slug>-harvest-h<seq>`. The RPC's `harvestId` and DB keys stay the global id.
- **Data model.**
  - `harvests.seq`: per-study number, backfilled with `ROW_NUMBER()` per `study_id` ordered by id; new rows get max+1 per study.
  - `changesets.folded_into`: id of the changeset whose PR ships it.
  - `changesets.fold_reason`: why, in words.
  - `changesets.layer`: position in its stack's PR order.
  - `StackRecord.layers` (in `stacks_json`): hosts and members bottom first; `members` is now in PR order.
  - New standalone statuses `applied` (applies and passes gates, effect not measured yet) and `folded`.
  - New event `harvest.folded` (harvest, changesets, into, reason); `harvest.started` now carries `seq`.

### Data model

Append-only migrations: `bench_hosts.side_runs`, `bench_hosts.run_seconds`, `studies.recalibrate_due`. New events: `recalibration.due`, `recalibration.started`, `recalibration.failed`, `drift.explained`, `confirm.skipped`; `segment.started` and `calibration.ready` gain `auto`; `measure.finished` gains `stop` and `confirm_skipped`; `measure.progress` is also recorded at 0 pairs when a confirmation starts. A measured candidate's `metrics_json` gains `stop`, `confirmSkipped`, `runSeconds` (median seconds of one run per side) and `sideRuns`; calibration reports and segment details gain `sideRuns` and `runSeconds` per host. New notice kind `segment.recalibrated`. New spec keys: `[oracle.protocol] futility`, `early_lose_from`, `early_lose_confidence`, `skip_confirm_factor`, `side_runs`, `min_side_seconds` (part of the oracle hash, left out of it at their defaults so stored segments keep their hash), `[oracle.drift] recalibrate_below` (not hashed). Stored specs are read with the defaults filled in (`normalizeSpec`).

### Live check (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** `src/toy.py` runs three stages that wait for fixed times (parse 1.2 s, sort 1.0 s, render 0.8 s); the metric is the wall time of one `run()` in ms with 2% synthetic noise (protected `bench/measure.py`), the gate a correctness test. Noisy, `n_min` 4, `n_max` 10, `calibration_pairs` 6, `min_side_seconds` 2.5, local bench (single-machine mode on), health checks off, `max_workers` 1, `max_candidates` 6, the default provider; five pinned ideas: move the stages into a new `src/steps.py` and halve parse, two deliberately tiny changes, and two big cuts.
- **Calibration.** One run takes 3.1 s, so `side_runs = "auto"` kept one run per side ("One run per side (a run takes about 3.1 s, at least the 2.5 s a side needs)"); noise floor 2.23% per pair, win threshold 1.55%.
- **Verdicts.** c/1 (new module, parse halved) won 18.5% after 4 pairs and skipped its confirmation ("the CI's lower bound +17.0% is 11.0× the 1.6% win threshold"). c/2 (render 0.8 → 0.79 s) looked like a win at 4 pairs (CI +1.9% to +5.1%) and failed its confirmation after 7 fresh pairs: a lose. c/3 (sort 1.0 → 0.1 s) won 38.4%, skipped its confirmation, and made best's runs 51% as long as at calibration. c/4 (render 0.8 → 0.2 s) won 39.6%. c/5 (parse 0.6 → 0.597 s) stopped after 7 of 10 pairs: "effect −1.1% (CI −3.1% to +2.0%, 7 pairs) can no longer clear the 2.6% win threshold: stopped early (futility…)". c/6 (parse → 0.1 s) won 54.1%, again without a confirmation. Best vs base: 86.1% lower (7.2×) in about 6 minutes of Running; the feed said "c/5 measured: 7 pairs in 27 s (stopped: it could no longer win)" and "c/6 measured: 4 pairs in 12 s (confirmation skipped: far beyond the win threshold)".
- **Automatic recalibration, twice, no pause.** After c/3's promotion `recalibration.due` (source: promotion), then segment 2 41 s later, same oracle hash, side runs 1 → 2 (one run 3.06 → 1.56 s, noise 2.23% → 1.92%, threshold 1.55% → 2.65%), and c/4 measured in it. After c/6, segment 3: side runs 6 (one run 0.46 s). The study never paused for drift; the notice read "recalibrated itself on best (c/3 made best's runs 51% as long as at calibration …): segment 2 started, same oracle … Nothing to do." with the per-host before and after. c/4's own runs took 61% of segment 2's calibration, just above the 60% trigger, so it didn't recalibrate there.
- **Across segments.** `bb study show`, the Live view's `best` and the report read "86.1% lower t_ms (7.2×) across 3 segments · this segment: 414.9 ms, no promotion yet". The harvest's line read "414.9 → 414.9 ms" (the segment's baseline, not the study base); fixed during the check to "≈ 3,053 → 414.9 ms" from the harvest's own base-vs-best measurement.
- **Notices.** Strategist round 2 (2 wins, a recalibration) said no "notices for you"; round 1 said 1 (calibration ready), round 4 1 (budget used up).
- **Harvest h1 (the strategist's grouping, as asked: {c/1, c/4} and {c/3, c/6}).** The two groups' commits interleave on `src/steps.py`, so they were folded into one PR: "#1 and #2 need each other: their commits interleave on src/steps.py, so neither applies without the other"; #2 "ships inside #1's PR". One branch, its parent `main`, the gate passing in a checkout of it. The study's first harvest was numbered h1.
- **Harvest h2 (one changeset per promotion).** A stack #1 → #2 → #3 → #4 in dependency order; four branches, each one's parent the branch below it (the first's `main`), the gate passing on every tip; contributions 23.3% and 18.8% of the gain for the two that could be ablated alone, the stack together 100.0% (CI 90.8% to 108.8%).
- **Other studies.** The plugin database was backed up first; after reinstalling the released plugin, every other study's row and event count matched the backup (a harvesting study included).
- **Cleanup.** The study was archived with its seven threads, the temporary project, `/tmp` files and the harvest exports deleted, and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Early losses are rare on modest regressions.** The t interval catches large regressions at 3-4 pairs; a regression of one or two thresholds still runs to `n_min` and often ends `inconclusive` by futility rather than `lose`.
- **The recalibration trigger is noisy-only** and compares one run's median time; a benchmark whose runs got longer, or an expensive oracle, keeps its calibration.
- **Auto side runs cap at 30.** A benchmark faster than `min_side_seconds` / 30 should repeat itself internally.
- **The confirmation skip** uses only the primary metric's CI; guardrails are then judged on the first measurement's pairs.
- **Replay** shows the headline across segments but not the segment's raw values.
- **Harvest attribution.** Reverting from best still isolates blockers one at a time (else all later ones); only the forward probe shrinks to a minimal set. Fold reasons say a file was "added or changed" (telling them apart needs a new host op). No real-git test triggers a forward or backward fold inside an already ordered stack; the pure model tests cover that loop.

## v0.2.3

Fixes from capturing the marketplace screenshots, plus two found right after: the strategist didn't know where best's code was, and archiving a running study could spawn replacement workers. Same platform pins (BB 0.45.x, SDK 0.6.14). UI, wording and view models, except the two engine fixes at the end; no statistics change.

### Live view

- **Status line by phase.** It said "N workers editing" whatever the workers did. `runningStatusText` (present.ts) now takes the workers' recorded phases and says what they do: "Running: 2 workers: 1 editing, 1 being measured; measuring c/9, 1 queued for the bench." (one phase: "2 workers editing"; none: "no live workers"). The server status line, the Live view and replay all pass phases; a worker row without a recorded phase counts by its state (starting, finishing) or as "working".
- **Worker count against W.** "3 workers (up to 2)" read like a bug: live workers include finishing ones, and W can drop below the live count (nobody is stopped for it). The header now reads "2 workers + 1 finishing · target 2", or "3 workers · target now 2 (no new worker until fewer)" (`workerCountText`). The Overview's hint says "target 2 now (W), max 3" and, when more are live, that no new worker starts until fewer than W are.
- **One queue position.** The lane counted the measurement on the bench as ahead ("c/2 queued, 2nd for the bench") while the Queue card counted the queue ("1st in line"). `benchQueueOrder` and `queuePosition` (live-model.ts) are now the one place the order and the position are decided; the lanes, cards, bench strip, Overview worker list and worker badges read them (1 = next for the bench, "1st in line"), and the lane prefers the view's queue over the server's number so a refetch can't make them disagree.
- **CI band labels.** The region names (win, continue, lose) moved into a right margin outside the plot, so they never cover the band or the decision line; the y-axis labels (0, the threshold, the domain's ends) and the region names are placed by `layoutLabels` (src/chart.ts): by priority, at least 11 px apart, a label that can't fit near its spot is dropped (0 always stays). Tests check the computed positions for four scales, including a +1.0% threshold a pixel above 0. The "pairs" axis title sits in the margin too, and the decision label no longer jumps down at the right edge.
- **Before the first pair.** The band's box was empty at "pair 0": it now says "Running best and the candidate for the first pair (in random order) of up to 20; the band starts once that pair is done" (and the same for the confirmation), and progress text says "first pair of ≤20 running" instead of "pair 0 of ≤20".
- **Expensive band in pixels.** It used a stretched viewBox, so its text was scaled; it now draws at the box's width like the noisy band (`useBoxWidth`), with column labels that shorten when columns get narrow.
- **Guardrail rows.** "no change than best vs the 10.0% limit" became "no change from best (CI 0.3% better to 0.4% worse), within the 10.0% limit · in total 2.1% worse than the segment base, within the 15.0% total limit" (`limitCheckWords`, guardrails.ts). `guardrailStatus`'s text reads "than best"/"than the segment base" (and "no change from …") instead of "vs best".

### Notices and the Overview

- **The human's own controls aren't notices for them.** The strategist's first round said "13 notices for you" when most were `control.idea_added` from the human's own CLI calls. The digest's summary counts only notices that need the human; controls are listed apart in the agent-only detail as an audit trail ("mention one only if it looks like something the human wouldn't have done"). Pre-start notices steered into the human's turn separate them the same way. All are still marked delivered.
- **State-aware actions.** A notice is stored once, but its step may be done: `noticeAction` now takes the study's state (and the latest harvest). `budget.exhausted` offers "Start harvest" only while the study is paused; while harvesting it is "Open Harvest" or "Review harvest", when running again "See budget", when archived nothing (or "Open Harvest"). `calibration.ready` after the start reads "See calibration"; `spec.proposed` without a pending spec "See the spec".
- **Trajectory chart.** It drew in a stretched 640-wide viewBox (text scaled with the width) with ticks at fifths of the data range (−7.9%, +19.1%) and no x axis. It now draws at its box's width with a fixed 10 px font, nice y ticks (1, 2, 2.5 or 5 × 10ⁿ, the domain widened to them; `niceTicks`) and labelled candidate numbers on x, spaced for the width (`trajectoryAxes`).
- **Guardrail trend.** The small trend line stretched any range to the full height, so a 0.02% wobble looked like a drop. `trendDomain` gives it at least 5% of the values' size, so a near-constant guardrail draws flat.

### Candidate detail

- **How the verdict formed.** The candidate detail shows the measurement's CI band with the Live view's component (`Measurement`, without its header): the stored `band_json` once measured (recomputed from samples for older candidates, marked as such), the live band while it is on the bench. `LiveRecorder.bandFor` picks which.
- **Which statistic.** The headline says what it is ("median of the per-pair changes, the verdict's estimate"; "single run of each side"; for expensive, "mean of the confirmation runs (or the screening run) against the median of best's runs"). The metrics table is titled "median of each side" and, when its primary change differs from the headline (6.20% vs 5.72%), a line under it says why.
- **Samples.** No inner scroll box: the first 12 rows, then "Show all 30 pairs". Rows come from `sampleTableRows` (src/sample-rows.ts) per noise class: noisy pairs numbered from 1, a deterministic measurement as one "single run" row (never "pair 0"), an expensive one as baseline runs, the screening run and confirmation runs.

### Harvest

- **No cut words or open code spans.** PR bodies clipped titles, summaries and dependency reasons mid-word and inside code spans ("Byte-i…", "a cheap `lin…"). `clipWords` (present.ts) cuts at the last word boundary and before an opening backtick whose code span the limit would cut; PR titles, bodies and the report's tables use it. Bodies are stored when drafted, so harvests drafted before v0.2.3 keep their old text.
- **Signs.** "best with this change reverted is +22.00% worse than best" is now "… is 22.00% worse than best" (or "better", or "measures the same") (`revertedWords`).
- **"It".** "Builds on #5: reverting it from best fails while this one stays" named neither; it now reads "Builds on #5: reverting #5 from best fails while this changeset stays."

### Replay: health checks

Replay showed every bench host as "not checked yet": only unhealthy streaks were events. Every health check now appends a `bench.health` event (host, ok, context; append-only), replay applies it, and the bench strip says "health checks off" when the spec disables them, "health not recorded" in replays of studies from before v0.2.3 (no `bench.health` event at all), and "not checked yet" only when none has run yet. `benchHealthText` (live-model.ts) is the one place it is worded; the replay bundle's spec carries `healthChecks`.

### The strategist reads best through git

- **The gap.** The study thread's environment is whatever was picked when the study was created: often a managed worktree branched from the project's default branch, or the project checkout on any branch. Nothing told the strategist where best was, so as promotions landed it kept reading base and its dossier and ideas drifted from best. Workers were fine (they branch from `studies/<slug>/best`).
- **The Code block.** Every strategist round and the harvest grouping round now carry a short "Code" section (`codeLines`, prompts.ts; `Engine.codeInfo`): the study base with its commit, `studies/<slug>/best` with its commit and the promotions so far, the sentence "Your own checkout may be on another commit; read code at best this way. Don't check out or commit in your own checkout.", and the commands that read best without switching branches from any checkout of the repository (refs are shared by its worktrees): `git show studies/<slug>/best:<path>`, `git grep -n <pattern> studies/<slug>/best`, `git diff --stat <base sha>..studies/<slug>/best`, `git log --oneline <base sha>..studies/<slug>/best`.
- **Another repository.** Detecting whether the strategist's environment is a worktree of the study's repository would need the thread's environment path and a git call on its host per round, so instead the block always also gives the `git -C <study repo path> …` form, with a line saying when to use it (a different `git rev-parse --git-common-dir`, or no repository).
- **Skills.** The `autoresearch` skill's strategist section says the same; `study-create` says the study thread may run in any environment of the project, because it only reads code and reads best through git.

### Archiving a running study spawned replacement workers

- **Seen live.** `control.archive` at t, the two live workers marked abandoned 0.2 ms later, then `worker.spawned` twice at t + 0.3-0.7 s (new ideas, new threads), and `study.state running → archived` only at t + 43 s, after the bench checkouts were removed. Each ended worker kicks the control loop, and the loop still saw a Running study with free slots and queued ideas. The two new workers kept running until stopped by hand.
- **Fix.** `archiveStudy` changes the state first, in one transaction with finishing the strategist row, before cancelling the harvest, stopping workers or removing checkouts. The control loop re-reads the study after its awaits before deciding to spawn (it used the row read at the start of the pass). `spawnWorker` re-checks the state after its own awaits and before asking BB for a thread (the row is marked failed and its idea re-queued), and again when the spawn resolves: if the study left Running meanwhile (paused, harvesting, archived), the new thread is stopped and archived at once (`worker.spawn_discarded`; the idea goes back to the queue unless the study is archived), and if the row was ended while the spawn was in flight (the archive ends spawning rows too) its late thread is stopped and archived the same way. Reconciliation finishes stopping live workers of an archived study (an archive interrupted mid-cleanup).
- **Pause and harvest** already changed the state synchronously before anything else; they shared only the late-spawn race, which the same check covers. A pause still lets running workers finish.
- **Tests.** Archiving with free slots and five queued ideas records no `worker.spawned` after it starts, and its `study.state` event comes before the first `worker.abandoned`; a spawn held until after the archive (and one held until after a pause) ends with its thread stopped and archived and no second `worker.spawned`. All three fail on v0.2.2.

### Live check (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** `src/toy.py` (a loop sum, a recursive fib, a quadratic dedupe, a bubble sort); the metric is opcodes of `toy.run()` counted with `sys.settrace` and 1% synthetic noise, guardrail `src_lines`; noisy, `n_min` 4, `n_max` 10; single-machine mode on (auto). Study 1: `max_workers` 3, `max_candidates` 6, four ideas added from the CLI. Study 2: `max_workers` 2, `max_candidates` 20, six ideas, archived as soon as two workers were live.
- **Status line.** Read every few seconds: "Running: 3 workers: 1 reading the code, 1 being measured, 1 reading a verdict; measuring c/3.", "… 1 refining, 1 waiting for the bench, 1 being measured; measuring c/4, 1 in tests.", "Running: 1 worker finishing." The view's counts carried `finishing` (2 of 3 at one point).
- **Before the first pair.** A measurement at pair 0 had a band with no points (the placeholder case) and progress "first pair of ≤10 running".
- **Notices.** Round 1 said "1 notice for you" (calibration ready) with six control notices (four ideas added from the CLI, calibrate, start) listed apart as the audit trail. On the Overview, `calibration.ready` offered "See calibration" once started; `budget.exhausted` offered "Start harvest" while paused on the budget and "Open Harvest" once the harvest ran.
- **Code block.** Rounds 1 and 2 carried it with the base commit, then best's new commit and "2 promotions so far", and the `git -C <study repo path>` form.
- **Candidate detail and replay.** `study.candidate` returned the stored band (10 pairs, exact) and "median of the per-pair changes, the verdict's estimate"; the replay bundle carried 12 `bench.health` events and `healthChecks: true`.
- **PR bodies.** A long summary was clipped at a word boundary with its code spans closed ("… `list(dict.fromkeys(xs))` … dedupe order…"), and the ablation read "best with this change reverted is 100.00% worse than best". Findings in PR bodies used the old clip and were switched to `clipWords` after the run.
- **Archive.** Study 2: `control.archive` at t, `study.state running → archived` at t + 3 ms, the two workers abandoned at t + 3 ms and t + 2.1 s, no `worker.spawned` after t; both worker threads and the study thread ended archived.
- **Seen, not fixed.** The toy's tracer stopped counting on the promoted best (0 opcodes, a bug in the toy's bench under Python 3.13 that the workers themselves reported), which made harvest's shares degenerate (two changesets each "100% of the gain") and the Overview call a zero-width CI of a noisy oracle "single runs, no CI". Both are what the numbers say for a metric of 0; neither occurs with a working bench.
- **Not checked live:** the rendered pages (screenshots are re-captured separately; the components are covered by jsdom tests), a spawn resolving after an archive (tested with a held spawn only), and an expensive-class band.
- **Cleanup.** Both studies archived with their threads, the temporary project and `/tmp` files deleted, and the released plugin reinstalled from GitHub (its database kept every study).

### Data model

No migrations. New events: `bench.health` (every health check), `worker.spawn_discarded`. The replay bundle's `spec` gains `healthChecks`; `LiveBenchHost` gains `healthRecord`; `LiveView.counts` gains `finishing`; the candidate detail gains `band`, `noise`, `effectStatistic` and `hostName`.

## v0.2.2: single-machine mode

v0.2.2. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Why

On a laptop the edit host is also the bench host. Gates (tests, type checks, renders) ran in parallel outside the bench lock, so a 2-3 minute gate could run next to a 15 s timing run and add noise to it. The health check before a measurement only defers it when the machine is already loaded; it can't stop a gate that starts a second later.

### The shared lock

- **Detection** (`src/single-machine.ts`). `[oracle] single_machine = "auto"` (default) is on when one of the study's resolved bench hosts is the edit host (`"local"`, the default, or the edit machine's own name or id) and the noise class takes the bench lock (`noisy`, `expensive`). Before the bench hosts are resolved (a draft), the spec entries decide: empty or `"local"` means the same machine. `"on"` forces it (gates take the edit host's lock key even when no bench host shares it, which only serializes gates with each other; a spec warning says so), `"off"` disables it. Deterministic oracles stay off under `auto` (their measurements don't take the machine-wide lock) and get a warning under `"on"`.
- **One queue** (`Pipeline.launch`). Gating candidates of single-machine studies join the bench work list with the queued candidates of every study. The list is sorted by when each candidate started waiting: `queued_at` for a measurement (and for a candidate re-gated after best moved, which keeps its place), `submitted_at` for a first gate. Each lock key gets one holder per pass: a gate takes its edit host's key, a measurement the first free, online, healthy host of its study. A key is busy while a measurement, a drift check or a serialized gate is launched on it. Calibration, profiles and harvest measurements take the same `HostMutex`, so they never overlap either.
- **The whole gate stage holds the lock.** Rebase (`prepareCandidate`) and gates run inside `withBench(..., "gate", candidate)`, so a candidate is never gated against a best that moved while it waited. Gate-less specs don't take the lock.
- **Calibration and harvest.** The base gates in calibration and every harvest gate run through `withGateLock`: under the lock in single-machine mode, directly otherwise. The calibration report says how long a candidate occupies the bench (gate + one evaluation) and what the mode does.
- **Bench intervals.** Gate spans are `bench_intervals` rows of kind `gate`. Utilization counts them (the views also report how much of the busy time was gates) and the overlap audit checks them against measurements on the same lock key. `gate.started` and `gate.finished` events (single-machine mode only) let the live view and replay show "testing c/N" on the bench host.
- **Scheduling.** `evalTimes` (pipeline.ts): with serialized gates, `T_eval` is the mean of gate + measure seconds over the last 20 decided candidates that used the bench (gate failures included: their gate occupied it), falling back to calibration's eval + gate seconds. `candidates.gate_seconds` records gate time always. Backpressure already counted gating candidates as bench queue; in single-machine mode they are the part of the queue waiting to test. Gate time doesn't count against `max_bench_hours` (that budget stays measurement time).

### Quiet bench

- **What it does.** `[oracle] quiet_bench = true`: while a measurement (or calibration, drift, harvest or profile run) of such a study holds a machine's bench lock, the `message.dispatch` hook answers `wait` for a new turn (`attempt: "start-turn"`) of an autoresearch worker whose environment is on that machine, with a reason naming the candidate, the host and the study, and a 10-minute `sendAt` as a safety net. `withBench` calls `bb.experimental_hooks.recheck("message.dispatch")` when the measurement ends; reconciliation calls it once on load.
- **What it doesn't.** Running turns (`join-turn`) are never held, and nothing else is: the study thread, human threads, other plugins' threads. It holds turn starts only; a turn already running keeps running its tools.
- **Bounded wait (decision).** A held turn starts once any measurement on that machine has ended since it was first held, even if the next one already began. Without that, a saturated bench would hold workers until the queue drained (no submissions, so it would, but only then). Each held thread's first hold time is kept in memory; a plugin reload forgets it, which at worst holds a turn for one more measurement.
- **Spawns (found in the smoke test).** A worker's first turn is dispatched while `threads.spawn` is still in flight, before the worker row knows its thread id, so the first version proceeded for every spawn. The hook now also holds a thread whose `originPluginId` is this plugin (only workers are spawned by the plugin). `quiet.held` and `quiet.released` events record each hold.
- Neither setting is part of the oracle hash: toggling them applies with `bb study approve`, without recalibration.

### Surfaces

The Oracle tab has a "Single-machine mode: on/off" section with the reason and what it does; the calibration report, `bb study show` ("Single machine" and the scheduler line's "tests + measurement") and the Overview say the same. Bench hosts on the Overview and Bench tab read "testing c/N (single-machine mode: tests hold the bench)" while a gate holds them; the status line says "testing c/N on the bench"; the Live bench strip shows the gate as the host's current work, marks queued candidates waiting to test ("c/4 tests"), and its feed says "c/4 waits to run its tests on the bench", then "tests started on <host>, holding the bench".

### Commit identity

`[git] identity = "repo" | "plugin"` (default `"repo"`, not part of the oracle hash). The host ops used to force `autoresearch <autoresearch@bb.local>` on every commit they made in the studied repository. Now the snapshot, prepare, reword (promotion) and compose (harvest) ops take an explicit identity. `Pipeline.commitIdentity` resolves it on the edit host with a new `gitIdentity` host op (`git config user.name` / `user.email` in the repo, without the plugin's environment: repo-local, then global), caches it for a minute, and passes it to every commit. No identity configured: the plugin's, a calibration warning, and one `git.identity` notice. Bench hosts never commit; they receive the edit host's commits as bundles, so their clones carry exactly the same author and committer (tested with real git).

### Fix: protected paths in the oracle hash

The oracle hash is meant to fold in the content of the `[scope] protected` paths at the baseline, so that editing a protected benchmark starts a new segment. Calibration ran `git ls-tree -r <base> -- ':(glob)bench/**'`, but `git ls-tree` doesn't support glob pathspec magic (it exits with "pathspec magic not supported by this command"). The output was empty, so every study hashed the same empty content and editing the benchmark never changed the oracle hash. The smoke test above showed it: two studies calibrated before and after an edit to the protected `bench/measure.sh` got the same hash.

A new host op, `protectedHash`, now lists the whole tree at the baseline (`git ls-tree -r -z --full-tree`), filters it with the scope check's own glob matcher (so `bench/**`, `bench/*.sh`, `**/*.txt` and a bare `bench` mean the same as in scope checks), and hashes the sorted `mode sha path` lines. Protected globs that match nothing hash as a distinct value, and calibration warns about them (probably a typo). A spec without protected globs hashes as before. Studies calibrated before the fix get a new oracle hash the next time they recalibrate. Checked live on a toy repo with `protected = ["bench/**"]`: calibrating before and after a commit that edits the protected `bench/measure.sh` gave two different oracle hashes (`c8ef369f…` and `4b572b37…`).

### Data model

Append-only migrations: `candidates.gate_seconds`, and an index on `bench_intervals (host_id, ended_at)` for the hook's open-interval lookup. New events: `gate.started`, `gate.finished`, `quiet.held`, `quiet.released`, `git.identity`. New bench interval kind: `gate`.

### Smoke test (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** A Python `toy.run()` (a bubble sort, a list-based unique count, a recursive fib). Metric: wall-clock ms, the best of as many runs as fit in about 1 s (about 16 s per evaluation, noise floor 1.6-3.8% per pair). Gate: the unit tests, then every core burning CPU for 3 s (about 3.2 s). Noisy, `n_min` 4, `n_max` 8; `max_workers = 2`; `max_candidates` 4-5; `single_machine` left at `auto`, `quiet_bench = true`. A repo-local git identity was set in the toy repo.
- **Three studies.** `toy-sm` (0.25 s measurements, to check the path quickly), `toy-sm2` and `toy-sm3` (16 s measurements). 14 candidates: 12 wins, 2 conflicts.
- **No overlaps.** Across the three studies, 34 bench intervals on one lock key (3 calibration gates, 3 calibrations, 15 candidate gates, 13 measurements; a re-gate after best moved, the measurement it cut short, and two conflicted candidates' sub-second gates included): a self-join on the lock key finds 0 overlapping pairs, and `bb study show` reports 0 overlapping bench intervals.
- **FIFO, live.** In `toy-sm`, c/2 was submitted while c/1 was being measured; its gate started 2 ms after the measurement ended. In `toy-sm2`, c/2 arrived during c/1's gate and gated right after it, before c/1's measurement (queued later); after c/1 won, c/2 was re-gated against the new best. In `toy-sm3`, c/2 arrived 0.5 s after c/1 was queued, so c/1's measurement went first and c/2's gate waited 21 s.
- **Utilization.** `toy-sm`: busy 26.5% of Running time (44.4% since the first submission), 13 s of the 21 s busy were gates. `toy-sm2`: 67.2% (85.0% since the first submission), 16 s of 101 s gates. `toy-sm3`: 60.1% (75.6%), 13 s of 97 s gates. The scheduler line read "eval ≈ 24 s (tests 3.2 s + measurement 21 s, single-machine mode)".
- **Quiet bench.** `toy-sm2` ran on the first build and held nothing: two workers spawned during measurements started at once (the spawn case above). After the fix, in `toy-sm3` both workers spawned during a measurement were held (17.4 s and 19.0 s) and started within 50 ms of the measurement's end.
- **Identity.** Every commit on the three `studies/<slug>/best` branches and under `refs/studies/<slug>/c/*` was authored and committed as the toy repo's own identity.
- **Cleanup.** The studies were archived with their threads, the temporary project and `/tmp` files deleted, and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Gates run one at a time** in single-machine mode, even though gates don't disturb each other's results. A readers-writer lock (gates share, measurements exclusive) would let several gates run between measurements; one queue is simpler and is what the measurements need.
- **Quiet bench holds turn starts only.** A worker whose turn is already running (and runs its own tests) keeps competing with the measurement; the health check before each measurement is still the guard for that.
- **Replay shows today's setting.** The replay bundle carries the current single-machine setting, not the one in force at each moment (gate events are only recorded when it was on, so the bench strip is still right).
- **A held spawn is attributed by origin.** BB's hook context doesn't carry plugin metadata, so a thread is recognized as a spawning worker by `originPluginId` alone.

## v0.2.1: fixes

Small fixes before the marketplace submission; no new features. Same platform pins (BB 0.45.x, SDK 0.6.14).

- **Noise per class (Oracle tab).** `noiseFloorText` (`src/present.ts`) says the calibrated noise for the oracle's class: per pair (noisy), the σ of one run (expensive), or none (deterministic: single runs judged against the tolerance, so no MDE sentence). Without a noise floor (an imported study has no A/A calibration) it says "not measured"; the old sentence took `Math.max` over a null floor and printed "0.00% per pair". The view's host and segment floors are null when missing or not finite.
- **Why a verdict isn't the primary metric's.** `verdictCause` reads the verdict's own reasons: a primary-metric win that broke a guardrail is "lost on guardrail mem_kb (27.6% worse)" (or "… than the segment base" when only the total limit broke), a holdout failure "lost on the holdout check", and failed gates, conflicts and scope rejections their reason. Pipeline cards, the Candidates list and detail, Findings, the feed ("c/3 lost on guardrail mem_kb (27.6% worse), despite 43.3% fewer ops"), the CLI and replay show it instead of, or next to, the primary number. The `verdict` delta carries it; replay bundles carry it precomputed (their reasons are trimmed to the first one).
- **Single runs.** A point CI (deterministic) reads "single run, no CI" and "+20.0% (single run)" in tables, never "+20.0% to +20.0%". Measurement progress is per class (`progressText`): pairs for noisy, "running best" / "running the candidate" / "run 1 of 1" for deterministic, "run 2 of ≤4" for expensive; the live view carries the noise class (`LiveView.noise`, the replay bundle's `spec.noise`). The deterministic band reads "Single run: +2.00% vs best, better by more than the 0.50% tolerance: win", and the feed says "measured: one run each".
- **Status line and Overview.** A candidate on the bench is counted as measured, not queued: "Running: 2 workers editing, measuring c/1, 1 queued for the bench, 1 in tests." (`runningStatusText`, shared by the live status line and replay). The Overview's "Now" hint depends on the state: "no workers before the study starts" only for draft and calibrating; paused, harvesting and archived say what they mean.
- **Lanes link through the worker row.** `candidates.worker_id` (append-only migration) records the `threads` row that submitted a candidate; the live view, the recorder's phases, the Overview's workers and replay link lanes to candidates through it, with the BB thread id as the fallback. The migration backfills existing rows from the BB thread id, then from `worker.phase` events (which record each worker's latest candidate). A worker row without a BB thread id now shows its submissions and "c/N measuring" (it showed "submission 0 of 1" and never its candidate). The submit event carries `worker_row`.

## v0.2.0: live view, part 2

Part 2 of the Live view: a CI band per measurement, a "last action" per worker, a visible "best moved" moment, replay of any study, and two fixes from part 1's list. Same platform pins (BB 0.45.x, SDK 0.6.14). The view stays read only.

### The CI band

- **What it shows.** For each measurement on the bench (and for 30 s after one ends, so its decision stays on screen), the estimate and its CI after every pair against the zero line and the win threshold (the measurement's MDE). The sequential test's regions are shaded: below zero (a CI entirely there is a loss), between zero and the threshold (continue), above the threshold (a CI whose low end gets there is a win). Pairs before `n_min` are hatched ("no decision before pair 6"); their CI is drawn faintly, for orientation. Where the test stopped is marked on the chart and said in words: "Decided after 9 of 20 pairs: win · CI +2.1% to +7.9%". The confirmation run is a second panel with its own band. The sentence under each chart is also the chart's accessible name.
- **Consistency with the real decision (decision).** The decision's bootstrap used the study's shared generator, so nothing could recompute its CI later. The sequential test now takes a generator seeded per (candidate, run, pair) (`ciSeed`, FNV-1a of the three, passed to the noisy strategy as `ciRng`). Recomputing from the stored samples with the same seed and the same number of resamples gives the decision's CI to the bit at every pair from `n_min` on (tested at every pair of simulated measurements, and live: the band's last point equals the candidate's stored CI). A seeded bootstrap per step is as valid as one stream; only reproducibility changed. Before `n_min` the decision computes no CI; the band's preview CI there uses at most 400 resamples. Alternatives rejected: storing the CI at each step as an event (more events for nothing the samples don't already say), or a cheap approximate CI (it would disagree with the verdict at the moment that matters).
- **Cheap enough to be live.** `LiveRecorder.band` keeps a per-candidate cache: it loads only samples after the last one read, and reuses the points already computed (a point is recomputed only when its pair is new). A restarted measurement (its samples deleted and new ones written) is noticed by its lowest sample id and starts over. When a measurement ends, its band is stored with the candidate (`candidates.band_json`, with the verdict's guardrail checks), so later views and replays read it instead of recomputing. Bands of measurements decided before this change are recomputed from their samples, marked "recomputed: can differ slightly from the verdict's CI", and cached in memory (views are read only, so nothing is written back).
- **Pair by pair.** Each completed pair pushes a `band` delta with the new point (no event: bands come from samples). It is applied whatever the snapshot's event id (a point is idempotent by its pair number) and advances the card's and the bench strip's pair count, so the count no longer jumps by the 2-second progress events; on refetch, pair progress is the larger of the events' count and the band's (`mergeProgress`), so it never steps back.
- **Other classes.** Deterministic: the one run against the tolerance, as a number line with lose / within tolerance / win zones and the raw values. Expensive: the baseline runs (relative to their median), the screening run against the ±z·σ·√(1 + 1/m) band, then the confirmation runs' running mean against the tighter ±z·σ·√(1/k + 1/m) band, with the same thresholds the strategy uses.
- **Guardrails, compactly.** Under each band, one row per guardrail: the step's CI as a bar against its limit and the total's against its own, with the state in words (ok, inconclusive, BROKEN; "so far" while running). While a noisy measurement runs, the estimate comes from the per-pair regressions so far (pooled over both runs during the confirmation, like the verdict) with 400 resamples; once it ends, the verdict's own checks replace it.

### Last action per worker

- **The label (`src/action.ts`).** From the same tool items the phase classifier reads, plus the file paths an item names (`fileChange` changes, `fileRead` and `search` paths, a tool call's path arguments), never message text: "editing src/toy.py", "editing 3 files", "reading 3 files" (consecutive reads are summed), "searching the code", "running pytest -q", "submitting a candidate". Shell commands are unwrapped (`bash -lc`, leading `cd`), heredoc bodies and inline scripts are dropped, a compound command is labelled by its strongest part (an edit, then a program run, then reads).
- **Sanitized.** At most 80 characters; paths relative to the worker's worktree (other absolute paths keep their last two segments); environment assignments dropped; values of secret-looking flags (`--token`, `-pSECRET`, `--password=`), key=value pairs named like secrets, bearer tokens, known token prefixes (GitHub, OpenAI, Slack, AWS, Google, GitLab, npm, JWTs) and long hex/base64 runs replaced by "…"; URLs reduced to their host. Tested against a list of hostile commands.
- **Recorded.** The latest label is stored on the thread row (`threads.last_action`); the recorder appends a `worker.action` event when it changes, at most one per 3 s per worker (`liveActionMs`), the latest label winning after the wait. The view shows the recorded label (with "0:12 ago"), so live and replay agree; the delta carries the label (at most 80 characters).

### The "best moved" moment

- When a candidate is promoted: its card lands in Promoted (the existing glide), the header's best-vs-base number counts up to the new value over 0.9 s and says "best moved: c/N" for 4 s, the trajectory sparkline (best vs base after each promotion) steps, and the lanes of the other live workers say "best moved: rebases on next submit" for 6 s. The view model carries `best.value`, `best.movedAt`, `best.history` and `best.rebases` (live workers past spawning and not finishing, except the winner's); the moment is derived from the view's own clock, so a replay shows it at the right time too.
- Calm by design: no confetti, one highlight color, everything stated in words. Under `prefers-reduced-motion`, or when the page draws no frames, the number jumps and nothing moves.

### Replay

- **Data (`study.replay`, `replayBundle`).** The event rows replay reads (payloads trimmed to the fields used), every measurement's band, and immutable metadata: ideas (title, theme, source), worker rows (lane key, thread, spawn time), candidates (idea, thread, title), bench hosts and their busy intervals. About 120 bytes per event. New `submission.refunded` events (a conflict refund) keep the submission count right; `measure.finished` now carries the effect.
- **Model (`src/replay.ts`, pure, runs in the app).** `ReplayModel` reduces the events once, keeping a copy of the reduced state every 256 events. The view at time t restores the nearest keyframe at or before t and applies at most 256 events; playing forward applies only the events since the last frame. `viewAt(t)` returns the same `LiveView` the live page renders, so the same components draw it: lanes with phases and last actions, cards with their pair counts, the bench strip with utilization, Up next in pick order, the feed (told once over the whole study and cut at t), the bands cut at t (`bandAt`), and the best-moved moment. Synthetic 10k-event study: build 6.5 ms, a random seek 0.15 ms (p95), a 600× playback frame 0.06 ms (p95) on this machine; the test's budgets are 1.5 s, 16 ms and 8 ms.
- **Parity.** A recorded run in the tests (three workers, two promotions, last actions, a pause) took a live view snapshot at 30+ moments; the replay at each moment's time equals it on every compared field (lanes, cards, queue, bench, bands, Up next, feed, best and its history, counts), forwards and in a scrambled order. Live: in the smoke test, 155 of 155 `study.live` snapshots of one study and 111 of 116 of another equalled the replay at their times; the 5 differences were all during a measurement interrupted by a plugin reload, whose samples were deleted (below).
- **Player and scrubber (`src/app/live/Replay.tsx`).** A timeline with event density (120 bins), milestone markers (wins, best moves, pauses and resumes, segment and harvest starts; thinned when they would overlap), the position, and wins as thin lines; click or drag to seek. Play/pause, 1×, 10×, 60× (default) and 600×, "Next win" (lands 3 s before it so the moment plays), and the keyboard: Space or K, ←/→ (1% of the span, Shift 10%), Home/End, N/P, 1-4 for the speed, Escape to leave. Playback is time-based (animation frames, with a timer when the page draws none); the board re-renders at most every 120 ms or when an event lands, while the scrubber follows every frame; glides, the band's growth and the count-up play only while playing at 60× or slower, never on a seek.
- **URL.** `studies/<slug>/live/replay[/<ms since the study's first event>]`, updated with `replace` on pause and seeks and every 2 s while playing, so a moment can be reopened and back doesn't step through positions. Without a position the replay starts at the beginning and plays.
- **Entry points.** The Live header's Replay button (a running study rewound; "Back to live" and "Update" to load what happened since), the not-running state's "Replay this study", the Overview's Replay button, and a Live/Replay switch in the side panel (the panel keeps its own position and links to the page at it).
- **Transcripts.** Not time-synced. In a replay, the selected worker's transcript is its current `ThreadChat` timeline with the note "Current transcript, not at this moment". Checked live: it renders for archived worker threads too.
- **What replay can't show.** A measurement that restarted (reload, host worker exit, best moved during it) had its partial samples deleted, so replay shows that attempt's pair count from events but no band; health readings and the next health check time aren't events (the bench strip shows online/offline and the last health result from `bench.*` events); the status line is a shorter one built from the replayed state.

### Fixes from part 1's list

- **Up next follows the scheduler.** `scheduler.upNext` applies `pickIdea` repeatedly, each pick counted as running for the next, so the theme cap and the no-repeat rule order the list as spawns will; ideas the policy skips follow in board order with the reason ("waits: 1 running on algo", "repeats an idea that lost"). Tested against successive real picks.
- **No database access after dispose.** On reload, BB disposes the old instance, then closes its database; the old instance's measurement jobs were still awaiting bench runs and logged "The database connection is not open" when they resumed. `Engine.dispose` (a `bb.onDispose` hook) now marks the context disposed, aborts in-flight measurements and harvests, stops the live recorder, and closes the store: any later access throws a quiet `StoreClosedError`, the pipeline's catch paths return without writing, and the old instance's log is dropped. Tested with the SDK harness (`lifecycle.reload` during a blocked measurement: no log, no write, the new instance restarts the measurement) and live (a reload mid-measurement logged only the new instance's reconcile).
- **Pair progress** moves pair by pair (the band deltas above), though `measure.progress` events stay coarse.

### Motion, found in the smoke test

- **Frozen glides.** A BB browser tab that isn't composited still runs an animation frame about once a second, which fooled part 1's heartbeat; animations started there stayed at their first keyframe (cards invisible or far away). The heartbeat now requires two frames within 100 ms, and every animation is finished by a timer shortly after it should have ended.
- **Runaway glides.** A glide measured an element's position through a glide still in flight, so at 8 renders a second each new offset included the previous one (6.7e7 px after a few seconds of replay). Positions are now measured without the in-flight translation, a move restarts from where the element is seen, and an element that didn't move keeps its glide.

### Data model

Append-only migrations: `threads.last_action`, `last_action_at`, `action_recorded`, `action_recorded_at`; `candidates.band_json`. New events: `worker.action` (worker, thread, label, item time), `submission.refunded`; `measure.finished` gains `effect`. New RPC `study.replay`. New realtime deltas `action` and `band`. The noisy strategy takes `ciRng`.

### Smoke test (BB 0.45, one MacBook, a toy repo under /tmp, a temporary project)

- **Toy.** A program whose cost is spread over parts of 0.4% to 42% of the opcodes (a bubble sort, a linear `contains`, a loop sum, a recursive fib, a character-by-character parser, a string join), so ideas have small and large effects. Metric: opcodes of `toy.run()` with 4% synthetic noise per run (3.6% per pair after pairing; MDE 2.0-2.4% at 20 pairs); guardrail `mem_kb` (tracemalloc peak, 1% noise; limits 10% per step, 15% total). Noisy, `n_min` 6, `n_max` 20, about 1 s per run. `max_workers` 3; `max_candidates` 8 and 7.
- **Runs.** `toy-live4`: 8 candidates, 5 wins, 2 losses on the guardrail (set-based dedupe and `sorted()` at +24-51% memory), 1 inconclusive after 20 pairs; 95.8% fewer ops (24×). `toy-live5` (only moderate ideas): 2 wins at 5.5% and 4.4% (decided after 11 and 18 pairs, then confirmed with 9 and 7 fresh pairs), 4 inconclusive after 20 pairs, 1 guardrail loss; 9.7% fewer ops.
- **Band equals verdict.** For all 15 measured candidates of both studies, the stored band's last point equals the candidate's CI to 1e-12, and the confirmation band's last point equals the confirmation CI in the verdict's reasons.
- **Seen.** Bands narrowing pair by pair to "decided after 18 of 20 pairs: win" and "decided after 20 of 20 pairs: inconclusive", confirmation panels, guardrail rows going BROKEN; last actions ("submitting a candidate 0:30 ago", "running python3 -c …"); best moving with the count-up (5.5% → 9.0% → 9.7%), the sparkline step and the rebase chips; Up next with "waits: 1 running on data"; the side panel live and switched to Replay; replays at 60× and 600×; a reload mid-measurement with no database error.
- **Evidence.** Screen recordings (CDP screencast frames encoded with ffmpeg) and contact sheets in the building thread's storage (`video/`, `shots/`): the CI band narrowing (live), a win with its confirmation (live), the best-moved moment (live), a whole run, the side panel live and in replay, and replays at 60× and 600×. The screencast makes the hidden automation tab draw frames, so unlike part 1 the motion itself was recorded.
- **Cleanup.** Both studies were archived with all 16 threads, the temporary project and `/tmp` files deleted (including scratch files the workers wrote to `/tmp`), and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Replay of restarted measurements** has no band for the interrupted attempt (its samples are gone).
- **Huge effects flatten the band.** A 90% win makes the scale span 0 to 98%, so its (tiny) CI is a line; the words carry the numbers.
- **Event density only, no zoom.** A study of many hours puts minutes into one scrubber pixel; seeking by keyboard steps 1% or 10%.
- **Last action is per batch of items.** BB announces thread events about once a second; a worker that does three things in that second shows the last one.
- **Workers write outside their worktree.** Agents in the smoke test left scratch files in `/tmp`; the plugin doesn't sandbox them.

## v0.2.0: live view, part 1

A Live view for watching a running study: workers picking up ideas, editing and pushing candidates through tests and the bench, with verdicts arriving. Part 1 is the live surfaces and the event log they stand on; part 2 adds a CI band per measurement, a "last action" line per worker, a visible "best moved" moment, and a replay of finished studies. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Decisions taken before building

- **Two surfaces, one component.** A **Live** tab on the study page, which is the default tab while the study is Running (other states keep Overview), and a **Live panel** in the study thread's right split pane (`threadPanelAction`), so the human can watch while talking to the strategist. Both render `LiveStudy` (`src/app/live/`), in a wide and a compact layout.
- **Read only.** No stop, steer or reprioritize controls. The view opens things (a candidate, a worker's transcript or thread, the Overview); Pause stays on the Overview.

### Step 0: the transcript spike

- **Question.** Does `ThreadChat` with `variant="timeline"` (a transcript without a composer) render a hidden, plugin-spawned thread live, and do agent-only blocks stay hidden?
- **Setup.** A scratch plugin spawned a hidden thread in a managed worktree with a slow, multi-step prompt, rendered it with `ThreadChat variant="timeline"` in a nav panel and in a `threadPanelAction` tab, and sent it a message with a one-line summary and an agent-only block holding a secret word.
- **Result: it works.** The timeline streamed as the agent ran (commands appearing as they ran, "Working…" while busy). The human view showed only the summary line; the agent's reply quoted the secret word, so the agent-only block reached the agent and stayed out of the human view. The worker's brief (its first user message) is shown in full, as in the worker thread itself.
- **Also found.** `useBbNavigate().openThreadPanel` returns false on a plugin page, even right after `toThread` (the hook belongs to the page, not the thread). From a component mounted on the thread surface (the header badge) it opens the panel on the first try. That decided how "Open beside the study thread" works (below).

### Every visible change is an event

The Live view shows nothing that isn't in `events`, so a replay can rebuild it at any time t. Realtime deltas are a throttled projection of the same rows.

| Event | Recorded | Payload | Shows |
|---|---|---|---|
| `candidate.stage` | on every stage change, by the store (`insertCandidate`, `updateCandidate`): one choke point, so none is missed | candidate, n, from, to, the verdict when decided | which column a card is in, and since when |
| `worker.phase` | by the live recorder whenever a worker's derived phase changes | worker (the `threads` row id), thread, idea, from, to, candidate, reason (when done) | the lanes |
| `measure.started` | at the start of each measurement (now with `of`) | candidate, n, host, of | bench strip, card |
| `measure.progress` | for the first completed pair, then at most once per 2 s per candidate, and the last pair of each run | candidate, n, run (measure or confirm), pairs, of, host | pair i of n |
| `measure.finished` | at the end (now with `pairs`, `run`, `measure_pairs`, `confirm_pairs`) | | feed |
| `drift.started` | when a drift check takes a host | host | bench strip |
| `idea.added` | now with `theme`, `priority`, `pinned` | | Up next |
| `candidate.verdict`, `best.promoted`, `idea.status`, `worker.spawned/finished/abandoned`, `candidate.queued/rebased/requeued`, `measure.restarted` | as before | | cards, feed, Up next |

- **Replay.** `replaySkeleton(events, until)` (`src/live-model.ts`) rebuilds the state the view shows (live workers and their phases, every candidate's stage, verdict and pair progress, best, queued ideas, what each bench host measures) from these rows alone. `skeletonFromDb` builds the same from the tables. Tests compare the two at several points of simulated studies (including a replay up to an earlier t), and the smoke test compared them on the live database (below).
- **Pair progress is shared.** `reducePairs` turns a candidate's events into "pair i of n"; the live view and replay both use it, so they show the same numbers.

### Worker phases

- **From plugin state, not transcripts.** `deriveWorkerPhase` reads the thread row, the worker's latest candidate, and its activity: starting (spawning) → reading, editing or testing (before the first submission, by activity) → waiting for the bench (submitted, gating, queued) → being measured (measuring, confirming, promoting) → verdict received (decided) → refining (activity after the verdict was delivered) → finishing → done.
- **Activity.** BB announces new thread events at most once a second per thread (`experimental_thread.events`). For a live worker, the engine reads the `item/started` rows after the last one it read (`bb.sdk.threads.events.list`, at most 100 per page, which is BB's cap) and keeps only each item's kind, command and tool name, never message text. `classifyItem` maps them: file reads and searches are reading; file changes and shell edits (`sed -i`, scripts that write files, redirects into files, `apply_patch`) are editing; other commands are testing, unless every part of a compound command only reads. `threads.activity`, `activity_at` and `activity_seq` hold the result.
- **Recording.** The `LiveRecorder` (`src/live.ts`) listens to every appended event (`Store.onEvent`) and, on a microtask after the transaction, syncs the study's workers: a changed phase updates `threads.phase` and `phase_at` and appends `worker.phase`. A flip between reading, editing and testing is recorded at most every 3 s per worker (`liveDwellMs`); the latest activity wins. The control loop also syncs every tick as a safety net.

### Realtime deltas

- **Channel `study-live`.** A message is `{ s: studyId, d: [...] }`, each delta ids and small numbers only (`stage`, `phase`, `pair`, `verdict`, `best`, `idea`), carrying its event id and time. Data still comes from RPC (`study.live`).
- **Throttled per study (decision: ~4 messages/s).** `DeltaBus` sends at most one message per 250 ms per study, keeps only the latest delta per key within a window (a card that went gating → queued → measuring sends "measuring"), and turns a burst of more than 40 into `{ refetch: true }`.
- **Applied locally.** `applyDeltas` (shared, pure) moves cards, counts pairs, updates phases and removes picked ideas; a delta for a card, worker or idea the view doesn't know yet, a new best, a decided card or a newly queued one asks for a refetch. Deltas at or below the snapshot's `lastEventId` are ignored. The view refetches at most once a second, on `study-changed` (still published for the other pages), on reconnect, and every 5 s.

### Surfaces

- **Live tab.** The route without a tab opens Live while Running and Overview otherwise, decided once per visit so a study that pauses doesn't pull the page away. An explicit tab always wins. When the tab's area is narrower than 760 px (a narrow window, or the page beside an open side panel) it uses the compact layout.
- **Live panel.** `threadPanelAction` `study-live` (flush layout, "Study live view" in a thread's right-panel launcher). It resolves its study from the thread with the `thread.study` RPC: the study thread, or a worker thread (whose transcript is then selected). `params.slug`, when given, is validated and wins. On any other thread it says so and links to the Studies page.
- **Open beside the study thread.** The study thread's header badge gets a **Live** button that opens the panel there. The Live tab's button records a request and navigates to the study thread; the badge, mounted on that thread surface, takes the request and opens the panel (retrying briefly while the surface settles). The request lives in the app window's memory for 15 s.
- **Not running.** A calm state says why (draft, calibrating, paused, harvesting, archived), points to the Overview, and shows the last verdicts. A paused study with workers still finishing shows the full view.

### What the view shows

- **Header.** Live or not running (a dot that pings while running, and the word), the status line, best vs. base in the improvement convention (highlighted with "best moved" for a moment when it moves), candidates used, workers and W.
- **Worker lanes.** Idea number, title and theme; the phase in words with its glyph; time in phase and since spawn; submissions used of the maximum; the candidate it waits on and where (for example "c/4 queued, 2nd for the bench"); a row of step segments with the current one marked. Selecting a lane shows that worker's transcript (`ThreadChat`, timeline variant, read only), one at a time; Escape or Close hides it, and it stays readable after the worker finishes.
- **Pipeline.** Submitted → Tests → Queue → Bench → Verdict / Promoted. In-flight cards plus the last five verdicts and four promotions. Cards carry the stage in words, time in stage or queue position, pair progress on the bench, and the verdict with its glyph and the improvement ("23.4% fewer ops") once known. A card opens the candidate.
- **Bench strip.** Per host: health in words, what it measures (candidate, measuring or confirming, pair i of ≤n, elapsed), or a drift check, or idle; how busy it was over the last 10 minutes of running time (this study's bench intervals); the shared queue behind it.
- **Up next.** The next six queued ideas in board order (pinned, priority, age), with a count of the rest.
- **What just happened.** Plain sentences from events ("c/14 tests passed in 41 s, queued for the bench", "c/13 lost: 0.4% more ops (worse)", "Best moved: c/12 promoted, workers notified"), grouped by candidate with the newest group last, auto-scrolling unless the human scrolled up.

### Motion and accessibility

- **Motion.** Cards glide between columns and an idea glides from Up next into its worker's lane (FLIP with the Web Animations API, keyed by `card-<n>` and `idea-<id>`, positions relative to the view so scrolling isn't motion); new items fade in; pair bars and utilization ease; the running dot pings; the current phase segment pulses; a verdict briefly rings its card.
- **Reduced motion.** Under `prefers-reduced-motion` nothing moves (WAAPI is skipped, CSS uses `motion-safe:`/`motion-reduce:`). Animations are also skipped when the page renders no frames (a one-per-second animation-frame heartbeat): a hidden tab would otherwise leave items frozen at their first keyframe.
- **State in words and shapes.** Phases, stages and verdicts carry a word and a glyph; color is never the only signal. Lanes, cards, queue chips and buttons are keyboard reachable with focus rings and labels that read the state ("Worker on idea #3, Memoize fib: being measured for 42 seconds, submission 1 of 2, c/2 measuring. Show its transcript."). The feed is a `log` region (not announced on every line); the status lines are polite live regions.

### Data model

Append-only migrations: `threads.phase`, `phase_at`, `activity`, `activity_at`, `activity_seq`. New events `candidate.stage`, `worker.phase`, `measure.progress`, `drift.started`; extended payloads of `measure.started`, `measure.finished` and `idea.added` (above). New RPC `study.live` and `thread.study`; the thread badge view gains `state`.

### For part 2

- **Replay.** Build a view at time t from `store.eventsAsc(studyId, { untilAt })`: `replaySkeleton` gives phases, stages, verdicts, pairs, best, queued ideas and bench occupancy; `feedItems` turns any slice of events into the feed; titles come from `idea.added` (or the ideas table), effects from `candidate.verdict`. Times in stage and phase come from the same events (`candidate.stage`, `worker.phase`).
- **CI band per measurement.** Samples have per-pair values with timestamps (`samples.at`, run, pair, side) for every finished measurement; `measure.progress` marks the coarse steps. Samples of a measurement that restarted are deleted with it.
- **Last action per worker.** The port already reads each item's kind, command (first 300 characters) and tool name; only the class is stored. Persisting a short label (for example `threads.last_item` plus an event when it changes, rate-limited like phases) gives part 2 its line.
- **Best moved.** The `best` delta and the header highlight exist; a bigger moment can hang off the same delta.

### Smoke test (BB 0.45, one MacBook, toy repos under /tmp, a temporary project)

- **Toy.** The M3 toy: `src/toy.py` with a naive sum, a recursive fib and a quadratic dedupe; the metric is opcodes of `toy.run()` counted by a protected `bench/measure.py` with 1% synthetic noise; the gate is a protected test. Noisy class, `n_min` 5, `n_max` 12, `max_workers` 3, local bench, health checks off (a busy laptop), default provider. Studies 2 and 3 added a 6 s gate and 1 s per run so every stage stays on screen for a while.
- **Runs.**

  | Study | Candidates | Verdicts | Best vs base | Events replayed |
  |---|---|---|---|---|
  | `toy-live` | 6 | 4 wins, 1 inconclusive, 1 conflict | 99.5% fewer ops (210×) | 161 |
  | `toy-live2` | 6 | 4 wins, 2 inconclusive | 97.3% fewer ops (38×) | 200 |
  | `toy-live3` | 8 | 6 wins, 2 conflicts after best moved (one measurement restarted by a plugin reload) | 100.0% fewer ops (35,057×) | 279 |

- **Replay parity on the live database.** For all three studies, `replaySkeleton` over the recorded events equaled `skeletonFromDb` on a copy of the plugin database, including the measurement that a plugin reload restarted.
- **Seen in the app.** The Live tab opened by default once the study ran (and Overview while calibrating or paused); lanes went starting → reading → testing → editing → waiting → being measured → verdict → refining → finishing; cards moved Tests → Queue → Bench → Promoted or Verdict, with queue positions and pair counts; the bench strip showed pair i of ≤12 and utilization; "Open beside the study thread" opened the panel beside the study thread, which survived a reload; "Study live view" appeared in the thread's right-panel launcher; selecting a lane showed the hidden worker's transcript live.
- **Found and fixed during the run.** BB caps a thread events page at 100 rows (the first build asked for 200 and got HTTP 400, so no activity was recorded); workers edit through shell heredocs, which the first classifier read as reading; animations started in the hidden automation tab froze cards at their first keyframe (now skipped without rendered frames); the Live tab's six columns overflowed beside an open side panel (now compact under 760 px); the feed said "Best moved" before "won" (promotion is recorded first; the feed now tells the win first).
- **Evidence.** Screenshots, timelapses built from timed screenshots, and contact sheets are in the building thread's storage (`shots/`). They were captured from a hidden automation tab, which doesn't repaint animated layers, so they were taken with `prefers-reduced-motion` emulated; the motion itself is covered by tests.
- **Cleanup.** All three studies and their threads were archived, the temporary project and `/tmp` files deleted, and the released plugin reinstalled from GitHub.

### Not done, and known issues

- **Activity is a heuristic.** A provider that edits through a tool name the classifier doesn't know, or a worker whose thread emits no tool items, stays at "reading" until it submits. Short activities can be skipped by the 3 s dwell.
- **Coarse pair progress.** At most one progress event per 2 s per candidate, so a fast benchmark jumps by several pairs.
- **Up next is approximate.** It shows board order; the scheduler's theme-diversity cap can pick a later idea first.
- **Utilization** counts this study's bench intervals only, not other studies sharing the host.
- **Open beside** relies on the header badge mounting in the same app window within 15 s.
- **Visual motion** is checked in tests (jsdom with stubbed layout and animation frames); it was not watched or recorded in a visible window, because the only window available to the build was a hidden automation tab.
- **Reload during a measurement** logs "The database connection is not open" from the old instance's in-flight jobs before the new instance reconciles (pre-existing; the measurement restarts cleanly).

## v0.1.0: guardrails and pre-release fixes

The last pass before release. It fixes two guardrail correctness gaps and three usability issues the earlier smoke tests found. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Guardrails: a cumulative limit

- **The gap.** Guardrails compared each candidate only with the current best. Ten promotions that each add 4.9% memory pass a 5% limit and leave best 61% above the segment base.
- **Spec.** `[[guardrail]] max_total_regression` (a fraction like `max_regression`, default `max_regression`) limits how much worse best may get than the segment base over all promotions. A value below `max_regression` is accepted with a warning (the total limit then binds first). It is part of the guardrail entry, so it is in the oracle hash: changing it is an oracle change and starts a new segment. Spec versions stored before this pass are read with the default filled in (`normalizeSpec`), so their hashes stay comparable.
- **Where best stands (decision).** Best's position against the segment base is the promotion chain base → best (followed through `promoted_sha` and `against_sha`), compounded from each promotion's recorded guardrail estimate, with the candidate's own step on top. Steps compound in the metric's own terms (values multiply by 1 + r for lower-is-better, by 1 − r for higher-is-better); CI half-widths combine as a root sum of squares in log space, the same independence assumption as harvest's gap. Alternatives rejected: measuring the segment base as a third side of every pair (a third checkout and 50% more bench time per candidate), or comparing unpaired medians of the base's calibration runs with today's candidate (machine drift between the two times is not paired away).
- **Both limits on every win.** The verdict checks the step against `max_regression` and the total against `max_total_regression`; either one broken makes the win a `lose`. The reason says which, in words: "guardrail rss: 4.9% worse than best, within the 5.0% limit; 21.1% worse than the segment base, beyond the 20.0% total limit".
- **Segments.** A new segment starts the chain again from its baseline (best at recalibration).

### Guardrails: statistics

- **The gap.** A guardrail was the median of the paired differences with no CI: a noisy secondary metric could reject a real win by chance.
- **The rule (`src/guardrails.ts`).** Each guardrail gets a CI of its regression. **Broken** when the CI is entirely beyond a limit, **ok** when it is entirely within, **inconclusive** when it straddles. Inconclusive is not a rejection: the verdict lists it ("…inconclusive against the 5.0% limit (the CI straddles it; flagged, not a rejection)"), the worker's summary line says "Guardrail rss inconclusive (flagged)", and the page shows an inconclusive state with the warn tone.
- **Per class.**
  - `noisy`: a percentile bootstrap CI of the median of per-pair regressions, the primary metric's method and confidence. A confirmation measurement judges guardrails on the pairs of both measurements (decision: guardrails didn't select the candidate, so pooling isn't biased, and one test on more pairs replaces two separate chances to reject). The first measurement can already reject.
  - `deterministic`: one run per side; the CI is ± max(`tolerance`, the calibrated repeat difference). With tolerance 0 the exact value decides, as before.
  - `expensive`: the candidate's confirmation runs against the host's baseline runs, with a half-width t·σ_g·√(1/k + 1/m), σ_g the guardrail's calibrated per-run noise and t the same Student-t quantile as the primary metric. Without calibration it is estimated from the runs at hand when there are enough of them.
  - Old candidates have point estimates only; the chain uses them as exact.
- **Simulation** (test/guardrails.test.ts; noisy class, n_min 6, n_max 20, confirmation on, a 20% primary win, a 5% guardrail limit; "before" is the old rule applied to each measurement):

  | True guardrail change | Per-run noise (per-pair SD) | Rejected before | Rejected after | Flagged inconclusive after |
  |---|---|---|---|---|
  | 0 (400 trials) | 5% (≈ 7%, above half the limit) | 13.3% | 0.0% | 46.5% |
  | +12% (200 trials) | 5% | 100% | 82.0% | 18.0% |
  | +15% (200 trials) | 2% | 100% | 100% | 0% |

  The price is power: a noisy guardrail that really regresses is sometimes flagged instead of rejected, never silently passed.

### Guardrails: calibration, views, messages, report

- **Calibration.** Every strategy measures each guardrail: the A/A per-pair noise and CI half-width at `n_max` (noisy), the per-run σ and the half-width for k confirmation runs (expensive), the repeat difference (deterministic). The report gains a line per guardrail ("mem_kb: noise 1.99% per pair (A/A), CI half-width 0.76%: rejected beyond about 9.8% worse, ok below about 8.2% worse, inconclusive in between"). A guardrail whose half-width reaches its limit raises a calibration **warning** (not a failure): it can never be shown within the limit. The worst bench host decides, as for the MDE. Results are stored in the calibration report (`guardrails`, `warnings`) and the segment's `details_json`; verdicts read the segment's guardrail noise.
- **Views.** `guardrailStatus` (views.ts) checks the step and the total with the same rule as the verdict and returns both checks with their headroom; the label says when only the total is the problem ("BROKEN (total)", "inconclusive (total)"). Components only display it: the candidate list's guardrail column, the candidate detail's metrics table (step and total with CIs), and the Overview's best-vs-base position against the total limit, with the room left and the number of promotions compounded. The Oracle tab shows each guardrail's noise and any warning.
- **Messages.** Verdicts carry, in the agent-only detail, both checks with their CIs and the headroom left now; the human line names a broken or flagged guardrail only. Strategist digests and worker briefs carry the headroom per guardrail; the digest's summary line mentions a guardrail only when less than a fifth of its total limit is left.
- **Report and harvest.** The study report has a Guardrails section: best's position with CI, headroom, every promotion's step, the wins a guardrail rejected and the promotions it flagged, and the calibrated noise. Harvest's base-vs-best and ablation measurements already had guardrail samples; they are now kept (`harvests.total_guardrails_json`, `changesets.guardrails_json`), so the report also gives best vs base measured directly next to the verdicts' compounded estimate, and each changeset's cost to each guardrail.

### Pre-release fixes

- **Snapshots and build outputs.** `[scope] ignore` lists untracked build outputs and caches the worker snapshot never commits, gitignore-style: a pattern without a slash matches at any depth, a leading or inner slash anchors it at the root, a trailing slash means a directory. Defaults: `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/`, `node_modules/`, `dist/`, `build/`, `target/`, `.DS_Store`, `coverage/`, `.coverage`, `.nyc_output/`, `htmlcov/`; setting the key replaces them, `[]` turns it off. The snapshot stages tracked changes with `git add -u`, then untracked files with exclude pathspecs, and reports what it left out (the submission ticket says so). Changes to tracked files under a pattern always commit. A candidate that still adds a matching file (the worker committed it itself) is `rejected` with what to do (`git rm -r --cached`, or ask the human to change the list). Calibration warns when the base tracks files that match (a `build/` of sources, say), because new files next to them would be left out. Not part of the oracle hash.
- **New study.** The Studies page opens bb's own new-thread composer (`experimental_NewThreadComposer`) in a dialog, seeded with the study-create prompt and a project: the route's project, else the project of the most recently updated active study (only if it still exists), else none. The plugin spawns the thread from the composer's request and opens it. Before, `toCompose` took no project and opened with "No project".
- **Archive with the thread.** The archive dialog has "Also archive the study thread" (on by default); `study.archive` takes `archiveThread`, the CLI `--archive-thread`. The study thread is archived and stopped after the study, recorded as `study_thread.archived`; asking again on an archived study archives just the thread. Worker threads were already archived.

### Data model

Append-only migrations: `harvests.total_guardrails_json`, `changesets.guardrails_json`. A decided candidate's `metrics_json` gains `guardrailCi` (per guardrail: lo, hi, n) and `guardrailJudgement` (the step and total checks, best's prior position, the text). The calibration report and segment details gain `guardrails` and `warnings`. New event: `study_thread.archived`; `control.archive` records `archiveThread`; `candidate.submitted` records how many files the snapshot left out.

### Smoke test (BB 0.45, one MacBook, toy repo under /tmp without a `.gitignore`)

- **Toy.** `src/toy.py` with a naive `slow_sum`, recursive `fib`, and a `dedupe` built on a linear `contains()` and a `bubble_sort`; a gate test; the primary metric `ops` (opcodes of `toy.run()` counted with `sys.settrace`, 0.5% synthetic noise). The guardrail `mem_kb` is a synthetic memory model that creeps with every win: it grows by about 7% per halving of ops, plus 1.2% per-run noise. Limits: 9% per step, 12% in total. Noisy class, `max_workers = 2`, `max_candidates = 6`, local bench, default provider (pi).
- **Calibration** (after one A/A attempt failed the existing equivalence check by chance: median 0.48%, CI 0.42% to 0.87%): ops noise floor 0.83% per pair, MDE 1.00%; "mem_kb: noise 1.99% per pair (A/A), CI half-width 0.76%: rejected beyond about 9.8% worse, ok below about 8.2% worse, inconclusive in between".
- **Verdicts.** Five wins and one guardrail rejection, 68.5% fewer ops (3.2×) in a few minutes of Running:

  | Candidate | Primary | mem_kb step vs best (CI) | mem_kb vs segment base (CI) | Outcome |
  |---|---|---|---|---|
  | c/1 set-based dedupe | +38.8% | 5.1% worse (4.4 to 5.8) | 5.1% | win |
  | c/2 `sorted()` | +61.1% | 9.8% worse (8.4 to 10.9): inconclusive | 15.4% (13.7 to 16.9): beyond 12% | **lose on the total limit** |
  | c/3 closed-form sum | +9.3% | 0.1% better | 5.0% | win |
  | c/4 iterative fib | +28.5% | 3.0% worse | 8.1% | win |
  | c/5 data as a constant | +2.8% | no change | 8.1% | win |
  | c/6 guardrail-aware sort | +18.4% | 1.9% worse (0.6 to 2.6) | 10.1% (8.0 to 13.0): inconclusive | **win, flagged** |

  The c/6 worker read the headroom in its brief ("only ~3.5% headroom left") and kept a cheaper bubble sort instead of `sorted()`. After c/2 the strategist, whose digest carried the headroom line, queued micro-optimizations rather than more `sorted()` variants.
- **No build outputs.** Every submission left one or two `__pycache__/*.pyc` files out (recorded on `candidate.submitted`); no candidate ref and no commit on best contained one.
- **Harvest h7** (`--one-per-promotion`): best measured directly 12.1% worse than base on mem_kb (CI 10.6% to 12.9%), against the chain's 10.1% (CI 8.0% to 13.0%); per changeset 6.8%, 1.1%, 5.0%, 1.0%, 2.7%. The model's true value is 12.2%, inside both CIs. The chain underestimated it because noisy small steps were recorded as "no change" (the price of compounding estimates).
- **App.** Screenshots of the calibration's guardrail noise (Oracle tab), the Overview's cumulative position and headroom, the candidate list's guardrail column, the c/2 and c/6 details, the new-study composer with the project preselected, and the archive dialog are in the building thread's storage (`shots/`).
- **Cleanup.** The study was archived from the dialog with its study thread (all eight threads archived); the temporary project, `/tmp` files and the harvest export were deleted. The plugin is left installed from this pass's worktree, disabled.

### Not done, and known issues

- **Power with noisy guardrails.** The chain's CI grows about with √(promotions), so a noisy guardrail's total can stay inconclusive long after the point estimate passed the limit. Flagged, but not rejected.
- **No extra pairs for an inconclusive guardrail.** The sequential test stops on the primary metric; it doesn't keep measuring to settle a straddling guardrail.
- **The chain is an estimate.** It compounds per-step estimates; harvest's direct base-vs-best measurement is the better number when it exists, and the report shows both.
- **Reconciliation** re-checks scope for a crashed submission from its recorded paths, without the added-files list, so the ignore rule isn't applied there.
- **The composer's "current project"** falls back to the latest active study's project because the Studies panel isn't a project route; with no active study the human picks it.

## v0.1.0: human interface

A pass after M3 over every human step, with no new engine features. Same platform pins (BB 0.45.x, SDK 0.6.14). It started with a walk through the whole journey in the BB app on the M3 code, logging every confusing moment, dead end and forced trip to the CLI (18 of them, from "three different signs for the same number" to "approval needs a terminal"), and ended with the same journey on the new code.

### One way to express improvement

- **The convention (`src/present.ts`).** An improvement is a fraction relative to a reference, **positive = better in the metric's own direction**. It is written signed where space is short ("+74.7%", tables, the chart axis, the badge) and in words where it is the headline ("74.7% fewer ops (4.0×)", "12.0% higher throughput", "3.1% higher p99 (worse)"). Counts get "fewer/more", other metrics "lower/higher". A factor is added from 1.5× up. The raw values travel with it ("210,802 → 53,300 opcodes").
- **Magnitudes are unsigned.** Noise floor, MDE, guardrail limits and CI half-widths are magnitudes ("1.00%"), never signed; a CI is always written low to high ("CI +73.7% to +75.6%").
- **Everywhere the same.** The Overview cards, chart, candidates, findings, verdict messages, strategist digests, notices, PR bodies, the report and the CLI all use these helpers; the only raw relative-to-best numbers left are in `--json` output and one "for the record" line in PR bodies and the report.
- **Harvest contributions are shares of the gain.** Ablation measures each changeset relative to best, which makes terms additive but huge after big wins (+128,672% on the before toy). The page, CLI, PR bodies and report now show each contribution as its **share of the base→best gain** with the CI as shares ("81.3% of the gain (CI 81.0% to 81.6%)"), in points of the headline ("81.3 of the 99.9 points") and in metric units ("≈ 171,548 fewer opcodes"). The accounting reads "Explained by the changesets 100% ± 0.3%" and "Unexplained 0.2% (noise allows ± 0.6%)".
- **Two view-model fixes for higher-is-better metrics.** Compounding promoted effects used 1 − Π(1 − e), which is right only for lower-is-better; higher-is-better now uses Π(1 + e) − 1 (`compound`). Harvest's relative-to-base total used t / (1 + t); for higher-is-better it is t / (1 − t) (`vsBaseFromVsBest`). Neither changes a verdict: they only affected displayed best-vs-base numbers and notices. The stored `total_vs_base` column is no longer read.

### The study page

- **Hierarchy.** The header gives the state, a one-sentence status ("Running: 2 workers editing, measuring c/4.") and a "needs you (n)" chip. The Overview leads with **Needs you**, then best vs base (in words, raw values, CI), Now (workers and queue), Budget; then the trajectory, live workers and bench queue (only while there are any), secondary metrics, controls, bench hosts, notices, and a collapsed event log. A draft shows no running-state clutter.
- **Needs you (`needsYou` in views.ts).** Derived from state on every read, so it can't go stale: a draft spec to approve, a failed calibration (with the problems and "ask the study thread to revise the spec"), a finished calibration to approve, a pending spec, a system pause (budget exhausted → harvest; drift or broken oracle → Bench, then resume), a bench host unhealthy or offline past its grace period, a harvest ready for review, a failed harvest or publish. Alerts sort first. Each item has the in-app action that resolves it and the CLI equivalent. A pause by the human needs nothing.
- **Badges.** The nav panel's `experimental_sidebarAccessory` shows the number of needs-you items across studies (`studies.attention`); the study list marks each study; the study thread's header badge leads with the count and the first item ("draft · needs you: approve spec"). Notices count as new until the human has had the Overview open for 3 s (`study.notices.seen`, new column `studies.notices_seen_at`); the human's own control notices are an audit trail and never count.
- **Notices name their action.** Every notice text was rewritten to "what happened. Next: what to do (where, or the CLI command)". `noticeAction` maps each kind to a tab and a label ("Review calibration and start", "Start harvest", "Open Bench"), and the Overview shows that button next to the notice; control notices fold into "Audit trail: n human controls".
- **Inline help.** A "?" next to each statistical term opens one or two sentences (`GLOSSARY`): improvement convention, CI, MDE, noise floor, calibration, ablation, dependency edge, stack, standalone, droppable, unexplained, guardrail, drift, holdout, segment, utilization.
- **States.** Every tab has a layout-keeping skeleton while loading, an error line with Retry, an empty state that says what will fill it, and keeps the last data while refetching (no flicker). The status line reserves its height; the chart's hover card has a fixed position.
- **Tabs.** Oracle: approval buttons, MDE explained as "a win must improve by more than 1.00% with confidence (in practice changes of about 1.27% or more are detected)", the segment marked "awaiting your approval" until calibration is approved. Ideas: veto with an inline reason form (`window.prompt` doesn't exist in the desktop app, so veto was broken there), pinned shown in words, read-only when archived. Candidates: an Improvement column, CIs in order, a guardrail column, and in the detail a metrics table of every recorded metric. Findings: counts on every facet (outcome, theme including "no theme", verdict including "no candidate"), a finding's idea falls back to its candidate's idea, paging by 50. Bench: host names everywhere and the latest health check of each host marked.

### Secondary metrics and guardrails

- **One status function.** `guardrailStatus` in views.ts is the only place the UI decides a guardrail's state: pass, warn (more than 80% of the limit used), broken, or missing, with a text that carries the state without color. It takes values and limits (and prefers the regression the verdict recorded), and already has slots for a CI and a cumulative limit against the segment base, so the follow-up that adds `max_total_regression` and CI-based guardrail decisions can fill them without touching components. Verdict semantics are unchanged. *(Filled by the guardrails pass: cumulative position, CI, an inconclusive state and headroom; see below.)*
- **Where it shows.** The candidate detail has a metrics table (primary, guardrails with limit and status, informational metrics with a raw change and "no direction"); the candidates list has a guardrail column ("ok (1)", "rss near limit", "rss BROKEN"); the Overview shows each secondary metric of best against the segment base, the guardrail's position against its limit as a bar plus a word, the worst single promotion, and a small trend of best's value after each promotion.

### In-app actions (decision 1)

- **RPC.** `study.spec.approve {slug, version, confirm}` (draft: approve and calibrate; pending, oracle unchanged: apply; pending, oracle changed: approve and recalibrate), `study.start {slug, confirm}` (only from a finished calibration), `study.harvest.plan` (read: remote, URL, each branch → base, skips, and whether the preflight passes), `study.harvest.publish {slug, harvestId, confirm}`, `study.harvest.choice` (keep or drop a changeset nothing builds on), `study.archive {slug, confirm}`, plus `study.harvest.start` gained `onePerPromotion`.
- **Deliberate.** Without `confirm: true` each refuses with what it would do ("confirmation required: this pushes 3 branch(es) of harvest h1 to origin and opens draft PRs on GitHub…"). Approval names the version the human reviewed; a stale page is refused. Plugins are refused as callers. Every action is a `control.*` event and a notice; a refused publish is audited too, kept on the harvest (`publish_state = failed`, the error), and becomes a needs-you item.
- **Dialogs.** Each action's dialog states exactly what happens and shows the CLI equivalent. Publish loads the plan first, lists every branch and the draft PR it opens, and disables the confirm button with the reason when the preflight fails. Results (PR URLs, push or `gh` errors, skipped ones) stay on the Harvest tab.
- **Dropping a changeset.** A droppable changeset gets Keep/Drop; a dropped one is skipped when publishing (new column `changesets.human_choice`). A changeset that others build on can't be dropped.
- **CLI unchanged.** `calibrate`, `approve`, `start`, `harvest --publish` and `archive` behave as before and are audited the same way.

### Harvest review

- Each changeset shows its title, the contribution as above, the dependency explanation in words ("Reverting this from best conflicts with #6 (in src/toy.py), so it can't be measured alone…", "Builds on #1 and #3…", "Ships in stack 1 (#1 → #3 → #6), as a PR stacked on #3"), the standalone result in the convention, the PR base in words (no more "base base"), the PR body rendered with the host `Markdown` component, and the keep/drop choice.
- A progress line shows the phases. A small gap beyond the noise (within 2× its CI half-width, common with bootstrap CIs at n ≈ 20) is an info callout that says so; a large one or an unmeasured term is an alert.
- Fallback rationale says why: "Promotion c/1 as its own changeset (one changeset per promotion, as you asked)".
- With zero promotions the start button is disabled with the reason next to it.

### Study thread messages (decision 2)

- **Agent-only detail.** `threads.send` input blocks accept `visibility: "agent-only"` (SDK 0.6.14, `promptInputSchema`). Verdicts, strategist digests and the harvest grouping round are now an `AgentMessage`: a one-line summary the human sees, and the full detail as an agent-only block. Live check: the human timeline showed only "[autoresearch] Verdict for c/2: WIN: promoted to best, 62.9% fewer ops than best (CI +62.6% to +63.3%)." and the worker still quoted the medians and guardrail from the hidden detail.
- **Summaries.** A strategist round reads "[autoresearch] Strategist round 2 (new verdicts): 5 new verdicts (4 win, 1 inconclusive), best now 98.8% fewer ops (82×) vs base · 3 ideas queued · 1 worker · 9 notices for you on the Studies page." The digest asks the strategist to answer the human in two or three short lines.
- **Tool results** (a scope rejection, the submission ticket) stay one text, since a tool result has no visibility.

### CLI

- `--json` on every command, one JSON document from the same view models as the page; errors use the SDK envelope with a `hint` that names the command to run next.
- New `bb study needs [slug]`.
- `list` is a table with a NEEDS YOU column (active studies first), `show` gains a Needs you section, `harvest` prints shares, explanations and PR bases in the page's words. Same numbers and wording as the UI.

### Accessibility and theming

- The tabs are a WAI-ARIA tablist with roving focus (arrow keys, Home, End). Every control has a visible focus ring and an accessible name; chart marks are focusable and open their candidate.
- Color never carries meaning alone: verdicts carry a glyph and a word, chart marks differ by shape (● win, × lose, ○ other), guardrails and health checks carry words.
- **Theme tokens only.** Tailwind `dark:` variants in a plugin bundle compile to `prefers-color-scheme`, so they follow the OS, not BB's theme (a light BB theme on a dark OS rendered light-on-light text). All `dark:` variants were removed in favor of host tokens (`text-success`, `text-warning-text`, `bg-warning/10`, `text-destructive`, `bg-muted`). Light theme was checked by switching the tab's root class to `light` (screenshots), not through BB's settings.
- New vendored components from the BB registry (desktop-v0.45.0): `dialog`, `popover` and their support files; `@radix-ui/react-dialog` and `-popover` are type-only dev dependencies at the host's range.

### Data model

Append-only migrations: `changesets.human_choice`, `studies.notices_seen_at`. New events: `harvest.choice`, `harvest.publish_refused`; new control kinds `control.harvest_choice` and the in-app `control.calibrate|approve|start|publish|archive`; new notice kind `harvest.published`.

### Usability check (BB 0.45, one MacBook, toy repo under /tmp)

The same toy as M3 (`src/toy.py`, opcodes counted by the protected `bench/measure.py` with 0.5% noise), with a guardrail `src_lines` (≤ 30% worse per promotion) and an informational `wall_ms`; `max_workers = 2`, `max_candidates = 5`, local bench. Clicks were driven through the in-app browser; times are wall time from the action to the next state.

| Step | Before (M3 code) | After |
|---|---|---|
| Create (study-create conversation) | no entry point; a typed request; 87 s to a draft | New study (1 click, prompt prefilled) + project (2) + send (1); 23 s to a draft |
| Find the study | sidebar → Studies → row | the thread's header badge ("needs you: approve spec"): 1 click |
| Approve the spec and calibrate | CLI `bb study calibrate` (twice: the first calibration failed on laptop load, visible only below the fold) | Needs you → Approve and calibrate… → confirm: 2 clicks; 3 s to ready |
| Seed ideas | Ideas tab, 2 ideas | Ideas tab + 3 adds: 4 clicks, 7 s |
| Steer (reorder, veto with reason, unpin, concurrency and back, pause, resume) | veto used `window.prompt`, absent in the desktop app | 8 clicks plus typing, all in-app |
| Approve calibration and start | CLI `bb study start` | Approve and start… → confirm: 2 clicks (+1 for the tab) |
| Run to the budget | 140 s | 122 s |
| Harvest (dry run) | Harvest tab button; 33 s | Needs you → Start harvest… → confirm: 2 clicks; 27 s |
| Review changesets | "+128,672%" next to "−99.9%", "base base" | shares, points, units, dependency text; Review harvest: 1 click |
| Publish | CLI only, no preview | Publish draft PRs… → plan with the refusal ("no remote named origin"), confirm disabled; Cancel: 2 clicks |
| Archive | CLI only | Archive… → confirm: 2 clicks; 2 s |

Main path after: 21 clicks and no trip to the CLI (before: five forced CLI trips). Screenshots of every tab and flow, before and after, are in the building thread's storage (`shots/before`, `shots/after`, `shots/after-same-data` for the before study re-rendered by the new code).

### Remaining friction and not done

- **New study composer.** It opens with "No project" selected and placeholders to edit; `toCompose` takes no project, so the human picks it (2 clicks). *(Fixed in the guardrails pass.)*
- **Audit alarms for the human's own controls.** In-app controls used while workers run are flagged as "made while study agent turns were running", and the strategist relays that ("if that wasn't you…"). That is the threat model working (RPC can't identify the caller), but it reads as an alarm after ordinary steering.
- **Old notices keep their old text.** Texts are stored; only notices raised after this pass follow the new wording.
- **Archiving a study leaves its study thread** (the conversation) unarchived; the human archives it like any thread. *(Fixed in the guardrails pass: an option, on by default in the app.)*
- **Interaction warnings** still rest on bootstrap CIs that undercover at small n; the info callout only softens the wording.
- **Light theme** was checked by switching the root class in the browser tab, not by changing BB's theme setting; real light-theme contrast with a custom palette is untested.
- **The creating agent** in the live run still listed CLI next steps (from the old `study_propose` result text, fixed after the run) and the updated skill wasn't re-run live.

## v0.1.0: M3, harvest and operations

What M3 added, and every place it differs from the design or from M2. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Harvest

- **Lifecycle.** `bb study harvest <slug>` (or the Harvest tab's dry-run button) moves Running or Paused to **Harvesting**. `bb study resume` is "keep exploring" (back to Running; a harvest still in progress is cancelled, a ready one stays for review). `bb study archive` ends the study and cancels a running harvest. A new harvest after a ready, failed or cancelled one needs `--restart`.
- **Waiting (decision).** Harvest doesn't cancel anything. While Harvesting no worker spawns, submissions are refused with "record a finding, then finish", and the pipeline still finishes candidates already in flight. Only then is best frozen (`base_sha`, `best_sha`, and the promotion list from `git rev-list --first-parent base..best`, mapped to candidates by the `Autoresearch-Candidate` trailer).
- **Grouping.** The plugin sends one strategist turn, `[autoresearch] Harvest h<N>`, listing the promotions (candidate, idea, effect, files). `study_propose_harvest` now validates against that list: every promoted candidate in exactly one group, unknown or duplicated numbers rejected with the reason so the strategist can retry; promotions it leaves out get a changeset of their own. Fallback, one changeset per promotion: when the study thread is missing, when its turn ends without a valid proposal (after `harvestGroupGraceMs`, 60 s), after `[harvest].group_timeout_minutes` (10), for a single promotion, or on request with `--one-per-promotion` (deterministic, no strategist turn). Changesets are ordered by their earliest commit on best.
- **Git without checkouts.** A new host op `composeCommits` replays or reverts a list of commits onto a commit with one `git merge-tree` per step and returns one commit (or the conflicting step and paths). `commitLog` lists first-parent commits with their paths. Ablation commits, standalone commits and probes are dangling commits in the project repo; only the PR branches get refs.
- **Ablation.** For each changeset S: revert S's commits from best (newest first), run the gates on the edit host, then measure best-without-S against best on the first online, healthy bench host with the study's noise-class protocol under the bench lock. For `noisy` the full `n_max` pairs run (no early stop: harvest needs an estimate, not a decision). The **contribution** is how much worse best gets without S, relative to best: `−effect`, CI flipped. The **total gain** is measured the same way, with the base as the "candidate", so every term is on the same scale and they add. The report also gives the total relative to base (`t / (1 + t)`).
- **Scale (decision).** Contributions are relative to best, not base, because that is what ablation measures and it makes them additive. After big wins the numbers get large: on the toy, best is a quarter of base, so the total is +291% relative to best (−74% relative to base). The Harvest tab and report show both.
- **Droppable.** A measured changeset whose contribution CI reaches zero (for `deterministic`, not above `tolerance`) is flagged droppable; the human decides.
- **Dependencies (decision, changed during the smoke test).** A revert conflict or gate failure means a later changeset depends on S. Which one is found with git probes: revert S together with every later candidate (those sharing files with S, else all later ones); if that works, a candidate T is a dependent when keeping T in place makes S's revert fail again. Gate failures run the gates for each probe. If the failure can't be isolated (it fails even with all of them reverted, or no single one is to blame), every candidate is treated as dependent, because stacking is always safe. The first version attributed by shared file paths; on the one-file toy that stacked all six changesets together (harvest h2 below), so path overlap is now only the pre-filter.
- **Stacks.** Dependency edges are grouped into connected components; each component is one **stack**, linearized in best order. A stack with a member that couldn't be ablated alone (conflict or gate failure) is ablated as a whole, and that joint contribution stands in for its members in the sum. A stack covering every changeset is the base itself, so it reuses the total measurement instead of measuring the same thing twice (h2 measured it twice and the two bootstrap CIs disagreed enough to raise a false interaction warning).
- **Standalone check.** Each changeset is applied to its PR base: the segment base for an independent one, the previous layer's commit for a stacked one. Gates always run; the effect against the PR base is measured unless `[harvest].measure_standalone = false` or `--no-measure-standalone`. An independent changeset that doesn't apply to the base reveals an earlier dependency (found with the same probes, forward); the plugin adds the edge, restacks, and checks again.
- **Accounting.** Sum of contributions (independent changesets, stack members when all were measured, otherwise the stack's joint ablation) vs the total gain. The gap's CI half-width is the root sum of squares of the terms' half-widths and the total's (independent errors). An **interaction warning** is raised when |gap| exceeds it, or when a term could not be measured at all. Small-sample bootstrap CIs of the median undercover, so expect occasional false warnings at `n_max` ≈ 10.
- **PR drafting.** Drafting creates one local branch per changeset, `studies/<slug>/harvest/h<N>/<kk>-<title>`, whose tip is its standalone commit. Each commit message carries `Autoresearch-Study` and `Autoresearch-Changeset` trailers. A stacked branch sits on the branch below it. The PR body has:
  - what (the promoted candidates' summaries and their effects when promoted) and why (the group rationale);
  - the ablation contribution with CI and n, and the droppable flag;
  - the standalone effect on its PR base;
  - depends-on and needed-by;
  - linked findings;
  - a study link (`bb.server.experimental_appUrl` when configured, otherwise the page path).
- **Publishers (`src/publisher.ts`, behind `PrPublisher`).**
  - `dry-run` is the only mode harvest itself runs. It writes `report.md`, `prs/<kk>-<title>.md`, and `manifest.json` through a new `writeExport` host op under `<dataDir>/exports/<slug>-harvest-h<N>/` on the edit host. Nothing is pushed.
  - `github` runs only through `bb study harvest <slug> --publish` on a **ready** harvest (decision: always review a dry run first). It is CLI-only, like approval: the RPC can start dry runs but cannot publish. *(Superseded by the human interface pass: the Harvest tab publishes behind a confirmation that lists every branch, remote and draft PR.)*
  - The `github` publisher refuses when the flag is missing, when the repo has no remote named `[harvest].remote` (default `origin`), when that remote isn't GitHub, or when `gh` is missing. Otherwise it pushes each branch and runs `gh pr create --draft`, with stacked PRs based on the branch below. A failed push skips the PRs stacked on it.
  - It was tested against a mock `gh` only; no PR was ever opened.
- **Report (`src/report.ts`, `bb study report`, `study.report`).** Trajectory table, wins, notable losses with their reasons and findings, the dossier, calibration and segments, drift checks, and the latest harvest (changesets, stacks, droppable, the sum-vs-total section). It never reads holdout data: a test checks the report and the new views for the holdout command and numbers.
- **Reconciliation.** Every phase persists per-changeset results; a plugin restart resumes a harvesting study's harvest where it stopped.

### Budgets and provider usage

- **What the SDK exposes (investigated).**
  - `turn.failed` carries `errorInfo.category` and the provider's `rateLimits` (windows with `resetsAtMs` and status).
  - `bb.sdk.threads.retry({ sendAt })` queues a retry on the clock.
  - `bb.sdk.system.usageLimits()` returns each provider's subscription windows (`usedPercent`, `resetsAt`).
  - **Per-thread tokens are readable:** the latest `thread/tokenUsage/updated` event (`bb.sdk.threads.events.list`) has cumulative `totalTokens`. Dollar cost per thread is not exposed.
- **Rate limits.** A rate-limited turn of a worker or of the study thread is retried at the latest blocked window's reset plus 15 s (or now + 1 min × attempt when no reset is known), at most `agents.max_rate_limit_retries` (3) times per thread. Then the plugin gives up with a notice, and an idle worker is later abandoned. The study records `rate_limited_until`; until then no new worker spawns (W shown as 1).
- **Usage windows.** Usage windows are read every 2 min for the providers the study's threads use. A window at or above `agents.usage_tight_percent` (90) halves W, recorded in the `scheduler.target` event. On the smoke-test machine `usageLimits` returned no providers (the default provider, pi, reports no windows), so this path is unit-tested only.
- **Tokens.** Each live thread's total is read at most once a minute and once more when a worker ends. Study tokens are the workers' totals plus the study thread's growth since its first reading after start. `budget.max_tokens` (optional) is enforced like the other limits, and tokens per win show on the Overview, in `bb study show`, and in the report.
- **All limits.** `max_candidates`, `max_bench_hours`, `deadline`, and `max_tokens` pause the study when reached and propose a harvest (decision: the design's lifecycle allows "budget exhausted → Harvesting"; the plugin pauses and asks, because harvest spends bench time). `budget.notify_at` (50 and 80 by default) raises one notice per dimension per threshold, the deadline counting time from the first start. The Overview projects the bench time the remaining candidate budget would take at the calibrated cost per evaluation. Harvest bench time counts toward the bench budget but is never blocked by it.

### Notifications

- **One mechanism.** M1's notices: a row in `notices`, the study page and `bb study show`, `markUnread` on the study thread (unless quiet), and the text in the next strategist round. Kinds:
  - `best.new`;
  - `stall` (quiet; the stall round itself follows);
  - `budget.threshold` and `budget.exhausted`;
  - `oracle.broken` (best fails to build or measure, the holdout fails on best, best can't be sent to a bench host) and `drift`;
  - `rate_limit` and `usage.tight` (quiet);
  - `harvest.ready` and `harvest.failed`;
  - plus M1/M2's calibration, bench health, offline, spec and `control.*` notices.
- **No push.** The SDK has no notification, push, or Slack API for plugins. `bb.sdk.system.attention()` only reads the global flag, and `threads.send` always starts or steers a turn. The unread study thread is what reaches the human, plus the Studies list's "new" count.

### Human surface

- **New tabs (data from `src/views.ts` view models over RPC).**
  - **Findings:** search, outcome, theme, and verdict filters; links to candidates and worker threads.
  - **Oracle:** the active spec as TOML with `[oracle.holdout]` removed (agents can call RPC), version history, calibration report per host, segments, and a pending spec with its line diff and the CLI command that approves it. Approval stays CLI-only. *(Superseded: see the human interface notes.)*
  - **Bench:** hosts, queue, utilization, health-check history, drift checks, bundle transfers, recent bench intervals, and flaky and failed gate counts.
  - **Harvest:** state, total, sum, gap and the interaction warning, changesets with ablation, standalone, dependencies, stack, PR branch and expandable PR body, stacks, the export dir, the publish command (no button), history, an on-demand report, and a dry-run start/restart button.
  - **Overview:** a provider-usage line and a Harvest link.
- **New RPC.** `study.findings`, `study.oracle`, `study.bench`, `study.harvest`, `study.report`, and the audited control `study.harvest.start` (dry run only).
- **CLI.** `bb study harvest [--wait] [--restart] [--one-per-promotion] [--no-measure-standalone] [--publish]` and `bb study report`. `show` gains a Usage line (tokens, tokens per win, rate limit, usage window, projected bench time) and the harvest line.
- **Skills.** `skills/study-harvest` from the integration map wasn't added: the grouping round's prompt carries the instructions, and the `autoresearch` skill documents harvest, budgets and limits.

### Spec additions

- **Budget:** `budget.max_tokens` and `budget.notify_at`.
- **Agents:** `agents.max_rate_limit_retries` and `agents.usage_tight_percent`.
- **Harvest:** a new `[harvest]` section with `measure_standalone`, `group_timeout_minutes`, and `remote`. None of these are part of the oracle hash.

### Data model

M3's migrations are append-only:

- new tables `harvests` and `changesets`;
- `harvest_proposals.harvest_id`;
- `threads`: `tokens`, `tokens_base`, `tokens_at`, `provider_id`, `rate_limit_retries`;
- `studies`: `rate_limited_until`, `usage_json`, `usage_at`, `budget_notices_json`.

New events:

- harvest: `harvest.started`, `.phase`, `.frozen`, `.grouped`, `.grouping_fallback`, `.total`, `.ablation`, `.dependency`, `.standalone`, `.drafted`, `.ready`, `.failed`, `.resumed`, `.publishing`, `.published`;
- usage and budget: `turn.rate_limit_gave_up`, `usage.tight`, `budget.threshold`;
- controls: `control.harvest` and `control.publish`.

### Hermetic tests (fix from the M2 review)

The M2 end-to-end test failed on a loaded laptop because `LocalHostRunner` probed the real machine: at load 6 the health policy deferred the measurement. `LocalHostRunner` now takes an injected health probe, and every test uses `localRunner()` from `test/helpers.ts`, which returns fixed healthy readings and counts probes. Fixed sleeps and short polling loops in tests were replaced with bounded condition polling (`waitFor`, 10 s), including one test that relied on an 80 ms timing window. The full suite (17 files, 169 tests) passed three times in a row at load average 4.5–6.

### Smoke test (BB 0.45, one MacBook, toy repo under /tmp)

- **Toy.** `src/toy.py` has `slow_sum`, a naive `fib`, and a `dedupe` built on a linear `contains()` scan and a `bubble_sort`. The metric is the Python opcodes executed by `toy.run()` plus a fixed workload, counted with `sys.settrace` in the protected `bench/measure.py`, with 0.5% synthetic Gaussian noise, so the `noisy` protocol (real CIs) runs on a deterministic count. The gate is `bench/test_toy.py`. Calibration: noise floor 0.96%, MDE 1.00%, 0.9 s per evaluation, local bench.
- **First attempt (`toy-m3`, discarded).** The repo had no `.gitignore`. Workers ran the tests, the snapshot's `git add -A` committed `src/__pycache__/*.pyc`, and two candidates got `conflict` verdicts on the binary. That is a real usability issue (below). The study was archived and the toy got a `.gitignore`.
- **Study `toy-m3b`.** Settings: `max_workers = 2`, `max_candidates = 6`, default provider pi. Study thread `<thread>`; workers `<thread>`, `<thread>`, `<thread>`, `<thread>`, `<thread>`, `<thread>`.
  - All 6 candidates won: 4 human-seeded ideas (set membership, iterative fib, `sorted()`, closed-form sum) and 2 strategist ideas (items via `map`, `sorted(set(items))`).
  - Best vs base −74.4% (measured) after about 3 minutes of Running.
  - The candidate budget ran out: the study paused itself with "harvest them with `bb study harvest`".
  - Tokens: 295,901 in total (about 24k per worker, 149,883 for the study thread since start), so 49,317 per win.
  - Notices: `best.new` ×6, `budget.threshold` ×2 (50% and 80% of candidates), `budget.exhausted`, `harvest.ready` per harvest, `control.*`.
- **Harvest h1 (strategist grouping).**
  - The study thread answered with `study_propose_harvest`, grouping the three dedupe promotions (c/1, c/3, c/6) into one changeset next to fib, sum, and items: 4 independent changesets, no edges.
  - Total +292.57% (CI +291.34..+294.78%) relative to best; sum of contributions +291.05% ± 1.62%; gap +1.52% (half-width 2.36%): they add up.
- **Harvest h2 (`--one-per-promotion`, first dependency code).** Path-level attribution put all six changesets into one stack (one file). The stack's separate measurement of base vs best gave a false interaction warning (gap −2.78%, half-width 1.52%). Both issues were fixed as described above.
- **Harvests h3 and h4 (`--one-per-promotion`, final code).**
  - Reverting c/1 or c/3 from best conflicts in `src/toy.py`; the probes isolate c/6 as the dependent of both. That gives **edges #6 → #1 and #6 → #3** and a stack `#1 → #3 → #6`, ablated together at +236.9%.
  - The other three are independent:

    | Changeset | Contribution (CI) |
    |---|---|
    | fib | +29.76% (+29.34..+30.08%) |
    | sum | +20.38% (+19.98..+21.36%) |
    | items | +3.65% (+3.14..+3.95%) |
    | #6 | +3.75% (+2.90..+4.67%) |

  - **h4 total** +293.91% (CI +289.32..+296.22%), **sum** +290.68% ± 1.39%, **gap** +3.23% (half-width 3.72%): "The contributions add up to the total gain within the CI." (h3: gap +0.03%, half-width 2.49%.)
  - Standalone effects on each PR base:

    | Changeset | PR base | Effect |
    |---|---|---|
    | #1 | base | +30.65% |
    | #2 | base | +7.25% |
    | #3 | #1 | +42.03% |
    | #4 | base | +4.90% |
    | #5 | base | +0.87% |
    | #6 | #3 | +1.82% |

  - Harvest bench time: 11 s.
  - Six local branches; the stacked ones are chained (`06 → 03 → 01 → base`). The PR bodies and `report.md` were exported, and `--publish` was refused: "the repository has no remote named origin".
- **UI.** All seven tabs rendered in the BB app; there are in-app browser screenshots of Overview, Findings, Oracle, Bench and Harvest.
- **Cleanup.** Both studies and their threads were archived, and the temporary project, `/tmp` files, and toy exports were deleted. The plugin is left installed from the M3 worktree, disabled.

### Not in M3, and known issues

- **Exit criteria on real workloads.** Not run for any milestone (see Status). M3's criterion holds only on a toy with additive effects.
- **GitHub publishing.** Never run against GitHub.
- **Provider limits live.** Neither usage-window W-lowering nor rate-limit retries have been seen live.
- **Snapshots commit build outputs.** `git add -A` in worker worktrees picks up untracked build outputs when the repo lacks a `.gitignore` (the `toy-m3` failure). Scope globs don't exclude them because they sit under `editable`. *(Fixed: `[scope] ignore`; see [v0.1.0: guardrails and pre-release fixes](#v010-guardrails-and-pre-release-fixes).)*
- **Attribution limits.** Dependency attribution is pairwise. A failure that needs two later changesets together to explain it falls back to "all later", and a stack is linearized in best order, so a member can be stacked under another it doesn't depend on (#3 under #1 on the toy).
- **Gate dependencies only.** A changeset that is semantically needed but doesn't break the gates when reverted (no test covers it) is not detected as a dependency.
- **Interaction warnings.** They rely on bootstrap CIs that undercover at small n.
- **Dollar budgets.** Dollar cost per thread isn't exposed by BB, so there are no dollar budgets.

## v0.1.0: M2, remote bench and trust

What M2 added, and every place it differs from the design or from M1. Same platform pins (BB 0.45.x, SDK 0.6.14). Only one BB machine existed while building it, so remote bench hosts are exercised for real against the local machine in clone mode (below), and with fake hosts in unit tests.

### Bench hosts

- **Two modes, chosen by the spec entry.**
  - `"local"` (or an empty list) is the M1 path: plugin checkouts of the project repo on the edit host, no transfer.
  - Any other entry is a BB machine name or host id, resolved against `bb.sdk.hosts.list()` when `study_propose` runs. Unknown or ambiguous names are spec errors that list the known machines. That machine gets **clone mode**, even when it is the server's own machine: this is how the live smoke test took the full remote path.
  - The resolved list is stored per spec version (`spec_versions.bench_json`) and becomes the study's `bench_hosts` rows when that version is approved.
- **Edit host.** Workers, snapshots, gates, and promotion refs stay on the server's machine. Remote edit hosts aren't built.
- **Bench clone.** Each clone-mode host keeps a bare clone per study at `<dataDir>/bench/<slug>/repo.git`, where `dataDir` is the host entry's `experimental_paths.dataDir` (on the test machine, `~/.bb/plugins/bb-autoresearch/host-data/`). Measurement checkouts are worktrees of that clone, `<dataDir>/checkouts/<slug>-bench-{best,cand,drift,profile}`. Every received commit is pinned as `refs/bench/s/<sha>`, and `gc.auto` is off. `bb study archive` cancels the study's jobs, removes the checkouts, and deletes the clone.
- **Per-study clone (decision).** A clone per project would save bootstrap transfers across studies, but a per-study clone can be deleted safely when the study is archived.

### Transfer

- **What a bundle carries.** The edit host bundles the commit minus everything reachable from the bench's pinned tips (newest 4,096) into a temp file. The server relays it in chunks of 4 MiB raw (5.33 MiB base64): under the 8 MiB output cap on `bundleRead` and far under the 32 MiB input cap on `bundleWrite`. The bench checks the sha256, runs `git bundle verify`, fetches, and pins the commit.
- **Size limit.** A bundle above `oracle.max_bundle_mib` (default 256) fails before any chunk moves. For a candidate that's verdict `rejected`, with the size and limit in the reason. For best or the baseline it's a system pause. Failed transfers are recorded too.
- **Bootstrap by bundle (decision).** The first transfer carries the baseline's full history, instead of a `git clone` from origin. That works for repos without a remote and keeps "nothing leaves the machine". A very large repo needs a larger `max_bundle_mib` (open issue below).
- **Promotion.** The promoted commit has the same tree as the measured candidate, so refreshing best on a bench host is a one-commit bundle.
- **Audit.** Every transfer is a row in `transfers` (bytes, chunks, ms) and a `bench.transfer` event. `bb study bench` lists them.

### Long commands, progress, cancellation

- **Host jobs.** Build, gate, each measure run, holdout, and profile run as host background jobs:
  - `jobStart` returns at once.
  - `jobWait` blocks at most 60 s; the server polls every 20 s with a 30 s call timeout.
  - `jobCancel` kills the process group.
  - A running job holds an `experimental_retainWorker` lease, so the host worker's idle stop doesn't kill it.
  - No host call comes near the 30-minute cap. `oracle.timeout_minutes` is per command and may now go up to 1,440.
- **Progress.** A job's last output line goes to the server as a `progress` host signal, at most every 5 s, and also comes back with each poll. The pipeline adds the pair and side, and the Overview shows them on the bench host's row.
- **Cancellation.** Every measurement has an AbortController. Cancelling it cancels the current host job. Three things cancel measurements:
  - an oracle change (the candidate is sent back to the gate);
  - archiving the study;
  - a host worker exit (the measurement restarts).

### Dispatch, caches, calibration

- **Dispatch.** Queued candidates are sorted oldest first. Each goes to the first of its study's bench hosts (in spec order) that is free, online, and not deferred. Each host has its own bench lock, so hosts measure in parallel, one measurement per host.
- **Calibration on every host.** Calibration runs on all bench hosts in parallel. Each host records its own noise floor, MDE, and eval cost. The segment takes the worst host (decision: a win must clear every host's noise), and drift checks compare a host against its own floor.
- **Calibration checks.** Calibration on an unhealthy host fails calibration (decision: a noise floor measured on a disturbed machine is wrong). With a holdout configured, calibration also runs the holdout once per host to check that it works there.
- **Cached best builds.** Each bench host caches its build of best, recorded as `best_build_sha` plus the checkout path in memory. While the cache is valid the checkout isn't touched, so untracked build outputs survive.
  - Every promotion invalidates it on all hosts (`bench.cache_invalidated`).
  - So does reconciliation: a new process doesn't trust the old one's checkouts.

### Health checks

- **When.** The `health` host op runs before every measurement, drift check, calibration, and profile.
- **What it reports.**
  - Load averages.
  - The busiest processes: on Linux from two `/proc` samples 500 ms apart, because `ps` gives lifetime averages there; on macOS from `ps`. Only the host worker itself is excluded: gates on the same machine are real competing load.
  - Linux: the CPU governor, and turbo from `intel_pstate/no_turbo` or `cpufreq/boost`.
  - macOS: AC or battery power, and the pmset CPU speed limit.
  - What the platform can't report is listed as not detectable (on macOS: governor, turbo, and on Apple Silicon the speed limit), not guessed.
- **Policy.** `[oracle.health]` sets per-CPU load, competing-process CPU, an optional required governor, turbo off, AC power, and the CPU speed limit.
- **Deferral.** A failing check leaves the candidate queued in its place. The host waits `retry_seconds` (60). A notice goes out once per unhealthy streak, after `notify_after_minutes` (15).
- **Where it shows.** `bb study show` and `bb study bench` show the last report per host, and `health_checks` keeps the history.

### Drift checks

- **Engine-timed, not a cron schedule (decision).** The design asks for a check every N evaluations, and a `bb.background.schedule` cron can't count evaluations.
- **When.** Every `oracle.drift.every` evaluations per host (default 10, 0 turns it off), the host's next free slot runs an A/A check on best. A drift check takes priority over queued candidates.
- **noisy.** `pairs` pairs of best against a second built checkout of best. The statistic is the robust SD of the paired differences, the same statistic as the calibrated noise floor.
- **expensive.** `pairs` runs of best, compared with the host's baseline as the RMS relative deviation.
- **deterministic.** No drift checks.
- **Result.** Above `max_ratio` (2) × the calibrated level, the study pauses with the numbers in the reason. `bb study drift` requests a check now. Drift runs are kept in `drift_checks`, not as samples.
- **Finding from the smoke test.** Relative noise grows when runs get much shorter. After a 99% speedup, the 6 ms best was 4.9× noisier relative to itself than the calibrated 600 ms baseline. The drift check paused the study, and the fix was an oracle change (more pairs) with recalibration on best: exactly the path the design intends.

### Holdout

- **When.** It runs only for wins (after confirmation, for `noisy`), on the bench host, before promotion.
- **Protocol.** `runs` paired best/candidate runs (default 3). It passes when the median paired change is no worse than `max_regression` (default 1%).
- **"No worse", not "better" (decision).** Genuine wins often help the holdout less than the benchmark, and requiring an improvement would fail them on noise.
- **Outcomes.** A fail is a `lose` with a fixed reason text. A holdout that fails on best itself means the oracle is broken: the study pauses, and the reason carries no output.
- **Secrecy.**
  - The numbers go only to the private `holdout_results` table.
  - The holdout's output is never stored: no samples, DIAG lines, gate output, or progress lines.
  - Verdicts, events, notices, views, and RPC carry only pass or fail.
  - `bb study show` prints "holdout: configured (hidden from agents)", and no view exposes the spec TOML.
  - A test checks every agent-reachable surface for the holdout's numbers, command, and DIAG text.
- **Limits.** The creating agent drafts the spec, so it knows the command. A `local` bench host's holdout files are readable by agents on that machine (see the threat model).

### Guardrails

- **Already enforced since M0.** Guardrails relative to best were enforced in `decideVerdict` for all three noise classes, and inside confirmation: per-pair medians for `noisy`, and the candidate's median against the baseline's for `expensive`.
- **M2 completes them.** The verdict message now carries the deltas, for example "Guardrails vs best: precision_digits 0.20% worse (limit 5.00% worse) ok", or BROKEN. There's a pipeline-level test of a primary-metric win turned into a `lose` by a guardrail.

### Expensive class

- **Calibration.** `calibration_runs` (default 5) baseline runs give σ: the sample SD of the runs around their median.
- **Screening.** Each candidate gets one screening run against the median of the host's m baseline runs. It is promising above max(min_effect, t·σ·√(1 + 1/m)), and a lose below the negative of that.
- **Confirmation.** A promising run gets k = `confirm_runs` (default 3) fresh runs. The screening run is excluded from the decision, because it was selected for looking good. A win needs the k-run mean above max(min_effect, t·σ·√(1/k + 1/m)).
- **t, not z (decision).** t is the one-sided Student-t quantile with `calibration_runs − 1` degrees of freedom. σ comes from a handful of runs, and a normal quantile with a robust σ gave 5.3% false wins in simulation.
- **Simulation** (σ estimated from 5 runs, 4,000 candidates per effect size):

  | True effect | Win rate | Candidate runs per evaluation |
  |---|---|---|
  | 0 | 1.4% | 1.15 |
  | 1σ | 11.5% | 1.57 |
  | 2σ | 39.3% | 2.33 |
  | 3σ | 71.4% | 3.18 |
  | 4σ | 91.6% | 3.75 |

- **Baselines.** The winner's k confirmation runs become the new best's baseline on that host, so a promotion costs no extra baseline run. Another host with no baseline for the new best runs best once.

### Oracle versions and segments

- **The oracle hash** covers the metric, the guardrails, the oracle (commands, protocol, noise class, bench hosts, holdout, timeout) and the protected globs, plus the content hash of the protected paths at the segment baseline.
- **Bench operations aren't part of it (decision).** `[oracle.health]`, `[oracle.drift]`, `max_bundle_mib`, and `offline_grace_minutes` don't change how a commit is judged, so tuning them is not a new segment.
- **A spec revised after the study has run** (`study_propose` from the study thread) is **pending**. The study keeps running on the active spec, and a notice says which approval applies:
  - **Oracle unchanged:** `bb study approve <slug>` applies it in place.
  - **Oracle changed:** `bb study calibrate <slug>` (lifecycle Running → Calibrating) does the following:
    - cancels in-flight measurements;
    - sends queued candidates back to the gate, keeping their queue position;
    - activates the spec;
    - calibrates on the current best on every bench host.
  - `bb study start` then opens segment k+1, with `segments.spec_version` set and `refs/studies/<slug>/segment/<k+1>` pointing at best.
  - Workers keep editing during recalibration. Their submissions are accepted and wait at the gate.
  - If the new oracle fails calibration, the study goes back to the previous spec and segment and pauses, instead of dropping to Draft.
- **"Has run"** is decided from the append-only state log, not from `running_seconds`, which a fast test clock leaves at 0.

### Failure handling, as in the design's table

- **Bench host offline.**
  - BB's host status (`bb.sdk.hosts.get`, cached 15 s) is refreshed every control-loop pass, and offline hosts get no new measurements.
  - A measurement that fails while its host is disconnected restarts from scratch and isn't counted as a pipeline error.
  - The human is notified after `offline_grace_minutes` (10). The study isn't paused: workers keep editing until backpressure stops new spawns.
- **Host worker restart mid-measurement.**
  - `experimental_onWorkerExit` cancels the in-flight measurements on that host.
  - A `jobWait` that answers `unknown`, because the job registry died with the worker, is the same case.
  - The measurement restarts from scratch, and its partial samples are deleted. `measure_restarts` counts restarts; after 6 the study pauses.
- **Plugin restart.** Reconciliation requeues measuring and confirming candidates, deletes their samples, aborts drift checks that were running, and drops build caches.

### Trust

- **Threat model.** The threat model in the [design](design.md#threat-model) is new.
- **Controls are clamped.** `study.concurrency` (RPC and CLI) can only lower `max_workers` below the approved spec; asking for more is clamped, with a message saying so. Idea priorities were already clamped to ±100, and reorders to 200 ids.
- **Controls are audited.** Every control is audited: pause, resume (with the pause reason it cleared), concurrency, the idea board, calibrate, approve, start, drift, and archive. Each is a `control.<kind>` event whose actor is `rpc:client`, `rpc:plugin:<id>`, `cli:human`, or `cli:thread:<id>`, with the study agent turns that were running at that moment. Each also raises a notice. The study thread is marked unread only when an agent turn was running.
- **Approval is CLI-only.** *(Superseded by the human interface pass: approval is also in the app, with the same audit; see the threat model.)* Oracle and spec approval (calibrate, approve, start) exist only in the CLI, and the CLI refuses a study's own worker and strategist threads. The SDK gives no reliable way to tell an agent from a human: RPC callers are all `client`, the CLI thread id comes from the shell environment, and plugin forms can be answered with `bb thread interactions respond`. So approval can't be made impossible from an agent shell, only refused for the cooperative case and audited.
- **Smoke-test evidence.** The audit recorded `cli:thread:<id>` for CLI calls made from the building agent's own thread, and `rpc:client` for a `bb plugin rpc call`.

### Profiles

- **How `study_request_profile` runs.** It runs `oracle.profile` on the first online, non-deferred bench host, under that host's bench lock, after a health check. A candidate profile transfers the commit there first.
- **Bench budget.** Its time counts against the bench budget, and it is refused when the remaining budget can't cover one evaluation.
- **Cap.** It is capped per worker (`agents.max_profiles_per_worker`, default 2).
- **Output.** It returns a bounded summary: DIAG lines first, then the last 60 lines, at most 6,000 characters.

### Human surface

- **Overview.** It gains a Bench hosts section. Each host shows its mode, online status, health with problems and summary, what it's measuring with live progress, the shared queue depth, drift status with evaluations since the last check, the cached best build, and bundles sent. It also shows the current segment and oracle hash, and a banner for a pending spec that says which command applies it.
- **The full Bench/Oracle tabs are M3.**
- **CLI.** New: `bb study approve`, `bb study bench` (transfers, health history, drift checks, segments), and `bb study drift`. `show` gains segment, pending-spec, and bench host lines, and marks the holdout as hidden.
- **Candidates.** Rows carry the bench host and holdout pass or fail.

### Data model

M2's migrations are append-only:

- `studies`: `pending_spec_version`, `prev_spec_version`;
- `spec_versions`: `bench_json`;
- `segments`: `spec_version`, `details_json` (per-host calibration);
- `candidates`: `bench_host_id`, `holdout` (pass, fail, or null), `measure_restarts`;
- `threads`: `profiles`;
- new tables `bench_hosts`, `health_checks`, `drift_checks`, `transfers`, and `holdout_results` (private).

New events: `bench.transfer`, `bench.unhealthy`, `bench.healthy`, `bench.offline`, `bench.online`, `bench.worker_exit`, `bench.cache_invalidated`, `measure.deferred`, `measure.restarted`, `drift.checked`, `drift.requested`, `holdout.checked`, `spec.applied`, `segment.recalibrating`, `segment.started`, and `control.*`.

### Smoke test (BB 0.45, one MacBook, toy repo under /tmp)

- **Setup.**
  - A Python midpoint-rule integration (about 600 ms per run at the start), on a temporary project.
  - Bench host `<host>`, named by its host id, so clone mode on the server's own machine.
  - A holdout script outside the repo (a different interval), and the guardrail `precision_digits` (higher is better, 5%).
  - `max_workers = 2`, `max_candidates = 5`, `drift.every = 2`.
- **Spec v2, no oracle change.** Spec v1 asked for worker permission mode `auto`, which the default provider (pi) refuses. The study thread proposed spec v2 without it, `bb study approve` applied it without recalibration, and `bb study resume` continued.
- **Bundles.** All bundles went to the bench-owned clone `~/.bb/plugins/bb-autoresearch/host-data/bench/toy-m2/repo.git`, a bare repository with no alternates, outside `/tmp/ar-m2-toy`, with checkouts as its own worktrees. Each bundle was one chunk and took about 0.4–0.5 s.

  | Bundle | Size |
  |---|---|
  | Bootstrap (baseline) | 2,136 B |
  | Candidates c/1, c/2, c/3, c/5 | 701, 944, 802, 716 B |
  | Best refreshes | 1,040 and 1,443 B |
  | Segment-2 baseline | 1,173 B |

- **Health.** 7 health checks were recorded, all passing: calibration ×2, measurement ×4, drift ×1. The reports said governor and turbo are not detectable on macOS.
- **Drift.** 1 drift check ran after 2 evaluations. It measured A/A noise 7.96% per pair against the calibrated 1.64% (4.85×, over 6 pairs), and the study paused itself.
- **Oracle change.** The study thread proposed spec v3 (calibration_pairs and n_max 10 → 16), and it went pending. `bb study calibrate` recalibrated on best `8e90d2e` and created segment 2 (oracle `d4aa483b…`, noise floor 3.66%, MDE 2.86%), with `refs/studies/toy-m2/segment/1` and `segment/2` in the repo. `bb study start` resumed in segment 2.
- **Holdout.** It passed on all 4 promotions (c/1, c/2, c/3, c/5; only the private table holds the numbers).
- **Results.** Verdicts were 4 wins and 1 conflict. Best vs base was +99.6% (616 ms → about 2.7 ms).
- **No guardrail-driven `lose`.** Two human ideas meant to trade precision for speed, "10x fewer steps" and "3,000 steps, no extrapolation", were handled by the workers anticipating the guardrail. One used Richardson extrapolation instead and won. The other recorded a `not_attempted` finding ("certain to break the precision guardrail"). Guardrail rejection is covered by unit tests.
- **Audit.** A `bb plugin rpc call autoresearch study.concurrency {maxWorkers: 10}` was clamped to 2 and audited as `control.concurrency` by `rpc:client`.
- **Code version.** The smoke test ran on commit `ed044fe`. The later changes (the expensive class switched to t thresholds, bench tuning moved out of the oracle hash, and a transfer label) don't touch the noisy path it exercised.
- **Cleanup.** The study and every thread were archived, and archive deleted the bench clone. The temporary project and worktree, the `/tmp` files, and the empty bench directory were deleted. The plugin is left installed from the M2 worktree, disabled.

### Not in M2

- **Exit criterion.** "A full day on a remote x86 bench host" wasn't run: only one BB machine exists, and enrolling machines was out of bounds. Multi-host behavior (parallel hosts, per-host dispatch, offline, worker exit) is covered by fake-host unit tests only.
- **Remote edit hosts.** Workers and gates run on the server's machine.
- **Bootstrap without a big bundle.** A very large repo would need a large `max_bundle_mib` or a bench clone from origin.
- **Health tuning.** Health thresholds aren't calibrated per machine: the defaults suit a quiet dedicated host, and a busy laptop needs looser `[oracle.health]` limits.
- **Caller identity.** Approval from an agent shell can't be prevented without caller identity from BB (see the threat model).
- **M3 tabs.** The Findings, Oracle, Bench, and Harvest tabs.

## v0.1.0: M1, parallel

What M1 added, and every place it differs from the design or from M0. Same platform pins (BB 0.45.x, SDK 0.6.14).

### Concurrency

- **Pipeline jobs.** The M0 pump ran stages one after another. M1's `Pipeline.launch()` starts one job per candidate with work and re-runs whenever a job ends. There are three kinds of job:
  - gates run in parallel, at most the study's effective `max_workers` at once, each in its own checkout slot (`<slug>-gate-<k>`), and never take the bench lock;
  - measurement runs as one job per bench lock key (the bench host for `noisy` and `expensive`, host plus study for `deterministic`), oldest `queued_at` first across studies;
  - verdict reports retry every 30 s when delivery fails.
- **A rebased candidate keeps its place in the queue.** A candidate sent back to gating because best moved keeps its original `queued_at`.
- **Submissions are serialized per study.** This keeps candidate numbers dense and unique. Promotions are serialized per study by a mutex, and promotion still compare-and-swaps `studies/<slug>/best`.
- **Retries back off.** Host errors are retried after `retryDelayMs × attempts` (15 s by default) instead of immediately. If best fails to build or measure, the candidate is parked (attempts set to the limit) until the human resumes. Before this, a paused study could retry a broken oracle in a loop.
- **Bench intervals.** Every span the bench lock is held (measurement, profile, calibration) is a row in `bench_intervals`. Utilization, the overlap audit, and the Bench numbers on the page come from it. Reconciliation closes intervals left open by a crash.

### Scheduling

- **Adaptive W.** `W = min(max_workers, ceil(T_think / T_eval) + 1)`:
  - `T_think` is the mean time from a worker's spawn, or from the delivery of its previous verdict, to each submission, over the last 20 submissions.
  - `T_eval` is the mean bench seconds of the last 20 measured candidates. Until one exists, it's the calibration estimate.
  - With no submissions yet, `W = max_workers`.
  - Each change of W is a `scheduler.target` event, and the value is stored on the study.
  - The human can override `max_workers` with `bb study concurrency <slug> <n|auto>` or the page's concurrency control.
  - Lowering W during provider rate limits isn't built.
- **Backpressure.** The bench queue depth counts candidates in `gating`, `queued`, `measuring`, or `confirming`. No worker spawns while that depth is at least W.
- **Budget reservation.** Each live worker reserves one submission against `max_candidates`, so the study never spawns a worker that has no budget left to submit. A submission past the budget is refused.
- **Spawning fills slots.** One control-loop pass spawns up to `W - live` workers. A kick during a pass schedules another pass (M0 dropped it).
- **(a) Finishing race.** Finishing workers count as live, so a new worker never starts while the previous one is still wrapping up. A worker whose turn doesn't end within `finishingTimeoutMs` (3 min) of `study_finish` is stopped and archived.
- **Diversity.** At most `ceil(W / 2)` workers run one theme at a time. This is also checked at W = 1, where it makes no difference.
- **No repeats.** Ideas now have `variation_of` and `lineage`, where the lineage is the root idea of a chain of variations.
  - A non-human idea whose normalized title matches a lost idea is skipped, unless it's an explicit variation.
  - `study_queue_ideas` returns "Skipped: … repeats lost idea #N; queue it with variation_of=N" for such ideas instead of queueing them.
  - An idea with `start_ref = "c/N"` is automatically a variation of candidate N's idea. The ref must name an existing candidate.
  - Human ideas are exempt, because the human steers.
  - Lost and abandoned ideas never go back to `queued`.
- **Human idea controls.** The Ideas board can add ideas (with theme, rationale, and start ref), reorder them (written as priorities 100, 99, …), pin or unpin them, and veto them. A veto retires the idea with the reason "vetoed by the human".

### Rebase, conflict, and promotion

- **Rebase on submit** is the M0 `git merge-tree` preparation at gate time onto the current best. If best moved while a candidate was queued, the measure step sends it back to be prepared and gated again. This is recorded as `candidate.rebased` with the old and new best.
- **Fork point.** The snapshot now computes the fork point as `merge-base(HEAD, best)`. A worker that rebased by hand after a `conflict` is diffed, scope-checked, and prepared against the new best, not its original fork. The worker's `fork_sha` moves with it.
- **Conflict counting (decision).** A `conflict` is refunded: it doesn't count against `max_submissions_per_worker`, up to `CONFLICT_REFUNDS = 2` per worker. After that, conflicts count. The verdict says which case applies and tells the worker to `git rebase studies/<slug>/best`, resolve, and resubmit. In both smoke-test conflicts, the worker read the verdict, saw that its idea was already in best, recorded a `no_effect` finding, and finished. That's a legitimate resolution.
- **Best moves mid-measurement (decision).** A candidate is measured against the best at the start of its measurement, and `against_sha` records which one.
  - If the result is a **win** and best has moved by the time the measurement ends, the candidate is prepared, gated, and measured again against the new best before it can be promoted.
  - **Non-wins stand** against the best they were measured on. Re-measuring likely losers would cost bench time for nothing.
  - A compare-and-swap failure at promotion also sends the candidate back to be measured again (`best branch moved … during promotion`). M0 threw an error here.
  - With one bench host per study this can't happen in M1. It's built for M2's multiple bench hosts, and tests simulate it.
- **Confirmation.** Confirmation runs in the same bench session against the same best.

### Notifications (fix b)

- **No push without a turn.** The SDK can't post a message into a thread without starting or steering a turn: `threads.send` modes are `start`, `steer`, `auto`, and the queue variants.
- **Notices instead.** Milestones (calibration ready or failed, system pauses including budget exhaustion) are rows in `notices`:
  - shown on the study page and in `bb study show`, and counted on the Studies list;
  - the study thread is marked unread with `threads.markUnread`;
  - the text rides along in the next strategist round under "Notices for the human".
- **Before Running.** There are no rounds yet, so undelivered notices are steered into the human's own next turn in the study thread. This is how the creating agent hears about calibration results.
- **Best moved.** Workers are told without new turns:
  - a worker mid-turn, with no candidate pending, gets the notice steered into that turn;
  - any other worker gets it prepended to the next plugin message it receives (verdict or submission ticket).
  - `worker.notified` records which path was taken.

### Other fixes

- **(c) Bench time.** Budget lines and reports format durations as s, min, or h, so short runs no longer show 0.00 h.
- **(d) Tool prefix.** Every agent tool is prefixed: `study_submit_candidate`, `study_record_finding`, `study_propose_idea`, `study_request_profile`, `study_finish`, `study_queue_ideas`, `study_retire_idea`, `study_update_dossier`, `study_search_findings`, `study_propose_harvest`, and `study_propose`.
- **Worktree cleanup.** A worker that never submitted had no environment id recorded, because the spawn response can omit it while the worktree is provisioning. Its worktree was left for core's retirement. `endWorker` now looks the environment up from the thread before archiving.
- **Spec warning.** The "max_workers > 1 runs W = 1" warning is gone.

### Human surface

- **Studies nav panel** (`navPanel`, path `studies`). It lists studies with state, best vs. base, budget spent, workers, queue, and new notices. A study page lives at `studies/<slug>[/<tab>[/<n>]]`.
  - **Overview:** the trajectory chart (SVG; every measured candidate is a dot at its position relative to base, and best is a step line); best vs. base with an approximate CI (the promoted candidates' CI bounds, compounded); state and pause reason; budget; W, think and eval times; bench utilization; controls (pause, resume, concurrency, open study thread); live workers with their phase and queue position; the bench queue; notices; and recent events.
  - **Ideas:** the board (queued, running, won, lost, abandoned or vetoed) with add, reorder, pin, and veto.
  - **Candidates:** a table filterable by verdict, stage, and text. A row opens the verdict and reasons, the summary, samples per pair, gate output, diagnostics, and a diff summary. The diff comes from the new `diffSummary` host op, rendered per file with `experimental_Diff`. There's a link to the worker thread.
  - The Findings, Oracle, Bench, and Harvest tabs are still M3.
- **Thread header badge** (`experimental_threadHeaderAction`). On the study thread it reads `run N · best −x% ±y · W workers · queue Q`, prefixed with the state when not running. On a worker thread it reads `<slug> · idea #N · submission k/max · <phase>`, where the phase is working, gating, queued Nth, measuring, or confirming. Clicking it opens the study page. Other threads render nothing.
- **Data plane.** The page reads everything through `bb.rpc`: `studies.list`, `study.overview`, `study.ideas`, `study.candidates`, `study.candidate`, and `thread.badge`. It writes through `study.pause`, `study.resume`, `study.concurrency`, `ideas.add`, `ideas.update`, `ideas.reorder`, and `ideas.veto`. It refetches on the `study-changed` realtime signal (debounced), on reconnect, and on a 5 s poll. The plugin publishes that signal at every stage change.
- **Branding.** The plugin ships its flask glyph (`assets/flask.svg`), registered as the app icon `autoresearch-flask`.
- **Security gap.** RPC writes refuse other plugins as callers (`experimental_caller.kind === "plugin"`). The RPC context doesn't say which thread called, though, so an agent could still call them through `bb plugin rpc call`. They're bounded human controls (pause, resume, concurrency, the idea board), not verdicts or promotion. Closing this gap needs caller-thread identity from BB.
- **CLI.** New: `bb study concurrency`, and `ideas add --start-ref --variation-of`. `show` adds a Scheduler line (W, queue, think, eval), a Bench line (utilization and overlaps), and notices.

### Data model

M1's migrations are append-only:

- `candidates`: `queued_at`, `lines_added`, `lines_deleted`, `rebases`;
- `threads`: `conflict_refunds`, `pending_notice`, `finishing_at`;
- `ideas`: `variation_of`, `lineage`;
- `studies`: `max_workers_override`, `target_workers`, `running_since`, `running_seconds`;
- new tables `bench_intervals` and `notices`.

New events: `measure.started` and `measure.finished`, `candidate.rebased`, `scheduler.target`, `worker.notified`, `study.concurrency`, `notice.added`, and `idea.pinned`.

### Smoke test (BB 0.45, local host, toy repo under /tmp)

Three studies ran on one toy Python pipeline with a `noisy` metric. All had `max_workers = 3`, `max_candidates = 6`, and 2 submissions per worker, and all used the default agent provider.

| Study | Shape | Peak concurrent workers | Mean think | Mean eval | W | Bench busy / Running | Since first submission | Overlapping measurements | Rebases / conflicts |
|---|---|---|---|---|---|---|---|---|---|
| `toy-m1` | eval ≈ think, and eval collapses as wins land | 3 | 22 s | 18 s | 3 → 2 | 53% | 67% | 0 of 9 | 3 / 0 |
| `toy-m1b` | untimed setup keeps eval expensive | 3 | 17 s | 36 s | 3 → 2 | 74% (81% mid-run) | 85% | 0 of 9 | 3 / 1 |
| `toy-m1c` | think > eval | 3 | 18 s | 5 s | 3 | 21% | 28% | 0 of 7 | 1 / 1 |

- **No overlaps.** Measurements never overlapped (`bench_intervals` self-join). Every sample's timestamp fell inside its own candidate's measurement interval.
- **No notification turns.** No notification started a turn: the study threads went unread, and the notices arrived in the next round.
- **Live in the app.** The study page and the badge rendered in the BB app (checked with in-app browser screenshots).
- **What the numbers say.** Utilization follows the formula. When eval takes longer than think, the bench saturates (85% in steady state). When think takes longer than eval, W wants `ceil(18/5) + 1 = 5`, the cap of 3 starves the bench, and utilization drops to 21%. Short studies also pay for the first think period while the bench sits idle. Meeting the > 80% exit criterion on a real workload needs `max_workers` at least `T_think / T_eval + 1`, and a study long enough to amortize the start. That claim isn't proven yet.
- **Agents were fast.** Workers on this toy thought for only 17–22 s and mostly finished after one submission.

### Not in M1

- **Exit criterion and head-to-head.** The M1 exit criterion on a real benchmark, and the M0-vs-M1 time-to-target comparison.
- **Rate limits.** Lowering W while provider rate limits are tight.
- **Mixed providers.** Mixing providers across workers (open question 6).
- **Tabs.** The Findings, Oracle, Bench, and Harvest tabs.
- **Remote bench hosts.** Remote bench hosts and everything else in M2 (the `HostRunner` seam and per-key bench queues are ready for them).

## v0.1.0: M0, the main assumption

What M0 built, and every place it differs from the [design](design.md). Checked against BB 0.45.0 and `@get-bb/plugin-sdk` 0.6.14.

### Platform

- **SDK pin.** `bb plugin types` selects 0.6.15, which is not published to npm. The plugin pins 0.6.14, the newest published version (`engines.bbPluginSdk: ">=0.6.14"`). Every API used exists in both.
- **Host RPC is the only path to the machine.** Git, gates, builds and measurements run through the `bb.host` entry (`host.ts`) via `bb.hosts.experimental_client`, targeting `bb.sdk.system.config().primaryHostId`. The server never touches the repo with `child_process`. The same ops also run in-process behind the `HostRunner` interface (`LocalHostRunner`), which the tests use. M2 adds remote bench hosts by pointing a `HostRunner` at another host id.
- **Call duration.** A host call is capped at 30 minutes, so one `build`, `gate` or `measure` command is capped at 29 (`oracle.timeout_minutes`, default 20). A paired measurement is many calls, so a whole evaluation can run longer. Benchmarks that need more than 29 minutes per run need a background job on the host that reports through signals (open question 3, M2). *(M2: built as host jobs; see [the M2 notes](#v010-m2-remote-bench-and-trust).)*
- **Repo location.** The study's repo is the project's checkout on the server's machine (`projects.get().sources`). Projects without one are refused in M0.

### Git model

- **One commit per candidate, built without a checkout.** `prepareCandidate` applies the worker's changes since its fork point onto the current `best` with `git merge-tree --write-tree` and `git commit-tree`. The result is a single commit whose parent is `best`: it is both the rebase (step 3) and the squash (step 8). Gates and measurements run on that commit, and promotion re-messages it and compare-and-swaps `studies/<slug>/best` onto it. A failed merge is the `conflict` verdict. This needs git 2.38 or newer.
- **Plugin-owned checkouts.** Gates and measurements run in detached worktrees under the host bundle's data directory (`<slug>-gate`, `<slug>-best`, `<slug>-cand`), never in the worker's worktree. `bb study archive` removes them.
- **Worker branches.** BB's managed-worktree provider names the worker's branch itself (for example `<user>/<slug>-idea-1-…-thr_x`). The spawn API takes only a base branch, so `studies/<slug>/w/<n>` isn't used. When a worker ends, the plugin archives and stops the thread, deletes its environment once no live thread uses it (`environments.delete`, instead of waiting for core's retirement grace period), and deletes the branch. Candidate refs keep the commits.
- **Starting from a candidate.** An idea with `start_ref = "c/12"` gets a branch `studies/<slug>/start/<idea>` at that candidate. Its fork point is the candidate's own fork point, so its changes carry forward onto the current `best`.

### Pipeline and statistics

- **Snapshot and scope run inside `study_submit_candidate`.** Both are fast, so the tool call does them. A scope rejection comes back as the tool result instead of a later message. Everything after that (rebase, gate, measure, verdict, promotion) is asynchronous, and the verdict arrives through `threads.send({ mode: "auto" })`.
- **Stages are persisted.** Candidates move through `submitted → gating → queued → measuring → confirming → promoting → decided`, and `reported_at` records delivery. Each stage reruns safely. A host error is retried on later passes. After three failures the study pauses (system pause, human notified) and the candidate stays parked until `resume`.
- **Flaky gates.** A failed gate command runs once more. A pass on the retry is recorded as a `gate.flaky` event.
- **MDE definition.** Calibration runs `calibration_pairs` A/A pairs. The MDE is `max(min_effect, q)`, where `q` is the `confidence` quantile of |median| over bootstrap resamples of `n_max` centered A/A differences: the effect A/A noise alone can fake at `n_max` pairs. A win needs the CI lower bound above the MDE, so the report also gives "detectable", which is MDE plus that half-width. Calibration fails, and the study returns to Draft, when the MDE is above `max_mde` or the A/A CI excludes zero (the two checkouts aren't equivalent).
- **Confirmation.** For `noisy`, a win is measured again with a full fresh sequential test, which must also be a win. Otherwise the verdict becomes `inconclusive` or `lose`, with the reason attached. The holdout check is M2.
- **Deterministic class.** Best is run once per promotion and cached. A candidate within ± tolerance is `inconclusive`, not `lose`.
- **Expensive class** is minimal: calibration takes 3 baseline runs, a candidate gets 1 run, and a run that clears the MDE is confirmed with `confirm_runs` more.
- **Guardrails** take a `direction` field (default `lower`), because "regression" means opposite things for memory and for throughput.
- **A broken oracle pauses the study.** If best fails to build or to measure, the study pauses. If the candidate does, its verdict is `gate_failed`.

### Agents

- **Role gating.** `bb.agents.configure` is synchronous, and so is better-sqlite3, so `configure` checks both the metadata and the `threads` table. Worker metadata selects worker tools only when it matches a live worker row (by thread id, or by `spawnToken` while the spawn call is still in flight). Strategists are known only by their row. A thread with no row gets `study_propose` and the two skills. Every tool call checks the role against the table again. Forged metadata gets no tools.
- **`threads` has a surrogate id and a `spawn_token`.** The thread id isn't known until `threads.spawn` returns, and `configure` (or a fast first tool call) can run before that. The token in the worker's metadata ties the thread to its row. Reconciliation uses it to adopt or fail spawns that were interrupted.
- **Strategist tools need a fresh session.** Tool sets apply when a provider session starts. The study thread is created as an ordinary thread, so `bb study start` stops its runtime (when idle) and the first strategist round opens a new session that has the strategist tools. The smoke test confirmed this.
- **Human-message trigger.** BB has no "a human sent a message" event. A `thread.active` on the study thread that the plugin didn't cause counts as the human trigger. If there are new verdicts or findings, the digest is sent with `mode: "auto"`, which steers it into the human's turn. Plugin-sent notifications (calibration results, system pauses) count as rounds so they don't look like human messages. *(M1: notifications no longer start turns; see Notices below.)*
- **Round triggers** are K verdicts (`agents.strategist_every`), queue low (fewer ready ideas than W, only after something changed, so an unproductive round doesn't loop), stall (`agents.stall_after` verdicts without a win, once per window), the human, and a first round at start.
- **Idle handling.** Idle time starts at `thread.idle` and doesn't count while a verdict is pending. One nudge comes after `idle_nudge_minutes`. A worker still idle at `idle_abandon_minutes` is stopped and archived, and its idea is marked `abandoned`. A new submission clears the nudge.
- **Rate limits.** `turn.failed` with category `rate-limit` is retried at the window reset plus 15 s, up to 3 times.
- **Permission mode.** `[agents].worker.permission_mode` is passed to the spawn call. When it's absent, the project default applies. A hidden worker that asks for approval stalls until the idle timeout.
- **`study_request_profile`** runs the optional `oracle.profile` command inside the tool call, holding the bench lock, and adds the time to the bench budget.
- **`study_propose_harvest`** only records the proposal (M3).

### Human surface

- **No frontend.** The Study page, Studies nav panel, and header badges are deferred (M1/M3). The CLI is the M0 surface. *(M1: the Studies panel, study page v1, and the header badge exist; see M1 below.)*
- **Approval is in the CLI.** `bb study calibrate` approves the current spec version and calibrates. `bb study start` approves the calibration. Also built: `list`, `show`, `pause`, `resume`, `ideas add`, `ideas list`, `workers`, and `archive`. `harvest` prints a placeholder. Human controls are refused when they come from a study's own worker or strategist thread. The strategist may run `ideas add`.
- **Pause** stops new spawns. In-flight candidates finish and running workers keep their submission. Holding worker messages with the experimental `message.dispatch` hook isn't used.

### Data model

- All design tables exist, with implementation columns added (pipeline stage, attempts, prepared/promoted shas, round bookkeeping, cached best run). There are two extra tables: `dossiers` (versioned text) and `harvest_proposals`. `events` is append-only, enforced by triggers.
- Studies use state names `draft | calibrating | running | paused | harvesting | archived` and calibration status `running | ready | failed`. `harvesting` is unused in M0.

### Spec additions

`scope.max_files` and `scope.max_lines`; `oracle.profile`, `oracle.timeout_minutes`, and `oracle.protocol.{warmup, n_min, n_max, confidence, min_effect, max_mde, tolerance, confirm, confirm_runs, calibration_pairs, bootstrap}`; `guardrail.direction`; `agents.{strategist,worker}.permission_mode`, `agents.strategist_every`, `agents.stall_after`, and `agents.idle_nudge_minutes`/`idle_abandon_minutes`. Unknown keys are rejected. `oracle.bench_hosts` must be empty or `["local"]` until M2. `oracle.holdout` is accepted but not evaluated yet. `budget.max_workers > 1` is accepted, but M0 runs W = 1 (`EngineConfig.workerCeiling`). *(M1: W > 1 runs; `workerCeiling` is now only an emergency cap, default 64.)*

### Not in M0

The serial-loop head-to-head; W > 1, backpressure, and adaptive W (the `targetWorkers` formula exists but is capped at 1); drift checks; holdout; oracle segments after start (re-calibrating before the first candidate keeps segment 1); remote bench hosts and git bundles; harvest and ablation; token budgets; and the UI.
