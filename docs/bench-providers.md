# Bench providers

A **bench provider** is a BB plugin that lends bb-autoresearch short-lived
remote machines that can't be BB machines: for example cloud machines that
only allow outbound connections, so the BB server must drive them. The
provider is a thin transport. It creates and destroys machines, moves files,
and runs processes. Git, seeding, calibration, scheduling and every decision
stay in bb-autoresearch, which runs ordinary shell commands on the machine.

bb-autoresearch calls the provider's `bb.rpc` methods with
`bb.sdk.plugins.callRpc({ pluginId, method, input, outputSchema })`. The zod
schemas are in [`src/bench-provider/contract.ts`](../src/bench-provider/contract.ts).
A provider copies them (a BB plugin can't import files outside its own
directory) and registers them with `bb.rpc.register(benchProviderContract,
handlers)`. [`examples/bench-provider-local/`](../examples/bench-provider-local/)
is a complete provider against local temp directories and child processes.

This is contract version **1**. A change to the contract needs a new
`contractVersion`. bb-autoresearch 1.0 completed v1 with two optional fields,
`create`'s `machine` and `describe`'s `machineOptions`: it sends `machine`
only when a study sets machine options, and a provider that returns
`machineOptions` needs bb-autoresearch 1.0 or newer.

## Rules for providers

- **Callers.** Accept calls only when `ctx.experimental_caller` is
  `{ kind: "plugin", pluginId: "bb-autoresearch" }` (tests may configure
  another id). Refuse others with `[invalid] caller not allowed`.
- **Errors.** Throw `Error`s whose message starts with a code in brackets:
  `[not_found]`, `[capacity]`, `[auth]`, `[invalid]`, `[transient]`,
  `[internal]`. `[capacity]` and `[transient]` are retried; the others are
  not. BB prefixes what a provider throws (`HTTP 500: [invalid] …`), so
  bb-autoresearch reads the first bracketed code anywhere in the message, and
  a message without one counts as `[internal]`. `[not_found]` on a machine
  call means the machine is gone.
- **Credentials.** Never put the user's credentials on a remote machine.
  Files arrive only through `putFile`.
- **Paths.** Paths on the remote machine are relative to the remote user's
  home unless absolute. Create missing parent directories as the remote user.
- **Labels.** Every machine carries the caller's `labels`, so `list` can find
  orphans.
- **Machine options.** `create` may carry `machine`: what machine the study
  wants (machine type, SMT off, CPU platform, image, …), as provider-specific
  keys with string, number or boolean values. It is the study's choice, per
  machine, not a provider-wide setting. List the keys you accept in
  `describe`'s `machineOptions` (`[{ name, description }]`; bb-autoresearch
  checks a spec's keys against it when the study is calibrated). Apply them
  when the machine is created. Reject any key you don't understand with
  `[invalid] unknown machine option <key>`, so a typo fails loudly instead of
  benching on the wrong machine; an absent or empty `machine` means your
  default. `info` reports what the machine actually is (its `extra` is the
  place for the machine type, SMT state, CPU platform, image), and
  bb-autoresearch records it next to what was asked for. `cores` stays the
  cores bb-autoresearch plans threads for and checks against `info`.

## Methods

All JSON in, JSON out.

