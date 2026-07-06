/**
 * test/convert/convert-engine.spec.ts
 *
 * Integration-level tests for ConvertEngine using:
 *   - In-memory SQLite DB (openDb(':memory:')) for FolderRepo/SettingsRepo
 *   - Injected convertFn (jest.fn) so no real ffmpeg runs
 *   - Injected detectFn so ffmpeg availability is controllable
 *   - Real temp files enumerated by the REAL enumerateFiles / plan filter
 *
 * Mirrors test/organize/organize-engine.spec.ts.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { ConvertEngine } from '../../src/convert/convert-engine.js';
import { CONVERT_EV } from '../../src/convert/events.js';
import { FfmpegNotFoundError } from '../../src/convert/ffmpeg.js';
import type {
  ConvertFilePayload,
  ConvertProgressPayload,
  ConvertDonePayload,
  ConvertErrorPayload,
} from '../../src/convert/events.js';
import type { ConvertEngineDeps } from '../../src/convert/convert-engine.js';
import type BetterSqlite3 from 'better-sqlite3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = jest.Mock<(...args: any[]) => any>;

function writeTmp(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from('bytes-' + name));
  return p;
}

/** A convertFn stub that writes the target and reports a fixed mode. */
function makeConvertFn(mode: 'remux' | 'reencode' = 'remux'): AnyFn {
  return jest.fn<(...args: any[]) => any>().mockImplementation(async (_src: string, target: string) => {
    fs.writeFileSync(target, 'converted');
    return { mode, bytesIn: 100, bytesOut: 60 };
  });
}

/** A detectFn stub resolving a fixed availability. */
function makeDetectFn(available: boolean): AnyFn {
  return jest.fn<(...args: any[]) => any>().mockResolvedValue({ available, version: available ? '6.1' : undefined });
}

function makeEngine(
  db: BetterSqlite3.Database,
  convertFn: AnyFn,
  detectFn: AnyFn,
): ConvertEngine {
  return new ConvertEngine({
    folders: new FolderRepo(db),
    settings: new SettingsRepo(db),
    convertFn: convertFn as unknown as ConvertEngineDeps['convertFn'],
    detectFn: detectFn as unknown as ConvertEngineDeps['detectFn'],
  });
}

