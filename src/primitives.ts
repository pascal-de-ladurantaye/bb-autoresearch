// The trust boundary's primitives for agent-run harvests: measure any two
// commits against each other, and run the gates on any commit, with the
// study's own protocol, guardrails, bench hosts, bench lock and budget.
// Agents decide what to group, split, stack and publish; every number they
// put in a PR comes from here (`bb study measure`, `bb study gate`).
//
// Each request is a row in adhoc_runs (r<seq> per study) and a background
// job; the CLI waits for it or returns at once (`--detach`). A plugin reload
// interrupts running jobs: their rows fail with a reason, and the caller runs
// them again. Requests are refused while the study runs workers and its bench
// is busy (see `refusal`).
import { BenchTransferError } from "./bench.ts";
import { RemoteHostLostError } from "./bench-provider/runner.ts";
import type { Ctx } from "./context.ts";
import type { AdhocRunRow, BenchHostRow, StudyRow } from "./db/store.ts";
import { checkHealth } from "./health.ts";
import { BenchError, strategyFor, type Sample } from "./noise.ts";
import { BENCH_BOUND_STAGES, benchLockKey, errText, gatesSerialized, hostGuardrailCalibration, measurementMde, withBench, withGateLock, type Pipeline } from "./pipeline.ts";
import { clip, safeJson } from "./prompts.ts";
import { ciText, improvementText, magnitudePct } from "./present.ts";
import { candidateRef, type StudySpec } from "./spec.ts";
import { decideVerdict } from "./verdict.ts";
import { tail } from "./bench.ts";

/** A measurement of B against A (the reference), better is positive, in the metric's own direction. */
export interface MeasureResult {
  kind: "measure";
  a: { ref: string; sha: string };
  b: { ref: string; sha: string };
  host: { id: string; name: string };
  noise: "deterministic" | "noisy" | "expensive";
  /** Pairs measured (noisy), runs compared (expensive), or 1 (deterministic). */
  n: number;
  /** Relative improvement of B over A on the primary metric: positive = B is better. */
  effect: number;
  ciLo: number | null;
  ciHi: number | null;
  /** The win threshold the classification used: the one a candidate measured on this host gets (its calibrated MDE, or the tolerance for deterministic oracles). */
  threshold: number;
  /** The candidate verdict rules applied to B against A: win (B better beyond the threshold), lose (worse), inconclusive. */
  classification: "win" | "lose" | "inconclusive";
  reasons: string[];
  /** Per guardrail: B's regression against A (positive = B worse), its CI, and the per-step limit check. */
  guardrails: Record<string, { regression: number; lo: number | null; hi: number | null; n: number; state: string; text: string }>;
  /** Median of each side's metrics. */
  metrics: { a: Record<string, number>; b: Record<string, number> };
  diag: { a: string[]; b: string[] };
  samples: Array<{ pair: number; side: "a" | "b"; metrics: Record<string, number> }>;
  seconds: number;
  /** One line: "B vs A: 12.3% lower time_s (CI +10.1% to +14.2%), 20 pairs on local: win". */
  text: string;
}

/** The study's gates on one commit, on the edit host. */
export interface GateResult {
  kind: "gate";
  ref: string;
  sha: string;
  host: { id: string; name: string };
  ok: boolean;
  /** Each gate command; a failure is retried once, and `flaky` marks one that passed on the retry. */
  commands: Array<{ command: string; ok: boolean; exitCode: number; flaky: boolean; seconds: number; tail: string }>;
  /** True when the gates held the bench lock (single-machine mode): their time counts as bench time. */
  benchLock: boolean;
  seconds: number;
  text: string;
}

export interface PrimitiveHooks {
  notify(study: StudyRow, kind: string, text: string): Promise<void>;
  publish(studyId: string): void;
}

/** What `--host` names and the request resolves (shown in errors). */
function hostLabel(h: BenchHostRow): string {
  return h.name === h.host_id ? h.name : `${h.name} (${h.host_id})`;
}

/** A ref an agent may pass: a sha, a branch or tag, `best`, `base`, `c/<n>`, or rev syntax like `best~2`. Never an option. */
export function validRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 200 && !ref.startsWith("-") && /^[A-Za-z0-9._/@{}~^:+-]+$/u.test(ref) && !ref.includes("..");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Restarts on another host when a remote machine leaves during a requested measurement. */
const MAX_LOST_RESTARTS = 3;

