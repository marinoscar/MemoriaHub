/**
 * test/organize/organize-engine.spec.ts
 *
 * Integration-level tests for OrganizeEngine using:
 *   - In-memory SQLite DB (openDb(':memory:')) for FolderRepo/SettingsRepo
 *   - Mock placementFn (jest.fn()) so no real EXIF parsing is exercised
 *   - Real temp files on the filesystem, moved by the REAL enumerateFiles /
 *     fs.renameSync / resolveCollision code paths
 *
 * Mirrors the structure/helpers of test/scan/scan-engine.spec.ts. Ad-hoc
 * `paths` are used throughout (rather than registering folders) since it is
 * the simplest way to point the engine at a temp directory.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { OrganizeEngine } from '../../src/organize/organize-engine.js';
import { ORGANIZE_EV } from '../../src/organize/events.js';
import type {
  OrganizeFilePayload,
  OrganizeProgressPayload,
  OrganizeDonePayload,
  OrganizeErrorPayload,
} from '../../src/organize/events.js';
import type { OrganizeEngineDeps } from '../../src/organize/organize-engine.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = jest.Mock<(...args: any[]) => any>;

function writeTmpJpeg(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  return p;
}

/** Mirrors writeTmpJpeg but writes a .mov file — content is irrelevant since
 * placementFn is a stub in these tests (no real ffprobe/EXIF parsing runs). */
function writeTmpVideo(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
  return p;
}

/** A placementFn stub that returns a fixed {capturedAt, hasGps} for every call. */
function makePlacementFn(date: Date | null, hasGps: boolean): AnyFn {
  return jest.fn<(...args: any[]) => any>().mockResolvedValue({ capturedAt: date, hasGps });
}

/** A placementFn stub whose return value is looked up per file path. */
function makePlacementFnByPath(
  mapping: (filePath: string) => { capturedAt: Date | null; hasGps: boolean },
): AnyFn {
  const fn = jest.fn<(...args: any[]) => any>();
  fn.mockImplementation(async (filePath: string) => mapping(filePath));
  return fn;
}

