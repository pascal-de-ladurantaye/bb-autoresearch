// Harvest (v1): freeze best and close submissions. The plugin no longer
// groups, ablates, drafts or publishes: an agent does, following the
// study-harvest skill, with `bb study evidence` (what happened), `bb study
// measure` and `bb study gate` (every number and check it reports) and the
// repository's own tools for branches, PRs and publishing.
//
//   waiting   in-flight candidates finish (no new submissions, no new workers)
//   frozen    best is final for this harvest: base, best and the promotion
//             list are recorded, and refs/studies/<slug>/harvest/h<N> pins best
//
// `bb study resume` keeps exploring (best moves on; the frozen ref stays) and
// `bb study archive` ends the study. Harvests the plugin ran before 1.0
// (states grouping … ready) stay readable; one still in progress at the
// upgrade stops where it was and becomes frozen (see `stopLegacy`).
import type { Ctx } from "./context.ts";
import { LEGACY_ACTIVE_HARVEST_STATES, type HarvestRow, type StudyRow } from "./db/store.ts";
import { candidateFromMessage } from "./commit.ts";
import { errText, IN_FLIGHT_STAGES, type Pipeline } from "./pipeline.ts";
import { clip, safeJson } from "./prompts.ts";
import { bestBranch } from "./spec.ts";

/** A promotion on best at the freeze (first-parent order, oldest first). */
export interface Promotion {
  /** Commit on studies/<slug>/best. */
  sha: string;
  /** Candidate number from the commit's Autoresearch-Candidate trailer (null for a commit the plugin didn't make). */
  n: number | null;
  /** The commit's subject (v1: the worker's title; before 1.0: the idea title). */
  title: string;
  /** The commit's body without the plugin's trailers (v1 freezes only). */
  body?: string | null;
  paths: string[];
}

export interface HarvestHooks {
  notify(study: StudyRow, kind: string, text: string, opts?: { quiet?: boolean }): Promise<void>;
  publish(studyId: string): void;
}

export class HarvestCancelled extends Error {
  constructor() {
    super("harvest cancelled");
    this.name = "HarvestCancelled";
  }
}

