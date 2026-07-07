/**
 * test/scan/report.spec.ts
 *
 * Unit tests for buildScanReport() — pure aggregation over ScanRepo/FolderRepo
 * data. No I/O beyond the in-memory SQLite repos.
 */

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { ScanRepo } from '../../src/repo/scans.js';
import type { ScanFileInput } from '../../src/repo/scans.js';
import { buildScanReport } from '../../src/scan/report.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

function baseFile(overrides: Partial<ScanFileInput> = {}): ScanFileInput {
  return {
    folderId: 1,
    filePath: '/tmp/f.jpg',
    sizeBytes: 1000,
    mtimeMs: 123456,
    mimeType: 'image/jpeg',
    mediaKind: 'photo',
    hasExif: false,
    hasGps: false,
    ...overrides,
  };
}

describe('buildScanReport', () => {
  let db: BetterSqlite3.Database;
  let folders: FolderRepo;
  let scans: ScanRepo;
  let folderId: number;

  beforeEach(() => {
    db = makeDb();
    folders = new FolderRepo(db);
    scans = new ScanRepo(db);
    folderId = folders.add({ path: '/tmp/report-folder1' }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('throws for an unknown scan ID', () => {
    expect(() => buildScanReport(scans, folders, 999999)).toThrow(/not found/i);
  });

  describe('kpis + coverage — 66.7% repeating-decimal case', () => {
    it('matches the pct() formula exactly (2 of 3 files have EXIF -> 66.7%)', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/e1.jpg', hasExif: true, hasGps: true, capturedAt: '2026-01-01T00:00:00.000Z',
      }));
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/e2.jpg', hasExif: true, hasGps: false, capturedAt: '2026-01-02T00:00:00.000Z',
      }));
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/e3.jpg', hasExif: false, hasGps: false,
      }));
      const totals = scans.computeTotals(scanId);
      scans.finishScan(scanId, totals);

      const report = buildScanReport(scans, folders, scanId);

      expect(report.kpis.totalFiles).toBe(3);
      expect(report.kpis.photoCount).toBe(3);
      expect(report.kpis.videoCount).toBe(0);
      expect(report.kpis.totalBytes).toBe(3000);

      // 2/3 = 0.6666... -> Math.round(666.66...) / 10 = 66.7
      expect(report.coverage.exifCount).toBe(2);
      expect(report.coverage.exifPct).toBe(66.7);
      // 1/3 = 33.3
      expect(report.coverage.gpsCount).toBe(1);
      expect(report.coverage.gpsPct).toBe(33.3);
      // 2/3 capturedAt set -> 66.7
      expect(report.coverage.capturedAtCount).toBe(2);
      expect(report.coverage.capturedAtPct).toBe(66.7);
      expect(report.coverage.metaErrorCount).toBe(0);
    });

    it('returns 0% for all coverage fields when totalFiles is 0', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId);
      expect(report.coverage.exifPct).toBe(0);
      expect(report.coverage.gpsPct).toBe(0);
      expect(report.coverage.capturedAtPct).toBe(0);
    });
  });

  describe('capture date source — EXIF-only, no filesystem fallback', () => {
    it('a row with capturedAt:null carries capturedAtSource="none" and is excluded from capturedAtCount', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({
        folderId,
        filePath: '/tmp/nodate.jpg',
        capturedAt: null,
        capturedAtSource: 'none',
      }));
      scans.insertScanFile(scanId, baseFile({
        folderId,
        filePath: '/tmp/dated.jpg',
        hasExif: true,
        capturedAt: '2026-01-01T00:00:00.000Z',
        capturedAtSource: 'exif',
      }));
      const totals = scans.computeTotals(scanId);
      scans.finishScan(scanId, totals);

      const report = buildScanReport(scans, folders, scanId);

      expect(report.kpis.totalFiles).toBe(2);
      // Only the EXIF-dated row counts toward capturedAtCount — the null row
      // is never backfilled from a filesystem timestamp.
      expect(report.coverage.capturedAtCount).toBe(1);
      expect(report.coverage.capturedAtPct).toBe(50);

      const files = scans.listScanFiles(scanId);
      const nodateRow = files.find((f) => f.file_path === '/tmp/nodate.jpg')!;
      const datedRow = files.find((f) => f.file_path === '/tmp/dated.jpg')!;
      expect(nodateRow.captured_at).toBeNull();
      expect(nodateRow.captured_at_source).toBe('none');
      expect(datedRow.captured_at).toBe('2026-01-01T00:00:00.000Z');
      expect(datedRow.captured_at_source).toBe('exif');
    });
  });

  describe('byFolder', () => {
    it('resolves the real folder path via folders.getById()', () => {
      const folder2 = folders.add({ path: '/tmp/report-folder2' });
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId, folder2.id] });
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/report-folder1/x.jpg' }));
      scans.insertScanFile(scanId, baseFile({ folderId: folder2.id, filePath: '/tmp/report-folder2/y.jpg' }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId);

      const entry1 = report.byFolder.find((f) => f.folderId === folderId)!;
      const entry2 = report.byFolder.find((f) => f.folderId === folder2.id)!;
      expect(entry1.path).toBe(folders.getById(folderId)!.path);
      expect(entry2.path).toBe(folders.getById(folder2.id)!.path);
    });
  });

  describe('byCamera — label dedup logic', () => {
    it('dedups when model already starts with make (case-insensitive)', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/dup1.jpg', cameraMake: 'samsung', cameraModel: 'samsung Galaxy S21',
      }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId);
      expect(report.byCamera).toHaveLength(1);
      expect(report.byCamera[0].label).toBe('samsung Galaxy S21');
    });

    it('combines make + model when model does not start with make', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/dup2.jpg', cameraMake: 'Apple', cameraModel: 'iPhone 14',
      }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId);
      expect(report.byCamera).toHaveLength(1);
      expect(report.byCamera[0].label).toBe('Apple iPhone 14');
    });

    it('falls back to make-only when model is null', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/make-only.jpg', cameraMake: 'Nikon', cameraModel: null,
      }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId);
      expect(report.byCamera[0].label).toBe('Nikon');
    });

    it('falls back to model-only when make is null', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({
        folderId, filePath: '/tmp/model-only.jpg', cameraMake: null, cameraModel: 'D850',
      }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId);
      expect(report.byCamera[0].label).toBe('D850');
    });

    // NOTE: cameraBreakdown's underlying SQL filters
    // `WHERE camera_make IS NOT NULL OR camera_model IS NOT NULL`, so a row
    // with BOTH null never reaches cameraLabel() in practice via normal
    // insertion — the 'Unknown' fallback branch is unreachable through the
    // repo layer. We do not force that invalid state here; skipping that
    // branch is intentional (see task notes).

    it('respects the cameraLimit option', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/c1.jpg', cameraMake: 'A' }));
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/c2.jpg', cameraMake: 'B' }));
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/c3.jpg', cameraMake: 'C' }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId, { cameraLimit: 2 });
      expect(report.byCamera).toHaveLength(2);
    });
  });

  describe('largest', () => {
    it('respects size ordering and the largestLimit option', () => {
      const scanId = scans.startScan({ trigger: 'cli', folderIds: [folderId] });
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/small.jpg', sizeBytes: 100 }));
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/big.jpg', sizeBytes: 9000 }));
      scans.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/mid.jpg', sizeBytes: 500 }));
      scans.finishScan(scanId, scans.computeTotals(scanId));

      const report = buildScanReport(scans, folders, scanId, { largestLimit: 2 });
      expect(report.largest).toHaveLength(2);
      expect(report.largest[0].path).toBe('/tmp/big.jpg');
      expect(report.largest[0].sizeBytes).toBe(9000);
      expect(report.largest[1].path).toBe('/tmp/mid.jpg');
    });
  });
});
