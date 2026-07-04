/**
 * repo/runs.ts — Data-access repository for the `sync_runs` table.
 *
 * All methods are synchronous (better-sqlite3 API).
 * No I/O or console output here — only database operations and data mapping.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { SyncRun } from '../db/types.js';

// ---------------------------------------------------------------------------
// Raw row type from SQLite
// ---------------------------------------------------------------------------

interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  folder_ids: string;
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  dry_run: number;
}

function rowToRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    trigger: row.trigger,
    folder_ids: row.folder_ids,
    total: row.total,
    uploaded: row.uploaded,
    skipped: row.skipped,
    failed: row.failed,
    dry_run: row.dry_run !== 0,
  };
}

// ---------------------------------------------------------------------------
// RunRepo
// ---------------------------------------------------------------------------

export class RunRepo {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Record the start of a sync run.
   * @returns The numeric ID of the newly created run.
   */
  startRun(opts: {
    trigger: string;
    folderIds: number[];
    total: number;
    dryRun?: boolean;
  }): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO sync_runs (started_at, trigger, folder_ids, total, dry_run)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        opts.trigger,
        JSON.stringify(opts.folderIds),
        opts.total,
        opts.dryRun ? 1 : 0,
      );
    return info.lastInsertRowid as number;
  }

  /**
   * Record the completion of a sync run.
   */
  finishRun(
    id: number,
    counts: { uploaded: number; skipped: number; failed: number },
  ): void {
    this.db
      .prepare(
        `UPDATE sync_runs
         SET finished_at = ?, uploaded = ?, skipped = ?, failed = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        counts.uploaded,
        counts.skipped,
        counts.failed,
        id,
      );
  }

  /**
   * Get a single sync run by ID.  Returns null if not found.
   */
  getById(id: number): SyncRun | null {
    const row = this.db
      .prepare<[number], SyncRunRow>('SELECT * FROM sync_runs WHERE id = ?')
      .get(id);
    return row ? rowToRun(row) : null;
  }

  /**
   * List recent sync runs, newest first.
   * @param limit  Maximum number of rows to return (default 20).
   */
  listRuns(limit = 20): SyncRun[] {
    const rows = this.db
      .prepare<[number], SyncRunRow>(
        'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?',
      )
      .all(limit) as SyncRunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Get the most recent completed sync run, or null if none exist.
   */
  latestCompleted(): SyncRun | null {
    const row = this.db
      .prepare<[], SyncRunRow>(
        `SELECT * FROM sync_runs
         WHERE finished_at IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get();
    return row ? rowToRun(row) : null;
  }

  /**
   * Sum uploaded/skipped/failed across all completed runs.
   */
  totals(): { uploaded: number; skipped: number; failed: number; runs: number } {
    const row = this.db
      .prepare<
        [],
        { uploaded: number; skipped: number; failed: number; runs: number }
      >(
        `SELECT
           COALESCE(SUM(uploaded), 0) AS uploaded,
           COALESCE(SUM(skipped),  0) AS skipped,
           COALESCE(SUM(failed),   0) AS failed,
           COUNT(*)                   AS runs
         FROM sync_runs
         WHERE finished_at IS NOT NULL`,
      )
      .get();
    return row ?? { uploaded: 0, skipped: 0, failed: 0, runs: 0 };
  }
}
