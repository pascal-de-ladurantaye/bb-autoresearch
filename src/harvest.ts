// Harvest: turn base→best into reviewable changesets backed by measurements.
//
//   waiting   in-flight candidates finish (no new submissions), then best is frozen
//   grouping  the strategist proposes changesets (study_propose_harvest); if it
//             doesn't within agents' time, one changeset per promotion
//   ablating  per changeset S: best with S reverted, gated, measured against best
//             with the study's noise-class protocol → contribution with CI.
//             A revert conflict or gate failure is a dependency edge. The total
//             gain (base vs best) is measured the same way, and stacks whose
//             members couldn't be ablated alone are ablated together.
//   checking  stacks in dependency order (topological over the edges and
//             commit-level file overlap; coupled groups fold into one PR);
//             each layer applied on its PR base (the segment base, or the
//             previous layer) with gates, folding a layer that doesn't apply
//             into the layer(s) it needs, and optionally its standalone effect
//   drafting  one branch per changeset, PR bodies, the study report, and the
//             publisher (dry-run by default: local branches + files only)
//   ready     the human publishes (`--publish`), keeps exploring, or archives
//
// Every phase persists per-changeset results, so a restart resumes where it
// stopped. Measurements hold the bench lock like any other bench work.
import type { Ctx } from "./context.ts";
import type { BenchHostRow, ChangesetRow, HarvestRow, StudyRow } from "./db/store.ts";
import { BenchTransferError } from "./bench.ts";
import {
  applyProposal,
  branchSlug,
  contributionFromAblation,
  earlierDependencies,
  fallbackGrouping,
  fitLayers,
  foldLines,
  harvestBranch,
  harvestExportKey,
  isDroppable,
  laterDependents,
  planStacks,
  prOrder,
  stackOrderText,
  type CsNode,
  type Estimate,
  type FitOutcome,
  type Layer,
  type OrderNode,
  type PlannedChangeset,
  type Promotion,
  type ProposedGroup,
} from "./harvest-math.ts";
import { checkHealth } from "./health.ts";
import { BenchError, strategyFor } from "./noise.ts";
import type { GuardrailEstimate } from "./guardrails.ts";
import { errText, gitId, IN_FLIGHT_STAGES, segmentGuardrailCalibration, withBench, withGateLock, type Pipeline } from "./pipeline.ts";
import type { ComposeInput, ComposeResult } from "./host/contract.ts";
import { clip, safeJson } from "./prompts.ts";
import { DryRunPublisher, type PrDraft } from "./publisher.ts";
import { prBody, studyReport } from "./report.ts";
import { clipWords } from "./present.ts";
import { bestBranch, type StudySpec } from "./spec.ts";
import { tail } from "./bench.ts";

export interface HarvestHooks {
  notify(study: StudyRow, kind: string, text: string, opts?: { quiet?: boolean }): Promise<void>;
  /** Ask the strategist for a grouping; false when there is no study thread to ask. */
  sendGroupingRound(study: StudyRow, harvest: HarvestRow, promotions: Promotion[]): Promise<boolean>;
  publish(studyId: string): void;
}

export class HarvestCancelled extends Error {
  constructor() {
    super("harvest cancelled");
    this.name = "HarvestCancelled";
  }
}

export interface StackRecord {
  stack: number;
  /** Every changeset in the stack, in PR order (folded ones right after their host). */
  members: number[];
  /** The stack's PRs bottom first: each host with the changesets it ships (absent before v0.2.4). */
  layers?: Layer[];
  status: "pending" | "measured" | "not_needed" | "conflict" | "gate_failed" | "error";
  estimate: Estimate | null;
  n: number | null;
  detail: string | null;
}

type PairResult = { ok: true; effect: number; ciLo: number | null; ciHi: number | null; n: number; seconds: number; guardrails: Record<string, GuardrailCost> } | { ok: false; reason: string };

/**
 * What a set of commits costs a guardrail, relative to best: measured with
 * the commits removed ("candidate") against best ("reference"), so the cost
 * is minus that regression (positive = the commits make the guardrail worse),
 * the same sign flip as a contribution.
 */
export interface GuardrailCost {
  value: number;
  lo: number | null;
  hi: number | null;
  n: number;
}

