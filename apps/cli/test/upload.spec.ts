/**
 * test/upload.spec.ts
 *
 * Unit tests for uploadFile() from src/upload.ts.
 *
 * Strategy: use real temp files (so fs.statSync and fs.createReadStream work
 * without ESM frozen-module mocking), and inject a fully fake ApiClient object
 * so no real HTTP calls are made.
 *
 * Tests cover:
 *  1. Fresh upload — onInit, onPartComplete, onComplete are all called.
 *  2. Resume with pre-existing completed parts — already-done parts are skipped.
 *  3. Fallback to clean re-init when the server session has expired.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uploadFile, UploadPersistence, UploadResumeState } from '../src/upload.js';
import { ApiError } from '../src/api.js';
import type { ApiClient } from '../src/api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PART_SIZE = 10; // 10 bytes per part → easy math
const TOTAL_PARTS = 3;
const FILE_SIZE = PART_SIZE * TOTAL_PARTS; // 30 bytes

/** Write a temp file of FILE_SIZE bytes and return its path. */
function makeTempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  const filePath = path.join(dir, 'test-upload.bin');
  fs.writeFileSync(filePath, Buffer.alloc(FILE_SIZE, 0xab)); // 30 bytes of 0xAB
  return filePath;
}

/** Build presigned URL stubs for N parts. */
function makePresignedUrls(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    partNumber: i + 1,
    url: `https://s3.test/part${i + 1}`,
  }));
}

/** Build a fake ApiClient whose behaviour can be customised per-test. */
function makeFakeApi(opts: {
  /** Resolves to the init response (for POST /upload/init). */
  initResponse?: object;
  /** Resolves to a status check response (GET /upload/status). */
  statusResponse?: object;
  /** Resolves to part-urls response (POST /upload/part-urls). */
  partUrlsResponse?: object;
  /** ETag returned by putRaw (per-call, cycled). */
  eTags?: string[];
  /** If set, GET /upload/status throws this error. */
  statusError?: Error;
}): {
  api: Pick<ApiClient, 'post' | 'get' | 'putRaw'>;
  postSpy: jest.Mock;
  getSpy: jest.Mock;
  putRawSpy: jest.Mock;
} {
  const {
    initResponse = {
      objectId: 'obj-1',
      uploadId: 'upload-abc',
      partSize: PART_SIZE,
      totalParts: TOTAL_PARTS,
      presignedUrls: makePresignedUrls(TOTAL_PARTS),
    },
    statusResponse = { uploadId: 'upload-abc', status: 'uploading' },
    partUrlsResponse = null,
    eTags = Array.from({ length: TOTAL_PARTS }, (_, i) => `etag-${i + 1}`),
    statusError,
  } = opts;

  const eTagCursor = { index: 0 };

  const postSpy = jest.fn<ApiClient['post']>().mockImplementation(((url: string, body: unknown) => {
    if ((url as string) === '/api/storage/objects/upload/init') {
      return Promise.resolve(initResponse);
    }
    if ((url as string).includes('/upload/complete')) {
      return Promise.resolve({});
    }
    if ((url as string).includes('/upload/part-urls')) {
      if (partUrlsResponse) return Promise.resolve(partUrlsResponse);
      // Auto-generate presigned URLs for requested part numbers
      const { partNumbers } = body as { partNumbers: number[] };
      return Promise.resolve({
        presignedUrls: partNumbers.map((n: number) => ({
          partNumber: n,
          url: `https://s3.test/part${n}`,
        })),
      });
    }
    return Promise.reject(new Error(`Unexpected POST to ${url}`));
  }) as ApiClient['post']);

  const getSpy = jest.fn<ApiClient['get']>().mockImplementation(((url: string) => {
    if ((url as string).includes('/upload/status')) {
      if (statusError) return Promise.reject(statusError);
      return Promise.resolve(statusResponse);
    }
    return Promise.reject(new Error(`Unexpected GET to ${url}`));
  }) as ApiClient['get']);

  const putRawSpy = jest.fn<ApiClient['putRaw']>().mockImplementation((() => {
    const tag = eTags[eTagCursor.index++ % eTags.length]!;
    return Promise.resolve(tag);
  }) as ApiClient['putRaw']);

  const api = { post: postSpy, get: getSpy, putRaw: putRawSpy } as unknown as Pick<
    ApiClient,
    'post' | 'get' | 'putRaw'
  >;

  return { api, postSpy, getSpy, putRawSpy };
}

