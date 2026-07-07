/**
 * test/scan/scan-engine.spec.ts
 *
 * Integration-level tests for ScanEngine using:
 *   - In-memory SQLite DB (openDb(':memory:'))
 *   - Mock metadataFn (jest.fn()) so no real EXIF parsing is exercised
 *   - Real temp files on the filesystem (so enumerateFiles / statSync work)
 *
 * Mirrors the structure/helpers of test/sync/sync-engine.spec.ts.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { ScanRepo } from '../../src/repo/scans.js';
import { ScanEngine } from '../../src/scan/scan-engine.js';
import { SCAN_EV } from '../../src/scan/events.js';
import type {
  ScanStartPayload,
  ScanFolderStartPayload,
  ScanFileScannedPayload,
  ScanProgressPayload,
  ScanDonePayload,
  ScanErrorPayload,
} from '../../src/scan/events.js';
import type { ScanEngineDeps } from '../../src/scan/scan-engine.js';
import type { MediaMetadata } from '../../src/metadata.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = jest.Mock<(...args: any[]) => any>;

function writeTmpFile(dir: string, name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function writeTmpJpeg(dir: string, name: string): string {
  return writeTmpFile(dir, name, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
}

function writeTmpMp4(dir: string, name: string): string {
  return writeTmpFile(dir, name, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
}

const PHOTO_META: MediaMetadata = {
  mediaKind: 'photo',
  hasExif: true,
  hasGps: true,
  capturedAt: '2026-01-01T00:00:00.000Z',
  width: 4000,
  height: 3000,
  cameraMake: 'Apple',
  cameraModel: 'iPhone 14',
  takenLat: 30.24,
  takenLng: -95.48,
  error: null,
};

const VIDEO_META: MediaMetadata = {
  mediaKind: 'video',
  hasExif: false,
  hasGps: false,
  capturedAt: null,
  width: null,
  height: null,
  cameraMake: null,
  cameraModel: null,
  takenLat: null,
  takenLng: null,
  error: null,
};

/** Default metadataFn: photos get PHOTO_META, videos get VIDEO_META. */
function makeMetadataFn(overrides?: (filePath: string, mimeType: string) => MediaMetadata | undefined): AnyFn {
  const fn = jest.fn<(...args: any[]) => any>();
  fn.mockImplementation(async (filePath: string, mimeType: string) => {
    if (overrides) {
      const custom = overrides(filePath, mimeType);
      if (custom) return custom;
    }
    return mimeType.startsWith('video/') ? VIDEO_META : PHOTO_META;
  });
  return fn;
}