| Method | Input | Output |
|---|---|---|
| `benchProvider.describe` | `{}` | `{ contractVersion: 1, displayName, available, reason?, maxHosts: number \| null, maxLifetimeSeconds: number \| null, cores: { min, max } \| null, machineOptions?: [{ name, description }] }` |
| `benchProvider.create` | `{ key, cores, memoryGb?, lifetimeSeconds, labels, machine? }`; `key` is an idempotency key: the same key returns the same machine; `machine` has at most 32 keys matching `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, each a string (at most 256 characters), number or boolean | `{ hostId, state, expiresAt: string \| null }` |
| `benchProvider.status` | `{ hostId }` | `{ state, expiresAt: string \| null, detail? }` |
| `benchProvider.list` | `{ labels }` (match all given labels) | `{ hosts: [{ hostId, state, expiresAt, labels }] }` |
| `benchProvider.destroy` | `{ hostId }` | `{ ok }`; idempotent, `ok: true` if already gone |
| `benchProvider.info` | `{ hostId }` | `{ os, arch, cpuModel, nproc, cpuQuotaCores, memoryBytes, extra? }` |
| `benchProvider.putFile` | `{ hostId, localPath, remotePath, mode? }`; `localPath` is absolute, on the BB server's machine | `{ bytes, sha256 }` of what the machine received |
| `benchProvider.getFile` | `{ hostId, remotePath, localPath, maxBytes }` | `{ bytes, sha256 }` |
| `benchProvider.execStart` | `{ hostId, argv? \| script?, cwd?, env?, timeoutSeconds }`; exactly one of `argv` or `script`; `script` runs with `bash -lc` | `{ execId }` |
| `benchProvider.execPoll` | `{ hostId, execId, stdoutOffset, stderrOffset, maxBytes? }` | `{ done, exitCode, signal, stdout, stderr, stdoutOffset, stderrOffset, durationMs }` |
| `benchProvider.execCancel` | `{ hostId, execId }` | `{ ok }` |

`HostState` is `"provisioning" | "ready" | "suspended" | "gone" | "failed"`.

### Processes

- A running exec must survive between polls: run it detached. Polling counts
  as activity for the provider's idle timers.
- `execPoll` returns output from the given byte offsets, at most `maxBytes` of
  each stream (default 256 KiB), and the new offsets. `done` is true once the
  process ended. When more output remains than one poll returns, the caller
  polls again from the new offsets.
- A process killed by `timeoutSeconds` ends with `signal: "TIMEOUT"` and
  `exitCode: null`.
- A process that died without an exit record (the machine was suspended, or
  the provider restarted) ends with `signal: "LOST"`. bb-autoresearch treats
  it like a lost machine for that measurement: the measurement restarts from
  scratch on another bench host.

### Machines leaving

bb-autoresearch treats `suspended`, `gone` and `failed` as the machine
leaving, and never uses that machine again: a suspended machine may come back
on different hardware, where its calibration would be wrong. It destroys
machines it no longer needs; it calls `list` with its labels on load, pause
and archive (and every 10 minutes) and destroys what no live machine of a
study uses.

A reload of bb-autoresearch doesn't destroy calibrated machines. On load it
re-adopts each one whose `status` is `ready` and whose files are still there
(it runs a short probe with `execStart`), so a provider's machines must stay
reachable by the same `hostId` across a reload of either plugin. Machines of a
disabled bb-autoresearch are destroyed by nobody until their lifetime ends:
enforce `lifetimeSeconds`. When a call fails because the provider plugin isn't
loaded yet (BB's startup), bb-autoresearch waits for it instead of giving the
machine up.

## What bb-autoresearch does on a machine

Per machine (each slot of an `[[oracle.remote_bench]]` entry, and each
replacement):

1. Before creating anything, on the edit host: the entry's `seed` command runs
   in a checkout of the segment's baseline and prints a directory or tarball;
   it is scanned for credentials and packed (cached by content hash). A
   shallow git bundle of the study base is built once. A refused seed costs no
   machine.
2. `create` with labels `owner`, `study` and `slot` and the entry's
   `machine` options (verbatim), then `status` until `ready`, then `info`.
3. `putFile` the seed and unpack it under `~/bb-autoresearch/seed/<sha256>`;
   `putFile` the base bundle and fetch it into a bare repository at
   `~/bb-autoresearch/repo.git` (shallow at the base). Best and every
   candidate follow as small delta bundles.
4. The entry's `setup` command, in a checkout of best.
5. A/A calibration on best on that machine; it then measures with its own
   noise floor and win threshold.

Every command gets the entry's `env`, plus `AUTORESEARCH_REMOTE=1`,
`AUTORESEARCH_CORES` (the cores asked for, for code that would size thread
pools from a visible CPU count that doesn't match the quota) and
`AUTORESEARCH_SEED` (the unpacked seed).

The tools the machine needs: `bash`, `git` (2.38 or newer), `tar`, and what
the study's own commands need (or what the seed ships).