/** Build a no-op persistence stub. */
function makePersistence(
  resumeState: UploadResumeState | null = null,
): {
  persistence: UploadPersistence;
  onInit: jest.Mock;
  onPartComplete: jest.Mock;
  onComplete: jest.Mock;
} {
  const onInit = jest.fn<UploadPersistence['onInit']>();
  const onPartComplete = jest.fn<UploadPersistence['onPartComplete']>();
  const onComplete = jest.fn<UploadPersistence['onComplete']>();
  const getResumeState = jest.fn<UploadPersistence['getResumeState']>().mockReturnValue(resumeState);

  const persistence: UploadPersistence = {
    onInit: onInit as UploadPersistence['onInit'],
    onPartComplete: onPartComplete as UploadPersistence['onPartComplete'],
    onComplete: onComplete as UploadPersistence['onComplete'],
    getResumeState: getResumeState as UploadPersistence['getResumeState'],
  };

  return { persistence, onInit, onPartComplete, onComplete };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('uploadFile', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = makeTempFile();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // 1. Fresh upload with persistence callbacks
  // -------------------------------------------------------------------------

  describe('fresh upload — persistence callbacks', () => {
    it('calls onInit once with objectId, uploadId, and partSize', async () => {
      const { api } = makeFakeApi({});
      const { persistence, onInit } = makePersistence();

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      expect(onInit).toHaveBeenCalledTimes(1);
      expect(onInit).toHaveBeenCalledWith('obj-1', 'upload-abc', PART_SIZE);
    });

    it('calls onPartComplete once for each part', async () => {
      const { api } = makeFakeApi({});
      const { persistence, onPartComplete } = makePersistence();

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      expect(onPartComplete).toHaveBeenCalledTimes(TOTAL_PARTS);
    });

    it('calls onPartComplete with correct partNumber and eTag', async () => {
      const { api } = makeFakeApi({ eTags: ['etag-1', 'etag-2', 'etag-3'] });
      const { persistence, onPartComplete } = makePersistence();

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      expect(onPartComplete).toHaveBeenNthCalledWith(1, 1, 'etag-1');
      expect(onPartComplete).toHaveBeenNthCalledWith(2, 2, 'etag-2');
      expect(onPartComplete).toHaveBeenNthCalledWith(3, 3, 'etag-3');
    });

    it('calls onComplete once at the end', async () => {
      const { api } = makeFakeApi({});
      const { persistence, onComplete } = makePersistence();

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('POSTs to /upload/complete with all part ETags', async () => {
      const { api, postSpy } = makeFakeApi({ eTags: ['e1', 'e2', 'e3'] });
      const { persistence } = makePersistence();

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      const completeCall = (postSpy.mock.calls as Array<[string, unknown]>).find(
        ([url]) => url.includes('/upload/complete'),
      );
      expect(completeCall).toBeDefined();
      const body = completeCall![1] as { parts: Array<{ partNumber: number; eTag: string }> };
      expect(body.parts).toHaveLength(TOTAL_PARTS);
      expect(body.parts[0]).toEqual({ partNumber: 1, eTag: 'e1' });
      expect(body.parts[1]).toEqual({ partNumber: 2, eTag: 'e2' });
      expect(body.parts[2]).toEqual({ partNumber: 3, eTag: 'e3' });
    });

    it('returns { objectId } from the init response', async () => {
      const { api } = makeFakeApi({});
      const { persistence } = makePersistence();

      const result = await uploadFile(
        api as unknown as ApiClient,
        filePath,
        'image/jpeg',
        undefined,
        persistence,
      );

      expect(result).toEqual({ objectId: 'obj-1' });
    });

    it('PUTs each part to the presigned URL', async () => {
      const { api, putRawSpy } = makeFakeApi({});
      const { persistence } = makePersistence();

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      expect(putRawSpy).toHaveBeenCalledTimes(TOTAL_PARTS);
      const urls = (putRawSpy.mock.calls as Array<[string, Buffer, string]>).map(([url]) => url);
      expect(urls).toContain('https://s3.test/part1');
      expect(urls).toContain('https://s3.test/part2');
      expect(urls).toContain('https://s3.test/part3');
    });

    it('works without a persistence handler', async () => {
      const { api } = makeFakeApi({});

      await expect(
        uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg'),
      ).resolves.toEqual({ objectId: 'obj-1' });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Resume — valid server session, skip already-completed parts
  // -------------------------------------------------------------------------

  describe('resume with pre-existing completed parts and valid session', () => {
    it('skips parts that are already in the resume state', async () => {
      const resumeState: UploadResumeState = {
        objectId: 'obj-1',
        uploadId: 'upload-abc',
        partSize: PART_SIZE,
        completedParts: [
          { partNumber: 1, eTag: 'old-e1' },
          { partNumber: 2, eTag: 'old-e2' },
        ],
      };

      const { api, putRawSpy, getSpy } = makeFakeApi({
        statusResponse: { uploadId: 'upload-abc', status: 'uploading' },
      });
      const { persistence } = makePersistence(resumeState);

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      // Only part 3 should have been PUT
      expect(putRawSpy).toHaveBeenCalledTimes(1);
      // The session status check should have been called once
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('includes already-completed parts in the /upload/complete request', async () => {
      const resumeState: UploadResumeState = {
        objectId: 'obj-1',
        uploadId: 'upload-abc',
        partSize: PART_SIZE,
        completedParts: [
          { partNumber: 1, eTag: 'old-e1' },
          { partNumber: 2, eTag: 'old-e2' },
        ],
      };

      const { api, postSpy } = makeFakeApi({
        eTags: ['new-e3'],
        statusResponse: { uploadId: 'upload-abc', status: 'uploading' },
      });
      const { persistence } = makePersistence(resumeState);

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      const completeCall = (postSpy.mock.calls as Array<[string, unknown]>).find(
        ([url]) => url.includes('/upload/complete'),
      );
      const body = completeCall![1] as { parts: Array<{ partNumber: number; eTag: string }> };
      expect(body.parts).toHaveLength(TOTAL_PARTS);
      // Old parts still present
      expect(body.parts.find((p) => p.partNumber === 1)?.eTag).toBe('old-e1');
      expect(body.parts.find((p) => p.partNumber === 2)?.eTag).toBe('old-e2');
      // New part 3
      expect(body.parts.find((p) => p.partNumber === 3)?.eTag).toBe('new-e3');
    });

    it('only calls onPartComplete for the newly-uploaded part', async () => {
      const resumeState: UploadResumeState = {
        objectId: 'obj-1',
        uploadId: 'upload-abc',
        partSize: PART_SIZE,
        completedParts: [
          { partNumber: 1, eTag: 'old-e1' },
          { partNumber: 2, eTag: 'old-e2' },
        ],
      };

      const { api } = makeFakeApi({
        statusResponse: { uploadId: 'upload-abc', status: 'uploading' },
      });
      const { persistence, onPartComplete, onInit } = makePersistence(resumeState);

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      // onInit is NOT called on resume
      expect(onInit).not.toHaveBeenCalled();
      // onPartComplete only for the one new part
      expect(onPartComplete).toHaveBeenCalledTimes(1);
      expect(onPartComplete).toHaveBeenCalledWith(3, expect.any(String));
    });
  });

  // -------------------------------------------------------------------------
  // 3. Fallback to re-init when server session is expired/gone
  // -------------------------------------------------------------------------

  describe('fallback to clean re-init when server session is gone', () => {
    it('calls onComplete early (to clear stale state) then re-POSTs to /upload/init', async () => {
      const staleResumeState: UploadResumeState = {
        objectId: 'obj-stale',
        uploadId: 'upload-stale',
        partSize: PART_SIZE,
        completedParts: [{ partNumber: 1, eTag: 'stale-e1' }],
      };

      // GET /upload/status throws → session gone
      const { api, postSpy } = makeFakeApi({
        statusError: new Error('404 Not Found'),
      });
      const { persistence, onComplete, onInit } = makePersistence(staleResumeState);

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      // onComplete called early to wipe stale state
      expect(onComplete).toHaveBeenCalledTimes(2); // once early + once at completion
      // onInit called with new session identifiers
      expect(onInit).toHaveBeenCalledTimes(1);
      expect(onInit).toHaveBeenCalledWith('obj-1', 'upload-abc', PART_SIZE);

      // Fresh init POST sent
      const initCall = (postSpy.mock.calls as Array<[string, unknown]>).find(
        ([url]) => url === '/api/storage/objects/upload/init',
      );
      expect(initCall).toBeDefined();
    });

    it('uploads all parts from scratch after re-init', async () => {
      const staleResumeState: UploadResumeState = {
        objectId: 'obj-stale',
        uploadId: 'upload-stale',
        partSize: PART_SIZE,
        completedParts: [],
      };

      const { api, putRawSpy } = makeFakeApi({
        statusError: new Error('404'),
      });
      const { persistence } = makePersistence(staleResumeState);

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      expect(putRawSpy).toHaveBeenCalledTimes(TOTAL_PARTS);
    });

    it('returns the new objectId from the fresh init', async () => {
      const staleResumeState: UploadResumeState = {
        objectId: 'obj-stale',
        uploadId: 'upload-stale',
        partSize: PART_SIZE,
        completedParts: [],
      };

      const { api } = makeFakeApi({ statusError: new Error('Gone') });
      const { persistence } = makePersistence(staleResumeState);

      const result = await uploadFile(
        api as unknown as ApiClient,
        filePath,
        'image/jpeg',
        undefined,
        persistence,
      );

      expect(result.objectId).toBe('obj-1'); // new objectId from fresh init
    });
  });

  // -------------------------------------------------------------------------
  // 4. Provider-side stale session (issue #179)
  //
  // The API's /upload/status only reads its own DB row, so it happily reports a
  // resumable session for a multipart upload that S3/R2 has already garbage-
  // collected. The part PUT is the first place the truth surfaces — as a 404
  // NoSuchUpload — and before this fix that 404 was permanent for the file.
  // -------------------------------------------------------------------------

  describe('stale multipart session — provider reports NoSuchUpload', () => {
    const NO_SUCH_UPLOAD_XML =
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchUpload</Code>' +
      '<Message>The specified multipart upload does not exist.</Message></Error>';

    /** A resume state the API still considers valid (status check succeeds). */
    const resumeState: UploadResumeState = {
      objectId: 'obj-stale',
      uploadId: 'upload-stale',
      partSize: PART_SIZE,
      completedParts: [{ partNumber: 1, eTag: 'etag-1' }],
    };

    /** Fake api whose first N part PUTs 404 with NoSuchUpload, then succeed. */
    function makeApiWith404Until(failCalls: number) {
      const { api, postSpy, getSpy, putRawSpy } = makeFakeApi({
        statusResponse: { uploadId: 'upload-stale', status: 'uploading' },
      });
      let calls = 0;
      (putRawSpy as jest.Mock).mockImplementation((() => {
        calls++;
        if (calls <= failCalls) {
          return Promise.reject(new ApiError(404, NO_SUCH_UPLOAD_XML));
        }
        return Promise.resolve(`etag-${calls}`);
      }) as ApiClient['putRaw']);
      return { api, postSpy, getSpy, putRawSpy };
    }

    it('discards the dead session and re-inits instead of failing the file', async () => {
      const { api, postSpy } = makeApiWith404Until(1);
      const { persistence, onComplete } = makePersistence(resumeState);

      const result = await uploadFile(
        api as unknown as ApiClient,
        filePath,
        'image/jpeg',
        undefined,
        persistence,
      );

      // Recovered: a fresh init ran and the upload finished on the new session.
      const initCalls = postSpy.mock.calls.filter(
        (c) => c[0] === '/api/storage/objects/upload/init',
      );
      expect(initCalls).toHaveLength(1);
      expect(result.objectId).toBe('obj-1');

      // The dead session was cleared before re-initializing, so the retry
      // cannot resume into it again.
      expect(onComplete).toHaveBeenCalled();
    });

    it('re-uploads every part on the fresh session, ignoring resumed parts', async () => {
      const { api, putRawSpy } = makeApiWith404Until(1);
      const { persistence } = makePersistence(resumeState);

      await uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence);

      // 1 failed PUT (part 2, the first not already resumed) + all 3 parts
      // re-sent on the clean session.
      expect(putRawSpy).toHaveBeenCalledTimes(1 + TOTAL_PARTS);
    });

    it('gives up after one restart when the fresh session also 404s', async () => {
      // A persistently-404ing provider (e.g. a missing bucket) must not loop.
      const { api, putRawSpy } = makeApiWith404Until(Number.MAX_SAFE_INTEGER);
      const { persistence } = makePersistence(resumeState);

      await expect(
        uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence),
      ).rejects.toThrow(/no longer exists on the storage provider/i);

      // Exactly two attempts: the stale session, then one clean retry.
      expect(putRawSpy).toHaveBeenCalledTimes(2);
    });

    it('still reports a non-404 part failure as a normal per-part error', async () => {
      const { api, putRawSpy } = makeFakeApi({});
      (putRawSpy as jest.Mock).mockImplementation((() =>
        Promise.reject(new ApiError(403, 'AccessDenied'))) as ApiClient['putRaw']);
      const { persistence } = makePersistence();

      await expect(
        uploadFile(api as unknown as ApiClient, filePath, 'image/jpeg', undefined, persistence),
      ).rejects.toThrow(/^Part 1 failed:/);
    });
  });
});
