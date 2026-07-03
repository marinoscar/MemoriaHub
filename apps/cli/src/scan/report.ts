/**
 * scan/report.ts — Pure aggregation for the scan dashboard/report.
 *
 * buildScanReport() is the SINGLE source of truth consumed by all three
 * renderers (headless CLI, Ink dashboard, Excel export) so the numbers can
 * never diverge between surfaces.  It performs no I/O beyond the injected repo
 * queries and does no formatting — callers format bytes/percentages for display.
 */

import type { Scan } from '../db/types.js';
import type { ScanRepo } from '../repo/scans.js';
import type { FolderRepo } from '../repo/folders.js';

export interface ScanReportKpis {
  totalFiles: number;
  photoCount: number;
  videoCount: number;
  totalBytes: number;
  photoBytes: number;
  videoBytes: number;
}

export interface ScanReportCoverage {
  exifCount: number;
  exifPct: number;
  gpsCount: number;
  gpsPct: number;
  capturedAtCount: number;
  capturedAtPct: number;
  /** Files whose metadata extraction failed. */
  metaErrorCount: number;
}

export interface FolderBreakdownEntry {
  folderId: number;
  path: string;
  count: number;
  bytes: number;
}

export interface CameraBreakdownEntry {
  /** Human label combining make + model, e.g. "Apple iPhone 14 Pro". */
  label: string;
  count: number;
}

export interface LargestFileEntry {
  path: string;
  sizeBytes: number;
  mediaKind: string | null;
}

export interface ScanReport {
  scan: Scan;
  kpis: ScanReportKpis;
  coverage: ScanReportCoverage;
  byFolder: FolderBreakdownEntry[];
  byCamera: CameraBreakdownEntry[];
  largest: LargestFileEntry[];
}

/** Percentage of `count` out of `total`, rounded to one decimal (0 when total=0). */
function pct(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function cameraLabel(make: string | null, model: string | null): string {
  const m = (make ?? '').trim();
  const md = (model ?? '').trim();
  if (m && md) {
    // Avoid "Apple Apple iPhone" duplication when model already starts with make.
    return md.toLowerCase().startsWith(m.toLowerCase()) ? md : `${m} ${md}`;
  }
  return m || md || 'Unknown';
}

/**
 * Build the complete report object for a scan.
 *
 * @throws if the scan ID does not exist.
 */
export function buildScanReport(
  scans: ScanRepo,
  folders: FolderRepo,
  scanId: number,
  opts: { largestLimit?: number; cameraLimit?: number } = {},
): ScanReport {
  const scan = scans.getScan(scanId);
  if (!scan) {
    throw new Error(`Scan ${scanId} not found.`);
  }

  const total = scan.total_files;
  const { photoBytes, videoBytes } = scans.bytesByKind(scanId);
  const extras = scans.coverageExtras(scanId);

  const kpis: ScanReportKpis = {
    totalFiles: total,
    photoCount: scan.photo_count,
    videoCount: scan.video_count,
    totalBytes: scan.total_bytes,
    photoBytes,
    videoBytes,
  };

  const coverage: ScanReportCoverage = {
    exifCount: scan.exif_count,
    exifPct: pct(scan.exif_count, total),
    gpsCount: scan.gps_count,
    gpsPct: pct(scan.gps_count, total),
    capturedAtCount: extras.capturedAtCount,
    capturedAtPct: pct(extras.capturedAtCount, total),
    metaErrorCount: extras.metaErrorCount,
  };

  const byFolder: FolderBreakdownEntry[] = scans.folderBreakdown(scanId).map((r) => ({
    folderId: r.folderId,
    path: folders.getById(r.folderId)?.path ?? `folder #${r.folderId}`,
    count: r.count,
    bytes: r.bytes,
  }));

  const byCamera: CameraBreakdownEntry[] = scans
    .cameraBreakdown(scanId, opts.cameraLimit ?? 10)
    .map((r) => ({ label: cameraLabel(r.make, r.model), count: r.count }));

  const largest: LargestFileEntry[] = scans
    .largestFiles(scanId, opts.largestLimit ?? 10)
    .map((r) => ({
      path: r.file_path,
      sizeBytes: r.size_bytes ?? 0,
      mediaKind: r.media_kind,
    }));

  return { scan, kpis, coverage, byFolder, byCamera, largest };
}
