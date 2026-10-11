// Typed repository over the plugin database. All writes that change study
// state also append an audit event in the same transaction.
import type Database from "better-sqlite3";
import { normalizeSpec, type StudySpec } from "../spec.ts";
import type { CandidateStage, IdeaStatus, StudyState, ThreadRole, ThreadState } from "./schema.ts";
import type { Verdict } from "../verdict.ts";

export interface StudyRow {
  id: string;
  slug: string;
  project_id: string;
  state: StudyState;
  spec_version: number;
  best_sha: string | null;
  budget: string;
  created_at: number;
  updated_at: number;
  host_id: string | null;
  repo_path: string | null;
  study_thread_id: string | null;
  section_id: string | null;
  segment: number;
  base_sha: string | null;
  pause_reason: string | null;
  calibration_status: "running" | "ready" | "failed" | null;
  calibration_json: string | null;
  calibration_approved_at: number | null;
  round_in_flight: number;
  rounds: number;
  verdicts_since_round: number;
  last_round_at: number | null;
  last_round_event_id: number;
  stall_signaled_at_verdict: number;
  best_run_json: string | null;
  best_run_sha: string | null;
  max_workers_override: number | null;
  target_workers: number | null;
  running_since: number | null;
  running_seconds: number;
  pending_spec_version: number | null;
  prev_spec_version: number | null;
  rate_limited_until: number | null;
  usage_json: string | null;
  usage_at: number | null;
  budget_notices_json: string;
  /** When the human last looked at the study's notices (the "new" count). */
  notices_seen_at: number | null;
}

export interface SpecVersionRow {
  study_id: string;
  version: number;
  spec_toml: string;
  spec_json: string;
  oracle_hash: string;
  created_at: number;
  approved_at: number | null;
  bench_json: string | null;
}

export interface SegmentRow {
  study_id: string;
  k: number;
  baseline_sha: string;
  oracle_hash: string;
  noise_floor: number | null;
  mde: number | null;
  eval_seconds: number | null;
  gate_seconds: number | null;
  report: string | null;
  created_at: number;
  spec_version: number | null;
  details_json: string | null;
}

export interface IdeaRow {
  id: number;
  study_id: string;
  title: string;
  rationale: string;
  theme: string;
  source: "human" | "strategist" | "worker";
  priority: number;
  pinned: number;
  status: IdeaStatus;
  start_ref: string | null;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
  variation_of: number | null;
  lineage: number | null;
}

export interface ThreadRow {
  id: number;
  thread_id: string | null;
  spawn_token: string | null;
  study_id: string;
  role: ThreadRole;
  idea_id: number | null;
  state: ThreadState;
  submissions: number;
  spawned_at: number;
  fork_sha: string | null;
  environment_id: string | null;
  worktree_path: string | null;
  last_idle_at: number | null;
  last_active_at: number | null;
  nudged_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  conflict_refunds: number;
  pending_notice: string | null;
  finishing_at: number | null;
  profiles: number;
  tokens: number | null;
  tokens_base: number | null;
  tokens_at: number | null;
  provider_id: string | null;
  rate_limit_retries: number;
  /** Live view: the recorded worker phase (see live-model.ts) and since when. */
  phase: string | null;
  phase_at: number | null;
  /** What the agent is doing from its thread's tool items: reading, editing, testing. */
  activity: string | null;
  activity_at: number | null;
  activity_seq: number;
  /** Live view: the latest action label (sanitized, at most 80 characters) and the one last recorded as a worker.action event. */
  last_action: string | null;
  last_action_at: number | null;
  action_recorded: string | null;
  action_recorded_at: number | null;
}

export interface CandidateRow {
  id: number;
  study_id: string;
  n: number;
  idea_id: number | null;
  thread_id: string | null;
  sha: string;
  parent_sha: string;
  against_sha: string | null;
  prepared_sha: string | null;
  promoted_sha: string | null;
  summary: string;
  stage: CandidateStage;
  verdict: Verdict | null;
  effect: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  metrics_json: string | null;
  reasons_json: string | null;
  changed_paths_json: string | null;
  diag_json: string | null;
  gate_output: string | null;
  bench_seconds: number;
  attempts: number;
  submitted_at: number;
  decided_at: number | null;
  reported_at: number | null;
  queued_at: number | null;
  lines_added: number;
  lines_deleted: number;
  rebases: number;
  bench_host_id: string | null;
  holdout: "pass" | "fail" | null;
  measure_restarts: number;
  /** The measurement's CI band (band.ts), stored when it ended. */
  band_json: string | null;
  /** The worker row (threads.id) that submitted it; null for candidates not linked to a worker row. */
  worker_id: number | null;
  /** Seconds its gates ran (single-machine mode: holding the bench lock). */
  gate_seconds: number;
}

export interface FindingRow {
  id: number;
  study_id: string;
  idea_id: number | null;
  candidate_id: number | null;
  thread_id: string | null;
  outcome: string;
  learned: string;
  revisit_if: string;
  evidence: string;
  created_at: number;
}

export interface EventRow {
  id: number;
  study_id: string | null;
  at: number;
  kind: string;
  actor: string;
  data_json: string;
}

/** What held the bench lock: a measurement, a profile, calibration, a drift check, a harvest measurement, or (single-machine mode) a gate. */
export type BenchIntervalKind = "measure" | "profile" | "calibration" | "drift" | "harvest" | "gate";

export interface BenchIntervalRow {
  id: number;
  study_id: string;
  host_id: string;
  lock_key: string;
  kind: BenchIntervalKind;
  candidate_id: number | null;
  started_at: number;
  ended_at: number | null;
}

export interface NoticeRow {
  id: number;
  study_id: string;
  at: number;
  kind: string;
  text: string;
  delivered_round: number | null;
}

export type BenchMode = "shared" | "clone";

export interface BenchHostRow {
  study_id: string;
  host_id: string;
  name: string;
  /** The spec entry it was resolved from ("local", an id, or a name). */
  entry: string;
  mode: BenchMode;
  position: number;
  active: number;
  /** Clone mode: the bench-owned bare clone on that host. Shared mode: the project checkout. */
  repo_path: string | null;
  status: "unknown" | "online" | "offline";
  status_at: number | null;
  offline_since: number | null;
  offline_notified_at: number | null;
  best_build_sha: string | null;
  health_ok: number | null;
  health_at: number | null;
  health_json: string | null;
  unhealthy_since: number | null;
  unhealthy_notified_at: number | null;
  deferred_until: number | null;
  evals_since_drift: number;
  drift_status: "ok" | "drift" | "running" | null;
  drift_at: number | null;
  noise_floor: number | null;
  mde: number | null;
  eval_seconds: number | null;
  baseline_json: string | null;
}