export class PrimitiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrimitiveRefused";
  }
}

export class Primitives {
  private jobs = new Map<number, { promise: Promise<void>; controller: AbortController }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pipeline: Pipeline,
    private readonly hooks: PrimitiveHooks,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  /**
   * Why a study can't take a measurement or gate request now (null: it can).
   * Policy: the study must be calibrated (its thresholds and side runs come
   * from calibration) and not archived. While any of its workers is live
   * (running, or finishing its last submission after a pause or freeze),
   * requests are refused unless its bench is idle (no candidate testing,
   * queued or measuring), so an agent's measurement never pushes workers'
   * verdicts back. A study without live workers always takes them.
   */
  refusal(study: StudyRow, liveWorkers: number): string | null {
    if (study.state === "draft") return `${study.slug} is a draft: approve and calibrate it first (\`bb study calibrate ${study.slug}\`)`;
    if (study.state === "archived") return `${study.slug} is archived: its bench checkouts are gone`;
    if (study.state === "calibrating") return `${study.slug} is calibrating; wait for it to finish`;
    if (!this.store.segment(study.id, study.segment)) return `${study.slug} has no calibrated segment yet`;
    if (liveWorkers > 0) {
      const busy = this.store.candidates(study.id, { stages: [...BENCH_BOUND_STAGES] }).length;
      if (busy > 0) {
        const next = study.state === "running" ? `, or pause it (\`bb study pause ${study.slug}\`) or freeze it for harvest (\`bb study harvest ${study.slug}\`) first` : " (its workers are finishing their last submissions)";
        return `${study.slug} is running ${liveWorkers} worker(s) and its bench is busy (${busy} candidate(s) testing, queued or measuring). Measure when the bench is idle${next}`;
      }
    }
    return null;
  }

  /** The commit a ref names, on the edit host: `best`, `base`, `c/<n>` (the candidate's ref), or any git revision. */
  async resolve(study: StudyRow, ref: string): Promise<string> {
    const r = ref.trim();
    if (!validRef(r)) throw new PrimitiveRefused(`${JSON.stringify(ref)} is not a ref this command takes (a sha, branch, tag, best, base, c/<n>, or rev syntax such as best~1)`);
    if (r === "best" && study.best_sha) return study.best_sha;
    if (r === "base" && study.base_sha) return study.base_sha;
    const cand = /^c\/(\d+)$/u.exec(r);
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const rev = cand ? candidateRef(study.slug, Number(cand[1])) : r.replace(/^best(?=[~^])/u, study.best_sha ?? "best").replace(/^base(?=[~^])/u, study.base_sha ?? "base");
    const sha = await runner.resolveRef(study.repo_path!, rev);
    if (!sha) throw new PrimitiveRefused(`${JSON.stringify(ref)} does not name a commit in ${study.repo_path}`);
    return sha;
  }

  /**
   * The bench host a measurement runs on: the one named, else the quietest
   * online, healthy and idle one (Pipeline.dispatchHosts: each host's own win
   * threshold, then its noise floor; hosts left out for being much noisier
   * than their peers are skipped), then any healthy one, then any online one.
   * Null when none is online now.
   */
  pickHost(study: StudyRow, name?: string | null): BenchHostRow | null {
    const spec = this.store.spec(study);
    if (name) {
      const hosts = this.pipeline.benchHosts(study);
      const h = hosts.find((x) => x.name === name || x.host_id === name);
      if (!h) throw new PrimitiveRefused(`${study.slug} has no active bench host ${JSON.stringify(name)}; its bench hosts: ${hosts.map(hostLabel).join(", ") || "none"}`);
      if (h.status === "offline") throw new PrimitiveRefused(`bench host ${h.name} is offline`);
      if (h.excluded_json) throw new PrimitiveRefused(`bench host ${h.name} is not used until the next calibration (${clip(safeJson<{ reason?: string }>(h.excluded_json)?.reason ?? "much noisier than the other bench hosts", 300)}); leave out --host, or name another host`);
      return h;
    }
    const online = this.pipeline.dispatchHosts(study, spec).filter((x) => x.status !== "offline");
    const healthy = online.filter((x) => (x.deferred_until ?? 0) <= this.ctx.now() && x.drift_status !== "drift");
    const idle = healthy.filter((x) => !this.ctx.benchLock.busy(benchLockKey(study, spec, x.host_id)));
    return idle[0] ?? healthy[0] ?? online[0] ?? null;
  }

