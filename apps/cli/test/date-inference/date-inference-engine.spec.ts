/**
 * test/date-inference/date-inference-engine.spec.ts
 *
 * Integration-level tests for DateInferenceEngine, mirroring
 * test/organize/organize-engine.spec.ts's structure:
 *   - In-memory SQLite DB (openDb(':memory:')) for FolderRepo/SettingsRepo
 *   - Mock placementFn/parseFn/writeFn (jest.fn()) so no real EXIF parsing,
 *     filename regex, or ExifTool call is exercised
 *   - Real temp files on the filesystem, walked by the REAL enumerateFiles
 *     code path
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { DateInferenceEngine } from '../../src/date-inference/date-inference-engine.js';
import { DATE_INFERENCE_EV } from '../../src/date-inference/events.js';
import type {
  DateInferenceFilePayload,
  DateInferenceProgressPayload,
  DateInferenceDonePayload,
  DateInferenceErrorPayload,
} from '../../src/date-inference/events.js';
import type { DateInferenceEngineDeps } from '../../src/date-inference/date-inference-engine.js';
import type { FilenameDateMatch } from '../../src/date-inference/filename-date.js';
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

/** A placementFn stub that returns a fixed {capturedAt, hasGps} for every call. */
function makePlacementFn(date: Date | null): AnyFn {
  return jest.fn<(...args: any[]) => any>().mockResolvedValue({ capturedAt: date, hasGps: true });
}

/** A placementFn stub whose return value is looked up per file path. */
function makePlacementFnByPath(
  mapping: (filePath: string) => { capturedAt: Date | null; hasGps: boolean },
): AnyFn {
  const fn = jest.fn<(...args: any[]) => any>();
  fn.mockImplementation(async (filePath: string) => mapping(filePath));
  return fn;
}

function sampleMatch(overrides: Partial<FilenameDateMatch> = {}): FilenameDateMatch {
  return {
    iso: '2015-11-07T13:51:51.000Z',
    year: 2015,
    month: 11,
    day: 7,
    hour: 13,
    minute: 51,
    second: 51,
    hadTime: true,
    pattern: 'timestamp',
    matchedText: '20151107_135151',
    ...overrides,
  };
}

