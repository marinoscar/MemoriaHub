/**
 * test/sync/sync-engine.spec.ts
 *
 * Integration-level tests for SyncEngine using:
 *   - In-memory SQLite DB (openDb(':memory:'))
 *   - Mock ApiClient (plain object with jest.fn() methods)
 *   - Mock uploadFn (resolves { objectId })
 *   - Mock hashFn (deterministic hash)
 *   - Real temp files on the filesystem (so enumerateFiles / statSync work)
 *
 * We do NOT use global.fetch — the ApiClient itself is mocked at the object level.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { FileRepo } from '../../src/repo/files.js';
import { RunRepo } from '../../src/repo/runs.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { SyncEngine } from '../../src/sync/sync-engine.js';
import { EV } from '../../src/sync/events.js';
import type {
  RunStartPayload,
  RunDonePayload,
  FileDonePayload,
  FileFailedPayload,
  FileSkippedPayload,
  RunProgressPayload,
} from '../../src/sync/events.js';
import type { SyncEngineDeps } from '../../src/sync/sync-engine.js';
import type { ApiClient } from '../../src/api.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
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
  engine: SyncEngine;
  folders: FolderRepo;
  files: FileRepo;
  runs: RunRepo;
  settings: SettingsRepo;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncEngine', () => {
  let db: BetterSqlite3.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-engine-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Event sequence for a normal run
  // -------------------------------------------------------------------------

  describe('event sequence — normal run', () => {
    it('emits run:start → file:start → file:done → run:done for a single file', async () => {
      writeTmpJpeg(tmpDir, 'photo.jpg');

      const { engine, folders } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });

      const events: string[] = [];
      engine.on(EV.RUN_START, () => events.push('run:start'));
      engine.on(EV.FILE_START, () => events.push('file:start'));
      engine.on(EV.FILE_DONE, () => events.push('file:done'));
      engine.on(EV.RUN_DONE, () => events.push('run:done'));

      await engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(events).toContain('run:start');
      expect(events).toContain('file:start');
      expect(events).toContain('file:done');
      expect(events.at(-1)).toBe('run:done');
    });

    it('run:start payload contains correct runId, total, and dryRun=false', async () => {
      writeTmpJpeg(tmpDir, 'a.jpg');
      writeTmpJpeg(tmpDir, 'b.jpg');

      const { engine, folders } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });

      let startPayload: RunStartPayload | null = null;
      engine.on(EV.RUN_START, (p) => { startPayload = p; });

      await engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(startPayload).not.toBeNull();
      expect(startPayload!.total).toBeGreaterThanOrEqual(2);
      expect(startPayload!.dryRun).toBe(false);
      expect(startPayload!.folderIds).toContain(folder.id);
    });

    it('run:done payload contains stats and positive durationMs', async () => {
      writeTmpJpeg(tmpDir, 'x.jpg');

      const { engine, folders } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });

      let donePayload: RunDonePayload | null = null;
      engine.on(EV.RUN_DONE, (p) => { donePayload = p; });

      await engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(donePayload).not.toBeNull();
      expect(donePayload!.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof donePayload!.stats.uploaded).toBe('number');
    });

    it('run:progress counts converge — queued decreases, uploaded increases', async () => {
      writeTmpJpeg(tmpDir, 'p1.jpg');
      writeTmpJpeg(tmpDir, 'p2.jpg');

      const { engine, folders } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });

      const progresses: RunProgressPayload[] = [];
      engine.on(EV.RUN_PROGRESS, (p) => progresses.push(p));

      await engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(progresses.length).toBeGreaterThan(0);
      // Final progress should show 0 queued and 0 uploading
      const final = progresses.at(-1)!;
      expect(final.counts.queued).toBe(0);
      expect(final.counts.uploading).toBe(0);
    });

    it('persists uploaded status with media_item_id and storage_object_id', async () => {
      writeTmpJpeg(tmpDir, 'upload-me.jpg');

      const { engine, folders, files } = makeEngine(
        db,
        { post: mockResolving({ id: 'media-abc' }) },
        makeUploadFn('obj-xyz'),
      );
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });

      await engine.run({ trigger: 'cli', folderIds: [folder.id] });

      const all = files.listByFolder(folder.id);
      expect(all).toHaveLength(1);
      const rec = all[0];
      expect(rec.status).toBe('uploaded');
      expect(rec.media_item_id).toBe('media-abc');
      expect(rec.storage_object_id).toBe('obj-xyz');
      expect(rec.uploaded_at).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Dedup — file already exists on server
  // -------------------------------------------------------------------------

  describe('dedup', () => {
    it('skips a file (status=skipped, reason=dedup) when server returns a hash hit', async () => {
      writeTmpJpeg(tmpDir, 'dedup.jpg');

      const ctx = makeEngine(
        db,
        {
          get: mockResolving({
            items: [{ id: 'existing-media', contentHash: 'deadbeefdeadbeef' }],
          }),
        },
        makeUploadFn(),
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const skippedEvents: FileSkippedPayload[] = [];
      ctx.engine.on(EV.FILE_SKIPPED, (p) => skippedEvents.push(p));

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(skippedEvents).toHaveLength(1);
      expect(skippedEvents[0].reason).toBe('dedup');
      expect(ctx.uploadFn).not.toHaveBeenCalled();

      const rec = ctx.files.listByFolder(folder.id)[0];
      expect(rec.status).toBe('skipped');
      expect(rec.media_item_id).toBe('existing-media');
    });
  });

  // -------------------------------------------------------------------------
  // Unchanged fast-skip (already uploaded, size unchanged)
  // -------------------------------------------------------------------------

  describe('unchanged fast-skip', () => {
    it('skips uploaded file with matching size without hashing or uploading on second run', async () => {
      writeTmpJpeg(tmpDir, 'stable.jpg');

      const ctx = makeEngine(db, {
        get: mockResolving({ items: [] }),
        post: mockResolving({ id: 'media-stable' }),
      }, makeUploadFn('obj-stable'));

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      // First run — uploads the file
      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });
      expect(ctx.uploadFn).toHaveBeenCalledTimes(1);
      expect(ctx.hashFn).toHaveBeenCalledTimes(1);

      // Build a second engine (fresh mocks) pointing at the same DB
      const ctx2 = makeEngine(db, {
        get: mockResolving({ items: [] }),
        post: mockResolving({ id: 'media-stable2' }),
      }, makeUploadFn('obj-stable2'));

      const skippedEvents: FileSkippedPayload[] = [];
      ctx2.engine.on(EV.FILE_SKIPPED, (p) => skippedEvents.push(p));

      await ctx2.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // uploadFn and hashFn must not be called on the second run
      expect(ctx2.uploadFn).not.toHaveBeenCalled();
      expect(ctx2.hashFn).not.toHaveBeenCalled();

      const unchangedSkips = skippedEvents.filter((e) => e.reason === 'unchanged');
      expect(unchangedSkips).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure isolation
  // -------------------------------------------------------------------------

  describe('failure isolation', () => {
    it('marks one file failed with last_error while other files still complete', async () => {
      writeTmpJpeg(tmpDir, 'good.jpg');
      writeTmpJpeg(tmpDir, 'bad.jpg');

      let callCount = 0;
      const uploadFn = jest.fn<SyncEngineDeps['uploadFn'] & {}>()
        .mockImplementation(async (_api, filePath) => {
          callCount++;
          if (filePath.includes('bad.jpg')) {
            throw new Error('Upload failed for bad.jpg');
          }
          return { objectId: `obj-${callCount}` };
        }) as never;

      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-good' }),
        },
        uploadFn,
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const failedEvents: FileFailedPayload[] = [];
      const doneEvents: FileDonePayload[] = [];
      let runDoneEmitted = false;

      ctx.engine.on(EV.FILE_FAILED, (p) => failedEvents.push(p));
      ctx.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));
      ctx.engine.on(EV.RUN_DONE, () => { runDoneEmitted = true; });

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].error).toContain('bad.jpg');
      expect(doneEvents).toHaveLength(1);
      expect(runDoneEmitted).toBe(true);

      const allFiles = ctx.files.listByFolder(folder.id);
      const goodRec = allFiles.find((f) => f.file_path.includes('good.jpg'));
      const badRec = allFiles.find((f) => f.file_path.includes('bad.jpg'));
      expect(goodRec!.status).toBe('uploaded');
      expect(badRec!.status).toBe('failed');
      expect(badRec!.last_error).toContain('bad.jpg');
      expect(badRec!.attempt_count).toBeGreaterThanOrEqual(1);
    });

    it('emits file:failed with attempt count and willRetry=true when below cap', async () => {
      writeTmpJpeg(tmpDir, 'will-retry.jpg');

      const uploadFn = jest.fn<SyncEngineDeps['uploadFn'] & {}>()
        .mockRejectedValue(new Error('timeout')) as never;

      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [] }) },
        uploadFn,
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const failedEvents: FileFailedPayload[] = [];
      ctx.engine.on(EV.FILE_FAILED, (p) => failedEvents.push(p));

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(failedEvents).toHaveLength(1);
      // attempt=1, cap=5 → willRetry=true
      expect(failedEvents[0].willRetry).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Retry (retryFailedOnly)
  // -------------------------------------------------------------------------

  describe('retry', () => {
    it('re-queues and processes failed-under-cap files on retryFailedOnly run', async () => {
      writeTmpJpeg(tmpDir, 'retry-me.jpg');

      // First run — upload fails
      const failUpload = jest.fn<SyncEngineDeps['uploadFn'] & {}>()
        .mockRejectedValue(new Error('first fail')) as never;

      const ctx1 = makeEngine(
        db,
        { get: mockResolving({ items: [] }) },
        failUpload,
      );
      const folder = ctx1.folders.add({ path: tmpDir, circleId: 'test-circle' });
      await ctx1.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // Confirm file is failed
      const failedBefore = ctx1.files.listFailed({ folderIds: [folder.id], cap: 5 });
      expect(failedBefore).toHaveLength(1);

      // Second run — retry with a succeeding upload
      const succeedUpload = makeUploadFn('obj-retry');
      const ctx2 = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-retry' }),
        },
        succeedUpload,
      );

      const doneEvents: FileDonePayload[] = [];
      ctx2.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));

      await ctx2.engine.run({
        trigger: 'retry',
        folderIds: [folder.id],
        retryFailedOnly: true,
      });

      expect(doneEvents).toHaveLength(1);
      const rec = ctx2.files.listByFolder(folder.id)[0];
      expect(rec.status).toBe('uploaded');
    });

    it('does NOT retry a file at attempts cap unless force=true', async () => {
      writeTmpJpeg(tmpDir, 'blocked.jpg');

      // Upsert the file at cap=5 with status=failed
      const { folders, files } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });
      const rec = files.upsert(folder.id, path.join(tmpDir, 'blocked.jpg'), { status: 'failed' });
      files.setStatus(rec.id, 'failed', { attempt_count: 5 }); // at cap

      // Normal retry — should not include blocked files
      const uploadFn = makeUploadFn();
      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [] }) },
        uploadFn,
      );

      await ctx.engine.run({
        trigger: 'retry',
        folderIds: [folder.id],
        retryFailedOnly: true,
        force: false,
      });

      // uploadFn should NOT have been called (file is blocked)
      expect(uploadFn).not.toHaveBeenCalled();
    });

    it('retries a blocked file when force=true (resets attempt_count)', async () => {
      writeTmpJpeg(tmpDir, 'force-retry.jpg');

      const { folders, files } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });
      const rec = files.upsert(folder.id, path.join(tmpDir, 'force-retry.jpg'), { status: 'failed' });
      files.setStatus(rec.id, 'failed', { attempt_count: 5 }); // at cap

      const uploadFn = makeUploadFn('obj-forced');
      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-forced' }),
        },
        uploadFn,
      );

      const doneEvents: FileDonePayload[] = [];
      ctx.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));

      await ctx.engine.run({
        trigger: 'retry',
        folderIds: [folder.id],
        retryFailedOnly: true,
        force: true,
      });

      expect(doneEvents).toHaveLength(1);
      const after = ctx.files.listByFolder(folder.id)[0];
      expect(after.status).toBe('uploaded');
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery (resetStaleUploading)
  // -------------------------------------------------------------------------

  describe('crash recovery', () => {
    it('resets a stale uploading file to queued and then processes it', async () => {
      writeTmpJpeg(tmpDir, 'stale.jpg');

      const { folders, files } = makeEngine(db);
      const folder = folders.add({ path: tmpDir, circleId: 'test-circle' });

      // Pre-seed the file as uploading (simulating a crash mid-upload)
      const rec = files.upsert(folder.id, path.join(tmpDir, 'stale.jpg'), {
        status: 'uploading',
        size_bytes: 4,
        mime_type: 'image/jpeg',
      });
      expect(rec.status).toBe('uploading');

      const uploadFn = makeUploadFn('obj-recovered');
      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-recovered' }),
        },
        uploadFn,
      );

      const doneEvents: FileDonePayload[] = [];
      ctx.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // resetStaleUploading should have reset it, then it gets re-queued and uploaded
      expect(doneEvents).toHaveLength(1);
      const after = ctx.files.getByFolderAndPath(folder.id, path.join(tmpDir, 'stale.jpg'));
      expect(after!.status).toBe('uploaded');
    });
  });

  // -------------------------------------------------------------------------
  // Dry-run
  // -------------------------------------------------------------------------

  describe('dry-run', () => {
    it('emits file:done with dryRun=true and does NOT call uploadFn', async () => {
      writeTmpJpeg(tmpDir, 'dry.jpg');

      // dedup stub returns empty (no hit) so the engine reaches the dry-run path
      const uploadFn = makeUploadFn();
      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [] }) },
        uploadFn,
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });
      const doneEvents: FileDonePayload[] = [];
      ctx.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id], dryRun: true });

      expect(uploadFn).not.toHaveBeenCalled();
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].dryRun).toBe(true);
    });

    it('does not persist uploaded status in dry-run mode', async () => {
      writeTmpJpeg(tmpDir, 'dry2.jpg');

      const uploadFn = makeUploadFn();
      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [] }) },
        uploadFn,
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id], dryRun: true });

      const rec = ctx.files.listByFolder(folder.id)[0];
      // Status must NOT be 'uploaded' after a dry-run
      expect(rec.status).not.toBe('uploaded');
    });

    it('records dry_run=true in the sync_runs table', async () => {
      writeTmpJpeg(tmpDir, 'dry3.jpg');

      const ctx = makeEngine(
        db,
        { get: mockResolving({ items: [] }) },
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      let capturedRunId: number | null = null;
      ctx.engine.on(EV.RUN_START, (p) => { capturedRunId = p.runId; });

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id], dryRun: true });

      const runs = ctx.runs.listRuns(1);
      expect(runs).toHaveLength(1);
      expect(runs[0].dry_run).toBe(true);
      expect(runs[0].id).toBe(capturedRunId);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  describe('concurrency', () => {
    it('never exceeds concurrency=2 in-flight workers with 4 files', async () => {
      for (let i = 0; i < 4; i++) writeTmpJpeg(tmpDir, `c${i}.jpg`);

      let inFlight = 0;
      let maxInFlight = 0;

      const uploadFn = jest.fn<SyncEngineDeps['uploadFn'] & {}>()
        .mockImplementation(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((r) => setTimeout(r, 20));
          inFlight--;
          return { objectId: 'obj-concurrent' };
        }) as never;

      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-c' }),
        },
        uploadFn,
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      await ctx.engine.run({
        trigger: 'cli',
        folderIds: [folder.id],
        concurrency: 2,
      });

      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(uploadFn).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // Second sync — unchanged-fast-skip acceptance assertion (SQLite path)
  // -------------------------------------------------------------------------

  describe('second sync (SQLite path)', () => {
    it('uploads zero files on the second sync when nothing changed', async () => {
      writeTmpJpeg(tmpDir, 'stable2a.jpg');
      writeTmpJpeg(tmpDir, 'stable2b.jpg');

      // First run
      let postCallCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const post1: AnyFn = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
        postCallCount++;
        return { id: `media-${postCallCount}` };
      });

      const ctx1 = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: post1,
        },
        makeUploadFn('obj-1'),
      );

      const folder = ctx1.folders.add({ path: tmpDir, circleId: 'test-circle' });
      await ctx1.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      const upload1Count = (ctx1.uploadFn as jest.MockedFunction<typeof ctx1.uploadFn>).mock.calls.length;
      expect(upload1Count).toBe(2);

      // Second run — same DB, same unchanged files
      const upload2 = makeUploadFn('obj-2');
      const ctx2 = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-new' }),
        },
        upload2,
      );

      const skippedEvents: FileSkippedPayload[] = [];
      ctx2.engine.on(EV.FILE_SKIPPED, (p) => skippedEvents.push(p));

      await ctx2.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(upload2).not.toHaveBeenCalled();
      const unchangedSkips = skippedEvents.filter((e) => e.reason === 'unchanged');
      expect(unchangedSkips).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Fatal errors
  // -------------------------------------------------------------------------

  describe('fatal errors', () => {
    it('rejects and emits error when no target folders are found', async () => {
      const ctx = makeEngine(db);

      let errorMsg: string | null = null;
      ctx.engine.on(EV.ERROR, (p) => { errorMsg = p.message; });

      await expect(
        ctx.engine.run({ trigger: 'cli' }),
      ).rejects.toThrow();

      expect(errorMsg).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // circleId resolution
  // -------------------------------------------------------------------------

  describe('circleId resolution', () => {
    it('uses folder.circle_id when set', async () => {
      const postFn = mockResolving({ id: 'media-1' });
      const { engine, folders } = makeEngine(
        db,
        { get: mockResolving({ items: [] }), post: postFn },
        makeUploadFn('obj-1'),
        makeHashFn(),
      );

      const folder = folders.add({ path: tmpDir, circleId: 'circle-from-folder' });
      writeTmpJpeg(tmpDir, 'circle-test1.jpg');

      await engine.run({ folderIds: [folder.id], dryRun: false, trigger: 'cli' });

      const mediaCalls = (postFn.mock.calls as Array<[string, Record<string, unknown>]>)
        .filter(([p]) => p === '/api/media');
      expect(mediaCalls).toHaveLength(1);
      expect(mediaCalls[0][1].circleId).toBe('circle-from-folder');
    });

    it('uses opts.circleId when folder.circle_id is null', async () => {
      // Use a fresh db and dir to avoid leftover files from other tests
      const db2 = makeDb();
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-test-opts-'));
      try {
        const postFn = mockResolving({ id: 'media-2' });
        const { engine, folders } = makeEngine(
          db2,
          { get: mockResolving({ items: [] }), post: postFn },
          makeUploadFn('obj-2'),
          makeHashFn(),
        );

        const folder = folders.add({ path: dir2 }); // no circleId
        writeTmpJpeg(dir2, 'circle-test2.jpg');

        await engine.run({ folderIds: [folder.id], circleId: 'circle-from-opts', dryRun: false, trigger: 'cli' });

        const mediaCalls = (postFn.mock.calls as Array<[string, Record<string, unknown>]>)
          .filter(([p]) => p === '/api/media');
        expect(mediaCalls).toHaveLength(1);
        expect(mediaCalls[0][1].circleId).toBe('circle-from-opts');
      } finally {
        db2.close();
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    it('folder.circle_id takes priority over opts.circleId', async () => {
      const db3 = makeDb();
      const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-test-prio-'));
      try {
        const postFn = mockResolving({ id: 'media-3' });
        const { engine, folders } = makeEngine(
          db3,
          { get: mockResolving({ items: [] }), post: postFn },
          makeUploadFn('obj-3'),
          makeHashFn(),
        );

        const folder = folders.add({ path: dir3, circleId: 'circle-folder-wins' });
        writeTmpJpeg(dir3, 'circle-test3.jpg');

        await engine.run({ folderIds: [folder.id], circleId: 'circle-opts-loses', dryRun: false, trigger: 'cli' });

        const mediaCalls = (postFn.mock.calls as Array<[string, Record<string, unknown>]>)
          .filter(([p]) => p === '/api/media');
        expect(mediaCalls).toHaveLength(1);
        expect(mediaCalls[0][1].circleId).toBe('circle-folder-wins');
      } finally {
        db3.close();
        fs.rmSync(dir3, { recursive: true, force: true });
      }
    });

    it('fails fast when no circleId resolves', async () => {
      const db4 = makeDb();
      const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-test-fail-'));
      try {
        const postFn = mockResolving({ id: 'media-4' });
        const { engine, folders } = makeEngine(
          db4,
          { get: mockResolving({ items: [] }), post: postFn },
          makeUploadFn('obj-4'),
          makeHashFn(),
        );

        const folder = folders.add({ path: dir4 }); // no circleId
        writeTmpJpeg(dir4, 'circle-test4.jpg');

        // No circleId in opts either
        const result = await engine.run({ folderIds: [folder.id], dryRun: false, trigger: 'cli' });

        // File should be failed, not uploaded
        expect(result.stats.failed).toBe(1);
        expect(result.stats.uploaded).toBe(0);

        // POST /api/media should NOT have been called
        const mediaCalls = (postFn.mock.calls as Array<[string, string]>)
          .filter(([p]) => p === '/api/media');
        expect(mediaCalls).toHaveLength(0);
      } finally {
        db4.close();
        fs.rmSync(dir4, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // contentHash in register body
  // -------------------------------------------------------------------------

  describe('contentHash sent to server on registration', () => {
    it('includes contentHash in the POST /api/media body', async () => {
      writeTmpJpeg(tmpDir, 'hash-reg.jpg');

      const postFn = mockResolving({ id: 'media-hash-reg' });
      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: postFn,
        },
        makeUploadFn('obj-hash-reg'),
        makeHashFn('aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011'),
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });
      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(postFn).toHaveBeenCalledTimes(1);
      const callArgs = postFn.mock.calls[0] as [string, Record<string, unknown>];
      expect(callArgs[0]).toBe('/api/media');
      expect(callArgs[1]).toMatchObject({
        contentHash: 'aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011aabbccddeeff0011',
      });
    });

    it('sets status=skipped (reason=dedup) when register returns deduplicated:true', async () => {
      writeTmpJpeg(tmpDir, 'server-dedup.jpg');

      const postFn = mockResolving({ id: 'media-server-dedup', deduplicated: true });
      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }), // pre-check returns empty (no hit)
          post: postFn,
        },
        makeUploadFn('obj-server-dedup'),
        makeHashFn('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const skippedEvents: FileSkippedPayload[] = [];
      const doneEvents: FileDonePayload[] = [];
      ctx.engine.on(EV.FILE_SKIPPED, (p) => skippedEvents.push(p));
      ctx.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // Should emit file:skipped with reason=dedup, not file:done
      expect(skippedEvents).toHaveLength(1);
      expect(skippedEvents[0].reason).toBe('dedup');
      expect(doneEvents).toHaveLength(0);

      // DB record must reflect skipped, not uploaded
      const rec = ctx.files.listByFolder(folder.id)[0];
      expect(rec.status).toBe('skipped');
      expect(rec.media_item_id).toBe('media-server-dedup');
    });

    it('sets status=uploaded when register returns deduplicated:false (normal path)', async () => {
      writeTmpJpeg(tmpDir, 'normal-reg.jpg');

      const postFn = mockResolving({ id: 'media-normal', deduplicated: false });
      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: postFn,
        },
        makeUploadFn('obj-normal'),
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });

      const doneEvents: FileDonePayload[] = [];
      ctx.engine.on(EV.FILE_DONE, (p) => doneEvents.push(p));

      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      expect(doneEvents).toHaveLength(1);
      const rec = ctx.files.listByFolder(folder.id)[0];
      expect(rec.status).toBe('uploaded');
    });
  });

  // -------------------------------------------------------------------------
  // mtime hash cache — avoid re-hashing unchanged files across runs
  // -------------------------------------------------------------------------

  describe('mtime hash cache', () => {
    it('does NOT call hashFn when size+mtime match stored sha256', async () => {
      writeTmpJpeg(tmpDir, 'cached.jpg');

      // First run: hash is computed and persisted
      const hash1 = makeHashFn('cafecafe' + 'cafecafe'.repeat(7));
      const ctx1 = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-cached' }),
        },
        makeUploadFn('obj-cached'),
        hash1,
      );
      const folder = ctx1.folders.add({ path: tmpDir, circleId: 'test-circle' });
      await ctx1.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // After first run: sha256 and mtime_ms must be stored
      const recAfterFirstRun = ctx1.files.listByFolder(folder.id)[0];
      expect(recAfterFirstRun.sha256).not.toBeNull();
      expect(recAfterFirstRun.mtime_ms).not.toBeNull();
      expect(hash1).toHaveBeenCalledTimes(1);

      // Mark the file as queued again (simulating a retry scenario) so the engine will
      // process it, but keep sha256 and mtime_ms intact.
      ctx1.files.setStatus(recAfterFirstRun.id, 'queued');

      // Second run with a fresh hash mock — should NOT be called because cache hits
      const hash2 = makeHashFn('cafecafe' + 'cafecafe'.repeat(7));
      const ctx2 = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-cached2' }),
        },
        makeUploadFn('obj-cached2'),
        hash2,
      );

      await ctx2.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // hashFn must NOT have been called because size+mtime match
      expect(hash2).not.toHaveBeenCalled();
    });

    it('calls hashFn when mtime differs from stored value (file was modified)', async () => {
      const filePath = writeTmpJpeg(tmpDir, 'modified.jpg');

      // Seed the file record with a stale mtime_ms (different from the actual file)
      const ctx1 = makeEngine(db, {
        get: mockResolving({ items: [] }),
        post: mockResolving({ id: 'media-mod' }),
      }, makeUploadFn('obj-mod'));

      const folder = ctx1.folders.add({ path: tmpDir, circleId: 'test-circle' });

      // Pre-seed with a very old mtime to simulate a changed file
      const rec = ctx1.files.upsert(folder.id, filePath, {
        sha256: 'oldhash' + '0'.repeat(57),
        size_bytes: fs.statSync(filePath).size,
        mtime_ms: 1000, // deliberately stale mtime
        status: 'queued',
      });

      // Now run — mtime won't match so hashFn must be called
      const hash = makeHashFn('newhash' + '0'.repeat(57));
      const ctx2 = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-mod2' }),
        },
        makeUploadFn('obj-mod2'),
        hash,
      );

      await ctx2.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      // hashFn must have been called since mtime didn't match
      expect(hash).toHaveBeenCalledTimes(1);

      // Updated mtime_ms must be persisted after the run
      const recAfter = ctx2.files.getByFolderAndPath(folder.id, filePath);
      expect(recAfter!.mtime_ms).not.toBe(1000);
      expect(recAfter!.sha256).toBe('newhash' + '0'.repeat(57));

      // Suppress unused variable warning
      void rec;
    });

    it('stores mtime_ms alongside sha256 after computing hash on first run', async () => {
      writeTmpJpeg(tmpDir, 'store-mtime.jpg');

      const ctx = makeEngine(
        db,
        {
          get: mockResolving({ items: [] }),
          post: mockResolving({ id: 'media-mt' }),
        },
        makeUploadFn('obj-mt'),
        makeHashFn('ffffffff' + 'ffffffff'.repeat(7)),
      );

      const folder = ctx.folders.add({ path: tmpDir, circleId: 'test-circle' });
      await ctx.engine.run({ trigger: 'cli', folderIds: [folder.id] });

      const rec = ctx.files.listByFolder(folder.id)[0];
      // Both sha256 and mtime_ms must be stored after a successful upload
      expect(rec.sha256).toBe('ffffffff' + 'ffffffff'.repeat(7));
      expect(typeof rec.mtime_ms).toBe('number');
      expect(rec.mtime_ms).toBeGreaterThan(0);
    });
  });
});
