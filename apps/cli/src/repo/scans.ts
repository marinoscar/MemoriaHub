/**
 * repo/scans.ts — Data-access repository for the `scans` and `scan_files` tables.
 *
 * All methods are synchronous (better-sqlite3 API).
 * No I/O or console output here — only database operations and data mapping.
 *
 * A scan is an immutable, point-in-time snapshot of the file set a sync WOULD
 * process.  `ScanRepo` owns both the parent `scans` rollup row and the per-file
 * `scan_files` snapshot rows, plus the GROUP BY aggregate queries the report
 * layer composes.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { Scan, ScanFile, ScanStatus, MediaKind, CaptureDateSource } from '../db/types.js';

// ---------------------------------------------------------------------------
// Raw row types from SQLite (booleans stored as 0/1)
// ---------------------------------------------------------------------------

interface ScanRow {
  id: number;
  created_at: string;
  finished_at: string | null;
  status: string;
  trigger: string;
  folder_ids: string;
  total_files: number;
  total_bytes: number;
  photo_count: number;
  video_count: number;
  exif_count: number;
  gps_count: number;
}

interface ScanFileRow {
  id: number;
  scan_id: number;
  folder_id: number;
  file_path: string;
  size_bytes: number | null;
  mtime_ms: number | null;
  mime_type: string | null;
  media_kind: string | null;
  has_exif: number;
  has_gps: number;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  camera_make: string | null;
  camera_model: string | null;
  taken_lat: number | null;
  taken_lng: number | null;
  captured_at_source: string | null;
  meta_error: string | null;
}

function rowToScan(row: ScanRow): Scan {
  return {
    id: row.id,
    created_at: row.created_at,
    finished_at: row.finished_at,
    status: row.status as ScanStatus,
    trigger: row.trigger,
    folder_ids: row.folder_ids,
    total_files: row.total_files,
    total_bytes: row.total_bytes,
    photo_count: row.photo_count,
    video_count: row.video_count,
    exif_count: row.exif_count,
    gps_count: row.gps_count,
  };
}

function rowToScanFile(row: ScanFileRow): ScanFile {
  return {
    id: row.id,
    scan_id: row.scan_id,
    folder_id: row.folder_id,
    file_path: row.file_path,
    size_bytes: row.size_bytes,
    mtime_ms: row.mtime_ms,
    mime_type: row.mime_type,
    media_kind: (row.media_kind as MediaKind | null) ?? null,
    has_exif: row.has_exif !== 0,
    has_gps: row.has_gps !== 0,
    captured_at: row.captured_at,
    width: row.width,
    height: row.height,
    camera_make: row.camera_make,
    camera_model: row.camera_model,
    taken_lat: row.taken_lat,
    taken_lng: row.taken_lng,
    captured_at_source: (row.captured_at_source as CaptureDateSource | null) ?? null,
    meta_error: row.meta_error,
  };
}

// ---------------------------------------------------------------------------
// Insert payload for a scan_files snapshot row
// ---------------------------------------------------------------------------

export interface ScanFileInput {
  folderId: number;
  filePath: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  mimeType: string | null;
  mediaKind: MediaKind | null;
  hasExif: boolean;
  hasGps: boolean;
  capturedAt?: string | null;
  width?: number | null;
  height?: number | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  takenLat?: number | null;
  takenLng?: number | null;
  capturedAtSource?: CaptureDateSource | null;
  metaError?: string | null;
}

/** Denormalized rollups recorded when a scan finishes. */
export interface ScanTotals {
  totalFiles: number;
  totalBytes: number;
  photoCount: number;
  videoCount: number;
  exifCount: number;
  gpsCount: number;
}

/** One row of the per-camera breakdown. */
export interface CameraBreakdownRow {
  make: string | null;
  model: string | null;
  count: number;
}

