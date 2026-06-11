/**
 * test/repo/runs.spec.ts
 *
 * Unit tests for RunRepo using an in-memory SQLite database.
 */

import { openDb } from '../../src/db/database.js';
import { RunRepo } from '../../src/repo/runs.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

describe('RunRepo', () => {
  let db: BetterSqlite3.Database;
  let repo: RunRepo;

  beforeEach(() => {
    db = makeDb();
    repo = new RunRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // startRun
  // ---------------------------------------------------------------------------

  describe('startRun', () => {
    it('inserts a new run and returns its numeric id', () => {
      const id = repo.startRun({ trigger: 'cli', folderIds: [1, 2], total: 10 });
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('records trigger, folder_ids JSON, total, and dry_run=false by default', () => {
      const id = repo.startRun({ trigger: 'menu', folderIds: [3], total: 5 });
      const runs = repo.listRuns();
      const run = runs.find((r) => r.id === id);
      expect(run).toBeDefined();
      expect(run!.trigger).toBe('menu');
      expect(run!.folder_ids).toBe(JSON.stringify([3]));
      expect(run!.total).toBe(5);
      expect(run!.dry_run).toBe(false);
    });

    it('records dry_run=true when dryRun option is set', () => {
      const id = repo.startRun({ trigger: 'cli', folderIds: [], total: 0, dryRun: true });
      const runs = repo.listRuns();
      const run = runs.find((r) => r.id === id);
      expect(run!.dry_run).toBe(true);
    });

    it('has null finished_at after start', () => {
      const id = repo.startRun({ trigger: 'cli', folderIds: [], total: 0 });
      const runs = repo.listRuns();
      const run = runs.find((r) => r.id === id);
      expect(run!.finished_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // finishRun
  // ---------------------------------------------------------------------------

  describe('finishRun', () => {
    it('sets finished_at and counts', () => {
      const id = repo.startRun({ trigger: 'cli', folderIds: [], total: 3 });
      repo.finishRun(id, { uploaded: 2, skipped: 1, failed: 0 });

      const runs = repo.listRuns();
      const run = runs.find((r) => r.id === id);
      expect(run!.finished_at).not.toBeNull();
      expect(run!.uploaded).toBe(2);
      expect(run!.skipped).toBe(1);
      expect(run!.failed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listRuns
  // ---------------------------------------------------------------------------

  describe('listRuns', () => {
    it('returns empty array when no runs exist', () => {
      expect(repo.listRuns()).toEqual([]);
    });

    it('returns runs ordered by started_at DESC (newest first)', async () => {
      const id1 = repo.startRun({ trigger: 'cli', folderIds: [], total: 0 });
      // Small delay to ensure different started_at timestamps
      await new Promise((r) => setTimeout(r, 5));
      const id2 = repo.startRun({ trigger: 'menu', folderIds: [], total: 0 });

      const runs = repo.listRuns();
      expect(runs[0].id).toBe(id2); // newest first
      expect(runs[1].id).toBe(id1);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.startRun({ trigger: 'cli', folderIds: [], total: i });
      }
      const limited = repo.listRuns(3);
      expect(limited).toHaveLength(3);
    });

    it('defaults to limit 20', () => {
      for (let i = 0; i < 25; i++) {
        repo.startRun({ trigger: 'cli', folderIds: [], total: i });
      }
      const runs = repo.listRuns();
      expect(runs).toHaveLength(20);
    });
  });

  // ---------------------------------------------------------------------------
  // latestCompleted
  // ---------------------------------------------------------------------------

  describe('latestCompleted', () => {
    it('returns null when no completed runs exist', () => {
      repo.startRun({ trigger: 'cli', folderIds: [], total: 0 });
      expect(repo.latestCompleted()).toBeNull();
    });

    it('returns the most recently completed run', () => {
      const id1 = repo.startRun({ trigger: 'cli', folderIds: [], total: 3 });
      repo.finishRun(id1, { uploaded: 3, skipped: 0, failed: 0 });

      const id2 = repo.startRun({ trigger: 'cli', folderIds: [], total: 5 });
      repo.finishRun(id2, { uploaded: 5, skipped: 0, failed: 0 });

      const latest = repo.latestCompleted();
      expect(latest).not.toBeNull();
      // Both are completed; the latest by started_at should be id2
      expect([id1, id2]).toContain(latest!.id);
      // The one with total=5 (id2) should be latest
      expect(latest!.total).toBe(5);
    });

    it('ignores in-progress runs (no finished_at)', () => {
      const id1 = repo.startRun({ trigger: 'cli', folderIds: [], total: 3 });
      repo.finishRun(id1, { uploaded: 3, skipped: 0, failed: 0 });
      repo.startRun({ trigger: 'cli', folderIds: [], total: 10 }); // not finished

      const latest = repo.latestCompleted();
      expect(latest!.id).toBe(id1);
    });
  });

  // ---------------------------------------------------------------------------
  // totals
  // ---------------------------------------------------------------------------

  describe('totals', () => {
    it('returns zeroes when no completed runs exist', () => {
      const t = repo.totals();
      expect(t).toEqual({ uploaded: 0, skipped: 0, failed: 0, runs: 0 });
    });

    it('sums across completed runs only', () => {
      const id1 = repo.startRun({ trigger: 'cli', folderIds: [], total: 5 });
      repo.finishRun(id1, { uploaded: 3, skipped: 1, failed: 1 });

      const id2 = repo.startRun({ trigger: 'cli', folderIds: [], total: 10 });
      repo.finishRun(id2, { uploaded: 7, skipped: 2, failed: 1 });

      // id3 not finished — should be excluded
      repo.startRun({ trigger: 'cli', folderIds: [], total: 100 });

      const t = repo.totals();
      expect(t.uploaded).toBe(10);
      expect(t.skipped).toBe(3);
      expect(t.failed).toBe(2);
      expect(t.runs).toBe(2);
    });
  });
});
