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
  last_sync_at TEXT
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

/**
 * Migration 4: rate-limit / retry settings. Seeded for existing installs that
 * already passed migration 1 (INSERT OR IGNORE, so re-running is safe).
 */
export const SEED_SETTINGS_V4: Array<{ key: string; value: string }> = [
  { key: 'max_retries',                value: JSON.stringify(5) },
  { key: 'retry_base_ms',              value: JSON.stringify(500) },
  { key: 'retry_max_ms',               value: JSON.stringify(30000) },
  { key: 'rate_limit_cooldown_ms',     value: JSON.stringify(2000) },
  { key: 'rate_limit_max_cooldown_ms', value: JSON.stringify(60000) },
];

/**
 * Migration 5: durable multipart resume.
 *
 * upload_id       — opaque upload-session identifier from the server's /upload/init
 *                   response.  NULL when no upload is in progress.
 * upload_part_size — byte length of each part, needed to slice the file correctly
 *                   on resume.  NULL when no upload is in progress.
 */
export const ALTER_FILES_ADD_UPLOAD_ID = `
ALTER TABLE files ADD COLUMN upload_id TEXT`;

export const ALTER_FILES_ADD_UPLOAD_PART_SIZE = `
ALTER TABLE files ADD COLUMN upload_part_size INTEGER`;

/**
 * Migration 5: table that records which multipart parts have been successfully
 * PUT to storage.  Each row is written immediately after the S3/R2 PUT returns
 * an ETag so a CLI crash leaves behind exactly the parts that were confirmed.
 *
 * The PRIMARY KEY (file_id, part_number) is the idempotency anchor — re-saving
 * the same part is safe (ON CONFLICT REPLACE).  Rows are deleted when the
 * upload completes successfully or when the server session is found to have
 * expired (so the next attempt starts clean).
 */
export const CREATE_FILE_UPLOAD_PARTS = `
CREATE TABLE IF NOT EXISTS file_upload_parts (
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_number  INTEGER NOT NULL,
  etag         TEXT    NOT NULL,
  PRIMARY KEY (file_id, part_number)
)`;

/** Migration 6: persist why a file was skipped ('dedup' | 'unchanged'). Nullable. */
export const ALTER_FILES_ADD_SKIP_REASON = `
ALTER TABLE files ADD COLUMN skip_reason TEXT`;

/**
 * Migration 7: pre-sync "scan" (dry-run preview).
 *
 * A scan is a point-in-time, immutable snapshot of the file set a sync WOULD
 * process, captured without any uploads.  It is deliberately kept OUT of the
 * mutable `files` sync ledger (which sync overwrites on every run) so that the
 * snapshot survives untouched until a later `sync --scan` can diff the folders
 * against it for change detection.
 *
 * `scans` holds one row per scan run with denormalized rollups so `scan list`
 * is a single cheap SELECT.
 */
export const CREATE_SCANS = `
CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT    NOT NULL,
  finished_at  TEXT,
  status       TEXT    NOT NULL DEFAULT 'running',
  trigger      TEXT    NOT NULL,
  folder_ids   TEXT    NOT NULL,
  total_files  INTEGER NOT NULL DEFAULT 0,
  total_bytes  INTEGER NOT NULL DEFAULT 0,
  photo_count  INTEGER NOT NULL DEFAULT 0,
  video_count  INTEGER NOT NULL DEFAULT 0,
  exif_count   INTEGER NOT NULL DEFAULT 0,
  gps_count    INTEGER NOT NULL DEFAULT 0
)`;

export const CREATE_SCANS_IDX_CREATED = `
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at)`;

/**
 * Migration 7: `scan_files` — one immutable snapshot row per file per scan.
 *
 * The two metadata flags the scan report is built around are `has_exif` and
 * `has_gps` (location present inside EXIF).  The remaining metadata columns come
 * for free from the same exifr parse and are surfaced only in the Excel detail
 * sheet as bonus analysis columns.  `meta_error` records why extraction failed
 * for a given file without failing the whole scan.
 */
export const CREATE_SCAN_FILES = `
CREATE TABLE IF NOT EXISTS scan_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id      INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  folder_id    INTEGER NOT NULL,
  file_path    TEXT    NOT NULL,
  size_bytes   INTEGER,
  mtime_ms     INTEGER,
  mime_type    TEXT,
  media_kind   TEXT,
  has_exif     INTEGER NOT NULL DEFAULT 0,
  has_gps      INTEGER NOT NULL DEFAULT 0,
  captured_at  TEXT,
  width        INTEGER,
  height       INTEGER,
  camera_make  TEXT,
  camera_model TEXT,
  taken_lat    REAL,
  taken_lng    REAL,
  meta_error   TEXT,
  UNIQUE(scan_id, folder_id, file_path)
)`;

export const CREATE_SCAN_FILES_IDX_SCAN = `
CREATE INDEX IF NOT EXISTS idx_scan_files_scan ON scan_files(scan_id)`;

export const CREATE_SCAN_FILES_IDX_SCAN_KIND = `
CREATE INDEX IF NOT EXISTS idx_scan_files_scan_kind ON scan_files(scan_id, media_kind)`;

/**
 * Migration v8: provenance for scan_files.captured_at.  Records whether the
 * captured_at value came from real EXIF ('exif'), was inferred from the oldest
 * of the file's created/modified/accessed stamps ('file'), or is unavailable
 * ('none') — so the scan preview never presents a guessed date as if it were
 * a real EXIF date.
 */
export const ALTER_SCAN_FILES_ADD_CAPTURED_AT_SOURCE = `
ALTER TABLE scan_files ADD COLUMN captured_at_source TEXT`;

/**
 * Migration v9: record whether a per-folder `memoriahub.json` override WOULD
 * fill a gap the file's own EXIF left open, so the scan preview shows the user
 * exactly which files a sync would date-stamp / geo-tag from the override before
 * they upload.  Both flags are booleans stored as 0/1, NOT NULL DEFAULT 0 so
 * existing snapshot rows read as "no fallback applied".
 *
 * fallback_date_applied     — override supplies capturedAt (file has no EXIF date).
 * fallback_location_applied — override supplies GPS (file has no EXIF location).
 */
export const ALTER_SCAN_FILES_ADD_FALLBACK_DATE = `
ALTER TABLE scan_files ADD COLUMN fallback_date_applied INTEGER NOT NULL DEFAULT 0`;

export const ALTER_SCAN_FILES_ADD_FALLBACK_LOCATION = `
ALTER TABLE scan_files ADD COLUMN fallback_location_applied INTEGER NOT NULL DEFAULT 0`;
