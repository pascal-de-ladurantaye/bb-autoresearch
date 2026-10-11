# Local bench provider (example)

A BB plugin (id `bench-provider-local`) that implements bb-autoresearch's
**bench provider contract** against local temp directories and child
processes. Each "machine" it lends is a directory on the machine running the
BB server; each exec is a local process.

It exists for bb-autoresearch's tests and live smoke tests, and as a worked
example of the contract. **It is not a bench.** Nothing is isolated (processes
run as your user, absolute paths reach your whole file system), measurements
share the CPU with everything else on the machine, and nothing costs anything.

## Install

From the repository root:

```sh
bb plugin install ./examples/bench-provider-local
```

Then point a study at it:

```toml
[[oracle.remote_bench]]
provider = "bench-provider-local"
hosts = 2
cores = 2
lifetime_minutes = 30
```

## How it works

- Machines live under `<tmpdir>/bb-bench-provider-local/machines/<hostId>/`;
  a machine's home is `home/` there. Remote paths are relative to that home
  unless absolute.
- The registry (host id, key, labels, state, creation and expiry times,
  cores) is kept in `state.json` under the same root, so `list` and `destroy`
  still work after the plugin reloads. Execs that were still running when the
  plugin unloaded are reported done with `exitCode: null` and
  `signal: "LOST"`.
- Execs run detached in their own process group (`bash -lc <script>` or the
  given argv), with `HOME` set to the machine's home and stdout and stderr
  written to files that `execPoll` reads by byte offset. `execPoll` reports
  `done: true` once the process exited **and** the returned offsets reached
  the end of both streams, so a caller that keeps polling until `done` gets
  all output even when it exceeds `maxBytes`.
- A machine past its expiry (creation time plus `lifetimeSeconds`, capped at
  `maxLifetimeSeconds`) becomes `gone`: its processes are killed and its
  directory removed. Expiry is checked on every call and by a sweep timer.
- Only calls from the plugin `bb-autoresearch` are accepted.
- Unloading the plugin stops its timers and kills running execs; it does not
  destroy machines.

## Options

`server.ts` uses the defaults. Tests call `createLocalBenchProvider(options)`
from `provider.ts` directly:

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | `<tmpdir>/bb-bench-provider-local` | Where machines and `state.json` live. |
| `now` | `Date.now` | Clock (ms) for expiry and provisioning. |
| `allowedCaller` | `"bb-autoresearch"` | The plugin id allowed to call. |
| `maxHosts` | `4` | Live (not gone) machines at once; more is `[capacity]`. |
| `maxLifetimeSeconds` | `7200` | Lifetime cap. |
| `cores` | `{ min: 1, max: <CPU count> }` | Accepted core counts; outside is `[invalid]`. Cores are a pretend quota (reported by `info`, not enforced). |
| `displayName` | `"Local temp directories (example)"` | Shown by `describe`. |
| `provisionMs` | `0` | `0`: machines are `ready` at once. More: `provisioning` for that long. |
| `sweepMs` | `1000` | Expiry sweep period (`0` disables the timer). |

`createLocalBenchProvider` also returns test hooks: `suspend`, `fail`, `kill`
(gone without a destroy), `machines`, `setAvailable`, `failNext` (the next
call to a method throws `[code] injected`), `calls` (call counts per method)
and `sweep`.

## Writing your own provider

A BB plugin can't import files outside its own directory, so `contract.ts` here
is a copy of the repository's `src/bench-provider/contract.ts` (a test keeps the
two identical). Any provider does the same: copy the schemas (they are plain
zod) and register them with `bb.rpc.register(benchProviderContract, handlers)`.