  /**
   * Remote machines on their way, when no bench host is online: the study
   * keeps its machines (Running, or frozen for harvest) and has remote
   * entries, so the fleet is bringing them up (after a pause destroyed them,
   * or a plugin reload is re-adopting them). Null: none will come.
   */
  remoteComing(study: StudyRow): string | null {
    if (study.state !== "harvesting" && study.state !== "running") return null;
    const spec = this.store.spec(study);
    if (!spec.oracle.remote_bench?.length) return null;
    const live = this.store.remoteHosts(study.id, { live: true });
    const count = (states: string[]) => live.filter((r) => states.includes(r.state)).length;
    const adopting = live.filter((r) => r.state === "ready" && r.phase?.startsWith("re-adopting")).length;
    const parts = [
      count(["creating", "joining"]) ? `${count(["creating", "joining"])} joining` : "",
      count(["calibrating"]) ? `${count(["calibrating"])} calibrating on arrival` : "",
      adopting ? `${adopting} being re-adopted after a plugin reload` : "",
    ].filter(Boolean);
    return `waiting for a bench host: remote machines ${parts.length ? `on their way (${parts.join(", ")})` : "being requested"}`;
  }

  private noHostText(study: StudyRow): string {
    const spec = this.store.spec(study);
    return `${study.slug} has no online bench host${spec.oracle.remote_bench?.length && study.state === "paused" ? " (its remote machines are released while it is paused; freeze it for harvest with `bb study harvest`, which brings them up for its requests)" : ""}`;
  }

  /** Wait until a bench host is online (remote machines joining), up to adhocHostWaitMs. */
  private async waitForHost(row: AdhocRunRow, signal: AbortSignal): Promise<BenchHostRow> {
    const since = this.ctx.now();
    for (;;) {
      if (signal.aborted) throw new Error("cancelled");
      const study = this.store.study(row.study_id)!;
      const h = this.pickHost(study, null);
      if (h) return h;
      const coming = this.remoteComing(study);
      if (!coming) throw new Error(this.noHostText(study));
      const waited = this.ctx.now() - since;
      if (waited >= this.ctx.config.adhocHostWaitMs) throw new Error(`no bench host came online within ${Math.round(this.ctx.config.adhocHostWaitMs / 60_000)} min (${coming}); see \`bb study bench ${study.slug}\` and run it again`);
      this.progress(row, coming);
      await sleep(this.ctx.config.harvestPollMs, signal);
    }
  }

  async requestMeasure(study: StudyRow, input: { refA: string; refB: string; pairs?: number | null; host?: string | null }, actor: string, liveWorkers: number): Promise<AdhocRunRow> {
    const why = this.refusal(study, liveWorkers);
    if (why) throw new PrimitiveRefused(why);
    const spec = this.store.spec(study);
    if (input.pairs !== undefined && input.pairs !== null && spec.oracle.noise !== "noisy") throw new PrimitiveRefused(`--pairs applies to noisy oracles; ${study.slug}'s is ${spec.oracle.noise}`);
    const [shaA, shaB] = [await this.resolve(study, input.refA), await this.resolve(study, input.refB)];
    // A named host is pinned; otherwise the host is chosen when the run starts (and again if a remote machine leaves mid-run).
    const pinned = input.host ? this.pickHost(study, input.host) : null;
    if (!pinned && !this.pickHost(study, null) && !this.remoteComing(study)) throw new PrimitiveRefused(this.noHostText(study));
    const row = this.store.insertAdhocRun({ study_id: study.id, kind: "measure", ref_a: input.refA, ref_b: input.refB, sha_a: shaA, sha_b: shaB, host_id: pinned?.host_id ?? null, pairs: input.pairs ?? null, actor });
    this.store.event(study.id, "control.measure", actor, { run: row.id, seq: row.seq, a: input.refA, b: input.refB, sha_a: shaA, sha_b: shaB, host: pinned?.host_id ?? null, pairs: input.pairs ?? null });
    this.start(row.id);
    return row;
  }

