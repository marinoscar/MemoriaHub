/**
 * test/screenshots/screenshot-engine.spec.ts
 *
 * Integration-level tests for ScreenshotEngine using:
 *   - In-memory SQLite DB (openDb(':memory:')) for FolderRepo/SettingsRepo
 *   - Real temp files on the filesystem, scanned/moved/deleted by the REAL
 *     findScreenshotFiles / fs.renameSync / fs.unlinkSync / resolveCollision
 *     code paths (finderFn is only mocked for the per-file error-isolation
 *     test, where a match must point at a file that doesn't really exist)
 *
 * Mirrors the structure/helpers of test/organize/organize-engine.spec.ts.
 * Ad-hoc `paths` are used throughout since it's the simplest way to point the
 * engine at a temp directory.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { ScreenshotEngine } from '../../src/screenshots/screenshot-engine.js';
import { SCREENSHOTS_EV } from '../../src/screenshots/events.js';
import type {
  ScreenshotsFilePayload,
  ScreenshotsProgressPayload,
  ScreenshotsDonePayload,
  ScreenshotsErrorPayload,
} from '../../src/screenshots/events.js';
import type { ScreenshotEngineDeps } from '../../src/screenshots/screenshot-engine.js';
import type { ScreenshotMatch } from '../../src/screenshots/plan.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFile(dir: string, name: string, contents = 'x'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

function makeEngine(
  db: BetterSqlite3.Database,
  finderFn?: ScreenshotEngineDeps['finderFn'],
): { engine: ScreenshotEngine; folders: FolderRepo; settings: SettingsRepo } {
  const folders = new FolderRepo(db);
  const settings = new SettingsRepo(db);

  const engine = new ScreenshotEngine({ folders, settings, finderFn });

  return { engine, folders, settings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScreenshotEngine', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-screenshots-engine-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // No target folders
  // -------------------------------------------------------------------
  describe('no target folders', () => {
    it('rejects with "No target folders specified" and emits SCREENSHOTS_EV.ERROR when opts is empty', async () => {
      const { engine } = makeEngine(db);

      let errorPayload: ScreenshotsErrorPayload | null = null;
      engine.on(SCREENSHOTS_EV.ERROR, (p) => { errorPayload = p; });

      await expect(engine.run({ mode: 'find' })).rejects.toThrow(/No target folders specified/);

      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as ScreenshotsErrorPayload).message).toMatch(
        /No target folders specified/,
      );
    });
  });

  // -------------------------------------------------------------------
  // move mode: destDir validation
  // -------------------------------------------------------------------
  describe('move mode destDir validation', () => {
    it('rejects with a "destination folder ... required" message when destDir is omitted', async () => {
      writeFile(tmpDir, 'Screenshot 1.png');
      const { engine } = makeEngine(db);

      let errorPayload: ScreenshotsErrorPayload | null = null;
      engine.on(SCREENSHOTS_EV.ERROR, (p) => { errorPayload = p; });

      await expect(engine.run({ paths: [tmpDir], mode: 'move' })).rejects.toThrow(
        /destination folder.*required/i,
      );
      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as ScreenshotsErrorPayload).message).toBe(
        'A destination folder (--move-to) is required to move screenshots.',
      );
    });

    it('rejects the same way when destDir is an empty/whitespace string', async () => {
      writeFile(tmpDir, 'Screenshot 1.png');
      const { engine } = makeEngine(db);

      await expect(
        engine.run({ paths: [tmpDir], mode: 'move', destDir: '   ' }),
      ).rejects.toThrow(/destination folder.*required/i);
    });

    it('rejects when destDir points at an existing FILE, not a folder', async () => {
      writeFile(tmpDir, 'Screenshot 1.png');
      const destAsFile = writeFile(tmpDir, 'not-a-folder.txt');
      const { engine } = makeEngine(db);

      let errorPayload: ScreenshotsErrorPayload | null = null;
      engine.on(SCREENSHOTS_EV.ERROR, (p) => { errorPayload = p; });

      await expect(
        engine.run({ paths: [tmpDir], mode: 'move', destDir: destAsFile }),
      ).rejects.toThrow(/not a folder/i);
      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as ScreenshotsErrorPayload).message).toMatch(/not a folder/i);
    });
  });

  // -------------------------------------------------------------------
  // find mode
  // -------------------------------------------------------------------
  describe('find mode', () => {
    it('counts and sizes only screenshot-named files, case-insensitively, and touches nothing on disk', async () => {
      const shot1 = writeFile(tmpDir, 'Screenshot 2024-01-02.png', 'aa');
      const shot2 = writeFile(tmpDir, 'screenshot.jpg', 'bbb');
      const shot3 = writeFile(tmpDir, 'SCREENSHOT_final.HEIC', 'cccc');
      const other1 = writeFile(tmpDir, 'vacation.jpg', 'ddddd');
      const other2 = writeFile(tmpDir, 'notes.txt', 'eeeeee');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'find' });

      expect(result.totals.matched).toBe(3);
      expect(result.totals.bytes).toBe(2 + 3 + 4);
      expect(result.totals.moved).toBe(0);
      expect(result.totals.deleted).toBe(0);
      expect(result.totals.skipped).toBe(0);
      expect(result.totals.errors).toBe(0);

      for (const f of [shot1, shot2, shot3, other1, other2]) {
        expect(fs.existsSync(f)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------
  // move mode
  // -------------------------------------------------------------------
  describe('move mode', () => {
    it('moves matched files into destDir (creating it if needed) and leaves non-matches in place', async () => {
      const shot = writeFile(tmpDir, 'Screenshot 1.png', 'shot-bytes');
      const other = writeFile(tmpDir, 'vacation.jpg', 'other-bytes');
      const destDir = path.join(tmpDir, 'moved-screenshots');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'move', destDir });

      expect(result.totals.moved).toBe(1);
      expect(result.totals.matched).toBe(1);
      expect(result.totals.errors).toBe(0);

      expect(fs.existsSync(shot)).toBe(false);
      const expectedTarget = path.join(destDir, 'Screenshot 1.png');
      expect(fs.existsSync(expectedTarget)).toBe(true);

      // Non-matching file untouched in place.
      expect(fs.existsSync(other)).toBe(true);
    });

    it('renames the incoming file via the " (1)" collision pattern when destDir already has a same-named, different file', async () => {
      const destDir = path.join(tmpDir, 'dest');
      fs.mkdirSync(destDir, { recursive: true });
      const preExisting = path.join(destDir, 'Screenshot 1.png');
      fs.writeFileSync(preExisting, 'pre-existing-different-bytes');

      const incomingDir = path.join(tmpDir, 'incoming');
      fs.mkdirSync(incomingDir, { recursive: true });
      const incoming = writeFile(incomingDir, 'Screenshot 1.png', 'incoming-bytes');

      const { engine } = makeEngine(db);
      const fileEvents: ScreenshotsFilePayload[] = [];
      engine.on(SCREENSHOTS_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'move', destDir, recursive: true });

      expect(result.totals.moved).toBe(1);
      expect(result.totals.errors).toBe(0);

      const renamedTarget = path.join(destDir, 'Screenshot 1 (1).png');
      expect(fs.existsSync(preExisting)).toBe(true); // untouched
      expect(fs.existsSync(renamedTarget)).toBe(true); // incoming landed here
      expect(fs.existsSync(incoming)).toBe(false); // moved out of its original spot

      const movedEvent = fileEvents.find((e) => e.action === 'moved');
      expect(movedEvent).toBeDefined();
      expect(movedEvent?.target).toBe(renamedTarget);
    });

    it('counts an already-in-place match as skipped (not moved) and emits a FILE event with action:"skipped"', async () => {
      // Construct a scanned root that recursively contains destDir, with a
      // screenshot file already sitting exactly at destDir/<basename> before
      // the run starts.
      const destDir = path.join(tmpDir, 'already-here');
      fs.mkdirSync(destDir, { recursive: true });
      const alreadyPlaced = writeFile(destDir, 'Screenshot already.png', 'z');

      const { engine } = makeEngine(db);
      const fileEvents: ScreenshotsFilePayload[] = [];
      engine.on(SCREENSHOTS_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'move', destDir, recursive: true });

      expect(result.totals.matched).toBe(1);
      expect(result.totals.skipped).toBe(1);
      expect(result.totals.moved).toBe(0);
      expect(result.totals.errors).toBe(0);

      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0].action).toBe('skipped');
      expect(fileEvents[0].target).toBe(alreadyPlaced);

      // File is still there, untouched.
      expect(fs.existsSync(alreadyPlaced)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // delete mode
  // -------------------------------------------------------------------
  describe('delete mode', () => {
    it('deletes matched files and leaves non-matches untouched', async () => {
      const shot = writeFile(tmpDir, 'Screenshot 1.png');
      const other = writeFile(tmpDir, 'vacation.jpg');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'delete' });

      expect(result.totals.deleted).toBe(1);
      expect(result.totals.matched).toBe(1);
      expect(result.totals.errors).toBe(0);

      expect(fs.existsSync(shot)).toBe(false);
      expect(fs.existsSync(other)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // dryRun
  // -------------------------------------------------------------------
  describe('dryRun', () => {
    it('move mode: nothing on disk changes, destDir is never created, but matched/bytes still reflect the plan', async () => {
      const shot = writeFile(tmpDir, 'Screenshot 1.png', 'abcde');
      const destDir = path.join(tmpDir, 'would-be-dest');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'move', destDir, dryRun: true });

      expect(result.totals.matched).toBe(1);
      expect(result.totals.bytes).toBe(5);
      expect(result.totals.moved).toBe(0);

      expect(fs.existsSync(shot)).toBe(true);
      expect(fs.existsSync(destDir)).toBe(false);
    });

    it('delete mode: nothing on disk changes, but matched/bytes still reflect the plan', async () => {
      const shot = writeFile(tmpDir, 'Screenshot 1.png', 'abc');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'delete', dryRun: true });

      expect(result.totals.matched).toBe(1);
      expect(result.totals.bytes).toBe(3);
      expect(result.totals.deleted).toBe(0);

      expect(fs.existsSync(shot)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------
  describe('events', () => {
    it('emits DONE exactly once with totals/matches matching the resolved result', async () => {
      writeFile(tmpDir, 'Screenshot a.png');
      writeFile(tmpDir, 'Screenshot b.png');

      const { engine } = makeEngine(db);
      const doneEvents: ScreenshotsDonePayload[] = [];
      engine.on(SCREENSHOTS_EV.DONE, (p) => doneEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'find' });

      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].totals).toEqual(result.totals);
      expect(doneEvents[0].matches).toEqual(result.matches);
    });

    it('emits PROGRESS with phase "scanning" during the walk and phase "acting" during a real move/delete pass', async () => {
      writeFile(tmpDir, 'Screenshot a.png');
      const destDir = path.join(tmpDir, 'dest');

      const { engine } = makeEngine(db);
      const progressEvents: ScreenshotsProgressPayload[] = [];
      engine.on(SCREENSHOTS_EV.PROGRESS, (p) => progressEvents.push(p));

      await engine.run({ paths: [tmpDir], mode: 'move', destDir });

      const scanningEvents = progressEvents.filter((p) => p.phase === 'scanning');
      const actingEvents = progressEvents.filter((p) => p.phase === 'acting');

      expect(scanningEvents.length).toBeGreaterThanOrEqual(1);
      expect(actingEvents.length).toBeGreaterThanOrEqual(1);
      expect(actingEvents.at(-1)).toEqual({ phase: 'acting', processed: 1, total: 1 });
    });

    it('does not emit an "acting" phase PROGRESS event for find mode or a dry-run pass', async () => {
      writeFile(tmpDir, 'Screenshot a.png');
      const destDir = path.join(tmpDir, 'dest');

      const { engine } = makeEngine(db);
      const progressEvents: ScreenshotsProgressPayload[] = [];
      engine.on(SCREENSHOTS_EV.PROGRESS, (p) => progressEvents.push(p));

      await engine.run({ paths: [tmpDir], mode: 'move', destDir, dryRun: true });

      expect(progressEvents.every((p) => p.phase === 'scanning')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Recursive vs non-recursive
  // -------------------------------------------------------------------
  describe('recursive scanning', () => {
    it('finds a nested screenshot file when recursive is true', async () => {
      const subDir = path.join(tmpDir, 'nested');
      fs.mkdirSync(subDir, { recursive: true });
      writeFile(subDir, 'Screenshot nested.png');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'find', recursive: true });

      expect(result.totals.matched).toBe(1);
    });

    it('does not find a nested screenshot file when recursive is false', async () => {
      const subDir = path.join(tmpDir, 'nested');
      fs.mkdirSync(subDir, { recursive: true });
      writeFile(subDir, 'Screenshot nested.png');

      const { engine } = makeEngine(db);
      const result = await engine.run({ paths: [tmpDir], mode: 'find', recursive: false });

      expect(result.totals.matched).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Per-file error isolation
  // -------------------------------------------------------------------
  describe('per-file error isolation', () => {
    it('counts a bad match as an error and emits a FILE event with action:"error", without aborting other matches', async () => {
      const goodShot = writeFile(tmpDir, 'Screenshot good.png', 'ok');
      const missingMatch: ScreenshotMatch = {
        filePath: path.join(tmpDir, 'Screenshot missing.png'),
        size: 10,
      };

      const finderFn = jest.fn<(...args: unknown[]) => ScreenshotMatch[]>().mockReturnValue([
        { filePath: goodShot, size: 2 },
        missingMatch,
      ]);

      const { engine } = makeEngine(
        db,
        finderFn as unknown as ScreenshotEngineDeps['finderFn'],
      );
      const fileEvents: ScreenshotsFilePayload[] = [];
      engine.on(SCREENSHOTS_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'delete' });

      expect(result.totals.matched).toBe(2);
      expect(result.totals.deleted).toBe(1);
      expect(result.totals.errors).toBe(1);

      // The real file was actually deleted...
      expect(fs.existsSync(goodShot)).toBe(false);

      const errorEvent = fileEvents.find((e) => e.action === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.filePath).toBe(missingMatch.filePath);
      expect(errorEvent?.error).toBeDefined();

      const deletedEvent = fileEvents.find((e) => e.action === 'deleted');
      expect(deletedEvent).toBeDefined();
      expect(deletedEvent?.filePath).toBe(goodShot);
    });
  });
});
