/**
 * test/db/migration-v6.spec.ts
 *
 * Focused coverage for migration 6: the `skip_reason` column added to
 * `files` so the CLI can record *why* a file was skipped ('dedup' vs
 * 'unchanged'). See test/db/migrations.spec.ts for the full migration-chain
 * history suite; this file only asserts the v6-specific contract.
 */

import { openDb } from '../../src/db/database.js';
import type BetterSqlite3 from 'better-sqlite3';

describe('migration 6 — skip_reason column', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('reaches the latest user_version on a fresh database (skip_reason added at v6)', () => {
    // A fresh DB runs the full migration chain; the latest version is 7 (the v7
    // scan snapshot tables land after this v6 skip_reason migration).
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(7);
  });

  it('adds a nullable skip_reason column to the files table', () => {
    const cols = db
      .prepare("PRAGMA table_info('files')")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const col = cols.find((c) => c.name === 'skip_reason');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
    expect(col!.notnull).toBe(0);
  });

  it('defaults skip_reason to NULL for existing rows', () => {
    db.prepare(
      `INSERT INTO folders (path, path_hash, recursive, enabled, added_at)
       VALUES ('/tmp/v6-test', 'hash', 0, 1, '2024-01-01T00:00:00.000Z')`,
    ).run();
    const folderId = (
      db.prepare("SELECT id FROM folders WHERE path = '/tmp/v6-test'").get() as { id: number }
    ).id;

    db.prepare(
      `INSERT INTO files (folder_id, file_path, status, first_seen_at, updated_at)
       VALUES (?, '/tmp/v6-test/a.jpg', 'queued', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    ).run(folderId);

    const row = db
      .prepare("SELECT skip_reason FROM files WHERE file_path = '/tmp/v6-test/a.jpg'")
      .get() as { skip_reason: string | null };
    expect(row.skip_reason).toBeNull();
  });

  it('persists a skip_reason value once set', () => {
    db.prepare(
      `INSERT INTO folders (path, path_hash, recursive, enabled, added_at)
       VALUES ('/tmp/v6-test-2', 'hash2', 0, 1, '2024-01-01T00:00:00.000Z')`,
    ).run();
    const folderId = (
      db.prepare("SELECT id FROM folders WHERE path = '/tmp/v6-test-2'").get() as { id: number }
    ).id;

    db.prepare(
      `INSERT INTO files (folder_id, file_path, status, skip_reason, first_seen_at, updated_at)
       VALUES (?, '/tmp/v6-test-2/a.jpg', 'skipped', 'dedup', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    ).run(folderId);

    const row = db
      .prepare("SELECT skip_reason FROM files WHERE file_path = '/tmp/v6-test-2/a.jpg'")
      .get() as { skip_reason: string | null };
    expect(row.skip_reason).toBe('dedup');
  });
});
