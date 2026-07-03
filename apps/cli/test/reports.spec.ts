/**
 * test/reports.spec.ts
 *
 * Pure unit tests for the reports registry and the underlying FileRepo
 * aggregation methods (`storageSummary`, `duplicates`) that back the
 * "Storage synced" and "Duplicates" reports. Uses an in-memory SQLite DB —
 * no Ink/React involved.
 */

import { openDb } from '../src/db/database.js';
import { FolderRepo } from '../src/repo/folders.js';
import { FileRepo } from '../src/repo/files.js';
import { REPORTS } from '../src/reports/registry.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

describe('FileRepo.storageSummary', () => {
  let db: BetterSqlite3.Database;
  let folderRepo: FolderRepo;
  let fileRepo: FileRepo;

  beforeEach(() => {
    db = makeDb();
    folderRepo = new FolderRepo(db);
    fileRepo = new FileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns items:0, totalBytes:0, avgBytes:0 for an empty database', () => {
    expect(fileRepo.storageSummary()).toEqual({ items: 0, totalBytes: 0, avgBytes: 0 });
  });

  it('aggregates only uploaded files, excluding a non-uploaded file', () => {
    const folder = folderRepo.add({ path: '/tmp/storage-summary', recursive: false });

    fileRepo.upsert(folder.id, '/tmp/storage-summary/a.jpg', {
      status: 'uploaded',
      size_bytes: 100,
    });
    fileRepo.upsert(folder.id, '/tmp/storage-summary/b.jpg', {
      status: 'uploaded',
      size_bytes: 200,
    });
    fileRepo.upsert(folder.id, '/tmp/storage-summary/c.jpg', {
      status: 'uploaded',
      size_bytes: 300,
    });
    // Excluded: still queued, must not count toward the summary.
    fileRepo.upsert(folder.id, '/tmp/storage-summary/d.jpg', {
      status: 'queued',
      size_bytes: 9999,
    });

    expect(fileRepo.storageSummary()).toEqual({
      items: 3,
      totalBytes: 600,
      avgBytes: 200,
    });
  });

  it('scopes the aggregate to the given folder IDs', () => {
    const folderA = folderRepo.add({ path: '/tmp/storage-a', recursive: false });
    const folderB = folderRepo.add({ path: '/tmp/storage-b', recursive: false });

    fileRepo.upsert(folderA.id, '/tmp/storage-a/a.jpg', { status: 'uploaded', size_bytes: 100 });
    fileRepo.upsert(folderB.id, '/tmp/storage-b/b.jpg', { status: 'uploaded', size_bytes: 500 });

    expect(fileRepo.storageSummary([folderA.id])).toEqual({
      items: 1,
      totalBytes: 100,
      avgBytes: 100,
    });
  });
});

describe('FileRepo.duplicates', () => {
  let db: BetterSqlite3.Database;
  let folderRepo: FolderRepo;
  let fileRepo: FileRepo;

  beforeEach(() => {
    db = makeDb();
    folderRepo = new FolderRepo(db);
    fileRepo = new FileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns an empty array when there are no skipped files', () => {
    expect(fileRepo.duplicates()).toEqual([]);
  });

  it('returns only rows with status=skipped AND skip_reason=dedup', () => {
    const folder = folderRepo.add({ path: '/tmp/dupes', recursive: false });

    fileRepo.upsert(folder.id, '/tmp/dupes/dedup.jpg', {
      status: 'skipped',
      skip_reason: 'dedup',
    });
    fileRepo.upsert(folder.id, '/tmp/dupes/unchanged.jpg', {
      status: 'skipped',
      skip_reason: 'unchanged',
    });
    fileRepo.upsert(folder.id, '/tmp/dupes/uploaded.jpg', {
      status: 'uploaded',
    });
    fileRepo.upsert(folder.id, '/tmp/dupes/no-reason.jpg', {
      status: 'skipped',
    });

    const dupes = fileRepo.duplicates();
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.file_path).toBe('/tmp/dupes/dedup.jpg');
    expect(dupes[0]!.skip_reason).toBe('dedup');
  });

  it('scopes duplicates to the given folder IDs', () => {
    const folderA = folderRepo.add({ path: '/tmp/dupes-a', recursive: false });
    const folderB = folderRepo.add({ path: '/tmp/dupes-b', recursive: false });

    fileRepo.upsert(folderA.id, '/tmp/dupes-a/a.jpg', { status: 'skipped', skip_reason: 'dedup' });
    fileRepo.upsert(folderB.id, '/tmp/dupes-b/b.jpg', { status: 'skipped', skip_reason: 'dedup' });

    const dupes = fileRepo.duplicates([folderA.id]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.file_path).toBe('/tmp/dupes-a/a.jpg');
  });
});

describe('REPORTS registry — compute() shape', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('every registered report computes a {columns, rows} table without throwing', () => {
    for (const report of REPORTS) {
      expect(() => {
        const table = report.compute({ db });
        expect(Array.isArray(table.columns)).toBe(true);
        expect(Array.isArray(table.rows)).toBe(true);
      }).not.toThrow();
    }
  });

  it('exposes overview, runs, storage, and duplicates report ids', () => {
    const ids = REPORTS.map((r) => r.id);
    expect(ids).toEqual(['overview', 'runs', 'storage', 'duplicates']);
  });
});
