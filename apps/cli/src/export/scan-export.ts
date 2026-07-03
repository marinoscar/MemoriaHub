/**
 * export/scan-export.ts — Write a scan report to Excel (.xlsx) or CSV.
 *
 * The heavy exceljs dependency is loaded via dynamic import so it is only
 * pulled in when an export actually runs (mirrors the dynamic-Ink discipline
 * used elsewhere in the CLI).
 *
 * xlsx output has two sheets:
 *   - Summary : the ScanReport KPIs, coverage, and breakdown tables.
 *   - Detail  : one row per scanned file with all metadata columns.
 * csv output is the Detail sheet only (CSV is a single flat table).
 */

import * as fs from 'node:fs';
import type { ScanReport } from '../scan/report.js';
import type { ScanFile } from '../db/types.js';

export type ExportFormat = 'xlsx' | 'csv';

// exceljs is CJS; normalize the default-interop shape.
type ExcelJsModule = typeof import('exceljs');
async function getExcelJs(): Promise<ExcelJsModule> {
  const mod = await import('exceljs');
  return ((mod as unknown as { default?: ExcelJsModule }).default ?? mod) as ExcelJsModule;
}

/** Column order shared by the xlsx Detail sheet and the CSV output. */
const DETAIL_COLUMNS: Array<{ header: string; key: keyof ScanFileRowView; width: number }> = [
  { header: 'File path', key: 'filePath', width: 60 },
  { header: 'Folder ID', key: 'folderId', width: 10 },
  { header: 'Size (bytes)', key: 'sizeBytes', width: 14 },
  { header: 'MIME type', key: 'mimeType', width: 16 },
  { header: 'Media kind', key: 'mediaKind', width: 12 },
  { header: 'Has EXIF', key: 'hasExif', width: 10 },
  { header: 'Has location', key: 'hasGps', width: 12 },
  { header: 'Captured at', key: 'capturedAt', width: 22 },
  { header: 'Width', key: 'width', width: 8 },
  { header: 'Height', key: 'height', width: 8 },
  { header: 'Camera make', key: 'cameraMake', width: 16 },
  { header: 'Camera model', key: 'cameraModel', width: 20 },
  { header: 'Latitude', key: 'takenLat', width: 12 },
  { header: 'Longitude', key: 'takenLng', width: 12 },
  { header: 'Meta error', key: 'metaError', width: 24 },
];

interface ScanFileRowView {
  filePath: string;
  folderId: number;
  sizeBytes: number | null;
  mimeType: string | null;
  mediaKind: string | null;
  hasExif: string;
  hasGps: string;
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  takenLat: number | null;
  takenLng: number | null;
  metaError: string | null;
}

function toRowView(f: ScanFile): ScanFileRowView {
  return {
    filePath: f.file_path,
    folderId: f.folder_id,
    sizeBytes: f.size_bytes,
    mimeType: f.mime_type,
    mediaKind: f.media_kind,
    hasExif: f.has_exif ? 'yes' : 'no',
    hasGps: f.has_gps ? 'yes' : 'no',
    capturedAt: f.captured_at,
    width: f.width,
    height: f.height,
    cameraMake: f.camera_make,
    cameraModel: f.camera_model,
    takenLat: f.taken_lat,
    takenLng: f.taken_lng,
    metaError: f.meta_error,
  };
}

/** Resolve the export format from an explicit flag or the output extension. */
export function resolveFormat(outPath: string, explicit?: string): ExportFormat {
  if (explicit === 'csv' || explicit === 'xlsx') return explicit;
  return outPath.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

async function exportXlsx(
  report: ScanReport,
  files: ScanFile[],
  outPath: string,
): Promise<void> {
  const ExcelJS = await getExcelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MemoriaHub CLI';

  // --- Summary sheet ---
  const summary = wb.addWorksheet('Summary');
  const { scan, kpis, coverage } = report;
  const kv = (label: string, value: string | number): void => {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  };
  const section = (title: string): void => {
    const row = summary.addRow([title]);
    row.getCell(1).font = { bold: true, size: 13 };
    row.getCell(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8F0FE' },
    };
  };
  summary.columns = [{ width: 26 }, { width: 40 }];

  section('Scan');
  kv('Scan ID', scan.id);
  kv('Created at', scan.created_at);
  kv('Finished at', scan.finished_at ?? '');
  kv('Status', scan.status);
  summary.addRow([]);

  section('Totals');
  kv('Total files', kpis.totalFiles);
  kv('Photos', kpis.photoCount);
  kv('Videos', kpis.videoCount);
  kv('Total bytes', kpis.totalBytes);
  kv('Photo bytes', kpis.photoBytes);
  kv('Video bytes', kpis.videoBytes);
  summary.addRow([]);

  section('Metadata coverage');
  kv('EXIF present', `${coverage.exifCount} / ${kpis.totalFiles} (${coverage.exifPct}%)`);
  kv('Location present', `${coverage.gpsCount} / ${kpis.totalFiles} (${coverage.gpsPct}%)`);
  kv('Capture date present', `${coverage.capturedAtCount} / ${kpis.totalFiles} (${coverage.capturedAtPct}%)`);
  kv('Read errors', coverage.metaErrorCount);
  summary.addRow([]);

  if (report.byFolder.length > 0) {
    section('By folder');
    const head = summary.addRow(['Folder', 'Files', 'Bytes']);
    head.font = { bold: true };
    for (const f of report.byFolder) summary.addRow([f.path, f.count, f.bytes]);
    summary.addRow([]);
  }

  if (report.byCamera.length > 0) {
    section('By camera');
    const head = summary.addRow(['Make / Model', 'Files']);
    head.font = { bold: true };
    for (const c of report.byCamera) summary.addRow([c.label, c.count]);
    summary.addRow([]);
  }

  // --- Detail sheet ---
  const detail = wb.addWorksheet('Detail');
  detail.columns = DETAIL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  detail.getRow(1).font = { bold: true };
  detail.views = [{ state: 'frozen', ySplit: 1 }];
  for (const f of files) {
    detail.addRow(toRowView(f));
  }

  await wb.xlsx.writeFile(outPath);
}

// ---------------------------------------------------------------------------
// csv (detail only)
// ---------------------------------------------------------------------------

/** RFC 4180 field escaping: quote when the value contains "," CR/LF or a quote. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function exportCsv(files: ScanFile[], outPath: string): Promise<void> {
  const lines: string[] = [];
  lines.push(DETAIL_COLUMNS.map((c) => csvField(c.header)).join(','));
  for (const f of files) {
    const view = toRowView(f) as unknown as Record<string, unknown>;
    lines.push(DETAIL_COLUMNS.map((c) => csvField(view[c.key])).join(','));
  }
  await fs.promises.writeFile(outPath, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Export a scan report + file detail to disk in the requested format.
 */
export async function exportScan(
  report: ScanReport,
  files: ScanFile[],
  outPath: string,
  format: ExportFormat,
): Promise<void> {
  if (format === 'csv') {
    await exportCsv(files, outPath);
  } else {
    await exportXlsx(report, files, outPath);
  }
}
