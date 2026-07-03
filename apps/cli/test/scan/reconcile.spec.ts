/**
 * test/scan/reconcile.spec.ts
 *
 * Unit tests for reconcileScan() — diffs a persisted scan snapshot against a
 * live re-enumeration of the same folders, matching by exact size+mtime.
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
import { reconcileScan } from '../../src/scan/reconcile.js';
import type { ScanEngineDeps } from '../../src/scan/scan-engine.js';
import type { MediaMetadata } from '../../src/metadata.js';
import type BetterSqlite3 from 'better-sqlite3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = jest.Mock<(...args: any[]) => any>;

const STUB_META: MediaMetadata = {
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
};

function makeMetadataFn(): AnyFn {
  const fn = jest.fn<(...args: any[]) => any>();
  fn.mockResolvedValue(STUB_META);
  return fn;
}

function writeTmpJpeg(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  return p;
}

describe('reconcileScan', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;
  let folders: FolderRepo;
  let scans: ScanRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-reconcile-'));
    folders = new FolderRepo(db);
    scans = new ScanRepo(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws for an unknown scan ID', () => {
    expect(() => reconcileScan(scans, folders, 999999)).toThrow(/not found/i);
  });

  it('partitions added/removed/modified/unchanged correctly after mutating the folder', async () => {
    // Write 3 files, then run a real ScanEngine.run() to get a snapshot with
    // real on-disk size/mtime.
    writeTmpJpeg(tmpDir, 'keep.jpg');
    writeTmpJpeg(tmpDir, 'remove-me.jpg');
    const modifiedPath = writeTmpJpeg(tmpDir, 'modify-me.jpg');

    const folder = folders.add({ path: tmpDir });
    const settings = new SettingsRepo(db);
    const engine = new ScanEngine({
      scans,
      folders,
      settings,
      metadataFn: makeMetadataFn() as unknown as ScanEngineDeps['metadataFn'],
    });

    const { scanId } = await engine.run({ folderIds: [folder.id], trigger: 'cli' });

    // Mutate the folder on disk:
    // 1. Add a new file not in the snapshot.
    writeTmpJpeg(tmpDir, 'new-file.jpg');

    // 2. Delete one of the original files.
    fs.rmSync(path.join(tmpDir, 'remove-me.jpg'));

    // 3. Modify one of the original files (append bytes changes size; force a
    //    distinct mtime in case the filesystem's resolution is too coarse to
    //    show a natural change within this test's runtime).
    fs.appendFileSync(modifiedPath, Buffer.from([1, 2, 3, 4]));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(modifiedPath, future, future);

    // 4. Leave 'keep.jpg' completely untouched.

    const drift = reconcileScan(scans, folders, scanId);

    expect(drift.scanId).toBe(scanId);
    expect(drift.added.some((p) => p.endsWith('new-file.jpg'))).toBe(true);
    expect(drift.removed.some((p) => p.endsWith('remove-me.jpg'))).toBe(true);
    expect(drift.modified.some((p) => p.endsWith('modify-me.jpg'))).toBe(true);
    expect(drift.unchanged).toBe(1); // keep.jpg

    // Sanity: none of the buckets overlap.
    expect(drift.added).not.toEqual(expect.arrayContaining(drift.removed));
    expect(drift.modified.some((p) => p.endsWith('keep.jpg'))).toBe(false);
    expect(drift.added.some((p) => p.endsWith('keep.jpg'))).toBe(false);
  });

  it('reports unchanged=0, added=0, removed=0, modified=0 for a scan whose folder has vanished', () => {
    const folder = folders.add({ path: tmpDir });
    const scanId = scans.startScan({ trigger: 'cli', folderIds: [folder.id] });
    scans.insertScanFile(scanId, {
      folderId: folder.id,
      filePath: path.join(tmpDir, 'ghost.jpg'),
      sizeBytes: 10,
      mtimeMs: 1000,
      mimeType: 'image/jpeg',
      mediaKind: 'photo',
      hasExif: false,
      hasGps: false,
    });
    scans.finishScan(scanId, scans.computeTotals(scanId));

    // Delete the folder's contents entirely (file present only in the snapshot).
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir); // enumerateFiles still needs the dir to exist

    const drift = reconcileScan(scans, folders, scanId);
    expect(drift.removed).toEqual([path.join(tmpDir, 'ghost.jpg')]);
    expect(drift.added).toEqual([]);
    expect(drift.modified).toEqual([]);
    expect(drift.unchanged).toBe(0);
  });
});