  async requestGate(study: StudyRow, input: { ref: string }, actor: string, liveWorkers: number): Promise<AdhocRunRow> {
    const why = this.refusal(study, liveWorkers);
    if (why) throw new PrimitiveRefused(why);
    const sha = await this.resolve(study, input.ref);
    const row = this.store.insertAdhocRun({ study_id: study.id, kind: "gate", ref_a: null, ref_b: input.ref, sha_a: null, sha_b: sha, host_id: study.host_id, pairs: null, actor });
    this.store.event(study.id, "control.gate", actor, { run: row.id, seq: row.seq, ref: input.ref, sha });
    this.start(row.id);
    return row;
  }

  running(id: number): boolean {
    return this.jobs.has(id);
  }

  async wait(id: number, timeoutMs: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.promise, new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }

  /** Plugin dispose: stop every job quietly (their rows are failed by the next instance's reconcile). */
  abortAll(): void {
    for (const j of this.jobs.values()) j.controller.abort();
  }

  /** Archive: cancel a study's jobs. */
  cancelStudy(studyId: string, reason: string): void {
    for (const r of this.store.adhocRuns(studyId, { states: ["queued", "running"], limit: 1000 })) {
      this.jobs.get(r.id)?.controller.abort();
      this.store.updateAdhocRun(r.id, { state: "cancelled", error: reason, finished_at: this.ctx.now() });
    }
  }

  /** After a reload: jobs that were queued or running belonged to the old instance. */
  reconcile(): void {
    for (const r of this.store.unfinishedAdhocRuns()) {
      if (this.jobs.has(r.id)) continue;
      this.store.updateAdhocRun(r.id, { state: "failed", error: "interrupted by a plugin reload; run it again", finished_at: this.ctx.now() });
      this.store.event(r.study_id, `${r.kind}.adhoc_failed`, "plugin", { run: r.id, seq: r.seq, error: "interrupted by a plugin reload" });
    }
  }

  private start(id: number): void {
    const controller = new AbortController();
    const promise = (async () => {
      const row = this.store.adhocRun(id)!;
      try {
        if (row.kind === "measure") await this.runMeasure(row, controller.signal);
        else await this.runGate(row, controller.signal);
      } catch (e) {
        if (this.ctx.disposed) return;
        const fresh = this.store.adhocRun(id);
        if (!fresh || fresh.state === "cancelled") return;
        const error = controller.signal.aborted ? "cancelled" : clip(errText(e), 1000);
        this.store.updateAdhocRun(id, { state: controller.signal.aborted ? "cancelled" : "failed", error, finished_at: this.ctx.now() });
        this.store.event(row.study_id, `${row.kind}.adhoc_failed`, "plugin", { run: id, seq: row.seq, error: clip(error, 300) });
      } finally {
        this.jobs.delete(id);
        if (!this.ctx.disposed) this.hooks.publish(row.study_id);
      }
    })();
    this.jobs.set(id, { promise, controller });
  }

  private progress(row: AdhocRunRow, text: string): void {
    if (this.ctx.disposed) return;
    this.store.updateAdhocRun(row.id, { progress: clip(text, 300) });
    this.hooks.publish(row.study_id);
  }

  private finish(row: AdhocRunRow, result: MeasureResult | GateResult, benchSeconds: number): void {
    this.store.updateAdhocRun(row.id, { state: "done", result_json: JSON.stringify(result), progress: null, error: null, finished_at: this.ctx.now(), bench_seconds: benchSeconds });
    const data = result.kind === "measure"
      ? { run: row.id, seq: row.seq, effect: result.effect, lo: result.ciLo, hi: result.ciHi, n: result.n, classification: result.classification, host: result.host.id, seconds: result.seconds }
      : { run: row.id, seq: row.seq, ok: result.ok, sha: result.sha, seconds: result.seconds };
    this.store.event(row.study_id, `${row.kind}.adhoc_finished`, "plugin", data);
  }