/** One row of the per-folder breakdown. */
export interface FolderBreakdownRow {
  folderId: number;
  count: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// ScanRepo
// ---------------------------------------------------------------------------

export class ScanRepo {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Record the start of a scan run and return its numeric ID.
   * The scan starts in `running` status with zeroed rollups.
   */
  startScan(opts: { trigger: string; folderIds: number[] }): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO scans (created_at, status, trigger, folder_ids)
         VALUES (?, 'running', ?, ?)`,
      )
      .run(now, opts.trigger, JSON.stringify(opts.folderIds));
    return info.lastInsertRowid as number;
  }

  /**
   * Insert one immutable snapshot row for a scanned file.
   */
  insertScanFile(scanId: number, input: ScanFileInput): void {
    this.db
      .prepare(
        `INSERT INTO scan_files
           (scan_id, folder_id, file_path, size_bytes, mtime_ms, mime_type,
            media_kind, has_exif, has_gps, captured_at, width, height,
            camera_make, camera_model, taken_lat, taken_lng,
            captured_at_source, meta_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scanId,
        input.folderId,
        input.filePath,
        input.sizeBytes,
        input.mtimeMs,
        input.mimeType,
        input.mediaKind,
        input.hasExif ? 1 : 0,
        input.hasGps ? 1 : 0,
        input.capturedAt ?? null,
        input.width ?? null,
        input.height ?? null,
        input.cameraMake ?? null,
        input.cameraModel ?? null,
        input.takenLat ?? null,
        input.takenLng ?? null,
        input.capturedAtSource ?? null,
        input.metaError ?? null,
      );
  }

