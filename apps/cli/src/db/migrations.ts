/**
 * db/migrations.ts — Version-gated migration runner for the SQLite database.
 *
 * Uses PRAGMA user_version as a migration counter.  Each migration is a plain
 * function that receives the open Database instance and must run synchronously.
 * The runner applies every migration whose version > current user_version inside
 * a single transaction, then updates user_version to the final version number.
 */

import type BetterSqlite3 from 'better-sqlite3';
import {
  CREATE_FOLDERS,
  CREATE_FOLDERS_IDX_ENABLED,
  CREATE_FILES,
  CREATE_FILES_IDX_FOLDER_STATUS,
  CREATE_FILES_IDX_STATUS,
  CREATE_FILES_IDX_SHA256,
  CREATE_SYNC_RUNS,
  CREATE_SYNC_RUNS_IDX_STARTED,
  CREATE_SETTINGS,
  SEED_SETTINGS,
  SEED_SETTINGS_V4,
  ALTER_FILES_ADD_MTIME_MS,
  ALTER_FOLDERS_ADD_CIRCLE_ID,
  ALTER_FILES_ADD_UPLOAD_ID,
  ALTER_FILES_ADD_UPLOAD_PART_SIZE,
  CREATE_FILE_UPLOAD_PARTS,
} from './schema.js';

interface Migration {
  version: number;
  up: (db: BetterSqlite3.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db: BetterSqlite3.Database): void {
      // Create all tables
      db.exec(CREATE_FOLDERS);
      db.exec(CREATE_FOLDERS_IDX_ENABLED);
      db.exec(CREATE_FILES);
      db.exec(CREATE_FILES_IDX_FOLDER_STATUS);
      db.exec(CREATE_FILES_IDX_STATUS);
      db.exec(CREATE_FILES_IDX_SHA256);
      db.exec(CREATE_SYNC_RUNS);
      db.exec(CREATE_SYNC_RUNS_IDX_STARTED);
      db.exec(CREATE_SETTINGS);

      // Seed default settings using INSERT OR IGNORE so re-running is safe.
      const insert = db.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      );
      for (const { key, value } of SEED_SETTINGS) {
        insert.run(key, value);
      }
    },
  },
  {
    version: 2,
    up(db: BetterSqlite3.Database): void {
      // Add mtime_ms column to files table for hash-cache invalidation.
      // SQLite ALTER TABLE ADD COLUMN is safe to run: the column is nullable,
      // so existing rows get NULL (meaning "no cached mtime yet"), and the
      // engine will recompute and store it on the next sync.
      db.exec(ALTER_FILES_ADD_MTIME_MS);
    },
  },
  {
    version: 3,
    up(db: BetterSqlite3.Database): void {
      // Add circle_id column to folders table for per-folder circle binding.
      // Nullable: existing rows get NULL (no circle bound yet).
      db.exec(ALTER_FOLDERS_ADD_CIRCLE_ID);
    },
  },
  {
    version: 4,
    up(db: BetterSqlite3.Database): void {
      // Seed rate-limit / retry settings. Existing installs already passed the
      // version-1 seed loop, so backfill here. INSERT OR IGNORE keeps any value
      // a user may have set and is safe to re-run.
      const insert = db.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      );
      for (const { key, value } of SEED_SETTINGS_V4) {
        insert.run(key, value);
      }
    },
  },
  {
    version: 5,
    up(db: BetterSqlite3.Database): void {
      // Add upload_id column: stores the server-issued multipart upload session
      // identifier so the CLI can resume an interrupted upload on restart.
      // Nullable — NULL means no upload is currently in progress.
      db.exec(ALTER_FILES_ADD_UPLOAD_ID);
      // Add upload_part_size column: the byte length of each part, required to
      // slice the file correctly when re-uploading remaining parts on resume.
      // Nullable — NULL when no upload is in progress.
      db.exec(ALTER_FILES_ADD_UPLOAD_PART_SIZE);
      // Create the per-part persistence table.  Each row is written immediately
      // after a presigned PUT succeeds, so a crash leaves behind exactly the
      // parts that were confirmed by the storage provider.
      db.exec(CREATE_FILE_UPLOAD_PARTS);
    },
  },
];

/**
 * Run all pending migrations against the given database.
 * Reads `PRAGMA user_version`, applies each migration with version > current
 * inside a transaction, and writes the final version back.
 */
export function runMigrations(db: BetterSqlite3.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current);

  if (pending.length === 0) return;

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
    }
    const next = pending[pending.length - 1]!.version;
    // PRAGMA user_version cannot be set via a prepared statement parameter —
    // we must use exec with a literal value.
    db.exec(`PRAGMA user_version = ${next}`);
  });

  applyAll();
}
