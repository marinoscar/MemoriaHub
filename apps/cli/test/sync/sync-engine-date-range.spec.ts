/**
 * test/sync/sync-engine-date-range.spec.ts
 *
 * Tests for the capture-date range filter (`fromMs`/`toMs` on SyncOptions) in
 * the SyncEngine work-set build loop (src/sync/sync-engine.ts).
 *
 * Harness: mirrors test/sync/sync-engine.spec.ts — in-memory SQLite
 * (openDb(':memory:')), a mock ApiClient, and injectable uploadFn/hashFn —
 * plus REAL temp files on disk so enumerateFiles() / fs.statSync() work
 * unmodified (files.js is NOT mocked).
 *
 * SyncEngine has no DI hook for `resolveCapturedAt` (unlike uploadFn/hashFn),
 * so controlling capture dates per file requires mocking src/metadata.js.
 * Under ESM with --experimental-vm-modules, static jest.mock() does not
 * intercept relative imports, so we use jest.unstable_mockModule + dynamic
 * import (after the mock is registered) — the same pattern already used in
 * test/manifest.spec.ts and test/tui/login-screen.spec.tsx.
 *
 * IMPORTANT — resolveCapturedAt has TWO call sites in sync-engine.ts:
 *   1. The work-set build loop, gated by `dateFilterActive` (the guard this
 *      file is chiefly about).
 *   2. The worker's register step, which resolves capturedAt/originalCreatedAt
 *      to attach to POST /api/media — unrelated to date filtering, and it
 *      always runs for a normal upload regardless of whether a range filter
 *      is active (it reuses the build-phase result via captureDateCache when
 *      available, otherwise resolves fresh).
 * Because of call site #2, asserting "resolveCapturedAt was never called"
 * against an ordinary successful upload can NOT prove the build-phase guard
 * — call site #2 will always fire once. To isolate the guard, the
 * no-filter-call-count tests below use a DEDUP HIT, which short-circuits the
 * worker before it ever reaches the register step (see the dedup tests at
 * the bottom of this file for the reasoning spelled out again inline).
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ResolvedCaptureDate } from '../../src/metadata.js';
import type {
  FileSkippedPayload,
  FileQueuedPayload,
  FileDonePayload,
} from '../../src/sync/events.js';
import type { SyncEngineDeps } from '../../src/sync/sync-engine.js';
import type { ApiClient } from '../../src/api.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Mock metadata.js's resolveCapturedAt — controllable per absolute file path.
// Everything else (enumerateFiles, repos, DB) is real.
// ---------------------------------------------------------------------------

const capturedAtByPath = new Map<string, ResolvedCaptureDate>();

const resolveCapturedAtMock = jest.fn(
  async (filePath: string, _mimeType: string): Promise<ResolvedCaptureDate> =>
    capturedAtByPath.get(filePath) ?? {
      capturedAt: null,
      source: 'none',
      originalCreatedAt: null,
    },
);

jest.unstable_mockModule('../../src/metadata.js', () => ({
  resolveCapturedAt: resolveCapturedAtMock,
  readMediaMetadata: jest.fn(),
  oldestFileTimestamp: jest.fn(),
}));

// Dynamic imports AFTER jest.unstable_mockModule so the mock is applied.
const { openDb } = await import('../../src/db/database.js');
const { FolderRepo } = await import('../../src/repo/folders.js');
const { FileRepo } = await import('../../src/repo/files.js');
const { RunRepo } = await import('../../src/repo/runs.js');
const { SettingsRepo } = await import('../../src/repo/settings.js');
const { SyncEngine } = await import('../../src/sync/sync-engine.js');
const { EV } = await import('../../src/sync/events.js');

// ---------------------------------------------------------------------------
// Helpers (mirrors test/sync/sync-engine.spec.ts)
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = jest.Mock<(...args: any[]) => any>;

/** Return a jest mock that resolves with `value`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockResolving(value: any): AnyFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = jest.fn<(...args: any[]) => any>();
  fn.mockResolvedValue(value);
  return fn;
}

/** Create a minimal mock ApiClient with overrideable get/post stubs. */
function makeApi(overrides: { get?: AnyFn; post?: AnyFn } = {}): ApiClient {
  return {
    get:    overrides.get  ?? mockResolving({ items: [] }),
    post:   overrides.post ?? mockResolving({ id: 'media-default' }),
    putRaw: mockResolving('etag'),
  } as unknown as ApiClient;
}

