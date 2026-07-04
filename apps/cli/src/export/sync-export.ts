/**
 * export/sync-export.ts — Write a sync run report to Excel (.xlsx).
 *
 * Two sheets:
 *   - Summary : run metadata + totals (dates as real datetimes, size in MB).
 *   - Detail  : one row per processed file (status, size MB, media item, hash).
 *
 * exceljs is loaded via dynamic import so it is only pulled in on export.
 */

import type { SyncReport } from '../sync/sync-report.js';
import { DATE_FMT, MB_FMT, INT_FMT, bytesToMb, isoToDate } from './xlsx-format.js';

// exceljs is CJS; normalize the default-interop shape.
type ExcelJsModule = typeof import('exceljs');
async function getExcelJs(): Promise<ExcelJsModule> {
  const mod = await import('exceljs');
  return ((mod as unknown as { default?: ExcelJsModule }).default ?? mod) as ExcelJsModule;
}

interface DetailColumn {
  header: string;
  key: string;
  width: number;
}

const DETAIL_COLUMNS: DetailColumn[] = [
  { header: 'File path', key: 'filePath', width: 60 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Detail', key: 'detail', width: 30 },
  { header: 'Size (MB)', key: 'sizeMb', width: 12 },
  { header: 'MIME type', key: 'mimeType', width: 16 },
  { header: 'Media kind', key: 'mediaKind', width: 12 },
  { header: 'Media item ID', key: 'mediaItemId', width: 38 },
  { header: 'SHA-256', key: 'sha256', width: 20 },
];

/**
 * Write the sync report workbook to `outPath`.
 */
export async function exportSyncReport(report: SyncReport, outPath: string): Promise<void> {
  const ExcelJS = await getExcelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MemoriaHub CLI';

  // ------------------------------------------------------------------ Summary
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 26 }, { width: 60 }];

  const kv = (label: string, value: string | number, numFmt?: string): void => {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (numFmt) row.getCell(2).numFmt = numFmt;
  };
  const kvDate = (label: string, iso: string | null): void => {
    const row = summary.addRow([label]);
    row.getCell(1).font = { bold: true };
    const d = isoToDate(iso);
    if (d) {
      row.getCell(2).value = d;
      row.getCell(2).numFmt = DATE_FMT;
    } else {
      row.getCell(2).value = iso ?? '';
    }
  };
  const section = (title: string): void => {
    const row = summary.addRow([title]);
    row.getCell(1).font = { bold: true, size: 13 };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  };

  section('Sync run');
  kv('Run ID', report.runId);
  kv('Trigger', report.trigger || '—');
  kv('Dry run', report.dryRun ? 'yes' : 'no');
  kvDate('Started at', report.startedAt);
  kvDate('Finished at', report.finishedAt);
  kv('Duration (s)', Math.round((report.durationMs / 1000) * 10) / 10, '#,##0.0');
  summary.addRow([]);

  section('Totals');
  kv('Total processed', report.stats.total, INT_FMT);
  kv('Uploaded', report.stats.uploaded, INT_FMT);
  kv('Skipped', report.stats.skipped, INT_FMT);
  kv('Failed', report.stats.failed, INT_FMT);
  kv('Uploaded size (MB)', bytesToMb(report.uploadedBytes) ?? 0, MB_FMT);
  summary.addRow([]);

  if (report.folderPaths.length > 0) {
    section('Folders');
    for (const p of report.folderPaths) summary.addRow(['', p]);
    summary.addRow([]);
  }

  // ------------------------------------------------------------------- Detail
  const detail = wb.addWorksheet('Detail');
  detail.columns = DETAIL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  detail.getRow(1).font = { bold: true };
  detail.views = [{ state: 'frozen', ySplit: 1 }];

  for (const f of report.files) {
    detail.addRow({
      filePath: f.filePath,
      status: f.status,
      detail: f.detail ?? '',
      sizeMb: bytesToMb(f.sizeBytes),
      mimeType: f.mimeType ?? '',
      mediaKind: f.mediaKind ?? '',
      mediaItemId: f.mediaItemId ?? '',
      sha256: f.sha256 ? f.sha256.slice(0, 12) : '',
    });
  }
  detail.getColumn('sizeMb').numFmt = MB_FMT;

  await wb.xlsx.writeFile(outPath);
}
