/**
 * test/export/scan-export.spec.ts
 *
 * Unit tests for resolveFormat() and exportScan() (xlsx + csv).
 */

import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveFormat, exportScan } from '../../src/export/scan-export.js';
import type { ScanReport } from '../../src/scan/report.js';
import type { Scan, ScanFile } from '../../src/db/types.js';

// exceljs is CJS; use createRequire so we can read the workbook back
// synchronously in a .spec.ts under ts-jest (ESM project) — same pattern
// used by test/db/migrations.spec.ts for better-sqlite3.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ExcelJS = require('exceljs') as any;

function makeScan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:01:00.000Z',
    status: 'complete',
    trigger: 'cli',
    folder_ids: '[1]',
    total_files: 3,
    total_bytes: 6000,
    photo_count: 2,
    video_count: 1,
    exif_count: 1,
    gps_count: 1,
    ...overrides,
  };
}

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    scan: makeScan(),
    kpis: {
      totalFiles: 3,
      photoCount: 2,
      videoCount: 1,
      totalBytes: 6000,
      photoBytes: 3000,
      videoBytes: 3000,
    },
    coverage: {
      exifCount: 1,
      exifPct: 33.3,
      gpsCount: 1,
      gpsPct: 33.3,
      capturedAtCount: 1,
      capturedAtPct: 33.3,
      metaErrorCount: 0,
    },
    byFolder: [{ folderId: 1, path: '/tmp/report-folder', count: 3, bytes: 6000 }],
    byCamera: [{ label: 'Apple iPhone 14', count: 2 }],
    largest: [{ path: '/tmp/big.jpg', sizeBytes: 3000, mediaKind: 'photo' }],
    ...overrides,
  };
}

function makeScanFile(overrides: Partial<ScanFile> = {}): ScanFile {
  return {
    id: 1,
    scan_id: 1,
    folder_id: 1,
    file_path: '/tmp/report-folder/photo1.jpg',
    size_bytes: 2000,
    mtime_ms: 123456,
    mime_type: 'image/jpeg',
    media_kind: 'photo',
    has_exif: true,
    has_gps: true,
    captured_at: '2026-01-01T00:00:00.000Z',
    width: 4000,
    height: 3000,
    camera_make: 'Apple',
    camera_model: 'iPhone 14',
    taken_lat: 30.24,
    taken_lng: -95.48,
    meta_error: null,
    ...overrides,
  };
}

describe('resolveFormat', () => {
  it('infers csv from a .csv path with no explicit format', () => {
    expect(resolveFormat('report.csv')).toBe('csv');
  });

  it('infers xlsx from a .xlsx path with no explicit format', () => {
    expect(resolveFormat('report.xlsx')).toBe('xlsx');
  });

  it('is case-insensitive for the extension (.CSV -> csv)', () => {
    expect(resolveFormat('report.CSV')).toBe('csv');
  });

  it('explicit format wins over the path extension', () => {
    expect(resolveFormat('report.csv', 'xlsx')).toBe('xlsx');
  });

  it('defaults to xlsx for an unrecognized or missing extension', () => {
    expect(resolveFormat('report')).toBe('xlsx');
    expect(resolveFormat('report.txt')).toBe('xlsx');
  });
});

describe('exportScan', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-scan-export-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('xlsx', () => {
    it('writes a Summary + Detail workbook with the expected header row and row count', async () => {
      const report = makeReport();
      const files: ScanFile[] = [
        makeScanFile({ id: 1, file_path: '/tmp/report-folder/photo1.jpg' }),
        makeScanFile({ id: 2, file_path: '/tmp/report-folder/photo2.jpg', has_exif: false, has_gps: false }),
        makeScanFile({
          id: 3,
          file_path: '/tmp/report-folder/clip1.mp4',
          media_kind: 'video',
          mime_type: 'video/mp4',
          has_exif: false,
          has_gps: false,
          captured_at: null,
          width: null,
          height: null,
          camera_make: null,
          camera_model: null,
          taken_lat: null,
          taken_lng: null,
        }),
      ];

      const outPath = path.join(tmpDir, 'report.xlsx');
      await exportScan(report, files, outPath, 'xlsx');

      expect(fs.existsSync(outPath)).toBe(true);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(outPath);

      expect(workbook.worksheets.map((ws: { name: string }) => ws.name)).toEqual(['Summary', 'Detail']);

      const detail = workbook.getWorksheet('Detail')!;
      const expectedHeaders = [
        'File path',
        'Folder ID',
        'Size (bytes)',
        'MIME type',
        'Media kind',
        'Has EXIF',
        'Has location',
        'Captured at',
        'Width',
        'Height',
        'Camera make',
        'Camera model',
        'Latitude',
        'Longitude',
        'Meta error',
      ];
      const headerRow = detail.getRow(1).values as unknown[];
      // ExcelJS row.values is 1-indexed (index 0 is empty); drop it.
      const actualHeaders = (headerRow as unknown[]).slice(1);
      expect(actualHeaders).toEqual(expectedHeaders);

      // header row + one row per file
      expect(detail.rowCount).toBe(files.length + 1);
    });
  });

  describe('csv', () => {
    it('writes header + one line per file, with RFC-4180 quoting for fields containing commas', async () => {
      const report = makeReport();
      const files: ScanFile[] = [
        makeScanFile({
          id: 1,
          file_path: '/tmp/photos, vacation/img.jpg',
          camera_make: 'Apple',
        }),
        makeScanFile({ id: 2, file_path: '/tmp/plain/img2.jpg' }),
      ];

      const outPath = path.join(tmpDir, 'report.csv');
      await exportScan(report, files, outPath, 'csv');

      const content = fs.readFileSync(outPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);

      expect(lines).toHaveLength(files.length + 1);
      expect(lines[0]).toBe(
        'File path,Folder ID,Size (bytes),MIME type,Media kind,Has EXIF,Has location,Captured at,Width,Height,Camera make,Camera model,Latitude,Longitude,Meta error',
      );

      // The row for the comma-containing path must be RFC-4180 quoted.
      expect(lines[1]).toContain('"/tmp/photos, vacation/img.jpg"');
    });
  });
});
