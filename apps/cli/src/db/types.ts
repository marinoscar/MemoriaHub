/**
 * db/types.ts — Shared TypeScript types for the SQLite persistence layer.
 *
 * These types mirror the database schema exactly.  All repo modules return
 * and accept these types so callers never interact with raw row objects.
 */

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface Folder {
  id: number;
  path: string;
  path_hash: string;
  recursive: boolean;
  enabled: boolean;
  added_at: string;       // ISO 8601
  last_sync_at: string | null;
  circle_id: string | null;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type FileStatus = 'queued' | 'uploading' | 'uploaded' | 'skipped' | 'failed';

export interface FileRecord {
  id: number;
  folder_id: number;
  file_path: string;
  sha256: string | null;
  status: FileStatus;
  attempt_count: number;
  last_error: string | null;
  /** Why the file was skipped: 'dedup' (server already had the content) or 'unchanged' (matched a prior successful upload). Null when not skipped or not recorded. */
  skip_reason: 'dedup' | 'unchanged' | null;
  media_item_id: string | null;
  storage_object_id: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  /** Modification time in milliseconds (Math.round of fs.stat.mtimeMs), or null if not yet recorded. */
  mtime_ms: number | null;
  /**
   * Active multipart upload-session ID from the server's /upload/init response.
   * Null when no upload is in progress.  Combined with storage_object_id and
   * upload_part_size, this is enough to resume an interrupted upload.
   */
  upload_id: string | null;
  /**
   * Byte length of each part for the current multipart upload.
   * Null when no upload is in progress.
   */
  upload_part_size: number | null;
  first_seen_at: string;  // ISO 8601
  updated_at: string;     // ISO 8601
  uploaded_at: string | null;
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

export interface SyncRun {
  id: number;
  started_at: string;     // ISO 8601
  finished_at: string | null;
  trigger: string;
  folder_ids: string;     // JSON-encoded number[]
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// File counts aggregate
// ---------------------------------------------------------------------------

export interface FileCounts {
  queued: number;
  uploading: number;
  uploaded: number;
  skipped: number;
  failed: number;
  total: number;
}