/** The ref that pins a harvest's frozen best: refs/studies/<slug>/harvest/h<seq>. */
export function frozenRef(slug: string, seq: number): string {
  return `refs/studies/${slug}/harvest/h${seq}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** A commit message without the plugin's trailer lines (and the blank line before them). */
function bodyOf(message: string): string | null {
  const lines = message.replace(/\r\n/gu, "\n").split("\n").slice(1);
  const kept = lines.filter((l) => !/^Autoresearch-[A-Za-z-]+:/u.test(l));
  const text = kept.join("\n").trim();
  return text || null;
}

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

  /** Plugin dispose: stop every waiting harvest (the next instance resumes them). */
  abortAll(): void {
    for (const j of this.jobs.values()) j.controller.abort();
  }

  running(harvestId: number): boolean {
    return this.jobs.has(harvestId);
  }

  /** Start (or resume) waiting for the bench to drain, then freeze. */
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
          if (h.state === "waiting") this.store.updateHarvest(harvestId, { state: "cancelled", finished_at: this.ctx.now() });
          return;
        }
        this.store.updateHarvest(harvestId, { state: "failed", error: clip(errText(e), 1000), finished_at: this.ctx.now() });
        this.store.event(h.study_id, "harvest.failed", "plugin", { harvest: harvestId, error: clip(errText(e), 500) });
        const study = this.store.study(h.study_id);
        if (study) await this.hooks.notify(study, "harvest.failed", `Harvest h${h.seq} of \`${study.slug}\` could not freeze best: ${clip(errText(e), 500)}. Next: fix the cause and run \`bb study harvest ${study.slug}\` again, or resume to keep exploring.`);
      } finally {
        this.jobs.delete(harvestId);
        const h = this.store.harvest(harvestId);
        if (h && !this.ctx.disposed) this.hooks.publish(h.study_id);
      }
    })();
    this.jobs.set(harvestId, { promise, controller });
  }

  /** Cancel a harvest that is still waiting (resume, archive). A frozen one stays as it is. */
  cancel(harvestId: number): void {
    const job = this.jobs.get(harvestId);
    if (job) job.controller.abort();
    const h = this.store.harvest(harvestId);
    if (h && h.state === "waiting") this.store.updateHarvest(harvestId, { state: "cancelled", finished_at: this.ctx.now() });
  }

  async wait(harvestId: number, timeoutMs: number): Promise<void> {
    const job = this.jobs.get(harvestId);
    if (!job) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.promise, new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }

  private check(signal: AbortSignal, harvestId: number): void {
    const h = this.store.harvest(harvestId);
    if (signal.aborted || !h || h.state !== "waiting") throw new HarvestCancelled();
    const study = this.store.study(h.study_id);
    if (!study || study.state !== "harvesting") throw new HarvestCancelled();
  }

  private detail(h: HarvestRow, detail: string): void {
    this.store.updateHarvest(h.id, { phase_detail: clip(detail, 300) });
    this.hooks.publish(h.study_id);
  }

  async run(harvestId: number, signal: AbortSignal): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    if (h.state !== "waiting") return;
    this.detail(h, "in-flight candidates finish; submissions are closed");
    for (;;) {
      this.check(signal, h.id);
      const inFlight = this.store.candidates(h.study_id, { stages: [...IN_FLIGHT_STAGES] });
      if (!inFlight.length) break;
      this.detail(h, `waiting for ${inFlight.length} in-flight candidate(s): ${inFlight.map((c) => `c/${c.n} ${c.stage}`).slice(0, 5).join(", ")}`);
      this.pipeline.kick();
      await sleep(this.ctx.config.harvestPollMs, signal);
    }
    this.check(signal, h.id);
    await this.freeze(h.id);
  }

  /** Record base, best and the promotions, pin best with a ref, and mark the harvest frozen. */
  private async freeze(harvestId: number): Promise<void> {
    const h = this.store.harvest(harvestId)!;
    const study = this.store.study(h.study_id)!;
    if (!study.base_sha || !study.best_sha) throw new Error("the study has no base or best commit");
    const runner = this.ctx.bb.hostRunner(study.host_id!);
    const log = study.base_sha === study.best_sha ? [] : await runner.commitLog(study.repo_path!, study.base_sha, study.best_sha);
    const promotions: Promotion[] = log.map((c) => {
      const n = candidateFromMessage(c.message, study.slug);
      const cand = n !== null ? this.store.candidateByN(study.id, n) : this.store.candidates(study.id).find((x) => x.promoted_sha === c.sha);
      return { sha: c.sha, n: cand?.n ?? null, title: clip(c.subject, 200), body: clip(bodyOf(c.message) ?? "", 4000) || null, paths: c.paths };
    });
    const ref = frozenRef(study.slug, h.seq);
    const current = await runner.resolveRef(study.repo_path!, ref);
    if (current !== study.best_sha) {
      const r = await runner.updateRef(study.repo_path!, ref, study.best_sha, current);
      if (!r.ok) throw new Error(`could not create ${ref}`);
    }
    this.store.updateHarvest(h.id, { state: "frozen", phase_detail: null, base_sha: study.base_sha, best_sha: study.best_sha, segment: study.segment, promotions_json: JSON.stringify(promotions), finished_at: this.ctx.now() });
    this.store.event(study.id, "harvest.frozen", "plugin", { harvest: h.id, seq: h.seq, base: study.base_sha, best: study.best_sha, promotions: promotions.length, ref });
    await this.hooks.notify(study, "harvest.frozen", harvestFrozenText(study, this.store.harvest(h.id)!));
  }

  /**
   * A harvest the plugin was running before 1.0 (grouping, ablating, checking
   * or drafting) can't continue: that machinery is gone. It stops where it
   * is, frozen on the best it froze; what it measured and drafted so far
   * stays readable, and an agent takes it from there.
   */
  stopLegacy(harvest: HarvestRow): void {
    if (!(LEGACY_ACTIVE_HARVEST_STATES as readonly string[]).includes(harvest.state)) return;
    const was = harvest.state;
    this.store.updateHarvest(harvest.id, {
      state: "frozen",
      phase_detail: `stopped while ${was} when the plugin moved to agent-run harvests (1.0); what it measured and drafted so far stays on this page`,
      finished_at: this.ctx.now(),
    });
    this.store.event(harvest.study_id, "harvest.frozen", "plugin", { harvest: harvest.id, seq: harvest.seq, base: harvest.base_sha, best: harvest.best_sha, legacy: was });
  }
}