  // ---- measure ----
  private async runMeasure(row0: AdhocRunRow, signal: AbortSignal): Promise<void> {
    const study0 = this.store.study(row0.study_id)!;
    const spec = this.store.spec(study0);
    const pinned = row0.host_id;
    if (pinned && !this.store.benchHost(study0.id, pinned)) throw new Error(`bench host ${pinned} is no longer one of the study's`);
    const label = `r${row0.seq}`;
    let benchSeconds = 0;
    let deferrals = 0;
    let lost = 0;
    for (;;) {
      if (signal.aborted) throw new Error("cancelled");
      const host = pinned ? this.store.benchHost(study0.id, pinned)! : await this.waitForHost(row0, signal);
      if (!pinned) this.store.updateAdhocRun(row0.id, { host_id: host.host_id });
      const study = this.store.study(row0.study_id)!;
      this.progress(row0, `waiting for the bench lock on ${host.name}`);
      const started = this.ctx.now();
      let out: MeasureResult | "deferred";
      try {
        out = await withBench(this.ctx, study, host.host_id, "adhoc", null, async (): Promise<MeasureResult | "deferred"> => {
          this.store.updateAdhocRun(row0.id, { state: "running", started_at: this.store.adhocRun(row0.id)!.started_at ?? this.ctx.now() });
          const health = await checkHealth(this.ctx, study, host, spec, "measure", (kind, text) => this.hooks.notify(study, kind, text));
          if (!health.ok) return "deferred";
          return await this.measureOn(study, spec, host, row0, label, signal);
        });
      } catch (e) {
        if (e instanceof RemoteHostLostError) {
          // A remote machine left (lifetime, provider): start again on another host, unless the caller pinned this one.
          if (!pinned && lost < MAX_LOST_RESTARTS && !signal.aborted) {
            lost += 1;
            this.progress(row0, `${host.name} left during the measurement; starting again on another bench host (${lost} of ${MAX_LOST_RESTARTS})`);
            continue;
          }
          throw new Error(`bench host ${host.name} left during the measurement (a remote machine ends its lifetime or was lost); run it again`);
        }
        if (e instanceof BenchError) throw new Error(`measure failed on side ${e.side === "best" ? "A" : "B"}: ${e.message}${e.output ? `\n${clip(e.output, 600)}` : ""}`);
        if (e instanceof BenchTransferError) throw new Error(`could not send ${e.purpose === "best" ? "A" : "B"} to ${host.name}: ${e.message}`);
        throw e;
      } finally {
        const seconds = (this.ctx.now() - started) / 1000;
        benchSeconds += seconds;
        if (!this.ctx.disposed) this.store.addBenchSeconds(study.id, seconds);
      }
      if (out !== "deferred") {
        this.finish(row0, out, benchSeconds);
        return;
      }
      if (deferrals >= this.ctx.config.adhocHealthTries) throw new Error(`bench host ${host.name} stayed unhealthy; the measurement could not run`);
      deferrals += 1;
      this.progress(row0, `${host.name} failed its health check; retrying in ${spec.oracle.health.retry_seconds} s`);
      await sleep(spec.oracle.health.retry_seconds * 1000, signal);
    }
  }

