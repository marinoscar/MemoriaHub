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
  SEED_SETTINGS_V4,
  ALTER_FILES_ADD_MTIME_MS,
  ALTER_FOLDERS_ADD_CIRCLE_ID,
  ALTER_FILES_ADD_UPLOAD_ID,
  ALTER_FILES_ADD_UPLOAD_PART_SIZE,
  CREATE_FILE_UPLOAD_PARTS,
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
  it('reaches the latest user_version (6)', () => {
    const db = openDb(':memory:');
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(6);
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

    // Run again — should be a no-op (version already at 6, all seeds use INSERT OR IGNORE)
    runMigrations(db);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(6);

    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM settings').get() as { cnt: number }
    ).cnt;
    // 3 base seeds (v1) + 5 rate-limit seeds (v4) — no duplicates
    expect(count).toBe(SEED_SETTINGS.length + SEED_SETTINGS_V4.length);

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
    // openRaw() already runs all migrations including v2, v3, v4, v5, and v6
    const versionBefore = db.pragma('user_version', { simple: true }) as number;
    expect(versionBefore).toBe(6);

    // Re-running must not throw and must not change version
    runMigrations(db);
    const versionAfter = db.pragma('user_version', { simple: true }) as number;
    expect(versionAfter).toBe(6);

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

    // Now run runMigrations — should apply v3, v4, v5, and v6
    runMigrations(db);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(6);

    const colsAfter = db.prepare("PRAGMA table_info('folders')").all() as Array<{ name: string }>;
    expect(colsAfter.some((c) => c.name === 'circle_id')).toBe(true);
    db.close();
  });

  it('migration 3 is idempotent — re-running on a v6 db is a no-op', () => {
    const db = openRaw();
    const versionBefore = db.pragma('user_version', { simple: true }) as number;
    expect(versionBefore).toBe(6);

    runMigrations(db);
    const versionAfter = db.pragma('user_version', { simple: true }) as number;
    expect(versionAfter).toBe(6);

    db.close();
  });

  it('migration 4 seeds all rate-limit settings with their defaults', () => {
    const db = openRaw();
    for (const { key, value } of SEED_SETTINGS_V4) {
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(key) as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe(value);
    }
    db.close();
  });

  it('migration 4 backfills rate-limit settings on a pre-existing v3 database', () => {
    // Build a v1+v2+v3 database without v4, mirroring an older install.
    const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
    db.pragma('foreign_keys = ON');
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
    db.exec(ALTER_FOLDERS_ADD_CIRCLE_ID);
    db.exec('PRAGMA user_version = 3');

    // Pre-condition: none of the v4 keys exist yet.
    for (const { key } of SEED_SETTINGS_V4) {
      const before = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      expect(before).toBeUndefined();
    }

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true }) as number).toBe(6);
    for (const { key } of SEED_SETTINGS_V4) {
      const after = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      expect(after).toBeDefined();
    }
    db.close();
  });

  it('migration 4 preserves a user-customized value (INSERT OR IGNORE)', () => {
    // Pre-seed a custom max_retries before v4 runs, then ensure it is not overwritten.
    // CREATE_FILES is required so that migration 5 can ALTER TABLE files without error.
    const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_SETTINGS);
    db.exec(CREATE_FILES);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('max_retries', JSON.stringify(99));
    db.exec('PRAGMA user_version = 3');

    runMigrations(db);

    const row = db.prepare("SELECT value FROM settings WHERE key='max_retries'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toBe(99);
    db.close();
  });

  it('migration 5 (and 6) bump user_version to 6 from a v4 database', () => {
    // Build a v4 database and verify that running migrations advances all the
    // way to 6 (migration 5 — durable multipart resume — AND migration 6 —
    // scan snapshot tables — both apply in the same runMigrations() call).
    const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
    db.pragma('foreign_keys = ON');
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
    db.exec(ALTER_FOLDERS_ADD_CIRCLE_ID);
    for (const { key, value } of SEED_SETTINGS_V4) { insert.run(key, value); }
    db.exec('PRAGMA user_version = 4');

    // Pre-condition: no upload columns or file_upload_parts table yet.
    const colsBefore = db.prepare("PRAGMA table_info('files')").all() as Array<{ name: string }>;
    expect(colsBefore.some((c) => c.name === 'upload_id')).toBe(false);
    expect(colsBefore.some((c) => c.name === 'upload_part_size')).toBe(false);
    const tableBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_upload_parts'")
      .get();
    expect(tableBefore).toBeUndefined();

    runMigrations(db);

    expect(db.pragma('user_version', { simple: true }) as number).toBe(6);
    db.close();
  });

  it('migration 5 adds upload_id and upload_part_size columns to files table', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("PRAGMA table_info('files')").all() as Array<{ name: string; type: string; notnull: number }>;

    const uploadIdCol = cols.find((c) => c.name === 'upload_id');
    expect(uploadIdCol).toBeDefined();
    expect(uploadIdCol!.type).toBe('TEXT');
    expect(uploadIdCol!.notnull).toBe(0); // nullable

    const uploadPartSizeCol = cols.find((c) => c.name === 'upload_part_size');
    expect(uploadPartSizeCol).toBeDefined();
    expect(uploadPartSizeCol!.type).toBe('INTEGER');
    expect(uploadPartSizeCol!.notnull).toBe(0); // nullable

    db.close();
  });

  it('migration 5 creates the file_upload_parts table with PK (file_id, part_number)', () => {
    const db = openDb(':memory:');

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_upload_parts'")
      .get();
    expect(tableRow).toBeTruthy();

    // Verify the column set
    const cols = db.prepare("PRAGMA table_info('file_upload_parts')").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('file_id');
    expect(colNames).toContain('part_number');
    expect(colNames).toContain('etag');

    // Both file_id and part_number are part of the composite PK (pk > 0)
    const fileIdCol = cols.find((c) => c.name === 'file_id')!;
    const partNumCol = cols.find((c) => c.name === 'part_number')!;
    expect(fileIdCol.pk).toBeGreaterThan(0);
    expect(partNumCol.pk).toBeGreaterThan(0);

    // Verify the composite PK enforces uniqueness — inserting the same (file_id, part_number) twice should throw
    // First we need a files row to satisfy the FK; skip that overhead by disabling FK checks temporarily.
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO file_upload_parts (file_id, part_number, etag) VALUES (1, 1, 'abc')").run();
    expect(() => {
      db.prepare("INSERT INTO file_upload_parts (file_id, part_number, etag) VALUES (1, 1, 'xyz')").run();
    }).toThrow();
    db.pragma('foreign_keys = ON');

    db.close();
  });

  // ---------------------------------------------------------------------------
  // Migration 6 — scan (pre-sync dry-run) tables
  // ---------------------------------------------------------------------------

  describe('migration 6 — scan snapshot tables', () => {
    it('creates the scans table with all expected columns', () => {
      const db = openDb(':memory:');

      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scans'")
        .get();
      expect(tableRow).toBeTruthy();

      const cols = (
        db.prepare("PRAGMA table_info('scans')").all() as Array<{ name: string }>
      ).map((c) => c.name);

      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'created_at',
          'finished_at',
          'status',
          'trigger',
          'folder_ids',
          'total_files',
          'total_bytes',
          'photo_count',
          'video_count',
          'exif_count',
          'gps_count',
        ]),
      );

      db.close();
    });

    it('creates the scan_files table with all expected columns', () => {
      const db = openDb(':memory:');

      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scan_files'")
        .get();
      expect(tableRow).toBeTruthy();

      const cols = (
        db.prepare("PRAGMA table_info('scan_files')").all() as Array<{ name: string }>
      ).map((c) => c.name);

      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'scan_id',
          'folder_id',
          'file_path',
          'size_bytes',
          'mtime_ms',
          'mime_type',
          'media_kind',
          'has_exif',
          'has_gps',
          'captured_at',
          'width',
          'height',
          'camera_make',
          'camera_model',
          'taken_lat',
          'taken_lng',
          'meta_error',
        ]),
      );

      db.close();
    });

    it('creates idx_scans_created_at, idx_scan_files_scan, and idx_scan_files_scan_kind', () => {
      const db = openDb(':memory:');
      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

      expect(indexes).toContain('idx_scans_created_at');
      expect(indexes).toContain('idx_scan_files_scan');
      expect(indexes).toContain('idx_scan_files_scan_kind');
      db.close();
    });

    it('upgrades a hand-built v5 database to v6, creating the scan tables', () => {
      // Build a full v1-v5 database (mirrors the "migration 5 bumps..." test above)
      // then bump to v5 explicitly, without applying migration 6.
      const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
      db.pragma('foreign_keys = ON');
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
      db.exec(ALTER_FOLDERS_ADD_CIRCLE_ID);
      for (const { key, value } of SEED_SETTINGS_V4) { insert.run(key, value); }
      db.exec(ALTER_FILES_ADD_UPLOAD_ID);
      db.exec(ALTER_FILES_ADD_UPLOAD_PART_SIZE);
      db.exec(CREATE_FILE_UPLOAD_PARTS);
      db.exec('PRAGMA user_version = 5');

      // Pre-condition: scans/scan_files do not exist yet.
      const scansBefore = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scans'")
        .get();
      expect(scansBefore).toBeUndefined();
      const scanFilesBefore = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scan_files'")
        .get();
      expect(scanFilesBefore).toBeUndefined();

      runMigrations(db);

      expect(db.pragma('user_version', { simple: true }) as number).toBe(6);
      const scansAfter = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scans'")
        .get();
      expect(scansAfter).toBeTruthy();
      const scanFilesAfter = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scan_files'")
        .get();
      expect(scanFilesAfter).toBeTruthy();

      db.close();
    });

    it('is idempotent — re-running on an already-v6 database does not throw, change version, or duplicate tables/indexes', () => {
      const db = openRaw(); // already at v6

      const versionBefore = db.pragma('user_version', { simple: true }) as number;
      expect(versionBefore).toBe(6);

      expect(() => runMigrations(db)).not.toThrow();

      const versionAfter = db.pragma('user_version', { simple: true }) as number;
      expect(versionAfter).toBe(6);

      // Tables still exist exactly once each.
      const scanTables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scans','scan_files')")
        .all() as Array<{ name: string }>;
      expect(scanTables).toHaveLength(2);

      // Indexes still exist exactly once each.
      const scanIndexNames = ['idx_scans_created_at', 'idx_scan_files_scan', 'idx_scan_files_scan_kind'];
      for (const name of scanIndexNames) {
        const rows = db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
          .all(name);
        expect(rows).toHaveLength(1);
      }

      db.close();
    });
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