function makeEngine(
  db: BetterSqlite3.Database,
  placementFn: AnyFn,
): { engine: OrganizeEngine; folders: FolderRepo; settings: SettingsRepo } {
  const folders = new FolderRepo(db);
  const settings = new SettingsRepo(db);

  const engine = new OrganizeEngine({
    folders,
    settings,
    placementFn: placementFn as unknown as OrganizeEngineDeps['placementFn'],
  });

  return { engine, folders, settings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrganizeEngine', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-organize-engine-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('move to bucket', () => {
    it('moves a dated photo (with GPS) into YEAR/MM - Month/ and updates totals', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'vacation.jpg');
      const placementFn = makePlacementFn(new Date(2023, 6, 15, 12, 0, 0), true);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      expect(fs.existsSync(filePath)).toBe(false);
      const expectedTarget = path.join(tmpDir, '2023', '07 - July', 'vacation.jpg');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      expect(result.totals.moved).toBe(1);
      expect(result.totals.total).toBe(1);
      expect(result.totals.skipped).toBe(0);
      expect(result.totals.conflicts).toBe(0);
      expect(result.totals.errors).toBe(0);
      expect(result.totals.nodate).toBe(0);
      expect(result.totals.noGps).toBe(0);
      expect(result.totals.byBucket['2023/07 - July']).toBe(1);

      // placementFn is always invoked with {full: true}.
      expect(placementFn).toHaveBeenCalledWith(filePath, 'image/jpeg', { full: true });
    });
  });

  describe('NODATE bucket', () => {
    it('routes an undated file (with GPS) into NODATE/ and increments totals.nodate only', async () => {
      writeTmpJpeg(tmpDir, 'unknown.jpg');
      const placementFn = makePlacementFn(null, true);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      const expectedTarget = path.join(tmpDir, 'NODATE', 'unknown.jpg');
      expect(fs.existsSync(expectedTarget)).toBe(true);
      expect(result.totals.moved).toBe(1);
      expect(result.totals.nodate).toBe(1);
      expect(result.totals.noGps).toBe(0);
      expect(result.totals.byBucket['NODATE']).toBe(1);
    });
  });

  describe('NO-GPS routing', () => {
    it('routes a dated photo with no GPS into YEAR/MM - Month/NO-GPS/ and increments totals.noGps', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'no-gps.jpg');
      const placementFn = makePlacementFn(new Date(2023, 6, 15, 12, 0, 0), false);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      expect(fs.existsSync(filePath)).toBe(false);
      const expectedTarget = path.join(tmpDir, '2023', '07 - July', 'NO-GPS', 'no-gps.jpg');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      expect(result.totals.moved).toBe(1);
      expect(result.totals.nodate).toBe(0);
      expect(result.totals.noGps).toBe(1);
      expect(result.totals.byBucket['2023/07 - July/NO-GPS']).toBe(1);
    });

    it('routes an undated photo with no GPS into NODATE/NO-GPS/ and increments both totals.nodate and totals.noGps', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'no-date-no-gps.jpg');
      const placementFn = makePlacementFn(null, false);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      expect(fs.existsSync(filePath)).toBe(false);
      const expectedTarget = path.join(tmpDir, 'NODATE', 'NO-GPS', 'no-date-no-gps.jpg');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      expect(result.totals.moved).toBe(1);
      expect(result.totals.nodate).toBe(1);
      expect(result.totals.noGps).toBe(1);
      expect(result.totals.byBucket['NODATE/NO-GPS']).toBe(1);
    });

    it('routes an undated photo WITH GPS into NODATE/ (not nested under NO-GPS) — totals.nodate only', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'no-date-has-gps.jpg');
      const placementFn = makePlacementFn(null, true);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      expect(fs.existsSync(filePath)).toBe(false);
      const expectedTarget = path.join(tmpDir, 'NODATE', 'no-date-has-gps.jpg');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      expect(result.totals.moved).toBe(1);
      expect(result.totals.nodate).toBe(1);
      expect(result.totals.noGps).toBe(0);
      expect(result.totals.byBucket['NODATE']).toBe(1);
    });
  });

  describe('idempotent skip', () => {
    it('skips a file already sitting at its correct bucket path on a second run', async () => {
      writeTmpJpeg(tmpDir, 'repeat.jpg');
      const fixedDate = new Date(2024, 2, 10, 9, 0, 0); // March 10, 2024
      const placementFn = makePlacementFn(fixedDate, true);
      const { engine: firstEngine } = makeEngine(db, placementFn);

      const firstResult = await firstEngine.run({ paths: [tmpDir] });
      expect(firstResult.totals.moved).toBe(1);

      const bucketedPath = path.join(tmpDir, '2024', '03 - March', 'repeat.jpg');
      expect(fs.existsSync(bucketedPath)).toBe(true);

      // Second run over the SAME root: the file now lives one level down inside
      // 2024/03 - March/, so `recursive: true` is required for enumerateFiles to
      // find it at all. bucketFor(fixedDate, true) still resolves to that same
      // sub-path, so it should be recognized as already-in-place and skipped
      // rather than re-moved.
      const { engine: secondEngine } = makeEngine(db, placementFn);
      const fileEvents: OrganizeFilePayload[] = [];
      secondEngine.on(ORGANIZE_EV.ORGANIZE_FILE, (p) => fileEvents.push(p));

      const secondResult = await secondEngine.run({ paths: [tmpDir], recursive: true });

      expect(secondResult.totals.total).toBe(1);
      expect(secondResult.totals.skipped).toBe(1);
      expect(secondResult.totals.moved).toBe(0);
      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0].action).toBe('skip');
      expect(fileEvents[0].target).toBe(bucketedPath);

      // File is still there, untouched.
      expect(fs.existsSync(bucketedPath)).toBe(true);
    });
  });

  describe('dryRun', () => {
    it('leaves the source file untouched while still reporting planned moves', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'preview.jpg');
      const placementFn = makePlacementFn(new Date(2022, 4, 5, 8, 0, 0), true); // May 2022
      const { engine } = makeEngine(db, placementFn);

      const fileEvents: OrganizeFilePayload[] = [];
      engine.on(ORGANIZE_EV.ORGANIZE_FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], dryRun: true });

      // Nothing was actually moved on disk.
      expect(fs.existsSync(filePath)).toBe(true);
      const wouldBeTarget = path.join(tmpDir, '2022', '05 - May', 'preview.jpg');
      expect(fs.existsSync(wouldBeTarget)).toBe(false);

      // Per src/organize/organize-engine.ts: totals.moved is incremented and an
      // ORGANIZE_FILE event with action:'move' fires in dryRun mode too — only
      // the fs.mkdirSync/fs.renameSync calls are skipped. Verified against the
      // actual engine source (not assumed).
      expect(result.totals.moved).toBe(1);
      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0].action).toBe('move');
      expect(fileEvents[0].target).toBe(wouldBeTarget);
    });
  });

  describe('conflict rename', () => {
    it('renames the incoming file when a different file already occupies its bucket path', async () => {
      // Pre-create a file that already sits at the destination bucket path,
      // with content different from the incoming source file — a genuine
      // collision (not the idempotent "already in place" case).
      const bucketDir = path.join(tmpDir, '2021', '09 - September');
      fs.mkdirSync(bucketDir, { recursive: true });
      const preExisting = path.join(bucketDir, 'photo.jpg');
      fs.writeFileSync(preExisting, 'pre-existing-bytes-different-identity');

      // The incoming source file lives elsewhere in the root, with the SAME
      // basename, and placementFn buckets it into the same target folder.
      const incomingDir = path.join(tmpDir, 'incoming');
      fs.mkdirSync(incomingDir, { recursive: true });
      const incoming = writeTmpJpeg(incomingDir, 'photo.jpg');

      // Every walked file (both the pre-existing one and the incoming one)
      // buckets to the same September 2021 folder, so the pre-existing file
      // resolves as "already in place" (skip) while the incoming file hits a
      // genuine collision against it and gets renamed.
      const placementFn = makePlacementFn(new Date(2021, 8, 1, 10, 0, 0), true);
      const { engine } = makeEngine(db, placementFn);

      const fileEvents: OrganizeFilePayload[] = [];
      engine.on(ORGANIZE_EV.ORGANIZE_FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], recursive: true });

      // Both the walked pre-existing file (already in its correct bucket, so
      // skipped) and the incoming file (renamed on conflict) are accounted for.
      expect(result.totals.total).toBe(2);
      expect(result.totals.conflicts).toBe(1);

      const renamedTarget = path.join(bucketDir, 'photo (1).jpg');
      expect(fs.existsSync(preExisting)).toBe(true); // untouched
      expect(fs.existsSync(renamedTarget)).toBe(true); // incoming file landed here
      expect(fs.existsSync(incoming)).toBe(false); // moved out of its original spot

      const conflictEvent = fileEvents.find((e) => e.action === 'conflict-rename');
      expect(conflictEvent).toBeDefined();
      expect(conflictEvent?.target).toBe(renamedTarget);
    });
  });

  describe('events', () => {
    it('emits ORGANIZE_DONE exactly once with totals matching the resolved result, and ORGANIZE_PROGRESS at least once including the initial baseline', async () => {
      writeTmpJpeg(tmpDir, 'a.jpg');
      writeTmpJpeg(tmpDir, 'b.jpg');
      const placementFn = makePlacementFn(new Date(2020, 0, 1), true);
      const { engine } = makeEngine(db, placementFn);

      const doneEvents: OrganizeDonePayload[] = [];
      const progressEvents: OrganizeProgressPayload[] = [];
      engine.on(ORGANIZE_EV.ORGANIZE_DONE, (p) => doneEvents.push(p));
      engine.on(ORGANIZE_EV.ORGANIZE_PROGRESS, (p) => progressEvents.push(p));

      const result = await engine.run({ paths: [tmpDir] });

      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].totals).toEqual(result.totals);

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      // The very first progress event is the {processed: 0, total} baseline
      // emitted before any file is processed.
      expect(progressEvents[0]).toEqual({ processed: 0, total: 2 });
      // The final progress event reaches processed === total.
      expect(progressEvents.at(-1)).toEqual({ processed: 2, total: 2 });
    });
  });

  describe('no target folders', () => {
    it('rejects with "No target folders specified" and emits ORGANIZE_EV.ERROR when opts is empty', async () => {
      const placementFn = makePlacementFn(null, true);
      const { engine } = makeEngine(db, placementFn);

      let errorPayload: OrganizeErrorPayload | null = null;
      engine.on(ORGANIZE_EV.ERROR, (p) => { errorPayload = p; });

      await expect(engine.run({})).rejects.toThrow(/No target folders specified/);

      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as OrganizeErrorPayload).message).toMatch(
        /No target folders specified/,
      );
    });
  });

  describe('video placement (ffprobe-backed)', () => {
    it('moves a video with a placementFn-supplied date+GPS into YEAR/MM - Month/ (not NODATE)', async () => {
      const filePath = writeTmpVideo(tmpDir, 'clip.mov');
      const placementFn = makePlacementFn(new Date(2023, 5, 20, 20, 16, 7), true);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      expect(fs.existsSync(filePath)).toBe(false);
      const expectedTarget = path.join(tmpDir, '2023', '06 - June', 'clip.mov');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      expect(result.totals.byBucket['2023/06 - June']).toBe(1);
      expect(result.totals.nodate).toBe(0);

      // mimeType is resolved by extension via enumerateFiles: mov -> video/quicktime.
      expect(placementFn).toHaveBeenCalledWith(filePath, 'video/quicktime', { full: true });
    });

    it('routes a video with no ffprobe metadata (capturedAt: null, hasGps: false) into NODATE/NO-GPS/', async () => {
      const filePath = writeTmpVideo(tmpDir, 'no-metadata.mov');
      const placementFn = makePlacementFn(null, false);
      const { engine } = makeEngine(db, placementFn);

      const result = await engine.run({ paths: [tmpDir] });

      expect(fs.existsSync(filePath)).toBe(false);
      const expectedTarget = path.join(tmpDir, 'NODATE', 'NO-GPS', 'no-metadata.mov');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      expect(result.totals.nodate).toBe(1);
      expect(result.totals.noGps).toBe(1);
      expect(result.totals.byBucket['NODATE/NO-GPS']).toBe(1);
    });
  });
});
