/**
 * test/upload-part-auth.spec.ts
 *
 * uploadFile() against the two kinds of part URL (issue #506):
 *  - partUploadAuth 'none'   → presigned S3/R2 URLs, PUT with no credential
 *    (ApiClient.putRaw), exactly as before;
 *  - partUploadAuth 'bearer' → the API's own part route (local storage
 *    provider), PUT with the bearer credential to the CLI's own server
 *    (ApiClient.putPart, given only the URL's path).
 * Plus the two recoverable complete-time conflicts: UPLOAD_PARTS_MISSING
 * (re-send only the listed parts) and UPLOAD_SESSION_INVALID (re-init).
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uploadFile, apiPathOfPartUrl } from '../src/upload.js';
import { ApiError } from '../src/api.js';
import type { ApiClient } from '../src/api.js';

const PART_SIZE = 10;
const TOTAL_PARTS = 3;
const FILE_SIZE = PART_SIZE * TOTAL_PARTS;
const APP_URL = 'https://photos.example.test';

const apiPartUrl = (objectId: string, n: number) =>
  `${APP_URL}/api/storage/objects/${objectId}/upload/parts/${n}`;

function makeTempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-auth-test-'));
  const filePath = path.join(dir, 'clip.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(FILE_SIZE, 0xab));
  return filePath;
}

const conflict = (reason: string, extra: Record<string, unknown> = {}) =>
  new ApiError(409, 'conflict', null, false, {
    statusCode: 409,
    code: 'CONFLICT',
    message: 'conflict',
    details: { reason, ...extra },
  });

interface FakeOpts {
  /** 'bearer' | 'none' | undefined (an older server omits the field). */
  partUploadAuth?: 'none' | 'bearer';
  /** Errors thrown by successive POST /upload/complete calls, then success. */
  completeErrors?: Error[];
  /** Errors thrown by successive part PUTs (either kind), then success. */
  putErrors?: Error[];
}

function makeFakeApi(opts: FakeOpts) {
  const completeErrors = [...(opts.completeErrors ?? [])];
  const putErrors = [...(opts.putErrors ?? [])];
  let inits = 0;
  let eTagSeq = 0;

  const urlFor = (objectId: string, n: number) =>
    opts.partUploadAuth === 'bearer' ? apiPartUrl(objectId, n) : `https://s3.test/${objectId}/part${n}`;

  const post = jest.fn(async (url: string, body: unknown): Promise<unknown> => {
    if (url === '/api/storage/objects/upload/init') {
      inits += 1;
      const objectId = `obj-${inits}`;
      return {
        objectId,
        uploadId: `upload-${inits}`,
        partSize: PART_SIZE,
        totalParts: TOTAL_PARTS,
        presignedUrls: Array.from({ length: TOTAL_PARTS }, (_, i) => ({
          partNumber: i + 1,
          url: urlFor(objectId, i + 1),
        })),
        ...(opts.partUploadAuth ? { partUploadAuth: opts.partUploadAuth } : {}),
      };
    }
    const objectId = url.split('/')[4]!;
    if (url.endsWith('/upload/part-urls')) {
      const { partNumbers } = body as { partNumbers: number[] };
      return {
        presignedUrls: partNumbers.map((n) => ({ partNumber: n, url: urlFor(objectId, n) })),
        ...(opts.partUploadAuth ? { partUploadAuth: opts.partUploadAuth } : {}),
      };
    }
    if (url.endsWith('/upload/complete')) {
      const err = completeErrors.shift();
      if (err) throw err;
      return {};
    }
    throw new Error(`Unexpected POST ${url}`);
  });

  const nextPut = async (): Promise<string> => {
    const err = putErrors.shift();
    if (err) throw err;
    eTagSeq += 1;
    return `"etag-${eTagSeq}"`;
  };
  const putRaw = jest.fn(async (_url: string, _buf: Buffer, _type?: string) => nextPut());
  const putPart = jest.fn(async (_path: string, _buf: Buffer) => nextPut());
  const get = jest.fn(async () => ({ status: 'uploading' }));

  const api = { post, get, putRaw, putPart } as unknown as ApiClient;
  return { api, post, putRaw, putPart };
}

const completeCalls = (post: jest.Mock) =>
  post.mock.calls.filter(([url]) => String(url).endsWith('/upload/complete'));