function makeEngine(
  db: BetterSqlite3.Database,
  deps: Partial<Pick<DateInferenceEngineDeps, 'placementFn' | 'parseFn' | 'writeFn'>>,
): { engine: DateInferenceEngine; folders: FolderRepo; settings: SettingsRepo } {
  const folders = new FolderRepo(db);
  const settings = new SettingsRepo(db);

  const engine = new DateInferenceEngine({
    folders,
    settings,
    ...(deps as DateInferenceEngineDeps),
  });

  return { engine, folders, settings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DateInferenceEngine', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-date-inference-engine-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('has_date short-circuit', () => {
    it('marks a file with a resolved capturedAt as has_date and never calls parseFn/writeFn', async () => {
      writeTmpJpeg(tmpDir, 'dated.jpg');
      const placementFn = makePlacementFn(new Date(2020, 0, 1, 12, 0, 0));
      const parseFn = jest.fn<(...args: unknown[]) => unknown>();
      const writeFn = jest.fn<(...args: unknown[]) => unknown>();
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const fileEvents: DateInferenceFilePayload[] = [];
      engine.on(DATE_INFERENCE_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'diagnose' });

      expect(result.totals.hasDate).toBe(1);
      expect(result.totals.total).toBe(1);
      expect(parseFn).not.toHaveBeenCalled();
      expect(writeFn).not.toHaveBeenCalled();
      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0].status).toBe('has_date');
      expect(fileEvents[0].existingCapturedAt).toBe(new Date(2020, 0, 1, 12, 0, 0).toISOString());
    });
  });

  describe('diagnose mode', () => {
    it('records a matched filename as inferred without calling writeFn, and updates byPattern', async () => {
      writeTmpJpeg(tmpDir, '20151107_135151000_iOS.jpg');
      const placementFn = makePlacementFn(null);
      const match = sampleMatch();
      const parseFn = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(match);
      const writeFn = jest.fn<(...args: unknown[]) => unknown>();
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const fileEvents: DateInferenceFilePayload[] = [];
      engine.on(DATE_INFERENCE_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'diagnose' });

      expect(writeFn).not.toHaveBeenCalled();
      expect(result.totals.inferred).toBe(1);
      expect(result.totals.written).toBe(0);
      expect(result.totals.writeFailed).toBe(0);
      expect(result.totals.byPattern.timestamp).toBe(1);

      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0]).toMatchObject({
        status: 'inferred',
        matchedPattern: 'timestamp',
        matchedText: match.matchedText,
        inferredDate: match.iso,
      });
    });
  });

  describe('apply mode', () => {
    it('calls writeFn with (filePath, match) and records status written on ok:true', async () => {
      const filePath = writeTmpJpeg(tmpDir, '20151107_135151000_iOS.jpg');
      const placementFn = makePlacementFn(null);
      const match = sampleMatch();
      const parseFn = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(match);
      const writeFn = jest.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ ok: true });
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const fileEvents: DateInferenceFilePayload[] = [];
      engine.on(DATE_INFERENCE_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'apply' });

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(filePath, match);
      expect(result.totals.written).toBe(1);
      expect(result.totals.writeFailed).toBe(0);
      expect(result.totals.byPattern.timestamp).toBe(1);
      expect(fileEvents[0].status).toBe('written');
    });

    it('records status write_failed and surfaces the error on ok:false', async () => {
      writeTmpJpeg(tmpDir, '20151107_135151000_iOS.jpg');
      const placementFn = makePlacementFn(null);
      const match = sampleMatch();
      const parseFn = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(match);
      const writeFn = jest
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ ok: false, error: 'ExifTool is not available' });
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const fileEvents: DateInferenceFilePayload[] = [];
      engine.on(DATE_INFERENCE_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'apply' });

      expect(result.totals.writeFailed).toBe(1);
      expect(result.totals.written).toBe(0);
      expect(fileEvents[0].status).toBe('write_failed');
      expect(fileEvents[0].error).toBe('ExifTool is not available');
    });
  });

  describe('no_pattern', () => {
    it('marks a file with no existing date and no filename match as no_pattern, never calling writeFn', async () => {
      writeTmpJpeg(tmpDir, 'random-name.jpg');
      const placementFn = makePlacementFn(null);
      const parseFn = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(null);
      const writeFn = jest.fn<(...args: unknown[]) => unknown>();
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const fileEvents: DateInferenceFilePayload[] = [];
      engine.on(DATE_INFERENCE_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'apply' });

      expect(result.totals.noPattern).toBe(1);
      expect(result.totals.inferred).toBe(0);
      expect(writeFn).not.toHaveBeenCalled();
      expect(fileEvents[0].status).toBe('no_pattern');
    });
  });

  describe('per-file error isolation', () => {
    it('counts a file whose placementFn throws as an error but still processes the rest of the batch', async () => {
      writeTmpJpeg(tmpDir, 'a-throws.jpg');
      writeTmpJpeg(tmpDir, 'b-ok.jpg');

      const placementFn = makePlacementFnByPath((filePath) => {
        if (filePath.includes('a-throws')) {
          throw new Error('boom: exif parse failure');
        }
        return { capturedAt: null, hasGps: true };
      });
      const match = sampleMatch();
      const parseFn = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(match);
      const writeFn = jest.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ ok: true });
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const fileEvents: DateInferenceFilePayload[] = [];
      engine.on(DATE_INFERENCE_EV.FILE, (p) => fileEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'apply' });

      expect(result.totals.total).toBe(2);
      expect(result.totals.errors).toBe(1);
      expect(result.totals.written).toBe(1);

      const errorEvent = fileEvents.find((e) => e.status === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error).toMatch(/boom: exif parse failure/);

      const writtenEvent = fileEvents.find((e) => e.status === 'written');
      expect(writtenEvent).toBeDefined();
    });

    it('counts a file whose writeFn throws as an error rather than aborting the run', async () => {
      writeTmpJpeg(tmpDir, 'throws-on-write.jpg');
      const placementFn = makePlacementFn(null);
      const match = sampleMatch();
      const parseFn = jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(match);
      const writeFn = jest
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('unexpected write crash'));
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
        parseFn: parseFn as unknown as DateInferenceEngineDeps['parseFn'],
        writeFn: writeFn as unknown as DateInferenceEngineDeps['writeFn'],
      });

      const result = await engine.run({ paths: [tmpDir], mode: 'apply' });

      expect(result.totals.errors).toBe(1);
      expect(result.totals.written).toBe(0);
      expect(result.totals.writeFailed).toBe(0);
    });
  });

  describe('events', () => {
    it('emits DONE exactly once with totals matching the resolved result, and PROGRESS at least once including the initial baseline', async () => {
      writeTmpJpeg(tmpDir, 'a.jpg');
      writeTmpJpeg(tmpDir, 'b.jpg');
      const placementFn = makePlacementFn(new Date(2020, 0, 1));
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
      });

      const doneEvents: DateInferenceDonePayload[] = [];
      const progressEvents: DateInferenceProgressPayload[] = [];
      engine.on(DATE_INFERENCE_EV.DONE, (p) => doneEvents.push(p));
      engine.on(DATE_INFERENCE_EV.PROGRESS, (p) => progressEvents.push(p));

      const result = await engine.run({ paths: [tmpDir], mode: 'diagnose' });

      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].totals).toEqual(result.totals);

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]).toEqual({ processed: 0, total: 2 });
      expect(progressEvents.at(-1)).toEqual({ processed: 2, total: 2 });
    });
  });

  describe('no target folders', () => {
    it('rejects with "No target folders specified" and emits ERROR when opts is empty (besides mode)', async () => {
      const placementFn = makePlacementFn(null);
      const { engine } = makeEngine(db, {
        placementFn: placementFn as unknown as DateInferenceEngineDeps['placementFn'],
      });

      let errorPayload: DateInferenceErrorPayload | null = null;
      engine.on(DATE_INFERENCE_EV.ERROR, (p) => {
        errorPayload = p;
      });

      await expect(engine.run({ mode: 'diagnose' })).rejects.toThrow(/No target folders specified/);

      expect(errorPayload).not.toBeNull();
      expect((errorPayload as unknown as DateInferenceErrorPayload).message).toMatch(
        /No target folders specified/,
      );
    });
  });
});

void jest;