/** A harvest the plugin ran before 1.0: it has changesets, or stopped in one of the old phases. Its best was frozen, but no `refs/studies/<slug>/harvest/h<N>` pins it. */
export function isLegacyHarvest(store: { changesets(harvestId: number): unknown[] }, h: HarvestRow): boolean {
  return ["grouping", "ablating", "checking", "drafting", "ready"].includes(h.state) || store.changesets(h.id).length > 0 || h.grouping_source !== null;
}

/**
 * The harvest a Harvesting study is on: waiting for in-flight candidates,
 * frozen, or a ready one from before 1.0 (its best is frozen too). `bb study
 * harvest` on such a study shows it and changes nothing; only `--refreeze`
 * starts a new one. Null when the study isn't harvesting or its latest
 * harvest failed (a new freeze retries it).
 */
export function currentHarvest(study: StudyRow, latest: HarvestRow | undefined): HarvestRow | null {
  return study.state === "harvesting" && latest && ["waiting", "frozen", "ready"].includes(latest.state) ? latest : null;
}

/**
 * Why `bb study harvest --refreeze` can't freeze the current harvest again,
 * or null when it can: only when that pins something new (best moved since
 * the freeze, or the freeze is from before 1.0, which no frozen ref pins).
 */
export function refreezeRefusal(store: { changesets(harvestId: number): unknown[] }, study: StudyRow, current: HarvestRow): string | null {
  if (current.state === "waiting") return `harvest h${current.seq} hasn't frozen best yet (in-flight candidates finish first), so there is nothing to refreeze; \`bb study harvest ${study.slug} --wait\` waits for it`;
  if (isLegacyHarvest(store, current)) return null;
  if (current.best_sha === study.best_sha && current.base_sha === study.base_sha) return `best hasn't moved since harvest h${current.seq} froze it at ${current.best_sha?.slice(0, 10) ?? "?"}, so there is nothing to refreeze; \`bb study harvest ${study.slug}\` shows that harvest`;
  return null;
}

/** The notice when best is frozen: what was frozen and how to harvest it with an agent. */
export function harvestFrozenText(study: StudyRow, h: HarvestRow): string {
  const promotions = safeJson<Promotion[]>(h.promotions_json) ?? [];
  return [
    `Harvest h${h.seq} of \`${study.slug}\`: best is frozen at ${h.best_sha?.slice(0, 10) ?? "?"} (${promotions.length} promotion${promotions.length === 1 ? "" : "s"} on ${bestBranch(study.slug)}, pinned as ${frozenRef(study.slug, h.seq)}). Submissions are closed.`,
    `Next: ask an agent to harvest it with the study-harvest skill (for example in this thread: "harvest ${study.slug} into PRs"). It reads \`bb study evidence ${study.slug} --json\`, splits and groups the changes, measures them with \`bb study measure\` and gates them with \`bb study gate\`, and drafts PR descriptions; it publishes only when you ask. Or keep exploring (\`bb study resume ${study.slug}\`) or archive.`,
  ].join("\n");
}
