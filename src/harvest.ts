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
//   checking  each changeset applied on its PR base (the segment base for an
//             independent one, the previous layer for a stacked one): gates,
//             and optionally its standalone effect
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
  computeStacks,
  contributionFromAblation,
  earlierDependencies,
  fallbackGrouping,
  isDroppable,
  laterDependents,
  type CsNode,
  type Estimate,
  type PlannedChangeset,
  type Promotion,
  type ProposedGroup,
} from "./harvest-math.ts";
import { checkHealth } from "./health.ts";
import { BenchError, strategyFor } from "./noise.ts";
import { errText, IN_FLIGHT_STAGES, withBench, type Pipeline } from "./pipeline.ts";
import { clip, safeJson } from "./prompts.ts";
import { DryRunPublisher, type PrDraft } from "./publisher.ts";
import { prBody, studyReport } from "./report.ts";
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
  members: number[];
  status: "pending" | "measured" | "not_needed" | "conflict" | "gate_failed" | "error";
  estimate: Estimate | null;
  n: number | null;
  detail: string | null;
}

type PairResult = { ok: true; effect: number; ciLo: number | null; ciHi: number | null; n: number; seconds: number } | { ok: false; reason: string };

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
        const h = this.store.harvest(harvestId);
        if (!h) return;
        if (e instanceof HarvestCancelled || controller.signal.aborted) {
          if (!["ready", "failed", "cancelled"].includes(h.state)) this.store.updateHarvest(harvestId, { state: "cancelled", finished_at: this.ctx.now() });
          return;
        }
        this.store.updateHarvest(harvestId, { state: "failed", error: clip(errText(e), 1000), finished_at: this.ctx.now() });
        this.store.event(h.study_id, "harvest.failed", "plugin", { harvest: harvestId, error: clip(errText(e), 500) });
        const study = this.store.study(h.study_id);
        if (study) await this.hooks.notify(study, "harvest.failed", `Harvest h${harvestId} of \`${study.slug}\` failed: ${clip(errText(e), 500)}. Fix the cause and run \`bb study harvest ${study.slug} --restart\`, or \`bb study resume ${study.slug}\` to keep exploring.`);
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
      return fallbackGrouping(promotions);
    };
    if (h.grouping_source === "fallback") return useFallback(h.grouping_notes ?? "one changeset per promotion (asked for by the human)");
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
            signal,
          });
          const seconds = (this.ctx.now() - started) / 1000;
          return { ok: true, effect: outcome.effect, ciLo: outcome.ciLo, ciHi: outcome.ciHi, n: outcome.n, seconds };
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

  /** Gates on the edit host for a harvest commit (one retry for flaky gates). */
  private async gates(study: StudyRow, spec: StudySpec, sha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!spec.oracle.gate.length) return { ok: true };
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const dir = await runner.checkout(study.repo_path!, `${study.slug}-harvest-gate`, sha);
    for (const command of spec.oracle.gate) {
      const job = { cwd: dir, command, timeoutMs: spec.oracle.timeout_minutes * 60_000, label: "harvest gate" };
      const r = await runner.run(job);
      if (r.exitCode === 0) continue;
      const retry = await runner.run(job);
      if (retry.exitCode !== 0) return { ok: false, reason: `gate failed: ${clip(command, 200)} exited ${retry.exitCode}: ${clip(tail(retry), 400)}` };
    }
    return { ok: true };
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
    this.store.updateHarvest(harvestId, { total_effect: e.value, total_ci_lo: e.lo, total_ci_hi: e.hi, total_n: r.n, total_vs_base: Number.isFinite(vsBase) ? vsBase : null });
    this.store.event(h.study_id, "harvest.total", "plugin", { harvest: harvestId, total: e.value, lo: e.lo, hi: e.hi, n: r.n });
  }

  private nodes(harvestId: number): CsNode[] {
    return this.store.changesets(harvestId).map((c) => ({ id: c.id, k: c.k, paths: safeJson<string[]>(c.paths_json) ?? [], dependsOn: safeJson<number[]>(c.depends_on_json) ?? [] }));
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
    const composed = await runner.composeCommits({
      repoPath: study.repo_path!,
      onto: h.best_sha!,
      steps: [...commits].reverse().map((sha) => ({ sha, revert: true })),
      message: `autoresearch harvest h${h.id}: best without #${cs.k} ${clip(cs.title, 60)}`,
    });
    const nodes = this.nodes(harvestId);
    const me = nodes.find((n) => n.id === cs.id)!;
    const conflictOk = async (steps: Array<{ sha: string; revert: boolean }>) =>
      (await runner.composeCommits({ repoPath: study.repo_path!, onto: h.best_sha!, steps, message: "autoresearch harvest probe" })).status === "ok";
    if (composed.status === "conflict") {
      const dep = await this.revertBlockers(harvestId, cs, laterDependents(me, nodes, composed.paths).ids, conflictOk);
      for (const id of dep.ids) this.addDependency(id, cs.id, `reverting #${cs.k} from best conflicts in ${composed.paths.slice(0, 5).join(", ") || "?"}${dep.exact ? " unless this one is reverted too" : " (not isolated: treated as dependent)"}`);
      this.store.updateChangeset(cs.id, { ablation_status: "conflict", ablation_detail: clip(`revert conflicts in ${composed.paths.slice(0, 10).join(", ")}`, 500) });
      return;
    }
    this.store.updateChangeset(cs.id, { ablation_sha: composed.sha });
    const gateOk = async (steps: Array<{ sha: string; revert: boolean }>) => {
      const c = await runner.composeCommits({ repoPath: study.repo_path!, onto: h.best_sha!, steps, message: "autoresearch harvest probe" });
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
    this.store.updateChangeset(cs.id, { ablation_status: "measured", contribution: e.value, ci_lo: e.lo, ci_hi: e.hi, n: r.n, droppable: isDroppable(e, tolerance) ? 1 : 0, ablation_detail: null });
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

  /** Which earlier changesets S needs to apply on the base: the same probe, forward. */
  private async applyBlockers(harvestId: number, s: ChangesetRow, candidateIds: number[]): Promise<{ ids: number[]; exact: boolean }> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const order = new Map((safeJson<Promotion[]>(h.promotions_json) ?? []).map((p, i) => [p.sha, i] as const));
    const all = this.store.changesets(harvestId);
    const earlier = candidateIds.map((id) => all.find((c) => c.id === id)!).filter(Boolean);
    if (!earlier.length || earlier.length > 12) return { ids: earlier.map((c) => c.id), exact: false };
    const picks = (members: ChangesetRow[]) =>
      members
        .flatMap((m) => safeJson<string[]>(m.commits_json) ?? [])
        .sort((a, b) => order.get(a)! - order.get(b)!)
        .map((sha) => ({ sha, revert: false }));
    const ok = async (steps: Array<{ sha: string; revert: boolean }>) => (await runner.composeCommits({ repoPath: study.repo_path!, onto: h.base_sha!, steps, message: "autoresearch harvest probe" })).status === "ok";
    const mine = picks([s]);
    if (!(await ok([...picks(earlier), ...mine]))) return { ids: earlier.map((c) => c.id), exact: false };
    const needed: number[] = [];
    for (const t of earlier) {
      if (!(await ok([...picks(earlier.filter((x) => x.id !== t.id)), ...mine]))) needed.push(t.id);
    }
    return needed.length ? { ids: needed, exact: true } : { ids: earlier.map((c) => c.id), exact: false };
  }

  /** Recompute stacks from the dependency edges; write stack indexes and PR bases. */
  private restack(harvestId: number): StackRecord[] {
    const h = this.store.harvest(harvestId)!;
    const { stacks, stackOf } = computeStacks(this.nodes(harvestId));
    const prior = safeJson<StackRecord[]>(h.stacks_json) ?? [];
    const records: StackRecord[] = stacks.map((members, i) => {
      const same = prior.find((p) => p.members.join(",") === members.join(","));
      return same ? { ...same, stack: i + 1 } : { stack: i + 1, members, status: "pending", estimate: null, n: null, detail: null };
    });
    const changesets = this.store.changesets(harvestId);
    this.store.tx(() => {
      for (const c of changesets) {
        const s = stackOf.get(c.id) ?? null;
        let prBase = "base";
        if (s !== null) {
          const members = stacks[s - 1]!;
          const i = members.indexOf(c.id);
          if (i > 0) prBase = `#${this.store.changeset(members[i - 1]!)!.k}`;
        }
        if (c.stack !== s || c.pr_base !== prBase) {
          this.store.updateChangeset(c.id, { stack: s, pr_base: prBase, ...(c.pr_base !== null && c.pr_base !== prBase ? { standalone_status: "pending", standalone_sha: null, standalone_effect: null, standalone_ci_lo: null, standalone_ci_hi: null } : {}) });
        }
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
      const composed = await this.ctx.bb.hostRunner(study.host_id!).composeCommits({
        repoPath: study.repo_path!,
        onto: h.best_sha!,
        steps: commits.map((sha) => ({ sha, revert: true })),
        message: `autoresearch harvest h${h.id}: best without stack ${rec.stack}`,
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

  /** Apply each changeset on its PR base; gates; optional standalone effect. A conflict on the base reveals an earlier dependency. */
  private async standalone(harvestId: number, spec: StudySpec, signal: AbortSignal): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    for (let pass = 0; pass < 50; pass++) {
      let restacked = false;
      for (const cs of this.store.changesets(harvestId)) {
        if (cs.standalone_status !== "pending") continue;
        this.check(signal, harvestId);
        const baseSha = this.prBaseSha(harvestId, cs);
        if (baseSha === null) {
          this.store.updateChangeset(cs.id, { standalone_status: "skipped", standalone_detail: "its stack's previous layer did not apply" });
          continue;
        }
        const commits = safeJson<string[]>(cs.commits_json) ?? [];
        this.detail(h, `#${cs.k}: applying on ${cs.pr_base === "base" ? "the base" : cs.pr_base}`);
        const composed = await runner.composeCommits({ repoPath: study.repo_path!, onto: baseSha, steps: commits.map((sha) => ({ sha, revert: false })), message: commitMessage(study, h, cs) });
        if (composed.status === "conflict") {
          if (cs.pr_base === "base" || cs.stack === null) {
            const nodes = this.nodes(harvestId);
            const dep = await this.applyBlockers(harvestId, cs, earlierDependencies(nodes.find((n) => n.id === cs.id)!, nodes, composed.paths).ids);
            if (dep.ids.length) {
              for (const id of dep.ids) this.addDependency(cs.id, id, `#${cs.k} does not apply to the base without it (conflict in ${composed.paths.slice(0, 5).join(", ")})${dep.exact ? "" : " (not isolated)"}`);
              this.restack(harvestId);
              await this.ablateStacks(harvestId, spec, signal);
              restacked = true;
              break;
            }
          }
          this.store.updateChangeset(cs.id, { standalone_status: "conflict", standalone_detail: clip(`does not apply on its PR base: ${composed.paths.slice(0, 10).join(", ")}`, 500) });
          continue;
        }
        this.store.updateChangeset(cs.id, { standalone_sha: composed.sha });
        const gate = await this.gates(study, spec, composed.sha);
        if (!gate.ok) {
          this.store.updateChangeset(cs.id, { standalone_status: "gate_failed", standalone_detail: clip(gate.reason, 500) });
          continue;
        }
        if (spec.harvest.measure_standalone && h.measure_standalone) {
          const r = await this.measurePair(harvestId, spec, baseSha, composed.sha, `standalone #${cs.k}`, signal);
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
      if (!restacked) return;
    }
  }

  /** The commit a changeset's PR branches from: the segment base, or the previous stack layer's standalone commit. */
  private prBaseSha(harvestId: number, cs: ChangesetRow): string | null {
    const h = this.store.harvest(harvestId)!;
    if (!cs.pr_base || cs.pr_base === "base") return h.base_sha!;
    const k = Number(cs.pr_base.slice(1));
    const prev = this.store.changesets(harvestId).find((c) => c.k === k);
    return prev?.standalone_sha && ["pass", "gate_failed"].includes(prev.standalone_status) ? prev.standalone_sha : null;
  }

  // ---- drafting ----
  private async draft(harvestId: number, spec: StudySpec): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const changesets = this.store.changesets(harvestId);
    const drafts: PrDraft[] = [];
    for (const cs of changesets) {
      const branch = `studies/${study.slug}/harvest/h${h.id}/${String(cs.k).padStart(2, "0")}-${branchSlug(cs.title)}`;
      const base = cs.pr_base && cs.pr_base !== "base" ? changesets.find((c) => `#${c.k}` === cs.pr_base) : undefined;
      const baseBranch = base ? `studies/${study.slug}/harvest/h${h.id}/${String(base.k).padStart(2, "0")}-${branchSlug(base.title)}` : spec.study.base;
      const title = clip(cs.title, 72);
      const body = prBody(this.ctx, study, spec, h, cs, changesets);
      let status: ChangesetRow["pr_status"] = "drafted";
      if (cs.standalone_sha) {
        const ref = `refs/heads/${branch}`;
        const cur = await runner.resolveRef(study.repo_path!, ref);
        if (cur !== cs.standalone_sha) {
          const r = await runner.updateRef(study.repo_path!, ref, cs.standalone_sha, cur);
          if (!r.ok) throw new Error(`could not create branch ${branch}`);
        }
        status = "branch";
      }
      this.store.updateChangeset(cs.id, { branch: cs.standalone_sha ? branch : null, pr_title: title, pr_body: body, pr_status: status });
      drafts.push({ changesetId: cs.id, k: cs.k, branch, baseBranch, title, body, sha: cs.standalone_sha, stacked: Boolean(base) });
    }
    // The export is the ready harvest's report (the state flips to ready right after drafting).
    const report = studyReport(this.ctx, study, spec, { ...this.store.harvest(harvestId)!, state: "ready" });
    const publisher = new DryRunPublisher(runner);
    const out = await publisher.publish({ key: `${study.slug}-harvest-h${h.id}`, drafts, report });
    this.store.updateHarvest(harvestId, { export_dir: out.exportDir, publisher: "dry-run", publish_state: "dry-run", publish_json: JSON.stringify(out) });
    this.store.event(study.id, "harvest.drafted", "plugin", { harvest: harvestId, branches: drafts.filter((d) => d.sha).length, export: out.exportDir });
  }
}

function commitMessage(study: StudyRow, h: HarvestRow, cs: ChangesetRow): string {
  const cands = safeJson<number[]>(cs.candidates_json) ?? [];
  return [
    clip(cs.title, 72),
    "",
    clip(cs.rationale, 2000),
    "",
    `From autoresearch study ${study.slug} (harvest h${h.id}, changeset #${cs.k}${cands.length ? `: ${cands.map((n) => `c/${n}`).join(", ")}` : ""}).`,
    "",
    `Autoresearch-Study: ${study.slug}`,
    `Autoresearch-Changeset: h${h.id}/#${cs.k}`,
  ].join("\n");
}

export function harvestReadyText(ctx: Ctx, study: StudyRow, h: HarvestRow): string {
  const cs = ctx.store.changesets(h.id);
  const deps = cs.filter((c) => (safeJson<number[]>(c.depends_on_json) ?? []).length).length;
  const drop = cs.filter((c) => c.droppable).length;
  return [
    `Harvest h${h.id} of \`${study.slug}\` is ready: ${cs.length} changeset(s)${deps ? `, ${deps} stacked on another` : ""}${drop ? `, ${drop} flagged droppable (no measurable contribution; your call)` : ""}.`,
    h.export_dir ? `Dry-run PR bodies and the report: ${h.export_dir}. Local branches: studies/${study.slug}/harvest/h${h.id}/*.` : "",
    `Review on the Harvest tab. Then: \`bb study harvest ${study.slug} --publish\` opens DRAFT PRs on GitHub, \`bb study resume ${study.slug}\` keeps exploring, or \`bb study archive ${study.slug}\` ends the study.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export { bestBranch };