describe('ConvertEngine', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-convert-engine-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('folder enumeration', () => {
    it('converts only non-MP4 videos in a folder, skipping photos and mp4s', async () => {
      writeTmp(tmpDir, 'a.mov');
      writeTmp(tmpDir, 'b.mts');
      writeTmp(tmpDir, 'c.mp4');   // already mp4 — not a source
      writeTmp(tmpDir, 'd.jpg');   // photo — not a video
      const convertFn = makeConvertFn('remux');
      const engine = makeEngine(db, convertFn, makeDetectFn(true));

      const result = await engine.run({ paths: [tmpDir] });

      expect(result.totals.total).toBe(2);
      expect(result.totals.converted).toBe(2);
      expect(result.totals.remuxed).toBe(2);
      expect(convertFn).toHaveBeenCalledTimes(2);
      const converted = convertFn.mock.calls.map((c) => path.basename(String(c[0]))).sort();
      expect(converted).toEqual(['a.mov', 'b.mts']);
    });
  });

  describe('single file input', () => {
    it('converts an explicitly passed video file', async () => {
      const src = writeTmp(tmpDir, 'holiday.MOV');
      const convertFn = makeConvertFn();
      const engine = makeEngine(db, convertFn, makeDetectFn(true));

      const result = await engine.run({ files: [src] });

      expect(result.totals.converted).toBe(1);
      expect(convertFn).toHaveBeenCalledTimes(1);
      const target = path.join(tmpDir, 'holiday.mp4');
      expect(convertFn.mock.calls[0][1]).toBe(target);
    });

    it('rejects a non-video file with a clear error', async () => {
      const src = writeTmp(tmpDir, 'notes.txt');
      const engine = makeEngine(db, makeConvertFn(), makeDetectFn(true));

      let errPayload: ConvertErrorPayload | null = null;
      engine.on(CONVERT_EV.ERROR, (p) => { errPayload = p; });

      await expect(engine.run({ files: [src] })).rejects.toThrow(/Not a convertible video/);
      expect(errPayload).not.toBeNull();
    });
  });

  describe('idempotent skip', () => {
    it('skips a source whose target .mp4 already exists', async () => {
      writeTmp(tmpDir, 'clip.mov');
      writeTmp(tmpDir, 'clip.mp4'); // target already present
      const convertFn = makeConvertFn();
      const engine = makeEngine(db, convertFn, makeDetectFn(true));

      const fileEvents: ConvertFilePayload[] = [];
      engine.on(CONVERT_EV.CONVERT_FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir] });

      expect(result.totals.total).toBe(1); // only clip.mov is a source
      expect(result.totals.skipped).toBe(1);
      expect(result.totals.converted).toBe(0);
      expect(convertFn).not.toHaveBeenCalled();
      expect(fileEvents[0].action).toBe('skip');
    });

    it('overwrite:true converts even when the target exists', async () => {
      writeTmp(tmpDir, 'clip.mov');
      writeTmp(tmpDir, 'clip.mp4');
      const convertFn = makeConvertFn();
      const engine = makeEngine(db, convertFn, makeDetectFn(true));

      const result = await engine.run({ paths: [tmpDir], overwrite: true });

      expect(result.totals.converted).toBe(1);
      expect(convertFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteOriginal', () => {
    it('removes the source after a successful conversion', async () => {
      const src = writeTmp(tmpDir, 'a.mov');
      const convertFn = makeConvertFn();
      const engine = makeEngine(db, convertFn, makeDetectFn(true));

      const result = await engine.run({ files: [src], deleteOriginal: true });

      expect(result.totals.deleted).toBe(1);
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'a.mp4'))).toBe(true);
    });
  });

  describe('dryRun', () => {
    it('counts planned conversions without invoking ffmpeg or detecting it', async () => {
      const src = writeTmp(tmpDir, 'a.mov');
      const convertFn = makeConvertFn();
      const detectFn = makeDetectFn(true);
      const engine = makeEngine(db, convertFn, detectFn);

      const result = await engine.run({ paths: [tmpDir], dryRun: true });

      expect(result.totals.converted).toBe(1);
      expect(convertFn).not.toHaveBeenCalled();
      expect(detectFn).not.toHaveBeenCalled(); // preflight skipped for dry-run
      expect(fs.existsSync(src)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'a.mp4'))).toBe(false);
    });
  });

  describe('events', () => {
    it('emits CONVERT_DONE once and a baseline + final CONVERT_PROGRESS', async () => {
      writeTmp(tmpDir, 'a.mov');
      writeTmp(tmpDir, 'b.avi');
      const engine = makeEngine(db, makeConvertFn(), makeDetectFn(true));

      const done: ConvertDonePayload[] = [];
      const progress: ConvertProgressPayload[] = [];
      engine.on(CONVERT_EV.CONVERT_DONE, (p) => done.push(p));
      engine.on(CONVERT_EV.CONVERT_PROGRESS, (p) => progress.push(p));

      const result = await engine.run({ paths: [tmpDir] });

      expect(done).toHaveLength(1);
      expect(done[0].totals).toEqual(result.totals);
      expect(progress[0]).toEqual({ processed: 0, total: 2 });
      expect(progress.at(-1)).toEqual({ processed: 2, total: 2 });
    });
  });

  describe('ffmpeg preflight', () => {
    it('rejects with FfmpegNotFoundError and emits ERROR when ffmpeg is absent', async () => {
      writeTmp(tmpDir, 'a.mov');
      const engine = makeEngine(db, makeConvertFn(), makeDetectFn(false));

      let errPayload: ConvertErrorPayload | null = null;
      engine.on(CONVERT_EV.ERROR, (p) => { errPayload = p; });

      await expect(engine.run({ paths: [tmpDir] })).rejects.toBeInstanceOf(FfmpegNotFoundError);
      expect(errPayload).not.toBeNull();
      expect((errPayload as unknown as ConvertErrorPayload).message).toMatch(/ffmpeg/i);
    });
  });

  describe('no sources', () => {
    it('rejects when nothing is passed', async () => {
      const engine = makeEngine(db, makeConvertFn(), makeDetectFn(true));
      await expect(engine.run({})).rejects.toThrow(/No sources specified/);
    });
  });
});

void jest;
