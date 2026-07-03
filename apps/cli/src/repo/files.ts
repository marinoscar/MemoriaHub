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
  mtime_ms: number | null;
  upload_id: string | null;
  upload_part_size: number | null;
  first_seen_at: string;
  updated_at: string;
  uploaded_at: string | null;
  skip_reason: string | null;
}

/** A completed multipart upload part as persisted in file_upload_parts. */
export interface CompletedPart {
  partNumber: number;
  eTag: string;
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
    mtime_ms: row.mtime_ms ?? null,
    upload_id: row.upload_id ?? null,
    upload_part_size: row.upload_part_size ?? null,
    first_seen_at: row.first_seen_at,
    updated_at: row.updated_at,
    uploaded_at: row.uploaded_at,
    skip_reason: (row.skip_reason as 'dedup' | 'unchanged' | null) ?? null,
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
  mtime_ms?: number | null;
  upload_id?: string | null;
  upload_part_size?: number | null;
  uploaded_at?: string | null;
  last_error?: string | null;
  attempt_count?: number;
  skip_reason?: string | null;
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
              storage_object_id, size_bytes, mime_type, mtime_ms, first_seen_at, updated_at,
              uploaded_at, last_error, attempt_count, skip_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fields.mtime_ms ?? null,
          now,
          now,
          fields.uploaded_at ?? null,
          fields.last_error ?? null,
          fields.attempt_count ?? 0,
          fields.skip_reason ?? null,
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
      apply('mtime_ms', 'mtime_ms');
      apply('upload_id', 'upload_id');
      apply('upload_part_size', 'upload_part_size');
      apply('uploaded_at', 'uploaded_at');
      apply('last_error', 'last_error');
      apply('attempt_count', 'attempt_count');
      apply('skip_reason', 'skip_reason');

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
    apply('mtime_ms', 'mtime_ms');
    apply('upload_id', 'upload_id');
    apply('upload_part_size', 'upload_part_size');
    apply('uploaded_at', 'uploaded_at');
    apply('last_error', 'last_error');
    apply('attempt_count', 'attempt_count');
    apply('skip_reason', 'skip_reason');

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
   * Aggregate size + count of successfully uploaded files across the given
   * folder IDs (all folders if empty).  `avgBytes` is the rounded mean size.
   */
  storageSummary(
    folderIds: number[] = [],
  ): { items: number; totalBytes: number; avgBytes: number } {
    let sql = `
      SELECT
        COUNT(*)                    AS items,
        COALESCE(SUM(size_bytes), 0) AS totalBytes
      FROM files
      WHERE status = 'uploaded'`;
    const params: number[] = [];

    if (folderIds.length > 0) {
      const placeholders = folderIds.map(() => '?').join(', ');
      sql += ` AND folder_id IN (${placeholders})`;
      params.push(...folderIds);
    }

    const row = this.db.prepare(sql).get(...params) as {
      items: number;
      totalBytes: number;
    };
    const items = row.items;
    const totalBytes = row.totalBytes;
    const avgBytes = items ? Math.round(totalBytes / items) : 0;
    return { items, totalBytes, avgBytes };
  }

  /**
   * List files skipped because the server already had identical content
   * (skip_reason = 'dedup'), across the given folder IDs (all folders if empty).
   */
  duplicates(folderIds: number[] = []): FileRecord[] {
    let sql = `SELECT * FROM files WHERE status = 'skipped' AND skip_reason = 'dedup'`;
    const params: number[] = [];

    if (folderIds.length > 0) {
      const placeholders = folderIds.map(() => '?').join(', ');
      sql += ` AND folder_id IN (${placeholders})`;
      params.push(...folderIds);
    }
    sql += ' ORDER BY id';

    const rows = this.db.prepare(sql).all(...params) as FileRow[];
    return rows.map(rowToFile);
  }

  /**
   * Reset any files stuck in `uploading` status back to `queued`.
   * Called on startup to recover from interrupted sync sessions.
   * Optionally scoped to specific folder IDs.
   *
   * NOTE: This intentionally does NOT clear upload_id, upload_part_size, or
   * file_upload_parts rows.  Those are preserved so the next run can resume
   * the interrupted multipart upload from where it left off.
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

  // ---------------------------------------------------------------------------
  // Multipart upload part persistence
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a single file by ID.  Returns null if not found.
   */
  getById(id: number): FileRecord | null {
    const row = this.db
      .prepare<[number], FileRow>('SELECT * FROM files WHERE id = ?')
      .get(id);
    return row ? rowToFile(row) : null;
  }

  /**
   * Persist (upsert) a completed part for a file's in-progress multipart upload.
   * Called immediately after a presigned PUT returns an ETag so that a crash
   * leaves exactly the confirmed parts in the database.
   */
  saveUploadPart(fileId: number, partNumber: number, eTag: string): void {
    this.db
      .prepare(
        `INSERT INTO file_upload_parts (file_id, part_number, etag)
         VALUES (?, ?, ?)
         ON CONFLICT(file_id, part_number) DO UPDATE SET etag = excluded.etag`,
      )
      .run(fileId, partNumber, eTag);
  }

  /**
   * Return all completed parts for a file, ordered by part number ascending.
   * Returns an empty array when no parts have been persisted yet.
   */
  getUploadParts(fileId: number): CompletedPart[] {
    const rows = this.db
      .prepare<[number], { part_number: number; etag: string }>(
        'SELECT part_number, etag FROM file_upload_parts WHERE file_id = ? ORDER BY part_number',
      )
      .all(fileId) as Array<{ part_number: number; etag: string }>;
    return rows.map((r) => ({ partNumber: r.part_number, eTag: r.etag }));
  }

  /**
   * Clear all in-progress multipart upload state for a file:
   * - Deletes all rows from file_upload_parts for this file.
   * - Sets upload_id and upload_part_size to NULL on the files row.
   *
   * Called when an upload completes successfully, or when the server signals
   * that the upload session has expired (so the next attempt starts fresh).
   */
  clearUploadState(fileId: number): void {
    this.db
      .prepare('DELETE FROM file_upload_parts WHERE file_id = ?')
      .run(fileId);
    this.db
      .prepare(
        `UPDATE files SET upload_id = NULL, upload_part_size = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), fileId);
  }
}