function guardrailCosts(estimates: Record<string, GuardrailEstimate> | undefined): Record<string, GuardrailCost> {
  const out: Record<string, GuardrailCost> = {};
  for (const [name, e] of Object.entries(estimates ?? {})) {
    if (!Number.isFinite(e.regression)) continue;
    out[name] = { value: -e.regression, lo: e.hi === null ? null : -e.hi, hi: e.lo === null ? null : -e.lo, n: e.n };
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export class Harvester {
  private jobs = new Map<number, { promise: Promise<void>; controller: AbortController }>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pipeline: Pipeline,
    private readonly hooks: HarvestHooks,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  /** Plugin dispose: stop every harvest job (the next instance resumes them). */
  abortAll(): void {
    for (const j of this.jobs.values()) j.controller.abort();
  }

  running(harvestId: number): boolean {
    return this.jobs.has(harvestId);
  }

  /** Start (or resume) a harvest job in the background. */
  start(harvestId: number): void {
    if (this.jobs.has(harvestId)) return;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        await this.run(harvestId, controller.signal);
      } catch (e) {
        if (this.ctx.disposed) return;
        const h = this.store.harvest(harvestId);
        if (!h) return;
        if (e instanceof HarvestCancelled || controller.signal.aborted) {
          if (!["ready", "failed", "cancelled"].includes(h.state)) this.store.updateHarvest(harvestId, { state: "cancelled", finished_at: this.ctx.now() });
          return;
        }
        this.store.updateHarvest(harvestId, { state: "failed", error: clip(errText(e), 1000), finished_at: this.ctx.now() });
        this.store.event(h.study_id, "harvest.failed", "plugin", { harvest: harvestId, error: clip(errText(e), 500) });
        const study = this.store.study(h.study_id);
        if (study) await this.hooks.notify(study, "harvest.failed", `Harvest h${h.seq} of \`${study.slug}\` failed: ${clip(errText(e), 500)}. Next: fix the cause and start a new harvest on the Harvest tab (\`bb study harvest ${study.slug} --restart\`), or resume to keep exploring.`);
      } finally {
        this.jobs.delete(harvestId);
        const h = this.store.harvest(harvestId);
        if (h) this.hooks.publish(h.study_id);
      }
    })();
    this.jobs.set(harvestId, { promise, controller });
  }

  /** Cancel a running harvest (resume, archive, restart). */
  cancel(harvestId: number): void {
    const job = this.jobs.get(harvestId);
    if (job) job.controller.abort();
    const h = this.store.harvest(harvestId);
    if (h && !["ready", "failed", "cancelled"].includes(h.state)) this.store.updateHarvest(harvestId, { state: "cancelled", finished_at: this.ctx.now() });
  }

  async wait(harvestId: number, timeoutMs: number): Promise<void> {
    const job = this.jobs.get(harvestId);
    if (!job) return;
    await Promise.race([job.promise, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private check(signal: AbortSignal, harvestId: number): void {
    const h = this.store.harvest(harvestId);
    if (signal.aborted || !h || h.state === "cancelled") throw new HarvestCancelled();
    const study = this.store.study(h.study_id);
    if (!study || study.state !== "harvesting") throw new HarvestCancelled();
  }

  private phase(h: HarvestRow, state: HarvestRow["state"], detail: string | null = null): void {
    this.store.updateHarvest(h.id, { state, phase_detail: detail });
    this.store.event(h.study_id, "harvest.phase", "plugin", { harvest: h.id, state, detail });
    this.hooks.publish(h.study_id);
  }

  private detail(h: HarvestRow, detail: string): void {
    this.store.updateHarvest(h.id, { phase_detail: clip(detail, 300) });
    this.hooks.publish(h.study_id);
  }

  async run(harvestId: number, signal: AbortSignal): Promise<void> {
    let h = this.store.harvest(harvestId)!;
    const study0 = this.store.study(h.study_id)!;
    const spec = this.store.spec(study0);

    // ---- waiting: the bench drains, best freezes ----
    if (!h.promotions_json) {
      this.phase(h, "waiting", "in-flight candidates finish; submissions are closed");
      for (;;) {
        this.check(signal, h.id);
        const inFlight = this.store.candidates(h.study_id, { stages: [...IN_FLIGHT_STAGES] });
        if (!inFlight.length) break;
        this.detail(h, `waiting for ${inFlight.length} in-flight candidate(s): ${inFlight.map((c) => `c/${c.n} ${c.stage}`).slice(0, 5).join(", ")}`);
        this.pipeline.kick();
        await sleep(this.ctx.config.harvestPollMs, signal);
      }
      const study = this.store.study(h.study_id)!;
      if (!study.base_sha || !study.best_sha) throw new Error("the study has no base or best commit");
      const runner = this.ctx.bb.hostRunner(study.host_id!);
      const log = study.base_sha === study.best_sha ? [] : await runner.commitLog(study.repo_path!, study.base_sha, study.best_sha);
      const promotions: Promotion[] = log.map((c) => {
        const n = Number(/Autoresearch-Candidate: c\/(\d+)/u.exec(c.message)?.[1] ?? Number.NaN);
        const cand = Number.isFinite(n) ? this.store.candidateByN(study.id, n) : this.store.candidates(study.id).find((x) => x.promoted_sha === c.sha);
        const idea = cand?.idea_id ? this.store.idea(cand.idea_id) : undefined;
        return { sha: c.sha, n: cand?.n ?? null, title: clip(idea?.title ?? c.subject, 120), paths: c.paths };
      });
      this.store.updateHarvest(h.id, { base_sha: study.base_sha, best_sha: study.best_sha, segment: study.segment, promotions_json: JSON.stringify(promotions) });
      this.store.event(study.id, "harvest.frozen", "plugin", { harvest: h.id, base: study.base_sha, best: study.best_sha, promotions: promotions.length });
      h = this.store.harvest(h.id)!;
    }
    const promotions = safeJson<Promotion[]>(h.promotions_json) ?? [];

    // ---- grouping ----
    if (!this.store.changesets(h.id).length && promotions.length) {
      this.phase(h, "grouping", "asking the strategist for changesets (study_propose_harvest)");
      const planned = await this.group(h, promotions, spec, signal);
      h = this.store.harvest(h.id)!;
      this.store.tx(() => {
        planned.forEach((p, i) =>
          this.store.insertChangeset({
            harvest_id: h.id,
            study_id: h.study_id,
            k: i + 1,
            title: clip(p.title, 200),
            rationale: clip(p.rationale, 2000),
            candidates_json: JSON.stringify(p.promotions.map((x) => x.n).filter((x) => x !== null)),
            commits_json: JSON.stringify(p.promotions.map((x) => x.sha)),
            paths_json: JSON.stringify([...new Set(p.promotions.flatMap((x) => x.paths))].slice(0, 2000)),
          }),
        );
        this.store.event(h.study_id, "harvest.grouped", "plugin", { harvest: h.id, source: h.grouping_source, changesets: planned.length });
      });
    }

    if (promotions.length) {
      // ---- ablating ----
      this.phase(h, "ablating");
      await this.measureTotal(h.id, spec, signal);
      for (const cs of this.store.changesets(h.id)) {
        if (cs.ablation_status !== "pending") continue;
        this.check(signal, h.id);
        await this.ablate(h.id, cs.id, spec, signal);
      }
      this.restack(h.id);
      await this.ablateStacks(h.id, spec, signal);

      // ---- checking: each changeset on its PR base ----
      this.phase(h, "checking");
      await this.standalone(h.id, spec, signal);
    }

    // ---- drafting ----
    this.check(signal, h.id);
    this.phase(this.store.harvest(h.id)!, "drafting");
    await this.draft(h.id, spec);
    h = this.store.harvest(h.id)!;
    this.store.updateHarvest(h.id, { state: "ready", phase_detail: null, finished_at: this.ctx.now() });
    this.store.event(h.study_id, "harvest.ready", "plugin", { harvest: h.id, changesets: this.store.changesets(h.id).length, export: h.export_dir });
    const study = this.store.study(h.study_id)!;
    await this.hooks.notify(study, "harvest.ready", harvestReadyText(this.ctx, study, this.store.harvest(h.id)!));
  }

  // ---- grouping ----
  private async group(h: HarvestRow, promotions: Promotion[], spec: StudySpec, signal: AbortSignal): Promise<PlannedChangeset[]> {
    const study = this.store.study(h.study_id)!;
    const useFallback = (why: string) => {
      this.store.updateHarvest(h.id, { grouping_source: "fallback", grouping_notes: why });
      this.store.event(study.id, "harvest.grouping_fallback", "plugin", { harvest: h.id, reason: why });
      return fallbackGrouping(promotions, why);
    };
    if (h.grouping_source === "fallback") return useFallback(h.grouping_notes ?? "one changeset per promotion, as you asked");
    if (promotions.length === 1) return useFallback("one promotion: one changeset");
    const asked = await this.hooks.sendGroupingRound(study, h, promotions).catch((e) => {
      this.ctx.bb.log("warn", `harvest grouping round: ${errText(e)}`);
      return false;
    });
    if (!asked) return useFallback("no study thread to ask");
    const sentAt = this.ctx.now();
    this.store.updateHarvest(h.id, { round_sent_at: sentAt });
    const timeoutMs = spec.harvest.group_timeout_minutes * 60_000;
    let idleSince: number | null = null;
    for (;;) {
      this.check(signal, h.id);
      const proposal = this.store.harvestProposal(h.id);
      if (proposal) {
        const groups = safeJson<ProposedGroup[]>(proposal.proposal_json) ?? [];
        const r = applyProposal(promotions, groups);
        if (r.ok) {
          this.store.updateHarvest(h.id, { grouping_source: "strategist", proposal_id: proposal.id, grouping_notes: r.notes.join("; ") || null });
          return r.changesets;
        }
      }
      const now = this.ctx.now();
      if (now - sentAt >= timeoutMs) return useFallback(`the strategist did not propose a valid grouping within ${spec.harvest.group_timeout_minutes} min`);
      // The round's turn ended without a proposal: give it a short grace, then fall back.
      const s = this.store.study(h.study_id)!;
      if (!s.round_in_flight) {
        idleSince ??= now;
        if (now - idleSince >= this.ctx.config.harvestGroupGraceMs) return useFallback("the strategist's turn ended without a valid study_propose_harvest");
      } else idleSince = null;
      await sleep(this.ctx.config.harvestPollMs, signal);
    }
  }

  // ---- bench measurement of two commits (ref = "best" side) ----
  private benchHost(study: StudyRow): BenchHostRow {
    const hosts = this.pipeline.benchHosts(study).filter((x) => x.status !== "offline");
    const host = hosts.find((x) => (x.deferred_until ?? 0) <= this.ctx.now()) ?? hosts[0] ?? this.pipeline.benchHosts(study)[0];
    if (!host) throw new Error("the study has no bench host");
    return host;
  }

  /** Measure `otherSha` against `refSha` with the study's noise-class protocol (noisy: a full n_max-pair run, no early stop). */
  private async measurePair(harvestId: number, spec: StudySpec, refSha: string, otherSha: string, label: string, signal: AbortSignal): Promise<PairResult> {
    const h = this.store.harvest(harvestId)!;
    for (let attempt = 0; ; attempt++) {
      this.check(signal, harvestId);
      const study = this.store.study(h.study_id)!;
      const host = this.benchHost(study);
      const started = this.ctx.now();
      const out = await withBench(this.ctx, study, host.host_id, "harvest", null, async (): Promise<PairResult | "deferred"> => {
        const health = await checkHealth(this.ctx, study, host, spec, "measure", (kind, text) => this.hooks.notify(study, kind, text));
        if (!health.ok) return "deferred";
        const site = this.pipeline.site(study, host);
        try {
          let refDir: string;
          if (refSha === study.best_sha) {
            const b = await site.bestCheckout(refSha, spec, signal);
            if (!b.ok) throw new Error(`best ${refSha.slice(0, 10)} does not build on ${host.name}: ${clip(b.output, 300)}`);
            refDir = b.dir;
          } else {
            refDir = await site.checkout("hbase", refSha, "best", label, signal);
            const b = await site.build(refDir, spec, `${label} base`, signal);
            if (!b.ok) throw new Error(`${refSha.slice(0, 10)} does not build on ${host.name}: ${clip(b.output, 300)}`);
          }
          const dir = await site.checkout("harvest", otherSha, "candidate", label, signal);
          const built = await site.build(dir, spec, label, signal);
          if (!built.ok) return { ok: false, reason: `build failed: ${clip(built.output, 300)}` };
          const strategy = strategyFor(spec.oracle.noise);
          // A contribution needs an estimate, not a decision: run the full n_max pairs.
          const fixed: StudySpec = { ...spec, oracle: { ...spec.oracle, protocol: { ...spec.oracle.protocol, n_min: spec.oracle.protocol.n_max } } };
          const segment = this.store.segment(study.id, study.segment);
          const row = this.store.benchHost(study.id, host.host_id)!;
          const baseline = safeJson<{ sha: string; runs: never[] }>(row.baseline_json);
          this.detail(h, `${label} on ${host.name}`);
          const outcome = await strategy.measure({
            bench: site.bench(fixed, { best: refDir, candidate: dir }, { signal, label }),
            spec: fixed,
            mde: Math.max(segment?.mde ?? spec.oracle.protocol.min_effect, row.mde ?? 0),
            rng: this.ctx.rng,
            record: () => undefined,
            bestCache: null,
            baseline: baseline?.sha === refSha ? baseline.runs : null,
            noiseFloor: row.noise_floor ?? segment?.noise_floor ?? null,
            guardrailNoise: Object.fromEntries(segmentGuardrailCalibration(this.store, study).map((g) => [g.name, g.noise])),
            signal,
          });
          const seconds = (this.ctx.now() - started) / 1000;
          return { ok: true, effect: outcome.effect, ciLo: outcome.ciLo, ciHi: outcome.ciHi, n: outcome.n, seconds, guardrails: guardrailCosts(outcome.guardrailEstimates) };
        } catch (e) {
          if (e instanceof BenchError && e.side === "candidate") return { ok: false, reason: `measure failed: ${e.message}` };
          if (e instanceof BenchTransferError && e.purpose === "candidate") return { ok: false, reason: `transfer failed: ${e.message}` };
          throw e;
        }
      });
      const seconds = (this.ctx.now() - started) / 1000;
      this.store.addBenchSeconds(h.study_id, seconds);
      const fresh = this.store.harvest(harvestId)!;
      this.store.updateHarvest(harvestId, { bench_seconds: fresh.bench_seconds + seconds });
      if (out !== "deferred") return out;
      if (attempt >= this.ctx.config.harvestHealthTries) throw new Error(`bench host ${host.name} stayed unhealthy; harvest measurements could not run`);
      await sleep(spec.oracle.health.retry_seconds * 1000, signal);
    }
  }

  /** composeCommits on the edit host, authored as the study's commit identity (identity.ts). */
  private async compose(study: StudyRow, input: Omit<ComposeInput, "identity">): Promise<ComposeResult> {
    const identity = gitId(await this.pipeline.commitIdentity(study));
    return await this.ctx.bb.hostRunner(study.host_id!).composeCommits({ ...input, identity });
  }

  /** Gates on the edit host for a harvest commit (one retry for flaky gates). */
  private async gates(study: StudyRow, spec: StudySpec, sha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!spec.oracle.gate.length) return { ok: true };
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    // Single-machine mode: harvest gates hold the edit host's bench lock too.
    return await withGateLock(this.ctx, study, null, async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const dir = await runner.checkout(study.repo_path!, `${study.slug}-harvest-gate`, sha);
      for (const command of spec.oracle.gate) {
        const job = { cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: "harvest gate" };
        const r = await runner.run(job);
        if (r.exitCode === 0) continue;
        const retry = await runner.run(job);
        if (retry.exitCode !== 0) return { ok: false, reason: `gate failed: ${clip(command, 200)} exited ${retry.exitCode}: ${clip(tail(retry), 400)}` };
      }
      return { ok: true };
    });
  }

  private async measureTotal(harvestId: number, spec: StudySpec, signal: AbortSignal): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    if (h.total_effect !== null) return;
    this.check(signal, harvestId);
    // Base measured as the "candidate" against best: the gain relative to best, the scale every contribution uses.
    const r = await this.measurePair(harvestId, spec, h.best_sha!, h.base_sha!, "total gain (base vs best)", signal);
    if (!r.ok) throw new Error(`could not measure the base against best: ${r.reason}`);
    const e = contributionFromAblation(r.effect, r.ciLo, r.ciHi);
    // The same gain relative to base (the usual "best vs base"): t_rel_best / (1 + t_rel_best).
    const vsBase = e.value / (1 + e.value);
    this.store.updateHarvest(harvestId, { total_effect: e.value, total_ci_lo: e.lo, total_ci_hi: e.hi, total_n: r.n, total_vs_base: Number.isFinite(vsBase) ? vsBase : null, total_guardrails_json: JSON.stringify(r.guardrails) });
    this.store.event(h.study_id, "harvest.total", "plugin", { harvest: harvestId, total: e.value, lo: e.lo, hi: e.hi, n: r.n });
  }

  /** Commit positions on best (first-parent order) and each commit's paths, from the frozen promotion list. */
  private commitOrder(harvestId: number): { pos: Map<string, number>; paths: Map<string, string[]> } {
    const promotions = safeJson<Promotion[]>(this.store.harvest(harvestId)!.promotions_json) ?? [];
    return { pos: new Map(promotions.map((p, i) => [p.sha, i] as const)), paths: new Map(promotions.map((p) => [p.sha, p.paths] as const)) };
  }

  private nodes(harvestId: number): CsNode[] {
    const { pos } = this.commitOrder(harvestId);
    return this.store.changesets(harvestId).map((c) => {
      const at = (safeJson<string[]>(c.commits_json) ?? []).map((sha) => pos.get(sha)).filter((x): x is number => x !== undefined);
      return { id: c.id, k: c.k, paths: safeJson<string[]>(c.paths_json) ?? [], dependsOn: safeJson<number[]>(c.depends_on_json) ?? [], ...(at.length ? { first: Math.min(...at), last: Math.max(...at) } : {}) };
    });
  }

  private addDependency(dependentId: number, onId: number, reason: string): void {
    const c = this.store.changeset(dependentId)!;
    const deps = new Set(safeJson<number[]>(c.depends_on_json) ?? []);
    if (deps.has(onId) || dependentId === onId) return;
    deps.add(onId);
    const on = this.store.changeset(onId)!;
    const why = [c.dependency_reason, `depends on #${on.k}: ${reason}`].filter(Boolean).join("; ");
    this.store.updateChangeset(dependentId, { depends_on_json: JSON.stringify([...deps]), dependency_reason: clip(why, 1000) });
    this.store.event(c.study_id, "harvest.dependency", "plugin", { harvest: c.harvest_id, changeset: c.k, on: on.k, reason: clip(reason, 300) });
  }

  private async ablate(harvestId: number, csId: number, spec: StudySpec, signal: AbortSignal): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const cs = this.store.changeset(csId)!;
    const commits = safeJson<string[]>(cs.commits_json) ?? [];
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    this.detail(h, `#${cs.k}: reverting from best`);
    const composed = await this.compose(study, {
      repoPath: study.repo_path!,
      onto: h.best_sha!,
      steps: [...commits].reverse().map((sha) => ({ sha, revert: true })),
      message: `autoresearch harvest h${h.seq}: best without #${cs.k} ${clip(cs.title, 60)}`,
    });
    const nodes = this.nodes(harvestId);
    const me = nodes.find((n) => n.id === cs.id)!;
    const conflictOk = async (steps: Array<{ sha: string; revert: boolean }>) =>
      (await this.compose(study, { repoPath: study.repo_path!, onto: h.best_sha!, steps, message: "autoresearch harvest probe" })).status === "ok";
    if (composed.status === "conflict") {
      const dep = await this.revertBlockers(harvestId, cs, laterDependents(me, nodes, composed.paths).ids, conflictOk);
      for (const id of dep.ids) this.addDependency(id, cs.id, `reverting #${cs.k} from best conflicts in ${composed.paths.slice(0, 5).join(", ") || "?"}${dep.exact ? " unless this one is reverted too" : " (not isolated: treated as dependent)"}`);
      this.store.updateChangeset(cs.id, { ablation_status: "conflict", ablation_detail: clip(`revert conflicts in ${composed.paths.slice(0, 10).join(", ")}`, 500) });
      return;
    }
    this.store.updateChangeset(cs.id, { ablation_sha: composed.sha });
    const gateOk = async (steps: Array<{ sha: string; revert: boolean }>) => {
      const c = await this.compose(study, { repoPath: study.repo_path!, onto: h.best_sha!, steps, message: "autoresearch harvest probe" });
      return c.status === "ok" && (await this.gates(study, spec, c.sha)).ok;
    };
    const gate = await this.gates(study, spec, composed.sha);
    if (!gate.ok) {
      const dep = await this.revertBlockers(harvestId, cs, laterDependents(me, nodes).ids, gateOk);
      for (const id of dep.ids) this.addDependency(id, cs.id, `best without #${cs.k} fails gates${dep.exact ? " unless this one is reverted too" : " (not isolated: treated as dependent)"}`);
      this.store.updateChangeset(cs.id, { ablation_status: "gate_failed", ablation_detail: clip(gate.reason, 500) });
      return;
    }
    const r = await this.measurePair(harvestId, spec, h.best_sha!, composed.sha, `ablation #${cs.k}`, signal);
    if (!r.ok) {
      const dep = laterDependents(me, nodes);
      for (const id of dep.ids) this.addDependency(id, cs.id, `best without #${cs.k}: ${r.reason}`);
      this.store.updateChangeset(cs.id, { ablation_status: "gate_failed", ablation_detail: clip(r.reason, 500) });
      return;
    }
    const e = contributionFromAblation(r.effect, r.ciLo, r.ciHi);
    const tolerance = spec.oracle.noise === "deterministic" ? spec.oracle.protocol.tolerance : 0;
    this.store.updateChangeset(cs.id, { ablation_status: "measured", contribution: e.value, ci_lo: e.lo, ci_hi: e.hi, n: r.n, droppable: isDroppable(e, tolerance) ? 1 : 0, ablation_detail: null, guardrails_json: JSON.stringify(r.guardrails) });
    this.store.event(h.study_id, "harvest.ablation", "plugin", { harvest: harvestId, changeset: cs.k, contribution: e.value, lo: e.lo, hi: e.hi, n: r.n });
  }

  /**
   * Which later changesets block reverting S from best: S reverts cleanly
   * (or passes gates) once every candidate is reverted too, and keeping a
   * blocker in place makes it fail again. Pure git (merge-tree) probes, plus
   * gate runs for gate failures; when the failure can't be isolated, every
   * candidate is treated as dependent (stacking is always safe).
   */
  private async revertBlockers(harvestId: number, s: ChangesetRow, candidateIds: number[], ok: (steps: Array<{ sha: string; revert: boolean }>) => Promise<boolean>): Promise<{ ids: number[]; exact: boolean }> {
    const h = this.store.harvest(harvestId)!;
    const order = new Map((safeJson<Promotion[]>(h.promotions_json) ?? []).map((p, i) => [p.sha, i] as const));
    const all = this.store.changesets(harvestId);
    const later = candidateIds.map((id) => all.find((c) => c.id === id)!).filter(Boolean);
    if (!later.length || later.length > 12) return { ids: later.map((c) => c.id), exact: false };
    const reverts = (members: ChangesetRow[]) =>
      members
        .flatMap((m) => safeJson<string[]>(m.commits_json) ?? [])
        .sort((a, b) => order.get(b)! - order.get(a)!)
        .map((sha) => ({ sha, revert: true }));
    const mine = reverts([s]);
    this.detail(h, `#${s.k}: isolating which later changesets depend on it`);
    if (!(await ok([...reverts(later), ...mine]))) return { ids: later.map((c) => c.id), exact: false };
    const blockers: number[] = [];
    for (const t of later) {
      const rest = later.filter((x) => x.id !== t.id);
      if (!(await ok([...reverts(rest), ...mine]))) blockers.push(t.id);
    }
    return blockers.length ? { ids: blockers, exact: true } : { ids: later.map((c) => c.id), exact: false };
  }

  /**
   * Which other changesets a group needs to apply (and, for a gate failure,
   * pass its gates) on the base: the same probe, forward. The group applies
   * once every candidate is picked with it (in best order); then candidates
   * are left out one by one (newest first) while it still applies, leaving a
   * minimal set that works. When even all of them don't suffice, every
   * candidate is treated as needed (stacking is always safe).
   */
  private async applyBlockers(harvestId: number, group: ChangesetRow[], candidateIds: number[], withGates: boolean, spec: StudySpec): Promise<{ ids: number[]; exact: boolean; enough: boolean }> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const { pos: order } = this.commitOrder(harvestId);
    const all = this.store.changesets(harvestId);
    const others = candidateIds.map((id) => all.find((c) => c.id === id)!).filter(Boolean);
    if (!others.length || others.length > 12) return { ids: others.map((c) => c.id), exact: false, enough: others.length > 0 };
    const picks = (members: ChangesetRow[]) =>
      members
        .flatMap((m) => safeJson<string[]>(m.commits_json) ?? [])
        .sort((a, b) => order.get(a)! - order.get(b)!)
        .map((sha) => ({ sha, revert: false }));
    const ok = async (members: ChangesetRow[]) => {
      const c = await this.compose(study, { repoPath: study.repo_path!, onto: h.base_sha!, steps: picks(members), message: "autoresearch harvest probe" });
      return c.status === "ok" && (!withGates || (await this.gates(study, spec, c.sha)).ok);
    };
    this.detail(h, `${group.map((g) => `#${g.k}`).join(", ")}: isolating which changesets ${group.length === 1 ? "it needs" : "they need"} on the base`);
    // Not enough even with all of them: every candidate is needed, and maybe more.
    if (!(await ok([...others, ...group]))) return { ids: others.map((c) => c.id), exact: false, enough: false };
    // Shrink to a minimal set that still works, newest first (so the earlier of two alternatives is kept):
    // every candidate needed on its own stays, and of interchangeable ones (either helper will do) one does.
    let keep = [...others];
    const newest = (c: ChangesetRow) => Math.max(...(safeJson<string[]>(c.commits_json) ?? []).map((sha) => order.get(sha) ?? -1));
    for (const t of [...others].sort((a, b) => newest(b) - newest(a))) {
      const rest = keep.filter((x) => x.id !== t.id);
      if (await ok([...rest, ...group])) keep = rest;
    }
    return keep.length ? { ids: keep.map((c) => c.id), exact: true, enough: true } : { ids: others.map((c) => c.id), exact: false, enough: true };
  }

  /**
   * Recompute stacks and their PR order from the dependency edges, commit-level
   * file overlap and the folds so far; fold coupled groups (cycles); write each
   * changeset's stack, layer, PR base and fold. A stack whose layers changed
   * is checked again from its first layer.
   */
  private restack(harvestId: number): StackRecord[] {
    const h = this.store.harvest(harvestId)!;
    const { pos, paths } = this.commitOrder(harvestId);
    let changesets = this.store.changesets(harvestId);
    const orderNodes: OrderNode[] = changesets.map((c) => ({
      id: c.id,
      k: c.k,
      dependsOn: safeJson<number[]>(c.depends_on_json) ?? [],
      foldedInto: c.folded_into,
      commits: (safeJson<string[]>(c.commits_json) ?? []).filter((sha) => pos.has(sha)).map((sha) => ({ pos: pos.get(sha)!, paths: paths.get(sha) ?? [] })),
    }));
    const { stacks, folds } = planStacks(orderNodes);
    const prior = safeJson<StackRecord[]>(h.stacks_json) ?? [];
    const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x, y) => x - y).join(",") === [...b].sort((x, y) => x - y).join(",");
    const layerKey = (ls: Layer[] | undefined) => (ls ?? []).map((l) => `${l.host}:${[...l.members].sort((x, y) => x - y).join(",")}`).join("|");
    const records: StackRecord[] = stacks.map((st, i) => {
      const members = st.layers.flatMap((l) => l.members);
      const same = prior.find((p) => sameSet(p.members, members));
      return same ? { ...same, stack: i + 1, members, layers: st.layers } : { stack: i + 1, members, layers: st.layers, status: "pending", estimate: null, n: null, detail: null };
    });
    const k = (id: number) => changesets.find((c) => c.id === id)?.k ?? 0;
    const reset = { standalone_status: "pending", standalone_sha: null, standalone_effect: null, standalone_ci_lo: null, standalone_ci_hi: null, standalone_detail: null } as const;
    this.store.tx(() => {
      for (const f of folds) {
        this.store.updateChangeset(f.id, { folded_into: f.into, fold_reason: foldReason(this.store.changeset(f.id)!, f.reason) });
        this.store.event(h.study_id, "harvest.folded", "plugin", { harvest: harvestId, changesets: [k(f.id)], into: k(f.into), reason: clip(f.reason, 300) });
      }
      changesets = this.store.changesets(harvestId);
      const place = new Map<number, { stack: number; layer: number; prBase: string; host: number }>();
      for (const rec of records) {
        rec.layers!.forEach((l, li) => {
          const prBase = li === 0 ? "base" : `#${k(rec.layers![li - 1]!.host)}`;
          for (const m of l.members) place.set(m, { stack: rec.stack, layer: li + 1, prBase, host: l.host });
        });
      }
      for (const c of changesets) {
        const p = place.get(c.id);
        const stack = p?.stack ?? null;
        const layer = p?.layer ?? null;
        const folded = p ? p.host !== c.id : false;
        const prBase = folded ? null : (p?.prBase ?? "base");
        const before = prior.find((r) => r.members.includes(c.id));
        const after = records.find((r) => r.members.includes(c.id));
        // Checked again when its stack's layers changed, or it moved in or out of one.
        const changed = layerKey(before?.layers) !== layerKey(after?.layers) || c.pr_base !== prBase;
        const patch: Partial<Omit<ChangesetRow, "id" | "harvest_id" | "study_id">> = {};
        if (c.stack !== stack) patch.stack = stack;
        if (c.layer !== layer) patch.layer = layer;
        if (c.pr_base !== prBase) patch.pr_base = prBase;
        if (folded) {
          if (c.folded_into !== p!.host) patch.folded_into = p!.host;
          if (c.standalone_status !== "folded") Object.assign(patch, reset, { standalone_status: "folded" });
        } else {
          if (c.folded_into !== null) Object.assign(patch, { folded_into: null, fold_reason: null });
          if ((changed || c.standalone_status === "folded") && c.standalone_status !== "pending") Object.assign(patch, reset);
        }
        if (Object.keys(patch).length) this.store.updateChangeset(c.id, patch);
      }
      this.store.updateHarvest(harvestId, { stacks_json: JSON.stringify(records) });
    });
    return records;
  }

  /** A stack with a member that couldn't be ablated alone is ablated as a whole (its joint contribution stands in for the members). */
  private async ablateStacks(harvestId: number, spec: StudySpec, signal: AbortSignal): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const records = safeJson<StackRecord[]>(h.stacks_json) ?? [];
    for (const rec of records) {
      if (rec.status !== "pending") continue;
      this.check(signal, harvestId);
      const members = rec.members.map((id) => this.store.changeset(id)!);
      if (members.every((m) => m.ablation_status === "measured")) {
        rec.status = "not_needed";
        continue;
      }
      const fresh = this.store.harvest(harvestId)!;
      if (members.length === this.store.changesets(harvestId).length && fresh.total_effect !== null) {
        // Reverting every changeset is the base: the total-gain measurement already is this stack's ablation.
        Object.assign(rec, { status: "measured", estimate: { value: fresh.total_effect, lo: fresh.total_ci_lo, hi: fresh.total_ci_hi }, n: fresh.total_n, detail: "the whole study: same as the total gain" });
        continue;
      }
      const commits = members.flatMap((m) => safeJson<string[]>(m.commits_json) ?? []);
      const order = new Map((safeJson<Promotion[]>(h.promotions_json) ?? []).map((p, i) => [p.sha, i] as const));
      commits.sort((a, b) => order.get(b)! - order.get(a)!);
      this.detail(h, `stack ${rec.stack}: reverting ${members.length} changesets together`);
      const composed = await this.compose(study, {
        repoPath: study.repo_path!,
        onto: h.best_sha!,
        steps: commits.map((sha) => ({ sha, revert: true })),
        message: `autoresearch harvest h${h.seq}: best without stack ${rec.stack}`,
      });
      if (composed.status === "conflict") {
        Object.assign(rec, { status: "conflict", detail: `reverting the stack conflicts in ${composed.paths.slice(0, 5).join(", ")}` });
      } else {
        const gate = await this.gates(study, spec, composed.sha);
        if (!gate.ok) Object.assign(rec, { status: "gate_failed", detail: gate.reason });
        else {
          const r = await this.measurePair(harvestId, spec, h.best_sha!, composed.sha, `ablation stack ${rec.stack}`, signal);
          if (!r.ok) Object.assign(rec, { status: "gate_failed", detail: r.reason });
          else Object.assign(rec, { status: "measured", estimate: contributionFromAblation(r.effect, r.ciLo, r.ciHi), n: r.n, detail: null });
        }
      }
      this.store.updateHarvest(harvestId, { stacks_json: JSON.stringify(records) });
    }
    this.store.updateHarvest(harvestId, { stacks_json: JSON.stringify(records) });
  }

  /**
   * Every PR applies and passes its gates on its PR base. Each stack is
   * checked layer by layer (fitLayers), folding a layer that doesn't apply
   * into the layer(s) it needs; an independent changeset is a stack of one.
   * When even the whole stack squashed onto the base fails, it needs
   * something outside it: the other changesets are probed, the edges added
   * and the stacks recomputed. Then the standalone effects are measured.
   */
  private async standalone(harvestId: number, spec: StudySpec, signal: AbortSignal): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const { pos: order } = this.commitOrder(harvestId);
    // Compose + gate results by (PR base, host, commits): re-checks after a fold are free.
    const cache = new Map<string, FitOutcome<string>>();
    const apply = async (layer: Layer, on: string): Promise<FitOutcome<string>> => {
      const rows = layer.members.map((id) => this.store.changeset(id)!);
      const commits = rows.flatMap((r) => safeJson<string[]>(r.commits_json) ?? []).sort((a, b) => order.get(a)! - order.get(b)!);
      const key = `${on}|${layer.host}|${commits.join(",")}`;
      const hit = cache.get(key);
      if (hit) return hit;
      this.check(signal, harvestId);
      const host = rows.find((r) => r.id === layer.host)!;
      this.detail(h, `${rows.map((r) => `#${r.k}`).join("+")}: applying on ${on === h.base_sha ? "the base" : "the layer below"}`);
      const composed = await this.compose(study, { repoPath: study.repo_path!, onto: on, steps: commits.map((sha) => ({ sha, revert: false })), message: commitMessage(study, h, host, rows.filter((r) => r.id !== host.id)) });
      let out: FitOutcome<string>;
      if (composed.status === "conflict") out = { ok: false, kind: "conflict", paths: composed.paths, detail: `conflict in ${composed.paths.slice(0, 10).join(", ")}` };
      else {
        const gate = await this.gates(study, spec, composed.sha);
        out = gate.ok ? { ok: true, value: composed.sha } : { ok: false, kind: "gate_failed", paths: [], detail: gate.reason };
      }
      cache.set(key, out);
      return out;
    };
    const baseLabel = `\`${spec.study.base}\``;
    for (let pass = 0; pass < 200; pass++) {
      this.check(signal, harvestId);
      const rows = this.store.changesets(harvestId);
      const kOf = (id: number) => rows.find((r) => r.id === id)?.k ?? 0;
      const records = safeJson<StackRecord[]>(this.store.harvest(harvestId)!.stacks_json) ?? [];
      const minK = (g: Layer[]) => Math.min(...g.flatMap((l) => l.members.map(kOf)));
      const groups: Layer[][] = [
        ...records.map((r) => r.layers ?? r.members.map((m) => ({ host: m, members: [m] }))),
        ...rows.filter((c) => c.stack === null && c.folded_into === null).map((c) => [{ host: c.id, members: [c.id] }]),
      ].sort((a, b) => minK(a) - minK(b));
      let changed = false;
      for (const layers of groups) {
        const hosts = layers.map((l) => rows.find((r) => r.id === l.host)!);
        if (hosts.every((c) => c.standalone_status !== "pending")) continue;
        const fit = await fitLayers(layers, h.base_sha!, apply, {
          k: kOf,
          paths: (ids) => ids.flatMap((id) => safeJson<string[]>(rows.find((r) => r.id === id)?.paths_json ?? "[]") ?? []),
          baseLabel,
        });
        if (fit.ok) {
          if (fit.folds.length) {
            this.store.tx(() => {
              for (const f of fit.folds) {
                for (const id of f.ids) this.store.updateChangeset(id, { folded_into: f.into, fold_reason: foldReason(this.store.changeset(id)!, f.reason) });
                this.store.event(h.study_id, "harvest.folded", "plugin", { harvest: harvestId, changesets: f.ids.map(kOf), into: kOf(f.into), reason: clip(f.reason, 300) });
              }
            });
            // The stack's layers changed: recompute its order and check it again (cached results make that cheap).
            this.restack(harvestId);
            changed = true;
            break;
          }
          this.store.tx(() => {
            for (const l of fit.layers) this.store.updateChangeset(l.host, { standalone_status: "applied", standalone_sha: l.value, standalone_detail: null });
          });
          continue;
        }
        // Even squashed onto the base the group fails: it needs changesets outside it.
        const inGroup = new Set(layers.flatMap((l) => l.members));
        const group = rows.filter((r) => inGroup.has(r.id));
        const nodes = this.nodes(harvestId);
        const mine = nodes.filter((n) => inGroup.has(n.id));
        const groupNode: CsNode = {
          id: -1,
          k: Math.min(...mine.map((n) => n.k)),
          paths: [...new Set(mine.flatMap((n) => n.paths))],
          dependsOn: [],
          first: Math.min(...mine.map((n) => n.first ?? n.k)),
          last: Math.max(...mine.map((n) => n.last ?? n.k)),
        };
        const outside = nodes.filter((n) => !inGroup.has(n.id)).map((n) => n.id);
        const gateFail = fit.squashed.kind === "gate_failed";
        const candidates = gateFail ? outside : earlierDependencies(groupNode, nodes.filter((n) => !inGroup.has(n.id)), fit.squashed.paths).ids;
        let dep = await this.applyBlockers(harvestId, group, candidates.length ? candidates : outside, gateFail, spec);
        // Not among the likely ones: any other changeset, with gates.
        if (!dep.enough && candidates.length && candidates.length < outside.length) dep = await this.applyBlockers(harvestId, group, outside, true, spec);
        const failedHost = rows.find((r) => r.id === fit.failed.host)!;
        if (dep.ids.length) {
          const what = gateFail ? `fails the gates on ${baseLabel}` : `does not apply to ${baseLabel}`;
          for (const id of dep.ids) this.addDependency(failedHost.id, id, `#${failedHost.k} ${what} without #${kOf(id)}${fit.squashed.kind === "conflict" ? ` (conflict in ${fit.squashed.paths.slice(0, 5).join(", ") || "?"})` : ""}${dep.exact ? "" : " (not isolated)"}`);
          this.restack(harvestId);
          await this.ablateStacks(harvestId, spec, signal);
          changed = true;
          break;
        }
        // Nothing else to bring in: report it; a layer that doesn't apply gets no branch.
        this.store.tx(() => {
          for (const l of fit.layers) this.store.updateChangeset(l.host, { standalone_status: "applied", standalone_sha: l.value, standalone_detail: null });
          const at = layers.findIndex((l) => l.host === fit.failed.host);
          for (const l of layers.slice(Math.max(at, 0))) {
            if (l.host === fit.failed.host) {
              this.store.updateChangeset(l.host, { standalone_status: fit.failure.kind, standalone_sha: null, standalone_detail: clip(`${fit.failure.kind === "conflict" ? "does not apply on its PR base" : "fails its gates on its PR base"}: ${fit.failure.detail}`, 500) });
            } else this.store.updateChangeset(l.host, { standalone_status: "skipped", standalone_sha: null, standalone_detail: "its stack's previous layer did not apply" });
          }
        });
      }
      if (!changed) break;
    }

    // Standalone effects, once every layer is final.
    for (const cs of prOrder(this.store.changesets(harvestId))) {
      if (cs.standalone_status !== "applied" || !cs.standalone_sha) continue;
      this.check(signal, harvestId);
      const baseSha = this.prBaseSha(harvestId, cs);
      if (spec.harvest.measure_standalone && h.measure_standalone && baseSha) {
        const r = await this.measurePair(harvestId, spec, baseSha, cs.standalone_sha, `standalone #${cs.k}`, signal);
        if (!r.ok) {
          this.store.updateChangeset(cs.id, { standalone_status: "gate_failed", standalone_detail: clip(r.reason, 500) });
          continue;
        }
        this.store.updateChangeset(cs.id, { standalone_status: "pass", standalone_effect: r.effect, standalone_ci_lo: r.ciLo, standalone_ci_hi: r.ciHi, standalone_detail: null });
        this.store.event(h.study_id, "harvest.standalone", "plugin", { harvest: harvestId, changeset: cs.k, effect: r.effect, lo: r.ciLo, hi: r.ciHi });
      } else {
        this.store.updateChangeset(cs.id, { standalone_status: "pass", standalone_detail: "gates pass on its PR base (effect not measured)" });
      }
    }
  }

  /** The commit a changeset's PR branches from: the segment base, or the previous stack layer's commit. */
  private prBaseSha(harvestId: number, cs: ChangesetRow): string | null {
    const h = this.store.harvest(harvestId)!;
    if (!cs.pr_base || cs.pr_base === "base") return h.base_sha!;
    const k = Number(cs.pr_base.slice(1));
    const prev = this.store.changesets(harvestId).find((c) => c.k === k);
    return prev?.standalone_sha && ["applied", "pass", "gate_failed"].includes(prev.standalone_status) ? prev.standalone_sha : null;
  }

  // ---- drafting ----
  private async draft(harvestId: number, spec: StudySpec): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const changesets = this.store.changesets(harvestId);
    const drafts: PrDraft[] = [];
    const drafted = new Set<number>();
    for (const cs of prOrder(changesets)) {
      const title = clipWords(cs.title, 72);
      const body = prBody(this.ctx, study, spec, h, cs, changesets);
      if (cs.folded_into !== null) {
        // It ships inside its host's PR: no branch, no PR of its own.
        this.store.updateChangeset(cs.id, { branch: null, pr_title: title, pr_body: body, pr_status: null });
        continue;
      }
      const branch = harvestBranch(study, h, cs);
      const base = cs.pr_base && cs.pr_base !== "base" ? changesets.find((c) => `#${c.k}` === cs.pr_base) : undefined;
      const baseBranch = base ? harvestBranch(study, h, base) : spec.study.base;
      // Only a layer that applies and passes its gates on its PR base gets a branch, and only on a drafted base.
      const ok = cs.standalone_status === "pass" && cs.standalone_sha !== null && (!base || drafted.has(base.id));
      let status: ChangesetRow["pr_status"] = "drafted";
      if (ok) {
        const ref = `refs/heads/${branch}`;
        const cur = await runner.resolveRef(study.repo_path!, ref);
        if (cur !== cs.standalone_sha) {
          const r = await runner.updateRef(study.repo_path!, ref, cs.standalone_sha!, cur);
          if (!r.ok) throw new Error(`could not create branch ${branch}`);
        }
        status = "branch";
        drafted.add(cs.id);
      } else if (cs.standalone_status === "pass" && base) {
        this.store.updateChangeset(cs.id, { standalone_status: "skipped", standalone_detail: `its PR base #${base.k} has no branch` });
      }
      this.store.updateChangeset(cs.id, { branch: ok ? branch : null, pr_title: title, pr_body: body, pr_status: status });
      drafts.push({ changesetId: cs.id, k: cs.k, branch, baseBranch, title, body, sha: ok ? cs.standalone_sha : null, stacked: Boolean(base) });
    }
    // The export is the ready harvest's report (the state flips to ready right after drafting).
    const report = studyReport(this.ctx, study, spec, { ...this.store.harvest(harvestId)!, state: "ready" });
    const publisher = new DryRunPublisher(runner);
    const out = await publisher.publish({ key: harvestExportKey(study, h), drafts, report });
    this.store.updateHarvest(harvestId, { export_dir: out.exportDir, publisher: "dry-run", publish_state: "dry-run", publish_json: JSON.stringify(out) });
    this.store.event(study.id, "harvest.drafted", "plugin", { harvest: harvestId, branches: drafts.filter((d) => d.sha).length, export: out.exportDir });
  }
}

