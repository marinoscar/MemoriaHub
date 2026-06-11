/**
 * repo/files.ts — Data-access repository for the `files` table.
 *
 * All methods are synchronous (better-sqlite3 API).
 * No I/O or console output here — only database operations and data mapping.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { FileRecord, FileStatus, FileCounts } from '../db/types.js';

// ---------------------------------------------------------------------------
// Raw row type from SQLite (booleans stored as 0/1)
// ---------------------------------------------------------------------------

interface FileRow {
  id: number;
  folder_id: number;
  file_path: string;
  sha256: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  media_item_id: string | null;
  storage_object_id: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  first_seen_at: string;
  updated_at: string;
  uploaded_at: string | null;
}

function rowToFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    folder_id: row.folder_id,
    file_path: row.file_path,
    sha256: row.sha256,
    status: row.status as FileStatus,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    media_item_id: row.media_item_id,
    storage_object_id: row.storage_object_id,
    size_bytes: row.size_bytes,
    mime_type: row.mime_type,
    first_seen_at: row.first_seen_at,
    updated_at: row.updated_at,
    uploaded_at: row.uploaded_at,
  };
}

// ---------------------------------------------------------------------------
// Patch type for upsert / setStatus
// ---------------------------------------------------------------------------

export interface FilePatch {
  sha256?: string | null;
  status?: FileStatus;
  media_item_id?: string | null;
  storage_object_id?: string | null;
  size_bytes?: number | null;
  mime_type?: string | null;
  uploaded_at?: string | null;
  last_error?: string | null;
  attempt_count?: number;
}

// ---------------------------------------------------------------------------
// FileRepo
// ---------------------------------------------------------------------------

export class FileRepo {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Upsert a file record.  Creates the row if UNIQUE(folder_id, file_path) is
   * new; otherwise updates only the supplied patch fields plus updated_at.
   */
  upsert(
    folderId: number,
    filePath: string,
    fields: FilePatch = {},
  ): FileRecord {
    const now = new Date().toISOString();

    // Try INSERT first (new file).
    try {
      this.db
        .prepare(
          `INSERT INTO files
             (folder_id, file_path, sha256, status, media_item_id,
              storage_object_id, size_bytes, mime_type, first_seen_at, updated_at,
              uploaded_at, last_error, attempt_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          folderId,
          filePath,
          fields.sha256 ?? null,
          fields.status ?? 'queued',
          fields.media_item_id ?? null,
          fields.storage_object_id ?? null,
          fields.size_bytes ?? null,
          fields.mime_type ?? null,
          now,
          now,
          fields.uploaded_at ?? null,
          fields.last_error ?? null,
          fields.attempt_count ?? 0,
        );
    } catch {
      // UNIQUE constraint violation — update existing row with supplied fields.
      const sets: string[] = ['updated_at = ?'];
      const params: (string | number | null)[] = [now];

      const apply = (key: keyof FilePatch, col: string): void => {
        if (key in fields) {
          sets.push(`${col} = ?`);
          params.push((fields[key] as string | number | null | undefined) ?? null);
        }
      };
      apply('sha256', 'sha256');
      apply('status', 'status');
      apply('media_item_id', 'media_item_id');
      apply('storage_object_id', 'storage_object_id');
      apply('size_bytes', 'size_bytes');
      apply('mime_type', 'mime_type');
      apply('uploaded_at', 'uploaded_at');
      apply('last_error', 'last_error');
      apply('attempt_count', 'attempt_count');

      params.push(folderId, filePath);
      this.db
        .prepare(
          `UPDATE files SET ${sets.join(', ')} WHERE folder_id = ? AND file_path = ?`,
        )
        .run(...params);
    }

    const row = this.db
      .prepare<[number, string], FileRow>(
        'SELECT * FROM files WHERE folder_id = ? AND file_path = ?',
      )
      .get(folderId, filePath);
    if (!row) throw new Error('Failed to retrieve upserted file row');
    return rowToFile(row);
  }

  /**
   * Set the status of a file (by ID), with an optional partial patch of other fields.
   */
  setStatus(
    id: number,
    status: FileStatus,
    patch: Omit<FilePatch, 'status'> = {},
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = [status, now];

    type PatchKey = keyof Omit<FilePatch, 'status'>;
    const apply = (key: PatchKey, col: string): void => {
      if (key in patch) {
        sets.push(`${col} = ?`);
        params.push((patch[key] as string | number | null | undefined) ?? null);
      }
    };
    apply('sha256', 'sha256');
    apply('media_item_id', 'media_item_id');
    apply('storage_object_id', 'storage_object_id');
    apply('size_bytes', 'size_bytes');
    apply('mime_type', 'mime_type');
    apply('uploaded_at', 'uploaded_at');
    apply('last_error', 'last_error');
    apply('attempt_count', 'attempt_count');

    params.push(id);
    this.db
      .prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
  }

  /**
   * Increment the attempt_count for a file (by ID).
   */
  incrementAttempt(id: number): void {
    this.db
      .prepare('UPDATE files SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /**
   * Record a last_error message for a file (by ID).
   */
  setError(id: number, msg: string): void {
    this.db
      .prepare('UPDATE files SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(msg, new Date().toISOString(), id);
  }

  /**
   * Retrieve a single file by folder ID + path.  Returns null if not found.
   */
  getByFolderAndPath(folderId: number, filePath: string): FileRecord | null {
    const row = this.db
      .prepare<[number, string], FileRow>(
        'SELECT * FROM files WHERE folder_id = ? AND file_path = ?',
      )
      .get(folderId, filePath);
    return row ? rowToFile(row) : null;
  }

  /**
   * List all files for a folder, optionally filtered by status.
   */
  listByFolder(
    folderId: number,
    opts: { status?: FileStatus } = {},
  ): FileRecord[] {
    const rows = opts.status
      ? (this.db
          .prepare<[number, string], FileRow>(
            'SELECT * FROM files WHERE folder_id = ? AND status = ? ORDER BY id',
          )
          .all(folderId, opts.status) as FileRow[])
      : (this.db
          .prepare<[number], FileRow>(
            'SELECT * FROM files WHERE folder_id = ? ORDER BY id',
          )
          .all(folderId) as FileRow[]);
    return rows.map(rowToFile);
  }

  /**
   * List failed files that still have retries left (attempt_count < cap).
   * Optionally scoped to specific folder IDs.
   */
  listFailed(opts: { folderIds?: number[]; cap?: number } = {}): FileRecord[] {
    const cap = opts.cap ?? 5;
    let sql = `SELECT * FROM files WHERE status = 'failed' AND attempt_count < ?`;
    const params: (number | string)[] = [cap];

    if (opts.folderIds && opts.folderIds.length > 0) {
      const placeholders = opts.folderIds.map(() => '?').join(', ');
      sql += ` AND folder_id IN (${placeholders})`;
      params.push(...opts.folderIds);
    }
    sql += ' ORDER BY id';

    const rows = this.db.prepare(sql).all(...params) as FileRow[];
    return rows.map(rowToFile);
  }

  /**
   * List failed files that are blocked (attempt_count >= cap).
   * Optionally scoped to specific folder IDs.
   */
  listBlocked(opts: { folderIds?: number[]; cap?: number } = {}): FileRecord[] {
    const cap = opts.cap ?? 5;
    let sql = `SELECT * FROM files WHERE status = 'failed' AND attempt_count >= ?`;
    const params: (number | string)[] = [cap];

    if (opts.folderIds && opts.folderIds.length > 0) {
      const placeholders = opts.folderIds.map(() => '?').join(', ');
      sql += ` AND folder_id IN (${placeholders})`;
      params.push(...opts.folderIds);
    }
    sql += ' ORDER BY id';

    const rows = this.db.prepare(sql).all(...params) as FileRow[];
    return rows.map(rowToFile);
  }

  /**
   * Count files by status across the given folder IDs (all folders if empty).
   */
  counts(folderIds: number[] = []): FileCounts {
    let sql = `
      SELECT
        status,
        COUNT(*) as cnt
      FROM files`;
    const params: number[] = [];

    if (folderIds.length > 0) {
      const placeholders = folderIds.map(() => '?').join(', ');
      sql += ` WHERE folder_id IN (${placeholders})`;
      params.push(...folderIds);
    }
    sql += ' GROUP BY status';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      status: string;
      cnt: number;
    }>;

    const result: FileCounts = {
      queued: 0,
      uploading: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      total: 0,
    };

    for (const row of rows) {
      const s = row.status as FileStatus;
      if (s in result) {
        (result as unknown as Record<string, number>)[s] = row.cnt;
      }
      result.total += row.cnt;
    }

    return result;
  }

  /**
   * Reset any files stuck in `uploading` status back to `queued`.
   * Called on startup to recover from interrupted sync sessions.
   * Optionally scoped to specific folder IDs.
   */
  resetStaleUploading(folderIds: number[] = []): number {
    const now = new Date().toISOString();
    let sql = `UPDATE files SET status = 'queued', updated_at = ? WHERE status = 'uploading'`;
    const params: (string | number)[] = [now];

    if (folderIds.length > 0) {
      const placeholders = folderIds.map(() => '?').join(', ');
      sql += ` AND folder_id IN (${placeholders})`;
      params.push(...folderIds);
    }

    const info = this.db.prepare(sql).run(...params);
    return info.changes;
  }
}
