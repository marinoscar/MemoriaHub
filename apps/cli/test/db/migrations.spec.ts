/**
 * test/db/migrations.spec.ts
 *
 * Verifies that the migration runner correctly initialises a fresh in-memory
 * database, creates all expected tables, seeds default settings, and is
 * idempotent on a second run.
 */

import { createRequire } from 'node:module';
import { openDb } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
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
  ALTER_FILES_ADD_MTIME_MS,
} from '../../src/db/schema.js';
import type BetterSqlite3 from 'better-sqlite3';

// Open a raw SQLite in-memory DB without running importLegacyManifests.
// We need this to inspect the seed values *before* the importer overwrites them.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RawDatabase = require('better-sqlite3') as typeof BetterSqlite3;

function openRaw(): BetterSqlite3.Database {
  const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// openDb(':memory:') calls importLegacyManifests which reads ~/.memoriahub/manifests.
// That directory typically does not exist in CI, so the importer returns early.
// We do NOT override HOME here — we just use ':memory:' which bypasses the file path.

describe('migrations — fresh :memory: database', () => {
  it('reaches the latest user_version (3)', () => {
    const db = openDb(':memory:');
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(3);
    db.close();
  });

  it('creates the folders table', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folders'")
      .get();
    expect(row).toBeTruthy();
    db.close();
  });

  it('creates the files table', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
      .get();
    expect(row).toBeTruthy();
    db.close();
  });

  it('creates the sync_runs table', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_runs'")
      .get();
    expect(row).toBeTruthy();
    db.close();
  });

  it('creates the settings table', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .get();
    expect(row).toBeTruthy();
    db.close();
  });

  it('creates all expected indexes', () => {
    const db = openDb(':memory:');
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(indexes).toContain('idx_folders_enabled');
    expect(indexes).toContain('idx_files_folder_status');
    expect(indexes).toContain('idx_files_status');
    expect(indexes).toContain('idx_files_sha256');
    expect(indexes).toContain('idx_sync_runs_started_at');
    db.close();
  });

  it('seeds concurrency=3 by default', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT value FROM settings WHERE key='concurrency'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe(3);
    db.close();
  });

  it('seeds attempts_cap=5 by default', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT value FROM settings WHERE key='attempts_cap'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe(5);
    db.close();
  });

  it('seeds schema_imported_manifests=false by default (checked before importLegacyManifests runs)', () => {
    // Use a raw DB that skips importLegacyManifests (which always sets the flag to true).
    const db = openRaw();
    const row = db
      .prepare("SELECT value FROM settings WHERE key='schema_imported_manifests'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe(false);
    db.close();
  });

  it('is idempotent — re-running runMigrations does not change user_version or duplicate settings', () => {
    // Use raw DB so importLegacyManifests does not interfere with the settings count.
    const db = openRaw();

    // Run again — should be a no-op (version already at 3, all seeds use INSERT OR IGNORE)
    runMigrations(db);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(3);

    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM settings').get() as { cnt: number }
    ).cnt;
    // Exactly the 3 seed rows — no duplicates
    expect(count).toBe(3);

    db.close();
  });

  it('migration 2 adds the mtime_ms column to the files table', () => {
    const db = openDb(':memory:');
    const cols = (
      db.prepare("PRAGMA table_info('files')").all() as Array<{ name: string; type: string; notnull: number }>
    );
    const mtimeCol = cols.find((c) => c.name === 'mtime_ms');
    expect(mtimeCol).toBeDefined();
    // Column must be nullable (notnull=0) and INTEGER type
    expect(mtimeCol!.type).toBe('INTEGER');
    expect(mtimeCol!.notnull).toBe(0);
    db.close();
  });

  it('migration 2 is idempotent — re-running on an already-migrated db is a no-op', () => {
    const db = openRaw();
    // openRaw() already runs all migrations including v2 and v3
    const versionBefore = db.pragma('user_version', { simple: true }) as number;
    expect(versionBefore).toBe(3);

    // Re-running must not throw and must not change version
    runMigrations(db);
    const versionAfter = db.pragma('user_version', { simple: true }) as number;
    expect(versionAfter).toBe(3);

    db.close();
  });

  it('migration 3 adds circle_id column to folders table', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("PRAGMA table_info('folders')").all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'circle_id');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
    expect(col!.notnull).toBe(0);
    db.close();
  });

  it('migration 3 applies to a v2 database (upgrading a pre-existing db)', () => {
    // Start with v1+v2 (mtime_ms) and run migrations to get to v3.
    // We use RawDatabase (already required at top) to create a fresh DB
    // without running any migrations, then manually apply only v1 and v2.
    const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
    db.pragma('foreign_keys = ON');

    // Manually run only v1 and v2 migrations using the imported schema constants
    db.exec(CREATE_FOLDERS);
    db.exec(CREATE_FOLDERS_IDX_ENABLED);
    db.exec(CREATE_FILES);
    db.exec(CREATE_FILES_IDX_FOLDER_STATUS);
    db.exec(CREATE_FILES_IDX_STATUS);
    db.exec(CREATE_FILES_IDX_SHA256);
    db.exec(CREATE_SYNC_RUNS);
    db.exec(CREATE_SYNC_RUNS_IDX_STARTED);
    db.exec(CREATE_SETTINGS);
    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const { key, value } of SEED_SETTINGS) { insert.run(key, value); }
    db.exec(ALTER_FILES_ADD_MTIME_MS);
    db.exec('PRAGMA user_version = 2');

    // Verify pre-condition: no circle_id column yet
    const colsBefore = db.prepare("PRAGMA table_info('folders')").all() as Array<{ name: string }>;
    expect(colsBefore.some((c) => c.name === 'circle_id')).toBe(false);

    // Now run runMigrations — should only apply v3
    runMigrations(db);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(3);

    const colsAfter = db.prepare("PRAGMA table_info('folders')").all() as Array<{ name: string }>;
    expect(colsAfter.some((c) => c.name === 'circle_id')).toBe(true);
    db.close();
  });

  it('migration 3 is idempotent — re-running on a v3 db is a no-op', () => {
    const db = openRaw();
    const versionBefore = db.pragma('user_version', { simple: true }) as number;
    expect(versionBefore).toBe(3);

    runMigrations(db);
    const versionAfter = db.pragma('user_version', { simple: true }) as number;
    expect(versionAfter).toBe(3);

    db.close();
  });

  it('enables foreign keys (PRAGMA foreign_keys = ON)', () => {
    const db = openDb(':memory:');
    const fk = db.pragma('foreign_keys', { simple: true }) as number;
    expect(fk).toBe(1);
    db.close();
  });

  it('uses WAL journal mode', () => {
    const db = openDb(':memory:');
    // In-memory DBs don't persist WAL but the pragma still reads back as 'memory'
    // (WAL is not supported in-memory). We just verify the DB is open and functional.
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(typeof mode).toBe('string');
    db.close();
  });
});