  /**
   * Mark a scan complete (or failed) and write its denormalized rollups.
   */
  finishScan(scanId: number, totals: ScanTotals, status: ScanStatus = 'complete'): void {
    this.db
      .prepare(
        `UPDATE scans
         SET finished_at = ?, status = ?, total_files = ?, total_bytes = ?,
             photo_count = ?, video_count = ?, exif_count = ?, gps_count = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        status,
        totals.totalFiles,
        totals.totalBytes,
        totals.photoCount,
        totals.videoCount,
        totals.exifCount,
        totals.gpsCount,
        scanId,
      );
  }

  /**
   * Compute the rollups for a scan directly from its `scan_files` rows.
   * Used by the engine to finalize a scan without tracking counters manually.
   */
  computeTotals(scanId: number): ScanTotals {
    const row = this.db
      .prepare<
        [number],
        {
          total_files: number;
          total_bytes: number;
          photo_count: number;
          video_count: number;
          exif_count: number;
          gps_count: number;
        }
      >(
        `SELECT
           COUNT(*)                                              AS total_files,
           COALESCE(SUM(size_bytes), 0)                          AS total_bytes,
           COALESCE(SUM(media_kind = 'photo'), 0)                AS photo_count,
           COALESCE(SUM(media_kind = 'video'), 0)                AS video_count,
           COALESCE(SUM(has_exif), 0)                            AS exif_count,
           COALESCE(SUM(has_gps), 0)                             AS gps_count
         FROM scan_files WHERE scan_id = ?`,
      )
      .get(scanId);
    return {
      totalFiles: row?.total_files ?? 0,
      totalBytes: row?.total_bytes ?? 0,
      photoCount: row?.photo_count ?? 0,
      videoCount: row?.video_count ?? 0,
      exifCount: row?.exif_count ?? 0,
      gpsCount: row?.gps_count ?? 0,
    };
  }

  /**
   * Get a single scan by ID.  Returns null if not found.
   */
  getScan(id: number): Scan | null {
    const row = this.db
      .prepare<[number], ScanRow>('SELECT * FROM scans WHERE id = ?')
      .get(id);
    return row ? rowToScan(row) : null;
  }

  /**
   * List recent scans, newest first.
   * @param limit  Maximum number of rows to return (default 20).
   */
  listScans(limit = 20): Scan[] {
    const rows = this.db
      .prepare<[number], ScanRow>(
        'SELECT * FROM scans ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(limit) as ScanRow[];
    return rows.map(rowToScan);
  }

  /**
   * Get the most recent completed scan, or null if none exist.
   */
  latestComplete(): Scan | null {
    const row = this.db
      .prepare<[], ScanRow>(
        `SELECT * FROM scans WHERE status = 'complete'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get();
    return row ? rowToScan(row) : null;
  }

  /**
   * List all snapshot rows for a scan, ordered by path.
   */
  listScanFiles(scanId: number): ScanFile[] {
    const rows = this.db
      .prepare<[number], ScanFileRow>(
        'SELECT * FROM scan_files WHERE scan_id = ? ORDER BY file_path',
      )
      .all(scanId) as ScanFileRow[];
    return rows.map(rowToScanFile);
  }

  // -------------------------------------------------------------------------
  // Aggregate queries for the report layer
  // -------------------------------------------------------------------------

  /**
   * Total bytes for a scan split by media kind.
   */
  bytesByKind(scanId: number): { photoBytes: number; videoBytes: number } {
    const row = this.db
      .prepare<[number], { photo_bytes: number; video_bytes: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN media_kind = 'photo' THEN size_bytes ELSE 0 END), 0) AS photo_bytes,
           COALESCE(SUM(CASE WHEN media_kind = 'video' THEN size_bytes ELSE 0 END), 0) AS video_bytes
         FROM scan_files WHERE scan_id = ?`,
      )
      .get(scanId);
    return {
      photoBytes: row?.photo_bytes ?? 0,
      videoBytes: row?.video_bytes ?? 0,
    };
  }

  /**
   * Per-camera breakdown (make + model), most frequent first.  Only rows that
   * carry a camera make or model are included.
   */
  cameraBreakdown(scanId: number, limit = 10): CameraBreakdownRow[] {
    return this.db
      .prepare<[number, number], CameraBreakdownRow>(
        `SELECT camera_make AS make, camera_model AS model, COUNT(*) AS count
         FROM scan_files
         WHERE scan_id = ? AND (camera_make IS NOT NULL OR camera_model IS NOT NULL)
         GROUP BY camera_make, camera_model
         ORDER BY count DESC, make, model
         LIMIT ?`,
      )
      .all(scanId, limit) as CameraBreakdownRow[];
  }

  /**
   * Per-folder breakdown (file count + total bytes), most files first.
   */
  folderBreakdown(scanId: number): FolderBreakdownRow[] {
    const rows = this.db
      .prepare<[number], { folder_id: number; count: number; bytes: number }>(
        `SELECT folder_id, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
         FROM scan_files
         WHERE scan_id = ?
         GROUP BY folder_id
         ORDER BY count DESC, folder_id`,
      )
      .all(scanId) as Array<{ folder_id: number; count: number; bytes: number }>;
    return rows.map((r) => ({ folderId: r.folder_id, count: r.count, bytes: r.bytes }));
  }

  /**
   * Additional coverage counts not stored on the rollup row: how many files
   * carry a capture timestamp, and how many hit a metadata-extraction error.
   */
  coverageExtras(scanId: number): { capturedAtCount: number; metaErrorCount: number } {
    const row = this.db
      .prepare<[number], { captured_at_count: number; meta_error_count: number }>(
        `SELECT
           COALESCE(SUM(captured_at IS NOT NULL), 0) AS captured_at_count,
           COALESCE(SUM(meta_error IS NOT NULL), 0)  AS meta_error_count
         FROM scan_files WHERE scan_id = ?`,
      )
      .get(scanId);
    return {
      capturedAtCount: row?.captured_at_count ?? 0,
      metaErrorCount: row?.meta_error_count ?? 0,
    };
  }

  /**
   * Top-N largest files in a scan (by size).
   */
  largestFiles(scanId: number, limit = 10): ScanFile[] {
    const rows = this.db
      .prepare<[number, number], ScanFileRow>(
        `SELECT * FROM scan_files
         WHERE scan_id = ? AND size_bytes IS NOT NULL
         ORDER BY size_bytes DESC, file_path
         LIMIT ?`,
      )
      .all(scanId, limit) as ScanFileRow[];
    return rows.map(rowToScanFile);
  }
}