function makeUploadFn(objectId = 'obj-default'): AnyFn {
  return mockResolving({ objectId });
}

function makeHashFn(fixedHash = 'deadbeefdeadbeef'): AnyFn {
  return mockResolving(fixedHash);
}

/** Write a real temp file (JPEG header) so statSync and enumerateFiles work. */
function writeTmpJpeg(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  return p;
}

/** Build a SyncEngine with in-memory repos. Returns engine + repos for inspection. */
function makeEngine(
  db: BetterSqlite3.Database,
  apiOverrides: { get?: AnyFn; post?: AnyFn } = {},
  uploadFn?: AnyFn,
  hashFn?: AnyFn,
): {
  engine: InstanceType<typeof SyncEngine>;
  folders: InstanceType<typeof FolderRepo>;
  files: InstanceType<typeof FileRepo>;
  runs: InstanceType<typeof RunRepo>;
  settings: InstanceType<typeof SettingsRepo>;
  api: ApiClient;
  uploadFn: AnyFn;
  hashFn: AnyFn;
} {
  const folders = new FolderRepo(db);
  const files = new FileRepo(db);
  const runs = new RunRepo(db);
  const settings = new SettingsRepo(db);
  const api = makeApi(apiOverrides);
  const upload = uploadFn ?? makeUploadFn();
  const hash = hashFn ?? makeHashFn();

  const engine = new SyncEngine({
    api,
    folders,
    files,
    runs,
    settings,
    uploadFn: upload as unknown as SyncEngineDeps['uploadFn'],
    hashFn: hash as unknown as SyncEngineDeps['hashFn'],
  });

  return { engine, folders, files, runs, settings, api, uploadFn: upload, hashFn: hash };
}

