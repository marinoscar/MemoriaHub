/**
 * test/sync/sync-report.spec.ts
 *
 * SyncReportCollector builds a per-run report from engine events + DB rows,
 * and exportSyncReport writes a Summary + Detail workbook (MB sizes, real dates).
 */

import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FileRepo } from '../../src/repo/files.js';
import { RunRepo } from '../../src/repo/runs.js';
import { TypedEmitter, EV } from '../../src/sync/events.js';
import { SyncReportCollector } from '../../src/sync/sync-report.js';
import { exportSyncReport } from '../../src/export/sync-export.js';
import type { SyncEngine } from '../../src/sync/sync-engine.js';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ExcelJS = require('exceljs') as any;

const MB = 1024 * 1024;

function seed(db: BetterSqlite3.Database) {
  const folders = new FolderRepo(db);
  const files = new FileRepo(db);
  const runs = new RunRepo(db);
  const fid = folders.add({ path: '/photos/trip' }).id;

  const a = files.upsert(fid, '/photos/trip/a.jpg', {
    size_bytes: 5 * MB, mime_type: 'image/jpeg', sha256: 'abc123def456aa', status: 'uploaded', media_item_id: 'm-1',
  });
  const b = files.upsert(fid, '/photos/trip/b.mov', {
    size_bytes: 40 * MB, mime_type: 'video/quicktime', status: 'uploaded', media_item_id: 'm-2',
  });
  const c = files.upsert(fid, '/photos/trip/c.png', {
    size_bytes: 300 * 1024, mime_type: 'image/png', status: 'skipped',
  });
  const d = files.upsert(fid, '/photos/trip/d.jpg', {
    size_bytes: 2 * MB, mime_type: 'image/jpeg', status: 'failed',
  });

  const runId = runs.startRun({ trigger: 'cli', folderIds: [fid], total: 4 });
  runs.finishRun(runId, { uploaded: 2, skipped: 1, failed: 1 });

  return { folders, files, runs, fid, ids: { a: a.id, b: b.id, c: c.id, d: d.id }, runId };
}

function driveRun(collector: SyncReportCollector, s: ReturnType<typeof seed>) {
  const em = new TypedEmitter();
  collector.attach(em as unknown as SyncEngine);
  em.emit(EV.RUN_START, { runId: s.runId, folderIds: [s.fid], total: 4, dryRun: false });
  em.emit(EV.FILE_DONE, { fileId: s.ids.a, path: '/photos/trip/a.jpg', mediaItemId: 'm-1', storageObjectId: 's1' });
  em.emit(EV.FILE_DONE, { fileId: s.ids.b, path: '/photos/trip/b.mov', mediaItemId: 'm-2', storageObjectId: 's2' });
  em.emit(EV.FILE_SKIPPED, { fileId: s.ids.c, path: '/photos/trip/c.png', reason: 'dedup' });
  em.emit(EV.FILE_FAILED, { fileId: s.ids.d, path: '/photos/trip/d.jpg', error: 'HTTP 500', attempt: 1, willRetry: false });
  em.emit(EV.RUN_DONE, { runId: s.runId, stats: { uploaded: 2, skipped: 1, failed: 1 }, durationMs: 12345 });
}

describe('SyncReportCollector', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('builds a report from engine events enriched with DB rows', () => {
    const s = seed(db);
    const collector = new SyncReportCollector(s.files, s.folders, s.runs);
    driveRun(collector, s);

    const report = collector.build();
    expect(report.runId).toBe(s.runId);
    expect(report.trigger).toBe('cli');
    expect(report.folderPaths).toEqual(['/photos/trip']);
    expect(report.stats).toEqual({ uploaded: 2, skipped: 1, failed: 1, total: 4 });
    // uploadedBytes = a (5MB) + b (40MB), sorted rows are a,b,c,d.
    expect(report.uploadedBytes).toBe(45 * MB);
    expect(report.files.map((f) => [f.status, f.detail])).toEqual([
      ['uploaded', null],
      ['uploaded', null],
      ['skipped', 'dedup'],
      ['failed', 'HTTP 500'],
    ]);
    expect(report.files[1].mediaKind).toBe('video'); // b.mov
  });
});

describe('exportSyncReport', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;
  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sync-export-'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a Summary + Detail workbook with MB sizes and real dates', async () => {
    const s = seed(db);
    const collector = new SyncReportCollector(s.files, s.folders, s.runs);
    driveRun(collector, s);

    const outPath = path.join(tmpDir, 'sync.xlsx');
    await exportSyncReport(collector.build(), outPath);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    expect(wb.worksheets.map((w: { name: string }) => w.name)).toEqual(['Summary', 'Detail']);

    const detail = wb.getWorksheet('Detail')!;
    const headers = (detail.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual([
      'File path', 'Status', 'Detail', 'Size (MB)', 'MIME type', 'Media kind', 'Media item ID', 'SHA-256',
    ]);
    expect(detail.rowCount).toBe(5); // header + 4 files

    // Row 1 (a.jpg): uploaded, 5 MB with #,##0.00.
    const row2 = detail.getRow(2);
    expect(row2.getCell(2).value).toBe('uploaded');
    expect(row2.getCell(4).value).toBe(5);
    expect(row2.getCell(4).numFmt).toBe('#,##0.00');

    // Summary: uploaded size in MB, Started at as a real date.
    const summary = wb.getWorksheet('Summary')!;
    let uploadedMb: number | undefined;
    let uploadedMbFmt: string | undefined;
    let startedIsDate = false;
    let startedFmt: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary.eachRow((r: any) => {
      const label = r.getCell(1).value;
      if (label === 'Uploaded size (MB)') {
        uploadedMb = r.getCell(2).value;
        uploadedMbFmt = r.getCell(2).numFmt;
      }
      if (label === 'Started at') {
        startedIsDate = r.getCell(2).value instanceof Date;
        startedFmt = r.getCell(2).numFmt;
      }
    });
    expect(uploadedMb).toBe(45);
    expect(uploadedMbFmt).toBe('#,##0.00');
    expect(startedIsDate).toBe(true);
    expect(startedFmt).toBe('yyyy-mm-dd hh:mm:ss');
  });
});
