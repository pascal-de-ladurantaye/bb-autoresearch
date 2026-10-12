# Implementation notes: v1, measurement quality

Workstream A of 1.0. Same platform pins (BB 0.45.x, SDK 0.6.14). For the integrator: these notes belong in `docs/release-notes.md`; the "Calibration and drift" and "Guardrails and holdout" sections of `docs/design.md` still say the segment takes the worst host and that calibration only warns about a guardrail it can't judge. Both statements are out of date.

## Why

A study on two cloud machines: one host had a noise floor of 5.44% per pair (win threshold 3.33%), the other 2.42% (threshold 1.42%). The segment took the worst host, so every candidate had to clear 3.33% wherever it was measured, and several real gains of 3-6% ended inconclusive on the quiet host. A guardrail with 2.9% noise and a 1% limit could never be judged: calibration only warned, so every win carried an inconclusive flag on it. An automatic recalibration that failed its health check paused the study for hours.

## 1. Per-host win thresholds

- **Before.** `measurementMde` returned `max(segment MDE, host MDE)`. The segment MDE was the largest of all hosts, so in practice every host used the noisiest host's threshold.
- **After.** Each host decides with its own calibrated MDE (the segment's for a host without a calibration), never below `min_effect`: `max(min_effect, host.mde ?? segment.mde)`. Remote machines that calibrate on arrival use their own threshold too. Before, they used the larger of their own and the segment's.
- **Why it's safe.** Each host's threshold is calibrated so that the false-win rate on that host is the nominal rate (the simulation below shows it). Candidates are assigned to hosts by availability, not by outcome, so per-host thresholds add no selection bias. The confirmation runs on the same host.
- **Guardrail noise per host.** The expensive and deterministic classes judge guardrails with calibrated noise. That noise is now the measuring host's own (`hostGuardrailCalibration`: the segment's per-host record, or a remote machine's arrival calibration, else the segment's worst).
- **Segment columns (decision).** `segments.mde` and `noise_floor` still hold the noisiest measuring host's numbers, so older readers (the CLI segment table, events) keep working. Everything a person reads shows the per-host thresholds instead:
  - the calibration report's headline ("2 bench hosts, each deciding with its own win threshold: 1.42% on b, 3.33% on a (noise floor per pair: …); a candidate goes to the quietest free host. b: Detects changes …");
  - the Overview's threshold line;
  - the Oracle tab (sentence, host table, segments table);
  - the bench host list and `bb study bench` / `show` ("win threshold 1.42%, noise 2.42%");
  - the CLI's MDE row ("… (each host decides with its own)");
  - the report's segment lines;
  - the worker brief ("A win must clear the win threshold of the bench host that measures it …");
  - the noise sentence ("1.23% to 3.62% per pair, depending on the bench host").
- **Running studies.** A study calibrated before v1 already has per-host MDEs in `bench_hosts.mde`, so it uses per-host thresholds from its next measurement on. Nothing has to be recalibrated.

## 2. The quietest free host first

- **Before.** A queued candidate went to the first free host in spec order. Remote machines come after local hosts, so with one candidate at a time the local host took everything.
- **After.** `Pipeline.dispatchHosts` orders hosts by effective win threshold, then noise floor, then spec order (hosts without a calibration go last). Measurements, drift checks, `study_request_profile` and harvest measurements use this order. Gates keep theirs.

## 3. Hosts much noisier than their peers