function makeEngine(
  db: BetterSqlite3.Database,
  metadataFn: AnyFn,
): { engine: ScanEngine; folders: FolderRepo; scans: ScanRepo; settings: SettingsRepo } {
  const folders = new FolderRepo(db);
  const scans = new ScanRepo(db);
  const settings = new SettingsRepo(db);

  const engine = new ScanEngine({
    scans,
    folders,
    settings,
    metadataFn: metadataFn as unknown as ScanEngineDeps['metadataFn'],
  });

  return { engine, folders, scans, settings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScanEngine', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-scan-engine-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('happy path — 2 photos + 1 video', () => {
    it('inserts one scan_files row per supported file', async () => {
      writeTmpJpeg(tmpDir, 'photo1.jpg');
      writeTmpJpeg(tmpDir, 'photo2.jpg');
      writeTmpMp4(tmpDir, 'clip1.mp4');

      const metadataFn = makeMetadataFn();
      const { engine, folders, scans } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      const files = scans.listScanFiles(result.scanId);
      expect(files).toHaveLength(3);
      expect(files.map((f) => path.basename(f.file_path)).sort()).toEqual([
        'clip1.mp4',
        'photo1.jpg',
        'photo2.jpg',
      ]);
    });

    it('rolls up totals on the scans table matching the mocked metadataFn', async () => {
      writeTmpJpeg(tmpDir, 'p1.jpg');
      writeTmpJpeg(tmpDir, 'p2.jpg');
      writeTmpMp4(tmpDir, 'v1.mp4');

      const metadataFn = makeMetadataFn();
      const { engine, folders, scans } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      const scan = scans.getScan(result.scanId)!;
      expect(scan.total_files).toBe(3);
      expect(scan.photo_count).toBe(2);
      expect(scan.video_count).toBe(1);
      expect(scan.exif_count).toBe(2); // both photos have hasExif:true
      expect(scan.gps_count).toBe(2); // both photos have hasGps:true
      expect(scan.status).toBe('complete');
      expect(scan.finished_at).not.toBeNull();

      // total_bytes should be the sum of the on-disk file sizes (real fs.statSync)
      const expectedBytes = ['p1.jpg', 'p2.jpg', 'v1.mp4']
        .map((name) => fs.statSync(path.join(tmpDir, name)).size)
        .reduce((a, b) => a + b, 0);
      expect(scan.total_bytes).toBe(expectedBytes);
    });

    it('emits SCAN_START -> FOLDER_START -> FILE_SCANNED(x3) -> SCAN_PROGRESS -> SCAN_DONE', async () => {
      writeTmpJpeg(tmpDir, 'e1.jpg');
      writeTmpJpeg(tmpDir, 'e2.jpg');
      writeTmpMp4(tmpDir, 'e3.mp4');

      const metadataFn = makeMetadataFn();
      const { engine, folders, scans } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const events: string[] = [];
      let fileScannedCount = 0;
      let donePayload: ScanDonePayload | null = null;

      engine.on(SCAN_EV.SCAN_START, () => events.push(SCAN_EV.SCAN_START));
      engine.on(SCAN_EV.FOLDER_START, () => events.push(SCAN_EV.FOLDER_START));
      engine.on(SCAN_EV.FILE_SCANNED, () => {
        events.push(SCAN_EV.FILE_SCANNED);
        fileScannedCount++;
      });
      engine.on(SCAN_EV.SCAN_PROGRESS, () => events.push(SCAN_EV.SCAN_PROGRESS));
      engine.on(SCAN_EV.SCAN_DONE, (p) => {
        events.push(SCAN_EV.SCAN_DONE);
        donePayload = p;
      });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      // Ordering: start -> folder:start -> (file x3 interleaved with progress) -> done (last)
      expect(events[0]).toBe(SCAN_EV.SCAN_START);
      expect(events[1]).toBe(SCAN_EV.FOLDER_START);
      expect(events.at(-1)).toBe(SCAN_EV.SCAN_DONE);
      expect(fileScannedCount).toBe(3);
      expect(events).toContain(SCAN_EV.SCAN_PROGRESS);

      expect(donePayload).not.toBeNull();
      const done = donePayload as unknown as ScanDonePayload;
      expect(done.scanId).toBe(result.scanId);
      expect(done.totals).toEqual(result.totals);

      const scan = scans.getScan(result.scanId)!;
      expect(done.totals.totalFiles).toBe(scan.total_files);
      expect(done.totals.totalBytes).toBe(scan.total_bytes);
      expect(done.totals.photoCount).toBe(scan.photo_count);
      expect(done.totals.videoCount).toBe(scan.video_count);
      expect(done.totals.exifCount).toBe(scan.exif_count);
      expect(done.totals.gpsCount).toBe(scan.gps_count);
      expect(done.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('SCAN_START payload contains scanId and folderIds', async () => {
      writeTmpJpeg(tmpDir, 'sp1.jpg');

      const metadataFn = makeMetadataFn();
      const { engine, folders } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      let startPayload: ScanStartPayload | null = null;
      engine.on(SCAN_EV.SCAN_START, (p) => { startPayload = p; });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      expect(startPayload).not.toBeNull();
      const sp = startPayload as unknown as ScanStartPayload;
      expect(sp.scanId).toBe(result.scanId);
      expect(sp.folderIds).toEqual([folder.id]);
    });

    it('FOLDER_START payload reports the correct fileCount', async () => {
      writeTmpJpeg(tmpDir, 'fc1.jpg');
      writeTmpJpeg(tmpDir, 'fc2.jpg');

      const metadataFn = makeMetadataFn();
      const { engine, folders } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      let folderStartPayload: ScanFolderStartPayload | null = null;
      engine.on(SCAN_EV.FOLDER_START, (p) => { folderStartPayload = p; });

      await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      expect(folderStartPayload).not.toBeNull();
      const fp = folderStartPayload as unknown as ScanFolderStartPayload;
      expect(fp.folderId).toBe(folder.id);
      expect(fp.path).toBe(folder.path);
      expect(fp.fileCount).toBe(2);
    });

    it('FILE_SCANNED payload carries hasExif/hasGps/error from metadataFn', async () => {
      writeTmpJpeg(tmpDir, 'fs1.jpg');

      const metadataFn = makeMetadataFn();
      const { engine, folders } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const scannedEvents: ScanFileScannedPayload[] = [];
      engine.on(SCAN_EV.FILE_SCANNED, (p) => scannedEvents.push(p));

      await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      expect(scannedEvents).toHaveLength(1);
      expect(scannedEvents[0].mediaKind).toBe('photo');
      expect(scannedEvents[0].hasExif).toBe(true);
      expect(scannedEvents[0].hasGps).toBe(true);
      expect(scannedEvents[0].error).toBeNull();
    });

    it('SCAN_PROGRESS reaches scanned===total at the end', async () => {
      writeTmpJpeg(tmpDir, 'pr1.jpg');
      writeTmpJpeg(tmpDir, 'pr2.jpg');

      const metadataFn = makeMetadataFn();
      const { engine, folders } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const progress: ScanProgressPayload[] = [];
      engine.on(SCAN_EV.SCAN_PROGRESS, (p) => progress.push(p));

      await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      expect(progress.length).toBeGreaterThan(0);
      const final = progress.at(-1)!;
      expect(final.scanned).toBe(2);
      expect(final.total).toBe(2);
    });
  });

  describe('capture date source — EXIF-only, no filesystem fallback', () => {
    it('records captured_at=null and captured_at_source="none" when metadataFn returns capturedAt:null (no fs-timestamp fallback)', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'nodate.jpg');
      // Backdate the file's mtime to a plausible-looking real date so this
      // test would fail loudly if the engine ever reintroduced a filesystem
      // fallback for a null EXIF capture date.
      const oldStamp = new Date('2010-01-01T00:00:00.000Z');
      fs.utimesSync(filePath, oldStamp, oldStamp);

      const metadataFn = makeMetadataFn(() => ({
        mediaKind: 'photo',
        hasExif: false,
        hasGps: false,
        capturedAt: null,
        width: null,
        height: null,
        cameraMake: null,
        cameraModel: null,
        takenLat: null,
        takenLng: null,
        error: null,
      }));
      const { engine, folders, scans } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      const files = scans.listScanFiles(result.scanId);
      expect(files).toHaveLength(1);
      expect(files[0].captured_at).toBeNull();
      expect(files[0].captured_at_source).toBe('none');
    });

    it('records captured_at=<EXIF value> and captured_at_source="exif" when metadataFn returns a capturedAt', async () => {
      writeTmpJpeg(tmpDir, 'dated.jpg');

      const metadataFn = makeMetadataFn(); // default -> PHOTO_META (capturedAt set)
      const { engine, folders, scans } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      const files = scans.listScanFiles(result.scanId);
      expect(files).toHaveLength(1);
      expect(files[0].captured_at).toBe(PHOTO_META.capturedAt);
      expect(files[0].captured_at_source).toBe('exif');
    });
  });

  describe('per-file metadata errors', () => {
    it('still inserts a scan_files row with meta_error set instead of aborting the scan', async () => {
      writeTmpJpeg(tmpDir, 'good.jpg');
      writeTmpJpeg(tmpDir, 'bad.jpg');

      const metadataFn = makeMetadataFn((filePath) => {
        if (filePath.includes('bad.jpg')) {
          return {
            mediaKind: 'photo',
            hasExif: false,
            hasGps: false,
            capturedAt: null,
            width: null,
            height: null,
            cameraMake: null,
            cameraModel: null,
            takenLat: null,
            takenLng: null,
            error: 'boom',
          };
        }
        return undefined;
      });

      const { engine, folders, scans } = makeEngine(db, metadataFn);
      const folder = folders.add({ path: tmpDir });

      const result = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

      const files = scans.listScanFiles(result.scanId);
      expect(files).toHaveLength(2);

      const badRow = files.find((f) => f.file_path.includes('bad.jpg'))!;
      expect(badRow.meta_error).toBe('boom');

      const goodRow = files.find((f) => f.file_path.includes('good.jpg'))!;
      expect(goodRow.meta_error).toBeNull();

      // Scan still completes normally.
      const scan = scans.getScan(result.scanId)!;
      expect(scan.status).toBe('complete');
      expect(scan.total_files).toBe(2);
    });
  });

  describe('fatal errors', () => {
    it('rejects and emits SCAN_EV.ERROR when neither folderIds nor all is set', async () => {
      const metadataFn = makeMetadataFn();
      const { engine } = makeEngine(db, metadataFn);

      let errorPayload: ScanErrorPayload | null = null;
      engine.on(SCAN_EV.ERROR, (p) => { errorPayload = p; });

      await expect(engine.run({ trigger: 'cli' })).rejects.toThrow(
        /No target folders specified/,
      );

      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as ScanErrorPayload).message).toMatch(/No target folders specified/);
    });

    it('rejects and emits SCAN_EV.ERROR when all=true but no enabled folders exist', async () => {
      const metadataFn = makeMetadataFn();
      const { engine } = makeEngine(db, metadataFn);

      let errorPayload: ScanErrorPayload | null = null;
      engine.on(SCAN_EV.ERROR, (p) => { errorPayload = p; });

      await expect(engine.run({ trigger: 'cli', all: true })).rejects.toThrow(
        /No enabled folders found/,
      );

      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as ScanErrorPayload).message).toMatch(/No enabled folders found/);
    });
  });
});