export interface HealthCheckRow {
  id: number;
  study_id: string;
  host_id: string;
  at: number;
  context: string;
  ok: number;
  problems_json: string;
  report_json: string;
}

export interface DriftCheckRow {
  id: number;
  study_id: string;
  host_id: string;
  segment: number;
  best_sha: string;
  started_at: number;
  finished_at: number | null;
  status: "running" | "ok" | "drift" | "aborted" | "error";
  pairs: number | null;
  noise: number | null;
  calibrated: number | null;
  ratio: number | null;
  median: number | null;
}

export interface TransferRow {
  id: number;
  study_id: string;
  host_id: string;
  sha: string;
  purpose: string;
  bytes: number;
  chunks: number;
  ms: number;
  ok: number;
  error: string | null;
  at: number;
}

export interface ResolvedBenchHost {
  entry: string;
  hostId: string;
  name: string;
  mode: BenchMode;
}

export const HARVEST_STATES = ["waiting", "grouping", "ablating", "checking", "drafting", "ready", "failed", "cancelled"] as const;
export type HarvestState = (typeof HARVEST_STATES)[number];

export interface HarvestRow {
  id: number;
  study_id: string;
  /** The harvest's number within its study: shown as h<seq> (the id stays internal). */
  seq: number;
  state: HarvestState;
  phase_detail: string | null;
  /** The lifecycle state the study returns to with "keep exploring". */
  from_state: "running" | "paused";
  base_sha: string | null;
  best_sha: string | null;
  segment: number | null;
  host_id: string | null;
  proposal_id: number | null;
  /** Promotions on best (harvest-math Promotion[]), set once the bench drained. */
  promotions_json: string | null;
  grouping_source: "strategist" | "fallback" | null;
  grouping_notes: string | null;
  round_sent_at: number | null;
  measure_standalone: number;
  /** Total gain relative to best: improvement of best over base, normalized by best (same scale as contributions). */
  total_effect: number | null;
  total_ci_lo: number | null;
  total_ci_hi: number | null;
  total_n: number | null;
  /** Per guardrail: what base → best cost it, relative to best (positive = best is worse), with a CI. */
  total_guardrails_json: string | null;
  /** The same gain normalized by base (the usual "best vs base"). */
  total_vs_base: number | null;
  stacks_json: string | null;
  publisher: "dry-run" | "github";
  publish_state: "dry-run" | "publishing" | "published" | "failed" | null;
  publish_json: string | null;
  export_dir: string | null;
  bench_seconds: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export type AblationStatus = "pending" | "measured" | "conflict" | "gate_failed" | "error";
/** "applied": applies and passes gates on its PR base, effect not measured yet; "folded": ships inside another changeset's PR. */
export type StandaloneStatus = "pending" | "applied" | "pass" | "conflict" | "gate_failed" | "error" | "skipped" | "folded";

export interface ChangesetRow {
  id: number;
  harvest_id: number;
  study_id: string;
  k: number;
  title: string;
  rationale: string;
  candidates_json: string;
  commits_json: string;
  paths_json: string;
  ablation_status: AblationStatus;
  ablation_detail: string | null;
  ablation_sha: string | null;
  /** How much worse best gets without this changeset (positive = it helps), relative to best. */
  contribution: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  n: number | null;
  droppable: number;
  /** Changeset ids (same harvest) this one depends on. */
  depends_on_json: string;
  dependency_reason: string | null;
  /** Stack index (dependent changesets share one), null when independent. */
  stack: number | null;
  /** Where its PR branches from: "base" or another changeset's branch. */
  pr_base: string | null;
  standalone_status: StandaloneStatus;
  standalone_detail: string | null;
  standalone_sha: string | null;
  /** Effect of applying it on its PR base, relative to that base (positive = better). */
  standalone_effect: number | null;
  standalone_ci_lo: number | null;
  standalone_ci_hi: number | null;
  branch: string | null;
  pr_title: string | null;
  pr_body: string | null;
  pr_url: string | null;
  pr_status: "drafted" | "branch" | "pushed" | "opened" | "failed" | null;
  /** The human's choice for a droppable changeset: "keep", "drop", or null (undecided). */
  human_choice: "keep" | "drop" | null;
  /** Per guardrail: what this changeset costs it (best vs best without it), relative to best, positive = worse. */
  guardrails_json: string | null;
  /** The changeset (id) whose PR ships this one, when it doesn't apply on its own PR base; null when it has its own PR. */
  folded_into: number | null;
  /** Why it is folded, in words ("#6 needs src/x.py, which #7 adds or changes, …"). */
  fold_reason: string | null;
  /** Position in its stack's PR order (1 = bottom); folded changesets share their host's. */
  layer: number | null;
}

export interface Budget {
  bench_seconds: number;
}

/** An appended event, as listeners see it (the live view turns these into realtime deltas). */
export interface AppendedEvent {
  id: number;
  studyId: string | null;
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

/**
 * Thrown by a store whose plugin instance was disposed (reload, disable,
 * shutdown). BB closes the database right after the dispose hooks, so work
 * still in flight in the old instance (a measurement awaiting its bench run)
 * must stop instead of touching the handle; this error says so quietly.
 */
export class StoreClosedError extends Error {
  constructor() {
    super("the plugin instance was disposed (reload): its store is closed");
    this.name = "StoreClosedError";
  }
}

export class Store {
  private listeners: Array<(e: AppendedEvent) => void> = [];
  private closedAt: number | null = null;
  /** Accesses refused after close (tests check that the old instance stopped). */
  refusedAfterClose = 0;

