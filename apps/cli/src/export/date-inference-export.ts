/**
 * export/date-inference-export.ts — Write a date-inference run report to
 * Excel (.xlsx) or CSV.
 *
 * Mirrors scan-export.ts: the heavy exceljs dependency is loaded via dynamic
 * import, xlsx output has a Summary sheet (totals) + a Detail sheet (one row
 * per processed file), and csv output is the Detail sheet only. Unlike scan,
 * there is no persisted run to read back from disk — the caller passes the
 * in-memory totals + accumulated per-file records straight from the engine's
 * events (see date-inference/date-inference-engine.ts), since this tool
 * keeps no SQLite run history.
 */

import * as fs from 'node:fs';
import type {
  DateInferenceTotals,
  DateInferenceFilePayload,
  DateInferenceStatus,
} from '../date-inference/events.js';
import type { DateInferenceMode } from '../date-inference/date-inference-engine.js';
import { DATE_FMT } from './xlsx-format.js';

export type ExportFormat = 'xlsx' | 'csv';

// exceljs is CJS; normalize the default-interop shape.
type ExcelJsModule = typeof import('exceljs');
async function getExcelJs(): Promise<ExcelJsModule> {
  const mod = await import('exceljs');
  return ((mod as unknown as { default?: ExcelJsModule }).default ?? mod) as ExcelJsModule;
}

/** Human-readable label for a per-file status. */
function statusLabel(status: DateInferenceStatus): string {
  switch (status) {
    case 'has_date': return 'Already has a date';
    case 'inferred': return 'Inferred from filename';
    case 'no_pattern': return 'No date found';
    case 'written': return 'Written to file';
    case 'write_failed': return 'Write failed';
    case 'error': return 'Error';
  }
}

/** Column order shared by the xlsx Detail sheet and the CSV output. */
const DETAIL_COLUMNS: Array<{ header: string; key: keyof DetailRowView; width: number }> = [
  { header: 'File path', key: 'filePath', width: 60 },
  { header: 'Media kind', key: 'mediaKind', width: 12 },
  { header: 'Status', key: 'status', width: 22 },
  { header: 'Matched pattern', key: 'matchedPattern', width: 16 },
  { header: 'Matched text', key: 'matchedText', width: 24 },
  { header: 'Inferred date', key: 'inferredDate', width: 22 },
  { header: 'Existing captured at', key: 'existingCapturedAt', width: 22 },
  { header: 'Error', key: 'error', width: 30 },
];

interface DetailRowView {
  filePath: string;
  mediaKind: string;
  status: string;
  matchedPattern: string;
  matchedText: string;
  inferredDate: string | null;
  existingCapturedAt: string | null;
  error: string | null;
}

function toRowView(f: DateInferenceFilePayload): DetailRowView {
  return {
    filePath: f.filePath,
    mediaKind: f.mediaKind,
    status: statusLabel(f.status),
    matchedPattern: f.matchedPattern ?? '',
    matchedText: f.matchedText ?? '',
    inferredDate: f.inferredDate ?? null,
    existingCapturedAt: f.existingCapturedAt ?? null,
    error: f.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

async function exportXlsx(
  totals: DateInferenceTotals,
  mode: DateInferenceMode,
  files: DateInferenceFilePayload[],
  outPath: string,
): Promise<void> {
  const ExcelJS = await getExcelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MemoriaHub CLI';

  // --- Summary sheet ---
  const summary = wb.addWorksheet('Summary');
  const kv = (label: string, value: string | number, numFmt?: string): void => {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (numFmt) row.getCell(2).numFmt = numFmt;
  };
  const section = (title: string): void => {
    const row = summary.addRow([title]);
    row.getCell(1).font = { bold: true, size: 13 };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  };
  summary.columns = [{ width: 26 }, { width: 40 }];

  section('Date Inference');
  kv('Mode', mode === 'apply' ? 'Apply (wrote dates)' : 'Diagnose (report only)');
  summary.addRow([]);

  section('Totals');
  kv('Total files scanned', totals.total, '#,##0');
  kv('Already had a date', totals.hasDate, '#,##0');
  kv('Inferred from filename', totals.inferred, '#,##0');
  kv('No date found', totals.noPattern, '#,##0');
  if (mode === 'apply') {
    kv('Written to file', totals.written, '#,##0');
    kv('Write failed', totals.writeFailed, '#,##0');
  }
  kv('Errors', totals.errors, '#,##0');
  summary.addRow([]);

  const patternEntries = Object.entries(totals.byPattern).filter(([, n]) => n > 0);
  if (patternEntries.length > 0) {
    section('Matched pattern breakdown');
    const head = summary.addRow(['Pattern', 'Files']);
    head.font = { bold: true };
    for (const [pattern, count] of patternEntries) {
      const row = summary.addRow([pattern, count]);
      row.getCell(2).numFmt = '#,##0';
    }
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

  // Convert the ISO date columns into real Excel datetimes so they render and
  // sort as dates rather than plain text.
  for (const key of ['inferredDate', 'existingCapturedAt'] as const) {
    const colIndex = DETAIL_COLUMNS.findIndex((c) => c.key === key) + 1;
    detail.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const cell = row.getCell(colIndex);
      if (typeof cell.value === 'string' && cell.value) {
        const d = new Date(cell.value);
        if (!isNaN(d.getTime())) {
          cell.value = d;
          cell.numFmt = DATE_FMT;
        }
      }
    });
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

async function exportCsv(files: DateInferenceFilePayload[], outPath: string): Promise<void> {
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

/** Export a date-inference run's totals + per-file detail to disk. */
export async function exportDateInference(
  totals: DateInferenceTotals,
  mode: DateInferenceMode,
  files: DateInferenceFilePayload[],
  outPath: string,
  format: ExportFormat,
): Promise<void> {
  if (format === 'csv') {
    await exportCsv(files, outPath);
  } else {
    await exportXlsx(totals, mode, files, outPath);
  }
}