const IN_RANGE_FROM_MS = Date.parse('2024-01-01T00:00:00.000Z');
const IN_RANGE_TO_MS = Date.parse('2024-12-31T23:59:59.999Z');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncEngine — capture-date range filter', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-engine-daterange-'));
    capturedAtByPath.clear();
    resolveCapturedAtMock.mockClear();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // In-range file: queued and uploaded, not skipped
  // -------------------------------------------------------------------------

  it('queues and uploads a file whose resolved capture date falls within [fromMs, toMs]', async () => {
    const filePath = writeTmpJpeg(tmpDir, 'in-range.jpg');
    capturedAtByPath.set(filePath, {
      capturedAt: '2024-06-15T12:00:00.000Z',
      source: 'exif',
      originalCreatedAt: null,
    });

    const ctx = makeEngine(
      db,
      { get: mockResolving({ items: [] }), post: mockResolving({ id: 'media-in-range' }) },
      makeUploadFn('obj-in-range'),
    );
    const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

    const skipped: FileSkippedPayload[] = [];
    const done: FileDonePayload[] = [];
    ctx.engine.on(EV.FILE_SKIPPED, (p) => skipped.push(p));
    ctx.engine.on(EV.FILE_DONE, (p) => done.push(p));

    await ctx.engine.run({
      trigger: 'cli',
      folderIds: [folder.id],
      fromMs: IN_RANGE_FROM_MS,
      toMs: IN_RANGE_TO_MS,
    });

    expect(skipped.some((s) => s.reason === 'out_of_range')).toBe(false);
    expect(done).toHaveLength(1);
    expect(ctx.uploadFn).toHaveBeenCalledTimes(1);

    const rec = ctx.files.listByFolder(folder.id)[0];
    expect(rec.status).toBe('uploaded');
  });

  // -------------------------------------------------------------------------
  // Out-of-range file: FILE_SKIPPED reason=out_of_range, never queued/uploaded
  // -------------------------------------------------------------------------

  it('skips an out-of-range file with reason=out_of_range and never queues or uploads it', async () => {
    const filePath = writeTmpJpeg(tmpDir, 'out-of-range.jpg');
    capturedAtByPath.set(filePath, {
      capturedAt: '2020-01-01T00:00:00.000Z',
      source: 'exif',
      originalCreatedAt: null,
    });

    const ctx = makeEngine(db, { get: mockResolving({ items: [] }) }, makeUploadFn());
    const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

    const skipped: FileSkippedPayload[] = [];
    const queued: FileQueuedPayload[] = [];
    ctx.engine.on(EV.FILE_SKIPPED, (p) => skipped.push(p));
    ctx.engine.on(EV.FILE_QUEUED, (p) => queued.push(p));

    await ctx.engine.run({
      trigger: 'cli',
      folderIds: [folder.id],
      fromMs: IN_RANGE_FROM_MS,
      toMs: IN_RANGE_TO_MS,
    });

    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('out_of_range');
    expect(queued).toHaveLength(0);
    expect(ctx.uploadFn).not.toHaveBeenCalled();

    const rec = ctx.files.listByFolder(folder.id)[0];
    expect(rec.status).not.toBe('uploaded');
  });

  // -------------------------------------------------------------------------
  // Undated file (capturedAt: null) while a range is active
  // -------------------------------------------------------------------------

  it('treats a file with capturedAt=null as out_of_range while a range filter is active', async () => {
    const filePath = writeTmpJpeg(tmpDir, 'undated.jpg');
    capturedAtByPath.set(filePath, { capturedAt: null, source: 'none', originalCreatedAt: null });

    const ctx = makeEngine(db, { get: mockResolving({ items: [] }) }, makeUploadFn());
    const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

    const skipped: FileSkippedPayload[] = [];
    ctx.engine.on(EV.FILE_SKIPPED, (p) => skipped.push(p));

    await ctx.engine.run({
      trigger: 'cli',
      folderIds: [folder.id],
      fromMs: IN_RANGE_FROM_MS,
      toMs: IN_RANGE_TO_MS,
    });

    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('out_of_range');
    expect(ctx.uploadFn).not.toHaveBeenCalled();

    const rec = ctx.files.listByFolder(folder.id)[0];
    expect(rec.status).not.toBe('uploaded');
  });

  // -------------------------------------------------------------------------
  // Unchanged fast-skip wins over the date filter
  // -------------------------------------------------------------------------

  it('lets the unchanged fast-skip win over an active date filter, without consulting resolveCapturedAt', async () => {
    const filePath = writeTmpJpeg(tmpDir, 'stable.jpg');
    const size = fs.statSync(filePath).size;

    const seedCtx = makeEngine(db);
    const folder = seedCtx.folders.add({ path: tmpDir, circleId: 'test-circle' });
    // Pre-seed as already uploaded with matching size — simulates a prior successful sync.
    seedCtx.files.upsert(folder.id, filePath, {
      status: 'uploaded',
      size_bytes: size,
      mime_type: 'image/jpeg',
    });

    // Deliberately leave this path unregistered in capturedAtByPath. If the
    // unchanged check did NOT run first, the engine would fall through to the
    // date-range check, call the mock (default fallback capturedAt: null),
    // and mis-skip this file as out_of_range instead of unchanged.
    resolveCapturedAtMock.mockClear();

    const ctx = makeEngine(db, { get: mockResolving({ items: [] }) }, makeUploadFn());

    const skipped: FileSkippedPayload[] = [];
    ctx.engine.on(EV.FILE_SKIPPED, (p) => skipped.push(p));

    await ctx.engine.run({
      trigger: 'cli',
      folderIds: [folder.id],
      fromMs: IN_RANGE_FROM_MS,
      toMs: IN_RANGE_TO_MS,
    });

    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('unchanged');
    expect(resolveCapturedAtMock).not.toHaveBeenCalled();
    expect(ctx.uploadFn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Re-process guarantee: a later unfiltered run picks up the skipped file
  // -------------------------------------------------------------------------

  it('re-processes a previously out-of-range file on a later unfiltered run (skipped -> uploaded)', async () => {
    const filePath = writeTmpJpeg(tmpDir, 'reprocess.jpg');
    capturedAtByPath.set(filePath, {
      capturedAt: '2020-05-05T00:00:00.000Z',
      source: 'exif',
      originalCreatedAt: null,
    });

    // First run — filtered — the file is out of range and left un-uploaded.
    const ctx1 = makeEngine(db, { get: mockResolving({ items: [] }) }, makeUploadFn('obj-1'));
    const folder = ctx1.folders.add({ path: tmpDir, circleId: 'test-circle' });

    const skipped1: FileSkippedPayload[] = [];
    ctx1.engine.on(EV.FILE_SKIPPED, (p) => skipped1.push(p));

    await ctx1.engine.run({
      trigger: 'cli',
      folderIds: [folder.id],
      fromMs: IN_RANGE_FROM_MS,
      toMs: IN_RANGE_TO_MS,
    });

    expect(skipped1).toHaveLength(1);
    expect(skipped1[0].reason).toBe('out_of_range');
    expect(ctx1.uploadFn).not.toHaveBeenCalled();

    const afterFirstRun = ctx1.files.listByFolder(folder.id)[0];
    expect(afterFirstRun.status).not.toBe('uploaded');

    // Second run — same DB/file, same (still stale) capturedAt, but NO range —
    // the file must be picked back up and uploaded.
    const ctx2 = makeEngine(
      db,
      { get: mockResolving({ items: [] }), post: mockResolving({ id: 'media-reprocess' }) },
      makeUploadFn('obj-2'),
    );

    const done2: FileDonePayload[] = [];
    ctx2.engine.on(EV.FILE_DONE, (p) => done2.push(p));

    await ctx2.engine.run({ trigger: 'cli', folderIds: [folder.id] });

    expect(done2).toHaveLength(1);
    expect(ctx2.uploadFn).toHaveBeenCalledTimes(1);

    const afterSecondRun = ctx2.files.listByFolder(folder.id)[0];
    expect(afterSecondRun.status).toBe('uploaded');
  });

  // -------------------------------------------------------------------------
  // dateFilterActive gate — build-phase call-site isolation via dedup hits
  // -------------------------------------------------------------------------
  //
  // See the file header comment: resolveCapturedAt has a second call site (the
  // register step) that always fires for a normal successful upload regardless
  // of filter state, so it cannot be used to prove the build-phase guard on
  // its own. A dedup hit short-circuits the worker BEFORE the register step,
  // so any call recorded against the mock in these two tests can only have
  // come from the build-phase `if (dateFilterActive)` gate.

  describe('dateFilterActive gate (isolated via dedup short-circuit)', () => {
    it('does NOT call resolveCapturedAt at all when no range is active (dedup hit)', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'dedup-no-filter.jpg');
      // No entry registered in capturedAtByPath for this path — if the gate
      // were broken and the mock got called, its fallback would still not
      // throw, but the assertion below on call count would fail either way.
      resolveCapturedAtMock.mockClear();

      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [{ id: 'existing-media', contentHash: 'deadbeefdeadbeef' }] }) },
        makeUploadFn(),
        makeHashFn('deadbeefdeadbeef'),
      );
      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const skipped: FileSkippedPayload[] = [];
      ctx.engine.on(EV.FILE_SKIPPED, (p) => skipped.push(p));

      // No fromMs/toMs at all — dateFilterActive must be false.
      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(skipped).toHaveLength(1);
      expect(skipped[0].reason).toBe('dedup');
      expect(resolveCapturedAtMock).not.toHaveBeenCalled();
    });

    it('DOES call resolveCapturedAt exactly once when a range is active (positive control, dedup hit)', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'dedup-with-filter.jpg');
      capturedAtByPath.set(filePath, {
        capturedAt: '2024-06-15T12:00:00.000Z',
        source: 'exif',
        originalCreatedAt: null,
      });
      resolveCapturedAtMock.mockClear();

      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [{ id: 'existing-media', contentHash: 'deadbeefdeadbeef' }] }) },
        makeUploadFn(),
        makeHashFn('deadbeefdeadbeef'),
      );
      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const skipped: FileSkippedPayload[] = [];
      ctx.engine.on(EV.FILE_SKIPPED, (p) => skipped.push(p));

      await ctx.engine.run({
        trigger: 'cli',
        folderIds: [folder.id],
        fromMs: IN_RANGE_FROM_MS,
        toMs: IN_RANGE_TO_MS,
      });

      // The file is in-range, so the worker proceeds to the dedup check — which
      // hits and short-circuits before the register step. The single call must
      // therefore have come from the build-phase gate.
      expect(skipped).toHaveLength(1);
      expect(skipped[0].reason).toBe('dedup');
      expect(resolveCapturedAtMock).toHaveBeenCalledTimes(1);
    });
  });
});