  constructor(
    private readonly handle: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** The database handle; throws StoreClosedError once the store is closed. */
  get db(): Database.Database {
    if (this.closedAt !== null) {
      this.refusedAfterClose += 1;
      throw new StoreClosedError();
    }
    return this.handle;
  }

  /** Stop all database access from this instance (plugin dispose). Idempotent. */
  close(): void {
    if (this.closedAt === null) this.closedAt = Date.now();
    this.listeners = [];
  }

  get closed(): boolean {
    return this.closedAt !== null;
  }

  /** Observe every appended event (called synchronously, possibly inside a transaction). Returns an unsubscribe. */
  onEvent(fn: (e: AppendedEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- events (append-only audit) ----
  event(studyId: string | null, kind: string, actor: string, data: Record<string, unknown> = {}): number {
    const at = this.now();
    const r = this.db.prepare(`INSERT INTO events (study_id, at, kind, actor, data_json) VALUES (?, ?, ?, ?, ?)`).run(studyId, at, kind, actor, JSON.stringify(data));
    const id = Number(r.lastInsertRowid);
    for (const l of this.listeners) {
      try {
        l({ id, studyId, at, kind, data });
      } catch {
        // A listener never breaks a state change.
      }
    }
    return id;
  }
  /** Events of a study in id order, after `afterId`, optionally of some kinds (replay, the live view). */
  eventsAsc(studyId: string, opts: { afterId?: number; limit?: number; kinds?: readonly string[]; untilAt?: number } = {}): EventRow[] {
    const kinds = opts.kinds?.length ? ` AND kind IN (${opts.kinds.map(() => "?").join(",")})` : "";
    const until = opts.untilAt !== undefined ? ` AND at <= ?` : "";
    return this.db
      .prepare(`SELECT * FROM events WHERE study_id = ? AND id > ?${kinds}${until} ORDER BY id ASC LIMIT ?`)
      .all(studyId, opts.afterId ?? 0, ...(opts.kinds ?? []), ...(opts.untilAt !== undefined ? [opts.untilAt] : []), opts.limit ?? 100_000) as EventRow[];
  }
  /** The latest events of some kinds, oldest first (the live view's recent window). */
  recentEvents(studyId: string, kinds: readonly string[], limit: number): EventRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE study_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`)
        .all(studyId, ...kinds, limit) as EventRow[]
    ).reverse();
  }
  events(studyId: string, opts: { afterId?: number; limit?: number; kinds?: string[] } = {}): EventRow[] {
    const kinds = opts.kinds?.length ? ` AND kind IN (${opts.kinds.map(() => "?").join(",")})` : "";
    return this.db
      .prepare(`SELECT * FROM events WHERE study_id = ? AND id > ?${kinds} ORDER BY id DESC LIMIT ?`)
      .all(studyId, opts.afterId ?? 0, ...(opts.kinds ?? []), opts.limit ?? 50) as EventRow[];
  }
  lastStudyEventId(studyId: string): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE study_id = ?`).get(studyId) as { id: number }).id;
  }
  lastEventId(): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get() as { id: number }).id;
  }

