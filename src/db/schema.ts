// SQLite schema (append-only migrations; never edit a shipped statement).
// Tables follow docs/design.md "Data model"; extra columns are the
// implementation state the design leaves implicit.

export const STUDY_STATES = ["draft", "calibrating", "running", "paused", "harvesting", "archived"] as const;
export type StudyState = (typeof STUDY_STATES)[number];

export const IDEA_STATUSES = ["queued", "running", "won", "lost", "abandoned", "retired"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const THREAD_ROLES = ["worker", "strategist"] as const;
export type ThreadRole = (typeof THREAD_ROLES)[number];

export const THREAD_STATES = ["spawning", "active", "finishing", "finished", "abandoned", "failed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/** Pipeline stages a candidate moves through. */
export const CANDIDATE_STAGES = ["submitted", "gating", "queued", "measuring", "confirming", "promoting", "decided"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export const MIGRATIONS: string[] = [
  `CREATE TABLE studies (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL,
    spec_version INTEGER NOT NULL,
    best_sha TEXT,
    budget TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    host_id TEXT,
    repo_path TEXT,
    study_thread_id TEXT,
    section_id TEXT,
    segment INTEGER NOT NULL DEFAULT 0,
    base_sha TEXT,
    pause_reason TEXT,
    calibration_status TEXT,
    calibration_json TEXT,
    calibration_approved_at INTEGER,
    round_in_flight INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0,
    verdicts_since_round INTEGER NOT NULL DEFAULT 0,
    last_round_at INTEGER,
    last_round_event_id INTEGER NOT NULL DEFAULT 0,
    stall_signaled_at_verdict INTEGER NOT NULL DEFAULT 0,
    best_run_json TEXT,
    best_run_sha TEXT
  )`,
  `CREATE TABLE spec_versions (
    study_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    spec_toml TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    oracle_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    PRIMARY KEY (study_id, version)
  )`,
  `CREATE TABLE segments (
    study_id TEXT NOT NULL,
    k INTEGER NOT NULL,
    baseline_sha TEXT NOT NULL,
    oracle_hash TEXT NOT NULL,
    noise_floor REAL,
    mde REAL,
    eval_seconds REAL,
    gate_seconds REAL,
    report TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (study_id, k)
  )`,
  `CREATE TABLE ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id TEXT NOT NULL,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    start_ref TEXT,
    status_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX ideas_study_status ON ideas (study_id, status)`,
  `CREATE TABLE threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT UNIQUE,
    spawn_token TEXT UNIQUE,
    study_id TEXT NOT NULL,
    role TEXT NOT NULL,
    idea_id INTEGER,
    state TEXT NOT NULL,
    submissions INTEGER NOT NULL DEFAULT 0,
    spawned_at INTEGER NOT NULL,
    fork_sha TEXT,
    environment_id TEXT,
    worktree_path TEXT,
    last_idle_at INTEGER,
    last_active_at INTEGER,
    nudged_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT
  )`,
  `CREATE INDEX threads_study ON threads (study_id, role, state)`,
  `CREATE TABLE candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    idea_id INTEGER,
    thread_id TEXT,
    sha TEXT NOT NULL,
    parent_sha TEXT NOT NULL,
    against_sha TEXT,
    prepared_sha TEXT,
    promoted_sha TEXT,
    summary TEXT NOT NULL,
    stage TEXT NOT NULL,
    verdict TEXT,
    effect REAL,
    ci_lo REAL,
    ci_hi REAL,
    metrics_json TEXT,
    reasons_json TEXT,
    changed_paths_json TEXT,
    diag_json TEXT,
    gate_output TEXT,
    bench_seconds REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    submitted_at INTEGER NOT NULL,
    decided_at INTEGER,
    reported_at INTEGER,
    UNIQUE (study_id, n)
  )`,
  `CREATE INDEX candidates_stage ON candidates (study_id, stage)`,
  `CREATE TABLE samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id TEXT NOT NULL,
    candidate_id INTEGER,
    run TEXT NOT NULL,
    pair INTEGER NOT NULL,
    side TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    host_id TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX samples_candidate ON samples (candidate_id, run)`,
  `CREATE TABLE findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id TEXT NOT NULL,
    idea_id INTEGER,
    candidate_id INTEGER,
    thread_id TEXT,
    outcome TEXT NOT NULL,
    learned TEXT NOT NULL,
    revisit_if TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id TEXT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX events_study ON events (study_id, id)`,
  `CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`,
  `CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`,
  `CREATE TABLE dossiers (
    study_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    author_thread_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (study_id, version)
  )`,
  `CREATE TABLE harvest_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    author_thread_id TEXT,
    created_at INTEGER NOT NULL
  )`,
];