  private async measureOn(study: StudyRow, spec: StudySpec, host: BenchHostRow, row: AdhocRunRow, label: string, signal: AbortSignal): Promise<MeasureResult> {
    const site = this.pipeline.site(study, host);
    const shaA = row.sha_a!;
    const shaB = row.sha_b;
    const started = this.ctx.now();
    this.progress(row, `building A ${shaA.slice(0, 10)} on ${host.name}`);
    let dirA: string;
    if (shaA === study.best_sha) {
      const b = await site.bestCheckout(shaA, spec, signal);
      if (!b.ok) throw new Error(`A (${shaA.slice(0, 10)}) does not build on ${host.name}: ${clip(b.output, 600)}`);
      dirA = b.dir;
    } else {
      dirA = await site.checkout("adhoc-a", shaA, "best", label, signal);
      const b = await site.build(dirA, spec, `${label} A`, signal);
      if (!b.ok) throw new Error(`A (${shaA.slice(0, 10)}) does not build on ${host.name}: ${clip(b.output, 600)}`);
    }
    this.progress(row, `building B ${shaB.slice(0, 10)} on ${host.name}`);
    const dirB = await site.checkout("adhoc-b", shaB, "candidate", label, signal);
    const built = await site.build(dirB, spec, `${label} B`, signal);
    if (!built.ok) throw new Error(`B (${shaB.slice(0, 10)}) does not build on ${host.name}: ${clip(built.output, 600)}`);
    // An estimate, not a sequential decision: a fixed number of pairs (the study's n_max unless --pairs).
    const pairs = spec.oracle.noise === "noisy" ? (row.pairs ?? spec.oracle.protocol.n_max) : spec.oracle.protocol.n_max;
    const fixed: StudySpec = { ...spec, oracle: { ...spec.oracle, protocol: { ...spec.oracle.protocol, n_min: pairs, n_max: pairs, early_lose_from: 0, futility: false } } };
    const segment = this.store.segment(study.id, study.segment);
    const hostRow = this.store.benchHost(study.id, host.host_id)!;
    // The same win threshold a candidate measured on this host gets.
    const threshold = measurementMde(this.store, study, spec, hostRow);
    const baseline = safeJson<{ sha: string; runs: never[] }>(hostRow.baseline_json);
    const samples: MeasureResult["samples"] = [];
    const strategy = strategyFor(spec.oracle.noise);
    this.progress(row, `measuring on ${host.name}: 0/${pairs} pair(s)`);
    const outcome = await strategy.measure({
      bench: site.bench(fixed, { best: dirA, candidate: dirB }, { signal, label }),
      spec: fixed,
      mde: threshold,
      rng: this.ctx.rng,
      record: (s: Sample) => {
        samples.push({ pair: s.pair, side: s.side === "best" ? "a" : "b", metrics: s.metrics });
        if (s.side === "candidate" && spec.oracle.noise === "noisy") this.progress(row, `measuring on ${host.name}: ${s.pair}/${pairs} pair(s)`);
      },
      bestCache: null,
      baseline: baseline?.sha === shaA ? baseline.runs : null,
      noiseFloor: hostRow.noise_floor ?? segment?.noise_floor ?? null,
      // The measuring host's own guardrail noise, as for a candidate measured there.
      guardrailNoise: Object.fromEntries(hostGuardrailCalibration(this.store, study, host.host_id).map((g) => [g.name, g.noise])),
      signal,
    });
    const verdict = decideVerdict(outcome, spec, { mde: threshold });
    const classification = verdict.verdict === "win" ? "win" : verdict.verdict === "lose" ? "lose" : "inconclusive";
    const guardrails: MeasureResult["guardrails"] = {};
    for (const [name, j] of Object.entries(verdict.guardrails ?? {})) {
      const e = outcome.guardrailEstimates?.[name];
      guardrails[name] = { regression: e?.regression ?? outcome.guardrails[name] ?? Number.NaN, lo: e?.lo ?? null, hi: e?.hi ?? null, n: e?.n ?? outcome.n, state: j.state, text: j.text };
    }
    const metric = { name: spec.metric.name, unit: spec.metric.unit ?? "", direction: spec.metric.direction };
    const ci = outcome.ciLo !== null && outcome.ciHi !== null ? ` (${ciText(outcome.ciLo, outcome.ciHi)})` : "";
    const what = spec.oracle.noise === "noisy" ? `${outcome.n} pair(s)` : spec.oracle.noise === "expensive" ? `${outcome.n} run(s)` : "one run each";
    const seconds = (this.ctx.now() - started) / 1000;
    return {
      kind: "measure",
      a: { ref: row.ref_a!, sha: shaA },
      b: { ref: row.ref_b, sha: shaB },
      host: { id: host.host_id, name: host.name },
      noise: spec.oracle.noise,
      n: outcome.n,
      effect: outcome.effect,
      ciLo: outcome.ciLo,
      ciHi: outcome.ciHi,
      threshold,
      classification,
      reasons: verdict.reasons,
      guardrails,
      metrics: { a: outcome.bestMetrics, b: outcome.candidateMetrics },
      diag: { a: outcome.bestDiag.slice(0, 40), b: outcome.candidateDiag.slice(0, 40) },
      samples,
      seconds,
      text: `B (${row.ref_b}) vs A (${row.ref_a}): ${improvementText(outcome.effect, metric, { factor: false })}${ci}, ${what} on ${host.name}: ${classification} against the ${magnitudePct(threshold, spec.oracle.noise === "deterministic" ? 2 : 1)} ${spec.oracle.noise === "deterministic" ? "tolerance" : "threshold"}`,
    };
  }