  // ---- studies ----
  insertStudy(row: Pick<StudyRow, "id" | "slug" | "project_id" | "host_id" | "repo_path" | "study_thread_id">): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO studies (id, slug, project_id, state, spec_version, budget, created_at, updated_at, host_id, repo_path, study_thread_id)
         VALUES (?, ?, ?, 'draft', 0, '{"bench_seconds":0}', ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.slug, row.project_id, t, t, row.host_id, row.repo_path, row.study_thread_id);
  }
  study(idOrSlug: string): StudyRow | undefined {
    return this.db.prepare(`SELECT * FROM studies WHERE id = ? OR slug = ?`).get(idOrSlug, idOrSlug) as StudyRow | undefined;
  }
  studies(states?: StudyState[]): StudyRow[] {
    if (!states?.length) return this.db.prepare(`SELECT * FROM studies ORDER BY created_at DESC`).all() as StudyRow[];
    return this.db
      .prepare(`SELECT * FROM studies WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...states) as StudyRow[];
  }
  updateStudy(id: string, patch: Partial<Omit<StudyRow, "id" | "slug" | "created_at">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE studies SET ${sets}, updated_at = @__now WHERE id = @__id`).run({ ...patch, __now: this.now(), __id: id });
  }
  setStudyState(id: string, state: StudyState, actor: string, data: Record<string, unknown> = {}): void {
    this.tx(() => {
      const before = this.study(id);
      const now = this.now();
      const running: Partial<StudyRow> = {};
      if (state === "running" && before?.state !== "running") running.running_since = now;
      if (state !== "running" && before?.state === "running") {
        running.running_seconds = before.running_seconds + (before.running_since === null ? 0 : (now - before.running_since) / 1000);
        running.running_since = null;
      }
      this.updateStudy(id, { state, ...running, ...(state === "paused" ? { pause_reason: (data.reason as string | undefined) ?? null } : { pause_reason: null }) });
      this.event(id, "study.state", actor, { from: before?.state, to: state, ...data });
    });
  }
  /** True once the study has ever been Running (a mid-run oracle change, not a first calibration). */
  hasRun(studyId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM events WHERE study_id = ? AND kind = 'study.state' AND data_json LIKE '%"to":"running"%' LIMIT 1`).get(studyId));
  }
  budget(study: StudyRow): Budget {
    try {
      return { bench_seconds: 0, ...(JSON.parse(study.budget) as Partial<Budget>) };
    } catch {
      return { bench_seconds: 0 };
    }
  }
  addBenchSeconds(studyId: string, seconds: number): void {
    const s = this.study(studyId);
    if (!s) return;
    const b = this.budget(s);
    b.bench_seconds += seconds;
    this.updateStudy(studyId, { budget: JSON.stringify(b) });
  }

  // ---- spec versions ----
  /**
   * Record a spec version. Before Running it becomes the active version at
   * once (and resets calibration); with `pending` it waits for the human's
   * approval while the study keeps running on the active version.
   */
  addSpecVersion(studyId: string, toml: string, spec: StudySpec, oracleHash: string, actor: string, opts: { bench?: ResolvedBenchHost[]; pending?: boolean } = {}): number {
    return this.tx(() => {
      const v = ((this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM spec_versions WHERE study_id = ?`).get(studyId) as { v: number }).v) + 1;
      this.db
        .prepare(`INSERT INTO spec_versions (study_id, version, spec_toml, spec_json, oracle_hash, created_at, bench_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(studyId, v, toml, JSON.stringify(spec), oracleHash, this.now(), opts.bench ? JSON.stringify(opts.bench) : null);
      if (opts.pending) this.updateStudy(studyId, { pending_spec_version: v });
      else this.updateStudy(studyId, { spec_version: v, pending_spec_version: null, calibration_status: null, calibration_json: null, calibration_approved_at: null });
      this.event(studyId, "spec.proposed", actor, { version: v, oracle_hash: oracleHash, pending: Boolean(opts.pending) });
      return v;
    });
  }
  specOfVersion(studyId: string, version: number): StudySpec {
    const row = this.specVersion(studyId, version);
    if (!row) throw new Error(`spec v${version} not found`);
    return normalizeSpec(JSON.parse(row.spec_json) as StudySpec);
  }
  resolvedBench(studyId: string, version: number): ResolvedBenchHost[] {
    const row = this.specVersion(studyId, version);
    return row?.bench_json ? (JSON.parse(row.bench_json) as ResolvedBenchHost[]) : [];
  }
  specVersion(studyId: string, version: number): SpecVersionRow | undefined {
    return this.db.prepare(`SELECT * FROM spec_versions WHERE study_id = ? AND version = ?`).get(studyId, version) as SpecVersionRow | undefined;
  }
  spec(study: StudyRow): StudySpec {
    const row = this.specVersion(study.id, study.spec_version);
    if (!row) throw new Error(`study ${study.slug} has no spec`);
    return normalizeSpec(JSON.parse(row.spec_json) as StudySpec);
  }
  approveSpec(studyId: string, version: number, actor: string): void {
    this.tx(() => {
      this.db.prepare(`UPDATE spec_versions SET approved_at = COALESCE(approved_at, ?) WHERE study_id = ? AND version = ?`).run(this.now(), studyId, version);
      this.event(studyId, "spec.approved", actor, { version });
    });
  }

  // ---- segments ----
  upsertSegment(row: Omit<SegmentRow, "created_at" | "spec_version" | "details_json"> & { spec_version?: number | null; details_json?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO segments (study_id, k, baseline_sha, oracle_hash, noise_floor, mde, eval_seconds, gate_seconds, report, created_at, spec_version, details_json)
         VALUES (@study_id, @k, @baseline_sha, @oracle_hash, @noise_floor, @mde, @eval_seconds, @gate_seconds, @report, @created_at, @spec_version, @details_json)
         ON CONFLICT (study_id, k) DO UPDATE SET baseline_sha = excluded.baseline_sha, oracle_hash = excluded.oracle_hash,
           noise_floor = excluded.noise_floor, mde = excluded.mde, eval_seconds = excluded.eval_seconds,
           gate_seconds = excluded.gate_seconds, report = excluded.report, spec_version = excluded.spec_version, details_json = excluded.details_json`,
      )
      .run({ spec_version: null, details_json: null, ...row, created_at: this.now() });
  }
  segments(studyId: string): SegmentRow[] {
    return this.db.prepare(`SELECT * FROM segments WHERE study_id = ? ORDER BY k`).all(studyId) as SegmentRow[];
  }
  segment(studyId: string, k: number): SegmentRow | undefined {
    return this.db.prepare(`SELECT * FROM segments WHERE study_id = ? AND k = ?`).get(studyId, k) as SegmentRow | undefined;
  }

  // ---- ideas ----
  addIdea(studyId: string, idea: { title: string; rationale?: string; theme?: string; source: IdeaRow["source"]; priority?: number; pinned?: boolean; start_ref?: string | null; variation_of?: number | null }, actor: string): IdeaRow {
    return this.tx(() => {
      const t = this.now();
      const parent = idea.variation_of ? this.idea(idea.variation_of) : undefined;
      const r = this.db
        .prepare(
          `INSERT INTO ideas (study_id, title, rationale, theme, source, priority, pinned, status, start_ref, created_at, updated_at, variation_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(studyId, idea.title, idea.rationale ?? "", idea.theme ?? "", idea.source, idea.priority ?? 0, idea.pinned ? 1 : 0, idea.start_ref ?? null, t, t, parent?.id ?? null);
      const id = Number(r.lastInsertRowid);
      // A lineage is the root idea of a chain of explicit variations.
      this.db.prepare(`UPDATE ideas SET lineage = ? WHERE id = ?`).run(parent ? (parent.lineage ?? parent.id) : id, id);
      this.event(studyId, "idea.added", actor, { idea: id, title: idea.title, source: idea.source, variation_of: parent?.id ?? null, theme: idea.theme ?? "", priority: idea.priority ?? 0, pinned: Boolean(idea.pinned) });
      return this.idea(id)!;
    });
  }
  setIdeaPinned(id: number, pinned: boolean, actor: string): void {
    const idea = this.idea(id);
    if (!idea) return;
    this.db.prepare(`UPDATE ideas SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, this.now(), id);
    this.event(idea.study_id, "idea.pinned", actor, { idea: id, pinned });
  }
  idea(id: number): IdeaRow | undefined {
    return this.db.prepare(`SELECT * FROM ideas WHERE id = ?`).get(id) as IdeaRow | undefined;
  }
  ideas(studyId: string, statuses?: IdeaStatus[]): IdeaRow[] {
    const where = statuses?.length ? ` AND status IN (${statuses.map(() => "?").join(",")})` : "";
    return this.db
      .prepare(`SELECT * FROM ideas WHERE study_id = ?${where} ORDER BY pinned DESC, priority DESC, id ASC`)
      .all(studyId, ...(statuses ?? [])) as IdeaRow[];
  }
  setIdeaStatus(id: number, status: IdeaStatus, actor: string, reason: string | null = null): void {
    const idea = this.idea(id);
    if (!idea) return;
    this.tx(() => {
      this.db.prepare(`UPDATE ideas SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`).run(status, reason, this.now(), id);
      this.event(idea.study_id, "idea.status", actor, { idea: id, from: idea.status, to: status, reason });
    });
  }
  setIdeaPriority(id: number, priority: number, actor: string): void {
    const idea = this.idea(id);
    if (!idea) return;
    this.db.prepare(`UPDATE ideas SET priority = ?, updated_at = ? WHERE id = ?`).run(priority, this.now(), id);
    this.event(idea.study_id, "idea.priority", actor, { idea: id, priority });
  }

  // ---- threads ----
  insertThread(row: { study_id: string; role: ThreadRole; thread_id?: string | null; spawn_token?: string | null; idea_id?: number | null; state: ThreadState; fork_sha?: string | null }): ThreadRow {
    const r = this.db
      .prepare(
        `INSERT INTO threads (thread_id, spawn_token, study_id, role, idea_id, state, spawned_at, fork_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.thread_id ?? null, row.spawn_token ?? null, row.study_id, row.role, row.idea_id ?? null, row.state, this.now(), row.fork_sha ?? null);
    return this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(Number(r.lastInsertRowid)) as ThreadRow;
  }
  threadById(threadId: string): ThreadRow | undefined {
    return this.db.prepare(`SELECT * FROM threads WHERE thread_id = ?`).get(threadId) as ThreadRow | undefined;
  }
  threadByToken(token: string): ThreadRow | undefined {
    return this.db.prepare(`SELECT * FROM threads WHERE spawn_token = ?`).get(token) as ThreadRow | undefined;
  }
  threadRow(id: number): ThreadRow | undefined {
    return this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
  }
  threads(studyId: string, opts: { role?: ThreadRole; states?: ThreadState[] } = {}): ThreadRow[] {
    const parts = [`study_id = ?`];
    const args: unknown[] = [studyId];
    if (opts.role) {
      parts.push(`role = ?`);
      args.push(opts.role);
    }
    if (opts.states?.length) {
      parts.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      args.push(...opts.states);
    }
    return this.db.prepare(`SELECT * FROM threads WHERE ${parts.join(" AND ")} ORDER BY id`).all(...args) as ThreadRow[];
  }
  updateThread(id: number, patch: Partial<Omit<ThreadRow, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE threads SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @__id`).run({ ...patch, __id: id });
  }

  // ---- candidates ----
  nextCandidateNumber(studyId: string): number {
    return ((this.db.prepare(`SELECT COALESCE(MAX(n), 0) AS n FROM candidates WHERE study_id = ?`).get(studyId) as { n: number }).n) + 1;
  }
  insertCandidate(row: Pick<CandidateRow, "study_id" | "n" | "idea_id" | "thread_id" | "sha" | "parent_sha" | "summary" | "stage" | "changed_paths_json"> & Partial<Pick<CandidateRow, "lines_added" | "lines_deleted" | "worker_id">>): CandidateRow {
    const r = this.db
      .prepare(
        `INSERT INTO candidates (study_id, n, idea_id, thread_id, worker_id, sha, parent_sha, summary, stage, changed_paths_json, submitted_at, lines_added, lines_deleted)
         VALUES (@study_id, @n, @idea_id, @thread_id, @worker_id, @sha, @parent_sha, @summary, @stage, @changed_paths_json, @submitted_at, @lines_added, @lines_deleted)`,
      )
      .run({ lines_added: 0, lines_deleted: 0, worker_id: null, ...row, submitted_at: this.now() });
    const c = this.candidate(Number(r.lastInsertRowid))!;
    this.event(c.study_id, "candidate.stage", "plugin", { candidate: c.id, n: c.n, from: null, to: c.stage, worker: c.thread_id, ...(c.worker_id !== null ? { worker_row: c.worker_id } : {}) });
    return c;
  }
  /**
   * A worker's candidates: linked through its worker row (candidates.worker_id),
   * with the BB thread id as the fallback for rows that predate the link.
   */
  workerCandidates(studyId: string, worker: Pick<ThreadRow, "id" | "thread_id">, opts: { stages?: CandidateStage[]; limit?: number; order?: "asc" | "desc" } = {}): CandidateRow[] {
    const parts = [`study_id = ?`, worker.thread_id ? `(worker_id = ? OR (worker_id IS NULL AND thread_id = ?))` : `worker_id = ?`];
    const args: unknown[] = [studyId, worker.id, ...(worker.thread_id ? [worker.thread_id] : [])];
    if (opts.stages?.length) {
      parts.push(`stage IN (${opts.stages.map(() => "?").join(",")})`);
      args.push(...opts.stages);
    }
    return this.db
      .prepare(`SELECT * FROM candidates WHERE ${parts.join(" AND ")} ORDER BY id ${opts.order === "desc" ? "DESC" : "ASC"} LIMIT ?`)
      .all(...args, opts.limit ?? 1_000_000) as CandidateRow[];
  }
  candidate(id: number): CandidateRow | undefined {
    return this.db.prepare(`SELECT * FROM candidates WHERE id = ?`).get(id) as CandidateRow | undefined;
  }
  candidateByN(studyId: string, n: number): CandidateRow | undefined {
    return this.db.prepare(`SELECT * FROM candidates WHERE study_id = ? AND n = ?`).get(studyId, n) as CandidateRow | undefined;
  }
  candidates(studyId: string, opts: { stages?: CandidateStage[]; threadId?: string; limit?: number; order?: "asc" | "desc" } = {}): CandidateRow[] {
    const parts = [`study_id = ?`];
    const args: unknown[] = [studyId];
    if (opts.stages?.length) {
      parts.push(`stage IN (${opts.stages.map(() => "?").join(",")})`);
      args.push(...opts.stages);
    }
    if (opts.threadId) {
      parts.push(`thread_id = ?`);
      args.push(opts.threadId);
    }
    return this.db
      .prepare(`SELECT * FROM candidates WHERE ${parts.join(" AND ")} ORDER BY id ${opts.order === "desc" ? "DESC" : "ASC"} LIMIT ?`)
      .all(...args, opts.limit ?? 1_000_000) as CandidateRow[];
  }
  candidateCount(studyId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM candidates WHERE study_id = ?`).get(studyId) as { c: number }).c;
  }
  /** Every stage change is also a `candidate.stage` event (the live view and its replay are built on them). */
  updateCandidate(id: number, patch: Partial<Omit<CandidateRow, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const before = patch.stage !== undefined ? this.candidate(id) : undefined;
    this.db.prepare(`UPDATE candidates SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @__id`).run({ ...patch, __id: id });
    if (before && patch.stage !== before.stage) {
      this.event(before.study_id, "candidate.stage", "plugin", { candidate: id, n: before.n, from: before.stage, to: patch.stage, ...(patch.verdict ? { verdict: patch.verdict } : {}) });
    }
  }
  /** Decided candidates in decision order (most recent last). */
  decided(studyId: string, limit = 1000): CandidateRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM candidates WHERE study_id = ? AND stage = 'decided' ORDER BY decided_at DESC, id DESC LIMIT ?`)
        .all(studyId, limit) as CandidateRow[]
    ).reverse();
  }

  // ---- bench intervals ----
  openBenchInterval(row: Omit<BenchIntervalRow, "id" | "started_at" | "ended_at">): number {
    const r = this.db
      .prepare(`INSERT INTO bench_intervals (study_id, host_id, lock_key, kind, candidate_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.study_id, row.host_id, row.lock_key, row.kind, row.candidate_id, this.now());
    return Number(r.lastInsertRowid);
  }
  closeBenchInterval(id: number): void {
    this.db.prepare(`UPDATE bench_intervals SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(this.now(), id);
  }
  benchIntervals(studyId: string, opts: { since?: number } = {}): BenchIntervalRow[] {
    return this.db.prepare(`SELECT * FROM bench_intervals WHERE study_id = ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at, id`).all(studyId, this.now(), opts.since ?? 0) as BenchIntervalRow[];
  }
  /** Close intervals left open by a crash (reconcile). */
  /** Intervals on `hostId` (every study) still holding the lock. */
  openBenchIntervals(hostId: string): BenchIntervalRow[] {
    return this.db.prepare(`SELECT * FROM bench_intervals WHERE host_id = ? AND ended_at IS NULL ORDER BY started_at, id`).all(hostId) as BenchIntervalRow[];
  }
  /** When the last interval on `hostId` other than a gate ended (quiet bench). */
  lastMeasureEnd(hostId: string): number | null {
    const r = this.db.prepare(`SELECT MAX(ended_at) AS t FROM bench_intervals WHERE host_id = ? AND kind != 'gate' AND ended_at IS NOT NULL`).get(hostId) as { t: number | null };
    return r.t;
  }
  closeOpenBenchIntervals(): number {
    return this.db.prepare(`UPDATE bench_intervals SET ended_at = started_at WHERE ended_at IS NULL`).run().changes;
  }

  // ---- notices ----
  addNotice(studyId: string, kind: string, text: string): number {
    const r = this.db.prepare(`INSERT INTO notices (study_id, at, kind, text) VALUES (?, ?, ?, ?)`).run(studyId, this.now(), kind, text);
    return Number(r.lastInsertRowid);
  }
  notices(studyId: string, opts: { undelivered?: boolean; limit?: number } = {}): NoticeRow[] {
    const where = opts.undelivered ? ` AND delivered_round IS NULL` : "";
    return this.db.prepare(`SELECT * FROM notices WHERE study_id = ?${where} ORDER BY id DESC LIMIT ?`).all(studyId, opts.limit ?? 50) as NoticeRow[];
  }
  markNoticesDelivered(ids: number[], round: number): void {
    const stmt = this.db.prepare(`UPDATE notices SET delivered_round = ? WHERE id = ?`);
    for (const id of ids) stmt.run(round, id);
  }

  // ---- samples ----
  samples(candidateId: number): Array<{ run: string; pair: number; side: string; metric: string; value: number; at: number; host_id: string | null }> {
    return this.db.prepare(`SELECT run, pair, side, metric, value, at, host_id FROM samples WHERE candidate_id = ? ORDER BY id`).all(candidateId) as Array<{ run: string; pair: number; side: string; metric: string; value: number; at: number; host_id: string | null }>;
  }
  addSample(row: { study_id: string; candidate_id: number | null; run: string; pair: number; side: string; metric: string; value: number; host_id: string | null }): void {
    this.db
      .prepare(`INSERT INTO samples (study_id, candidate_id, run, pair, side, metric, value, host_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.study_id, row.candidate_id, row.run, row.pair, row.side, row.metric, row.value, row.host_id, this.now());
  }
  /** A candidate's samples after a sample id, in id order (the live CI band reads them incrementally). */
  samplesAfter(candidateId: number, afterId = 0): Array<{ id: number; run: string; pair: number; side: string; metric: string; value: number; at: number }> {
    return this.db.prepare(`SELECT id, run, pair, side, metric, value, at FROM samples WHERE candidate_id = ? AND id > ? ORDER BY id`).all(candidateId, afterId) as Array<{ id: number; run: string; pair: number; side: string; metric: string; value: number; at: number }>;
  }
  /** Lowest and highest sample id of a candidate, and how many (the band cache notices a restarted measurement). */
  sampleBounds(candidateId: number): { min: number; max: number; count: number } {
    const r = this.db.prepare(`SELECT COALESCE(MIN(id), 0) AS min, COALESCE(MAX(id), 0) AS max, COUNT(*) AS count FROM samples WHERE candidate_id = ?`).get(candidateId) as { min: number; max: number; count: number };
    return r;
  }
  deleteSamples(candidateId: number): number {
    return this.db.prepare(`DELETE FROM samples WHERE candidate_id = ?`).run(candidateId).changes;
  }
  deleteCalibrationSamples(studyId: string): void {
    this.db.prepare(`DELETE FROM samples WHERE study_id = ? AND candidate_id IS NULL`).run(studyId);
  }
  sampleCount(candidateId: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM samples WHERE candidate_id = ?`).get(candidateId) as { c: number }).c;
  }

  // ---- findings ----
  addFinding(row: Omit<FindingRow, "id" | "created_at">, actor: string): FindingRow {
    return this.tx(() => {
      const r = this.db
        .prepare(
          `INSERT INTO findings (study_id, idea_id, candidate_id, thread_id, outcome, learned, revisit_if, evidence, created_at)
           VALUES (@study_id, @idea_id, @candidate_id, @thread_id, @outcome, @learned, @revisit_if, @evidence, @created_at)`,
        )
        .run({ ...row, created_at: this.now() });
      const id = Number(r.lastInsertRowid);
      this.event(row.study_id, "finding.recorded", actor, { finding: id, idea: row.idea_id, outcome: row.outcome });
      return this.db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as FindingRow;
    });
  }
  findings(studyId: string, opts: { threadId?: string; ideaId?: number; limit?: number; afterId?: number } = {}): FindingRow[] {
    const parts = [`study_id = ?`, `id > ?`];
    const args: unknown[] = [studyId, opts.afterId ?? 0];
    if (opts.threadId) {
      parts.push(`thread_id = ?`);
      args.push(opts.threadId);
    }
    if (opts.ideaId !== undefined) {
      parts.push(`idea_id = ?`);
      args.push(opts.ideaId);
    }
    return this.db.prepare(`SELECT * FROM findings WHERE ${parts.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, opts.limit ?? 50) as FindingRow[];
  }
  searchFindings(studyId: string, q: { text?: string; theme?: string; verdict?: string; limit: number }): Array<FindingRow & { title: string | null; theme: string | null; verdict: string | null; n: number | null }> {
    const parts = [`f.study_id = ?`];
    const args: unknown[] = [studyId];
    if (q.text) {
      parts.push(`(f.learned LIKE ? OR f.revisit_if LIKE ? OR f.evidence LIKE ? OR i.title LIKE ? OR i.rationale LIKE ?)`);
      const like = `%${q.text.replace(/[%_]/gu, "")}%`;
      args.push(like, like, like, like, like);
    }
    if (q.theme) {
      parts.push(`i.theme = ?`);
      args.push(q.theme);
    }
    if (q.verdict) {
      parts.push(`c.verdict = ?`);
      args.push(q.verdict);
    }
    return this.db
      .prepare(
        `SELECT f.*, i.title AS title, i.theme AS theme, c.verdict AS verdict, c.n AS n FROM findings f
         LEFT JOIN ideas i ON i.id = f.idea_id LEFT JOIN candidates c ON c.id = f.candidate_id
         WHERE ${parts.join(" AND ")} ORDER BY f.id DESC LIMIT ?`,
      )
      .all(...args, q.limit) as Array<FindingRow & { title: string | null; theme: string | null; verdict: string | null; n: number | null }>;
  }

  // ---- dossier ----
  dossier(studyId: string): { version: number; text: string } | null {
    const row = this.db.prepare(`SELECT version, text FROM dossiers WHERE study_id = ? ORDER BY version DESC LIMIT 1`).get(studyId) as { version: number; text: string } | undefined;
    return row ?? null;
  }
  setDossier(studyId: string, text: string, authorThreadId: string | null): number {
    return this.tx(() => {
      const v = (this.dossier(studyId)?.version ?? 0) + 1;
      this.db.prepare(`INSERT INTO dossiers (study_id, version, text, author_thread_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(studyId, v, text, authorThreadId, this.now());
      this.event(studyId, "dossier.updated", authorThreadId ?? "human", { version: v, chars: text.length });
      return v;
    });
  }

  addHarvestProposal(studyId: string, proposal: unknown, authorThreadId: string, harvestId: number | null = null): number {
    const r = this.db
      .prepare(`INSERT INTO harvest_proposals (study_id, proposal_json, author_thread_id, created_at, harvest_id) VALUES (?, ?, ?, ?, ?)`)
      .run(studyId, JSON.stringify(proposal), authorThreadId, this.now(), harvestId);
    this.event(studyId, "harvest.proposed", authorThreadId, { proposal: Number(r.lastInsertRowid), harvest: harvestId });
    return Number(r.lastInsertRowid);
  }
  harvestProposal(harvestId: number): { id: number; proposal_json: string; author_thread_id: string | null; created_at: number } | undefined {
    return this.db.prepare(`SELECT id, proposal_json, author_thread_id, created_at FROM harvest_proposals WHERE harvest_id = ? ORDER BY id DESC LIMIT 1`).get(harvestId) as
      | { id: number; proposal_json: string; author_thread_id: string | null; created_at: number }
      | undefined;
  }

  // ---- harvests (M3) ----
  insertHarvest(row: Pick<HarvestRow, "study_id" | "from_state" | "measure_standalone"> & { grouping_source?: "fallback" | null }, actor: string): HarvestRow {
    return this.tx(() => {
      const r = this.db
        .prepare(
          `INSERT INTO harvests (study_id, seq, state, from_state, measure_standalone, started_at, grouping_source, grouping_notes) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM harvests WHERE study_id = ?), 'waiting', ?, ?, ?, ?, ?)`,
        )
        .run(row.study_id, row.study_id, row.from_state, row.measure_standalone, this.now(), row.grouping_source ?? null, row.grouping_source === "fallback" ? "one changeset per promotion, as you asked" : null);
      const id = Number(r.lastInsertRowid);
      this.event(row.study_id, "harvest.started", actor, { harvest: id, seq: this.harvest(id)!.seq, from: row.from_state });
      return this.harvest(id)!;
    });
  }
  harvest(id: number): HarvestRow | undefined {
    return this.db.prepare(`SELECT * FROM harvests WHERE id = ?`).get(id) as HarvestRow | undefined;
  }
  latestHarvest(studyId: string): HarvestRow | undefined {
    return this.db.prepare(`SELECT * FROM harvests WHERE study_id = ? ORDER BY id DESC LIMIT 1`).get(studyId) as HarvestRow | undefined;
  }
  harvests(studyId: string): HarvestRow[] {
    return this.db.prepare(`SELECT * FROM harvests WHERE study_id = ? ORDER BY id DESC LIMIT 50`).all(studyId) as HarvestRow[];
  }
  activeHarvests(): HarvestRow[] {
    return this.db.prepare(`SELECT * FROM harvests WHERE state IN ('waiting','grouping','ablating','checking','drafting') ORDER BY id`).all() as HarvestRow[];
  }
  updateHarvest(id: number, patch: Partial<Omit<HarvestRow, "id" | "study_id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE harvests SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @__id`).run({ ...patch, __id: id });
  }
  insertChangeset(row: Pick<ChangesetRow, "harvest_id" | "study_id" | "k" | "title" | "rationale" | "candidates_json" | "commits_json" | "paths_json">): ChangesetRow {
    const r = this.db
      .prepare(
        `INSERT INTO changesets (harvest_id, study_id, k, title, rationale, candidates_json, commits_json, paths_json) VALUES (@harvest_id, @study_id, @k, @title, @rationale, @candidates_json, @commits_json, @paths_json)`,
      )
      .run(row);
    return this.db.prepare(`SELECT * FROM changesets WHERE id = ?`).get(Number(r.lastInsertRowid)) as ChangesetRow;
  }
  changesets(harvestId: number): ChangesetRow[] {
    return this.db.prepare(`SELECT * FROM changesets WHERE harvest_id = ? ORDER BY k`).all(harvestId) as ChangesetRow[];
  }
  changeset(id: number): ChangesetRow | undefined {
    return this.db.prepare(`SELECT * FROM changesets WHERE id = ?`).get(id) as ChangesetRow | undefined;
  }
  updateChangeset(id: number, patch: Partial<Omit<ChangesetRow, "id" | "harvest_id" | "study_id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE changesets SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @__id`).run({ ...patch, __id: id });
  }
  deleteChangesets(harvestId: number): void {
    this.db.prepare(`DELETE FROM changesets WHERE harvest_id = ?`).run(harvestId);
  }

  /** Tokens a study's threads reported (workers in full, the study thread since the study started), or null when no thread reported any. */
  studyTokens(studyId: string): number | null {
    const r = this.db
      .prepare(`SELECT COUNT(tokens) AS n, COALESCE(SUM(MAX(0, tokens - COALESCE(tokens_base, 0))), 0) AS t FROM threads WHERE study_id = ? AND tokens IS NOT NULL`)
      .get(studyId) as { n: number; t: number };
    return r.n ? r.t : null;
  }
  specVersions(studyId: string): SpecVersionRow[] {
    return this.db.prepare(`SELECT * FROM spec_versions WHERE study_id = ? ORDER BY version DESC LIMIT 100`).all(studyId) as SpecVersionRow[];
  }

  // ---- bench hosts (M2) ----
  /** Make the study's bench host rows match `hosts` (the active spec); removed hosts become inactive. */
  syncBenchHosts(studyId: string, hosts: ResolvedBenchHost[]): void {
    this.tx(() => {
      this.db.prepare(`UPDATE bench_hosts SET active = 0 WHERE study_id = ?`).run(studyId);
      hosts.forEach((h, i) => {
        this.db
          .prepare(
            `INSERT INTO bench_hosts (study_id, host_id, name, entry, mode, position, active) VALUES (?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT (study_id, host_id) DO UPDATE SET name = excluded.name, entry = excluded.entry, mode = excluded.mode, position = excluded.position, active = 1`,
          )
          .run(studyId, h.hostId, h.name, h.entry, h.mode, i);
      });
    });
  }
  benchHosts(studyId: string, opts: { all?: boolean } = {}): BenchHostRow[] {
    return this.db.prepare(`SELECT * FROM bench_hosts WHERE study_id = ?${opts.all ? "" : " AND active = 1"} ORDER BY position, host_id`).all(studyId) as BenchHostRow[];
  }
  benchHost(studyId: string, hostId: string): BenchHostRow | undefined {
    return this.db.prepare(`SELECT * FROM bench_hosts WHERE study_id = ? AND host_id = ?`).get(studyId, hostId) as BenchHostRow | undefined;
  }
  updateBenchHost(studyId: string, hostId: string, patch: Partial<Omit<BenchHostRow, "study_id" | "host_id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE bench_hosts SET ${sets} WHERE study_id = @__s AND host_id = @__h`).run({ ...patch, __s: studyId, __h: hostId });
  }
  /** Every study's bench hosts on `hostId` (a host worker exit affects all of them). */
  benchHostsOn(hostId: string): BenchHostRow[] {
    return this.db.prepare(`SELECT * FROM bench_hosts WHERE host_id = ? AND active = 1`).all(hostId) as BenchHostRow[];
  }

  addHealthCheck(row: Omit<HealthCheckRow, "id" | "at">): number {
    const r = this.db
      .prepare(`INSERT INTO health_checks (study_id, host_id, at, context, ok, problems_json, report_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.study_id, row.host_id, this.now(), row.context, row.ok, row.problems_json, row.report_json);
    return Number(r.lastInsertRowid);
  }
  healthChecks(studyId: string, opts: { hostId?: string; limit?: number } = {}): HealthCheckRow[] {
    const host = opts.hostId ? ` AND host_id = ?` : "";
    return this.db
      .prepare(`SELECT * FROM health_checks WHERE study_id = ?${host} ORDER BY id DESC LIMIT ?`)
      .all(studyId, ...(opts.hostId ? [opts.hostId] : []), opts.limit ?? 20) as HealthCheckRow[];
  }

  openDriftCheck(row: Pick<DriftCheckRow, "study_id" | "host_id" | "segment" | "best_sha">): number {
    const r = this.db
      .prepare(`INSERT INTO drift_checks (study_id, host_id, segment, best_sha, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')`)
      .run(row.study_id, row.host_id, row.segment, row.best_sha, this.now());
    return Number(r.lastInsertRowid);
  }
  closeDriftCheck(id: number, patch: Partial<Pick<DriftCheckRow, "status" | "pairs" | "noise" | "calibrated" | "ratio" | "median">>): void {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE drift_checks SET ${sets}${keys.length ? ", " : ""}finished_at = @__now WHERE id = @__id`).run({ ...patch, __now: this.now(), __id: id });
  }
  driftChecks(studyId: string, limit = 20): DriftCheckRow[] {
    return this.db.prepare(`SELECT * FROM drift_checks WHERE study_id = ? ORDER BY id DESC LIMIT ?`).all(studyId, limit) as DriftCheckRow[];
  }
  /** Drift checks left running by a crash (reconcile). */
  abortRunningDriftChecks(): number {
    return this.db.prepare(`UPDATE drift_checks SET status = 'aborted', finished_at = ? WHERE status = 'running'`).run(this.now()).changes;
  }

  addTransfer(row: Omit<TransferRow, "id" | "at">): void {
    this.db
      .prepare(`INSERT INTO transfers (study_id, host_id, sha, purpose, bytes, chunks, ms, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.study_id, row.host_id, row.sha, row.purpose, row.bytes, row.chunks, row.ms, row.ok, row.error, this.now());
  }
  transfers(studyId: string, limit = 50): TransferRow[] {
    return this.db.prepare(`SELECT * FROM transfers WHERE study_id = ? ORDER BY id DESC LIMIT ?`).all(studyId, limit) as TransferRow[];
  }

  /** Private holdout numbers: written here, read only by tests and the human's own SQLite access. */
  recordHoldout(row: { candidate_id: number; study_id: string; pass: boolean; runs: number; effect: number | null; details: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO holdout_results (candidate_id, study_id, at, pass, runs, effect, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (candidate_id) DO UPDATE SET at = excluded.at, pass = excluded.pass, runs = excluded.runs, effect = excluded.effect, details_json = excluded.details_json`,
      )
      .run(row.candidate_id, row.study_id, this.now(), row.pass ? 1 : 0, row.runs, row.effect, JSON.stringify(row.details));
  }
}