/** A fold's reason; a changeset folded again keeps why it was folded first. */
function foldReason(c: ChangesetRow, reason: string): string {
  return clip(c.fold_reason && c.folded_into !== null ? `${c.fold_reason}; then ${reason}` : reason, 600);
}

function commitMessage(study: StudyRow, h: HarvestRow, cs: ChangesetRow, folded: ChangesetRow[] = []): string {
  const cands = [cs, ...folded].flatMap((c) => safeJson<number[]>(c.candidates_json) ?? []).sort((a, b) => a - b);
  return [
    clip(cs.title, 72),
    "",
    clip(cs.rationale, 2000),
    ...(folded.length ? ["", `Also includes ${folded.map((f) => `#${f.k} ${clip(f.title, 60)}`).join(", ")}.`] : []),
    "",
    `From autoresearch study ${study.slug} (harvest h${h.seq}, changeset #${cs.k}${cands.length ? `: ${cands.map((n) => `c/${n}`).join(", ")}` : ""}).`,
    "",
    `Autoresearch-Study: ${study.slug}`,
    `Autoresearch-Changeset: h${h.seq}/#${cs.k}`,
  ].join("\n");
}

export function harvestReadyText(ctx: Ctx, study: StudyRow, h: HarvestRow): string {
  const cs = ctx.store.changesets(h.id);
  const deps = cs.filter((c) => c.folded_into === null && c.pr_base && c.pr_base !== "base").length;
  const drop = cs.filter((c) => c.droppable).length;
  const prs = cs.filter((c) => c.folded_into === null).length;
  const stacks = [...new Set(cs.map((c) => c.stack).filter((x): x is number => x !== null))].sort((a, b) => a - b);
  const unapplied = cs.filter((c) => c.folded_into === null && !c.branch);
  return [
    `Harvest h${h.seq} of \`${study.slug}\` is ready: ${cs.length} changeset(s)${prs !== cs.length ? ` in ${prs} PR(s)` : ""}${deps ? `, ${deps} stacked on another` : ""}${drop ? `, ${drop} flagged droppable (your call)` : ""}. Next: review them on the Harvest tab, then publish draft PRs, keep exploring, or archive.`,
    stacks.length ? `Stacks in PR order: ${stacks.map((s) => `${s}: ${stackOrderText(cs, s)}`).join("; ")}.` : "",
    ...foldLines(cs),
    unapplied.length ? `No branch (does not apply on its PR base): ${unapplied.map((c) => `#${c.k}`).join(", ")}.` : "",
    h.export_dir ? `Dry-run PR bodies and the report: ${h.export_dir}. Local branches: studies/${study.slug}/harvest/h${h.seq}/*.` : "",
    `CLI: \`bb study harvest ${study.slug} --publish\` (DRAFT PRs on GitHub), \`bb study resume ${study.slug}\` (keep exploring), \`bb study archive ${study.slug}\` (done).`,
  ]
    .filter(Boolean)
    .join("\n");
}

export { bestBranch };