  // ---- gate ----
  private async runGate(row: AdhocRunRow, signal: AbortSignal): Promise<void> {
    const study = this.store.study(row.study_id)!;
    const spec = this.store.spec(study);
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const serialized = gatesSerialized(this.store, study, spec);
    this.progress(row, serialized ? "waiting for the bench lock (single-machine mode: gates share it)" : "running the gates");
    const started = this.ctx.now();
    let lockSeconds = 0;
    const commands = await withGateLock(this.ctx, study, null, async () => {
      const t0 = this.ctx.now();
      this.store.updateAdhocRun(row.id, { state: "running", started_at: this.ctx.now() });
      const out: GateResult["commands"] = [];
      try {
        if (!spec.oracle.gate.length) return out;
        const dir = await runner.checkout(study.repo_path!, `${study.slug}-adhoc-gate`, row.sha_b);
        for (const command of spec.oracle.gate) {
          if (signal.aborted) throw new Error("cancelled");
          this.progress(row, `gate: ${clip(command, 120)}`);
          const job = { cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: `r${row.seq} gate` };
          const c0 = this.ctx.now();
          const first = await runner.run(job, { signal });
          if (first.exitCode === 0) {
            out.push({ command, ok: true, exitCode: 0, flaky: false, seconds: (this.ctx.now() - c0) / 1000, tail: "" });
            continue;
          }
          const retry = await runner.run(job, { signal });
          out.push({ command, ok: retry.exitCode === 0, exitCode: retry.exitCode ?? -1, flaky: retry.exitCode === 0, seconds: (this.ctx.now() - c0) / 1000, tail: clip(tail(retry.exitCode === 0 ? first : retry), 1500) });
          if (retry.exitCode !== 0) break;
        }
        return out;
      } finally {
        lockSeconds = (this.ctx.now() - t0) / 1000;
      }
    });
    // Gates count as bench time only when they held the bench lock (single-machine mode), as a candidate's do.
    if (serialized && !this.ctx.disposed) this.store.addBenchSeconds(study.id, lockSeconds);
    const ok = commands.every((c) => c.ok);
    const seconds = (this.ctx.now() - started) / 1000;
    const failed = commands.find((c) => !c.ok);
    const result: GateResult = {
      kind: "gate",
      ref: row.ref_b,
      sha: row.sha_b,
      host: { id: study.host_id!, name: "edit host" },
      ok,
      commands,
      benchLock: serialized,
      seconds,
      text: !spec.oracle.gate.length
        ? `${row.ref_b} (${row.sha_b.slice(0, 10)}): the study has no gates`
        : ok
          ? `${row.ref_b} (${row.sha_b.slice(0, 10)}): ${commands.length} gate(s) pass${commands.some((c) => c.flaky) ? ` (${commands.filter((c) => c.flaky).length} flaky: passed on the retry)` : ""}`
          : `${row.ref_b} (${row.sha_b.slice(0, 10)}): gate failed: ${clip(failed!.command, 160)} exited ${failed!.exitCode}`,
    };
    this.finish(row, result, serialized ? lockSeconds : 0);
  }
}

/** One line per run for the CLI and the Harvest tab: "r3 measure best~1 → best: …" */
export function adhocLine(r: AdhocRunRow): string {
  const what = r.kind === "measure" ? `measure B ${r.ref_b} vs A ${r.ref_a}` : `gate ${r.ref_b}`;
  const result = safeJson<MeasureResult | GateResult>(r.result_json);
  const tailText = r.state === "done" && result ? result.text : r.state === "failed" || r.state === "cancelled" ? `${r.state}: ${clip(r.error ?? "", 300)}` : `${r.state}${r.progress ? ` (${r.progress})` : ""}`;
  return `r${r.seq} ${what}: ${tailText}`;
}

/** Parsed result of a run (null until done). */
export function adhocResult(r: AdhocRunRow): MeasureResult | GateResult | null {
  return safeJson<MeasureResult | GateResult>(r.result_json);
}

