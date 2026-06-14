/**
 * db/schema.ts — DDL strings for the MemoriaHub SQLite schema.
 *
 * Each statement string is used by the migration runner in migrations.ts.
 * They are kept here so schema and migration logic are separated.
 */

export const CREATE_FOLDERS = `
CREATE TABLE IF NOT EXISTS folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,
  path_hash   TEXT    NOT NULL,
  recursive   INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT    NOT NULL,
  last_sync_at TEXT,
  circle_id   TEXT
)`;

export const CREATE_FOLDERS_IDX_ENABLED = `
CREATE INDEX IF NOT EXISTS idx_folders_enabled ON folders(enabled)`;

export const CREATE_FILES = `
CREATE TABLE IF NOT EXISTS files (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id         INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  file_path         TEXT    NOT NULL,
  sha256            TEXT,
  status            TEXT    NOT NULL DEFAULT 'queued',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  media_item_id     TEXT,
  storage_object_id TEXT,
  size_bytes        INTEGER,
  mime_type         TEXT,
  first_seen_at     TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  uploaded_at       TEXT,
  UNIQUE(folder_id, file_path)
)`;

export const CREATE_FILES_IDX_FOLDER_STATUS = `
CREATE INDEX IF NOT EXISTS idx_files_folder_status ON files(folder_id, status)`;

export const CREATE_FILES_IDX_STATUS = `
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status)`;

export const CREATE_FILES_IDX_SHA256 = `
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256)`;

/** Migration 2: add mtime_ms column to files for hash-cache invalidation. */
export const ALTER_FILES_ADD_MTIME_MS = `
ALTER TABLE files ADD COLUMN mtime_ms INTEGER`;

/** Migration 3: add circle_id column to folders for per-folder circle binding. */
export const ALTER_FOLDERS_ADD_CIRCLE_ID = `
ALTER TABLE folders ADD COLUMN circle_id TEXT`;

export const CREATE_SYNC_RUNS = `
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  trigger     TEXT    NOT NULL,
  folder_ids  TEXT    NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  uploaded    INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  dry_run     INTEGER NOT NULL DEFAULT 0
)`;

export const CREATE_SYNC_RUNS_IDX_STARTED = `
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at)`;

export const CREATE_SETTINGS = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** Default settings rows inserted during initial migration. */
export const SEED_SETTINGS: Array<{ key: string; value: string }> = [
  { key: 'concurrency',                value: JSON.stringify(3) },
  { key: 'attempts_cap',               value: JSON.stringify(5) },
  { key: 'schema_imported_manifests',  value: JSON.stringify(false) },
];