- **Rule.** A host whose calibrated noise floor is more than `[oracle] max_host_noise_ratio` (default 2, `0` off) times the median of the *other* hosts' noise floors is not used. Comparing with the others' median (not a median that includes the host) makes the rule work with two hosts: the peer is the other host, and the quietest host always stays. The deterministic class is exempt.
- **Chance guard (decision).** A noise floor estimated from 12 A/A pairs (the default `calibration_pairs`) is itself noisy. Two hosts with the same true noise differ by more than 2× about 8% of the time, so with two hosts one of them would be dropped about 17% of the time. A host is therefore taken out only when its ratio is also beyond what chance gives equal hosts about 1% of the time, `chanceRatio`:
  - the rule is exp(2.326 · √2 · se), where se is the standard error of log σ̂;
  - noisy class: se = 1.3/√n for the robust SD of n pairs (the MAD's asymptotic 1.17/√n is optimistic at a dozen pairs);
  - expensive class: se = 1.3/√(2(n − 1)) for the sample SD of n runs.

  The effective limit is max(`max_host_noise_ratio`, `chanceRatio`):

  | Pairs | Ratio needed | Equal hosts falsely flagged (simulated) |
  |---|---|---|
  | 12 | 3.4× | 0.9% |
  | 20 | 2.6× | 0.8% |
  | 40 | 2.0× (the limit binds) | 0.6% |

  A host above the limit but within chance keeps measuring with its own win threshold (item 1), and calibration warns: "a's noise floor … is 2.5× …, above max_host_noise_ratio 2, but with 12 calibration pairs two equal hosts differ that much by chance (it would take more than 3.4×) … More calibration pairs would tell them apart". The real study's 2.25× would get that warning at 12 pairs and be dropped at 40.
- **What happens to a noisy host.**
  - **BB machine or edit host.** It leaves the dispatch set (`bench_hosts.excluded_json`: reason, noise, peers' median, segment). It gets no measurements, no drift checks, no profiles and no harvest measurements until the next calibration (human or automatic), which measures it again and clears the flag when it is quiet.
  - **Remote machine, during the study's calibration.** It isn't marked calibrated and leaves when the calibration ends (`markNoisy`, then `endCalibration`). Leaving earlier would start a replacement that joins while the calibration finishes and is then left behind. The slot refills once the study runs, and the replacement calibrates on arrival.
  - **Remote machine, on arrival.** It is compared with the study's measuring hosts (`noisyOnArrival`). At most `NOISY_REPLACEMENTS` (2) machines of an entry are replaced in a row. The next one is kept, with one notice ("… after 2 replacement(s) in a row that were too: it is kept and measures with its own win threshold; candidates go to quieter hosts first"). From then on the entry's machines are kept as they come (`acceptsNoisy`, also respected by calibrations), so a provider whose machines are all noisier than the edit host doesn't churn. The count is in memory and starts over after a reload.
  - **Remote machine, in an automatic recalibration.** It leaves at once and is replaced (or kept, as above).
- **Where it shows.**
  - The calibration report ("Not used: a (noise floor …)", one warning per host).
  - The calibration-ready notice (its warnings).
  - The `segment.recalibrated` notice.
  - `bench.noisy_host` events and feed lines.
  - The bench host list ("not used: much noisier than the other hosts", with the reason).
  - `bb study bench` ("NOT USED until the next calibration (…)").
  - The Oracle tab's host tables.
  - A `bench.noisy_host` notice when a remote machine is kept (informational, opens the Bench tab).

## 4. Guardrails that can't be judged

- **Before.** A guardrail whose CI half-width at a full evaluation was not below its limit gave a calibration *warning*, and every win was flagged inconclusive on it.
- **After.** Calibration fails (`guardrailProblems`), on the worst measuring host, with the fixes. The noisy class names two: loosen the limit (to the half-width plus a quarter), or raise `n_max` to about n_max · (1.25 · half-width / limit)², the CI narrowing with √n. When that would take more than 1000 pairs, it says `n_max` can't do it. The expensive class names `confirm_runs` and `calibration_runs`; the deterministic class names `tolerance` or `noise = "noisy"`. Example from the live check:

  > guardrail mem can't be judged: its CI half-width at a full evaluation is 2.21% (noise 1.50%), not below its 1.0% limit, so every win would be flagged inconclusive on it. Fix the spec: loosen its max_regression to at least 2.8%, or raise oracle.protocol n_max from 6 to about 46 (the CI narrows with the square root of the pairs; each evaluation then takes longer).

- **Automatic recalibrations** fail the same way, and the study pauses with the message: the spec has to change.
- **A remote machine** on which a guardrail can't be judged leaves on arrival, like one above `max_mde`.

## 5. Automatic recalibration and health checks

- **Before.** A host that failed its health check made `runAutoRecalibration` fail, and the study paused ("automatic recalibration failed …") until a human resumed it.
- **After.** Every host's health is checked first, each under its own bench lock and before any A/A run, so a busy machine costs no A/A on the others. If one fails (or fails between that check and its A/A), nothing changes: the hosts keep their calibration, `recalibrate_due` stays set with `health_retries` and `retry_at`, a `recalibration.deferred` event is recorded, and the next try waits `[oracle.health] retry_seconds`. The pipeline's backoff handles the wait, and `retry_at` survives a reload. Measurements stay on hold meanwhile, as for any due recalibration.
  - The status line says "recalibrating on best waits for a healthy bench (retry 3 of 30, next in 40 s)".
  - The usual "unhealthy for N min" notice goes out after `notify_after_minutes`.
- **Bounded (`[oracle.health] recalibration_retries`, default 30).** After that many retries the study pauses ("… a bench host stayed unhealthy through 30 retries, 60 s apart: … then resume: it recalibrates first"). The recalibration stays due, with a fresh count, so resuming recalibrates before anything is measured.

## Spec keys

Both are left out of the oracle hash, so existing segments keep their hash (tested). Stored specs are read with the defaults (`normalizeSpec`).

| Key | Default | What it does |
|---|---|---|
| `[oracle] max_host_noise_ratio` | `2` | A bench host whose noise floor is more than this times the median of the other hosts' (and beyond chance) is not used; `0` turns it off; otherwise 1-100. |
| `[oracle.health] recalibration_retries` | `30` | Health-check retries of an automatic recalibration, `retry_seconds` apart, before it pauses the study. |

## Simulation

`test/v1-sim.test.ts` uses the real study's per-pair noise: 2.42% (quiet host) and 5.44% (noisy host). Each threshold is calibrated from 400 A/A pairs of its host's own noise (min_effect 1%, `n_min` 6, `n_max` 20, confirmation on), giving thresholds of 1.22% and 3.04% (the study had 1.42% and 3.33%). Each cell runs the same noise stream under both rules (common random numbers): v0.3 judges the quiet host's candidates against the segment's threshold (the noisy host's), v1 against its own. The noisy host's threshold is the same under both rules, so its verdicts are identical. 1,000 candidates per cell (`SIM_TRIALS=1000`; the suite runs 150 per cell and asserts the bounds):

| True effect | Quiet host: wins v0.3 → v1 | Quiet host: losses v0.3 → v1 | Quiet host: first-measurement wins v0.3 → v1 | Noisy host: wins | Noisy host: losses | Noisy host: first-measurement wins |
|---|---|---|---|---|---|---|
| −2% | 0.0% → 0.0% | 42.5% → 45.9% | 0.0% → 0.0% | 0.0% | 16.8% | 0.0% |
| 0 | 0.0% → 0.0% | 4.5% → 6.0% | 0.0% → 0.9% | 0.0% | 5.5% | 0.6% |
| +1% | 0.0% → 1.0% | 0.7% → 0.8% | 0.1% → 7.8% | 0.1% | 2.7% | 1.4% |
| +2% | 0.0% → 19.4% | 0.0% → 0.1% | 0.8% → 45.4% | 0.4% | 1.1% | 4.6% |
| +3% | 1.3% → 80.9% | 0.0% → 0.0% | 11.6% → 89.4% | 2.2% | 0.4% | 13.6% |
| +4.5% | 64.8% → 99.9% | 0.0% → 0.0% | 80.3% → 100.0% | 14.7% | 0.2% | 38.4% |
| +6% | 99.1% → 100.0% | 0.0% → 0.0% | 99.7% → 100.0% | 52.9% | 0.0% | 73.4% |

- **False wins per host.** 0.0% on both hosts at no true effect and at −2%, under both rules. Before the confirmation, the quiet host's own threshold gives chance wins at 0.9%, about the noisy host's 0.6% under its own. That is the nominal per-host rate the threshold is calibrated for, where v0.3 held the quiet host to 0.0%. The confirmation removes them.
- **Detection on the quiet host.** A real 3% gain went from 1.3% to 80.9% wins, 4.5% from 64.8% to 99.9%, and 2% from 0% to 19.4%. These are the 3-6% gains the study saw end inconclusive.
- **False losses** on real gains stay at or below 0.8%. At no true effect, the quiet host's false losses rise from 4.5% to 6.0%, about the noisy host's 5.5%. A lower threshold makes the futility rule stop fewer measurements early, and some of them then end in a loss.

## Tests

- `test/v1-measurement.test.ts`, pure functions: peers' median, two-host and three-host cases, the chance ratio (including the study's 2.25× at 12 and 40 pairs), dispatch order, threshold wording, and the oracle hash with and without the new keys (also as an older stored spec without them).
- `test/v1-measurement.test.ts`, fake hosts:
  - each host's own threshold in the verdict, with the quiet host taking a lone candidate although it is listed second, both hosts measuring at once, and every surface (Overview, Oracle tab, bench hosts, CLI);
  - a 20× noisier host excluded with the report, warning, notice and event, measuring nothing, then back after the next calibration;
  - a 2.5× host kept with the chance warning;
  - `max_host_noise_ratio = 0`;
  - an automatic recalibration that defers on a failed health check, waits `retry_seconds`, then runs without a pause;
  - the bound, the pause, and a resume that recalibrates first;
  - a recalibration that finds one host disturbed and leaves it out of the new segment.
- `test/remote-fleet.test.ts` (the example provider, real processes): a noisy remote machine is left out at calibration and leaves when it ends; two arrival replacements leave; the third machine is kept with a notice; the entry then keeps its machines, and the quiet edit host takes the candidate.
- `test/guardrails.test.ts`: an unjudgeable guardrail fails calibration end to end with both fixes; the fixes it names work (the loosened limit is above the half-width, and the half-width at the named `n_max` is below the limit); several hosts name the worst; and each noise class names its own fixes.
- `test/v1-sim.test.ts`: the simulation above.

## Live check (BB 0.45, one MacBook, a second BB instance with its own data directory, the example provider, a toy repository under /tmp)

The installed plugin and its studies were not touched: a second BB instance (own data directory and ports) ran a path install of this branch plus the example bench provider. The installed plugin's database was backed up first, and its studies and their states matched the backup afterwards.

- **Toy.** `src/cost.txt` holds a number. The protected measure sleeps in proportion to it and prints it with noise, plus a `mem` guardrail with ±3% noise. Remote commands get `AUTORESEARCH_REMOTE`, which the measure uses to pick each host's noise. Noisy class, `n_min` 3, `n_max` 6, 12 calibration pairs, `min_effect` 0.5%, one remote machine (example provider) plus the edit host, one claude-code worker, pinned ideas.
- **Study 1 (edit host ±0.2%, remote ±5%).**
  - Spec v1, with `mem` limited to 1%, failed calibration with the message quoted in item 4. Spec v2 loosened it to 3% and calibrated.
  - The remote machine was not used ("Not used: bench-provider-local #2 (noise floor 4.17% per pair, 28.5× the 0.15% median of the other bench hosts, above max_host_noise_ratio 2)") and left when the calibration ended.
  - Once running, replacements #3 and #4 calibrated on arrival and were replaced; #5 was kept, with the notice.
  - Three candidates won on the edit host (threshold 0.50%; the kept machine's was 4.08%).
  - Each win that made best's runs shorter recalibrated automatically. In segment 3 the noisy machine was replaced again on recalibration, and two more arrivals were replaced before one was kept. This churn led to `acceptsNoisy`: an entry that already hit the bound now keeps its machines, also on recalibration (covered by the fleet test).
- **Study 2 (edit host ±2%, remote ±0.2%, `max_host_noise_ratio = 20`).**
  - Calibration: "2 bench hosts, each deciding with its own win threshold: 0.50% on bench-provider-local #10, 2.02% on … (local)".
  - Both candidates went to the remote machine, which is listed after the edit host, and were judged against 0.50%.
  - A CPU burner (`yes`, 45 s) started when the first measurement began. The automatic recalibration after that promotion found both hosts unhealthy ("competing process yes … at 100% CPU (limit 90%)") and deferred three times, 5-13 s apart, then ran and opened segment 2 with no pause.
  - In segment 2 the edit host, 23.6× the remote's noise, was left out until segment 3's recalibration measured it again.
- **Seen and fixed during the check.**
  - Nested parentheses in the noisy-host reason.
  - Replacement churn after each recalibration (above).
- **Cleanup.** Both studies were archived with their threads. The second instance was stopped and its data directory and the toy repository were deleted.

## Data model

- **Migration (append-only).** `bench_hosts.excluded_json`.
- **New events.** `bench.noisy_host` (host, mode, noise, peers, ratio, limit, action `excluded`/`replaced`/`kept`, when `calibration`/`recalibration`/`arrival`), `recalibration.deferred` (tries, max, retry_seconds, problems). Both are in the live feed and replay.
- **Changed events.** `recalibration.failed` gains `health` and `tries`.
- **`studies.recalibrate_due`** gains `health_retries` and `retry_at`.
- **Calibration reports and segment details.** Every calibrated host is included, the noisy ones with `excluded` (why).
- **Remote machines.** `calibration_json` gains `guardrails`.
- **New notice kind.** `bench.noisy_host` (informational).
- **View models.**
  - Overview: `calibration.thresholds`.
  - Bench hosts: `threshold`, `excluded`.
  - Oracle calibration: `thresholds`; its hosts gain `threshold` and `excluded`.
  - Oracle segments: `thresholds`; their hosts gain `threshold` and `excluded`.
- **Removed.** `guardrailWarnings` (replaced by `guardrailProblems`).

## Not done, and known issues

- **Only calibration judges noise between hosts.** Drift checks still compare a host with its own calibration, not with its peers, so a host that becomes noisy mid-segment pauses the study for drift (as before) rather than leaving the dispatch set.
- **The chance guard's standard error is approximate** (simulated for normal noise). Heavy-tailed benchmarks make noise floors vary more, so hosts are taken out somewhat more often than 1%.
- **Single-machine mode** still serializes gates with measurements when the edit host has been left out of the dispatch set (it measures nothing then, so this only costs gate parallelism).
- **Consecutive noisy replacements are counted in memory**: a reload starts the count again.
- **Gates** keep spec order. They aren't sent to the noisier hosts to keep quiet hosts free for measurements.
