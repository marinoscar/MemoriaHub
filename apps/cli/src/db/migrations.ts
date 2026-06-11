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