describe('uploadFile — part URL authentication (issue #506)', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = makeTempFile();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("'bearer': PUTs every part through the API with the credential, by path only", async () => {
    const { api, putRaw, putPart } = makeFakeApi({ partUploadAuth: 'bearer' });

    await uploadFile(api, filePath, 'video/mp4');

    expect(putRaw).not.toHaveBeenCalled();
    expect(putPart.mock.calls.map(([p]) => p)).toEqual([
      '/api/storage/objects/obj-1/upload/parts/1',
      '/api/storage/objects/obj-1/upload/parts/2',
      '/api/storage/objects/obj-1/upload/parts/3',
    ]);
    expect(putPart.mock.calls.map(([, buf]) => (buf as Buffer).length)).toEqual([10, 10, 10]);
  });

  it("'none': PUTs every part straight to the presigned URL with no credential", async () => {
    const { api, putRaw, putPart } = makeFakeApi({ partUploadAuth: 'none' });

    await uploadFile(api, filePath, 'video/mp4');

    expect(putPart).not.toHaveBeenCalled();
    expect(putRaw.mock.calls.map(([u, , t]) => [u, t])).toEqual([
      ['https://s3.test/obj-1/part1', 'video/mp4'],
      ['https://s3.test/obj-1/part2', 'video/mp4'],
      ['https://s3.test/obj-1/part3', 'video/mp4'],
    ]);
  });

  it('an older server that omits partUploadAuth is treated as presigned', async () => {
    const { api, putRaw, putPart } = makeFakeApi({});

    await uploadFile(api, filePath, 'video/mp4');

    expect(putRaw).toHaveBeenCalledTimes(TOTAL_PARTS);
    expect(putPart).not.toHaveBeenCalled();
  });

  it('a resumed upload takes the auth mode from upload/part-urls', async () => {
    const { api, putPart, post } = makeFakeApi({ partUploadAuth: 'bearer' });
    const persistence = {
      onInit: jest.fn(),
      onPartComplete: jest.fn(),
      onComplete: jest.fn(),
      getResumeState: jest.fn(() => ({
        objectId: 'obj-9',
        uploadId: 'upload-9',
        partSize: PART_SIZE,
        completedParts: [{ partNumber: 1, eTag: '"done"' }],
      })),
    };

    await uploadFile(api, filePath, 'video/mp4', undefined, persistence);

    expect(post.mock.calls.some(([u]) => u === '/api/storage/objects/upload/init')).toBe(false);
    expect(putPart.mock.calls.map(([p]) => p)).toEqual([
      '/api/storage/objects/obj-9/upload/parts/2',
      '/api/storage/objects/obj-9/upload/parts/3',
    ]);
  });

  it('409 UPLOAD_PARTS_MISSING: re-sends only the listed parts, then completes on the same session', async () => {
    const { api, post, putPart } = makeFakeApi({
      partUploadAuth: 'bearer',
      completeErrors: [conflict('UPLOAD_PARTS_MISSING', { partNumbers: [2] })],
    });
    const onPartComplete = jest.fn();
    const persistence = {
      onInit: jest.fn(),
      onPartComplete,
      onComplete: jest.fn(),
      getResumeState: jest.fn(() => null),
    };

    const result = await uploadFile(api, filePath, 'video/mp4', undefined, persistence);

    expect(result.objectId).toBe('obj-1');
    expect(putPart).toHaveBeenCalledTimes(TOTAL_PARTS + 1);
    expect(putPart.mock.calls[3]![0]).toBe('/api/storage/objects/obj-1/upload/parts/2');
    expect(onPartComplete).toHaveBeenLastCalledWith(2, '"etag-4"');

    const completes = completeCalls(post);
    expect(completes).toHaveLength(2);
    expect((completes[1]![1] as { parts: unknown }).parts).toEqual([
      { partNumber: 1, eTag: '"etag-1"' },
      { partNumber: 2, eTag: '"etag-4"' },
      { partNumber: 3, eTag: '"etag-3"' },
    ]);
    // No re-init: the session was kept.
    expect(post.mock.calls.filter(([u]) => u === '/api/storage/objects/upload/init')).toHaveLength(1);
  });

  it('gives up when parts keep going missing', async () => {
    const missing = () => conflict('UPLOAD_PARTS_MISSING', { partNumbers: [1] });
    const { api } = makeFakeApi({
      partUploadAuth: 'bearer',
      completeErrors: [missing(), missing(), missing(), missing()],
    });

    await expect(uploadFile(api, filePath, 'video/mp4')).rejects.toMatchObject({ status: 409 });
  });

  it('409 UPLOAD_SESSION_INVALID on complete: re-initializes the upload', async () => {
    const { api, post } = makeFakeApi({
      partUploadAuth: 'bearer',
      completeErrors: [conflict('UPLOAD_SESSION_INVALID')],
    });

    const result = await uploadFile(api, filePath, 'video/mp4');

    expect(result.objectId).toBe('obj-2');
    expect(post.mock.calls.filter(([u]) => u === '/api/storage/objects/upload/init')).toHaveLength(2);
  });

  it('409 UPLOAD_SESSION_INVALID on a part PUT: re-initializes the upload', async () => {
    const { api, post } = makeFakeApi({
      partUploadAuth: 'bearer',
      putErrors: [conflict('UPLOAD_SESSION_INVALID')],
    });

    const result = await uploadFile(api, filePath, 'video/mp4');

    expect(result.objectId).toBe('obj-2');
    expect(post.mock.calls.filter(([u]) => u === '/api/storage/objects/upload/init')).toHaveLength(2);
  });

  it('reports an API part failure as an API error, not a storage-provider one', async () => {
    const { api } = makeFakeApi({
      partUploadAuth: 'bearer',
      putErrors: [new ApiError(400, 'Part 1 must be exactly 10 bytes')],
    });

    await expect(uploadFile(api, filePath, 'video/mp4')).rejects.toThrow(
      'Part 1 failed: API error 400: Part 1 must be exactly 10 bytes',
    );
  });
});

describe('apiPathOfPartUrl', () => {
  it('keeps only the path (and query) of an absolute URL', () => {
    expect(apiPathOfPartUrl('https://elsewhere.example/api/storage/objects/o/upload/parts/3?x=1')).toBe(
      '/api/storage/objects/o/upload/parts/3?x=1',
    );
  });

  it('passes a path through unchanged', () => {
    expect(apiPathOfPartUrl('/api/storage/objects/o/upload/parts/3')).toBe(
      '/api/storage/objects/o/upload/parts/3',
    );
  });
});
