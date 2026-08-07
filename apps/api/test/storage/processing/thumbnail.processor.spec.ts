/**
 * Unit tests — ThumbnailProcessor
 *
 * Mock strategy:
 *   - STORAGE_PROVIDER (upload, getBucket) → jest.fn()
 *   - PrismaService (storageObject.upsert)  → jest.fn()
 *   - sharp is NOT mocked; we use a real sharp-generated 4×4 JPEG buffer so the
 *     full resize path is exercised end-to-end.  See image-fixtures.ts for the
 *     pattern this follows (identical to exif.processor.spec.ts).
 *
 * Recursion guard:
 *   canProcess must return false for any storageKey that starts with
 *   'thumbnails/', and false for non-image MIME types.
 *
 * Video path mock strategy:
 *   The video path calls:
 *     - fs.writeFile / fs.readFile / fs.unlink  (temp file management)
 *     - the shared parity package's `extractPosterFrame`, which shells out via
 *       `@memoriahub/enrichment-compute/ffmpeg`'s `runFfmpeg` — a thin
 *       `spawn()` wrapper that replaced the deprecated `fluent-ffmpeg`
 *       dependency in issue #219.
 *   Both are module-level mocks (jest.mock hoisting) so the processor module
 *   gets the mock version before it is imported.
 *
 *   Only `runFfmpeg` is stubbed; `buildFrameExtractionArgs` stays REAL, so the
 *   ladder's per-attempt seek/filter facts asserted below are read back out of
 *   the genuine argv rather than out of a hand-rolled fluent chain. That makes
 *   this spec a corroborating parity check on top of the authoritative argv
 *   pins in packages/enrichment-compute/test/ffmpeg.test.mjs.
 *
 *   mockFfmpegInvokeEnd() / mockFfmpegInvokeError() control the outcome of a
 *   single, non-scripted call (legacy single-mode path used by the original
 *   tests below).
 *
 *   mockFfmpegQueue([...]) scripts an exact outcome per successive runFfmpeg
 *   call ('success' | 'error'), used by the 3-attempt ladder tests to assert
 *   precisely which attempt fails/succeeds and what seek/filter arguments each
 *   attempt used.
 *
 *   fs.promises is mocked so writeFile and unlink are no-ops and readFile
 *   returns a real JPEG buffer obtained from getPlainJpegBuffer().
 */

import { ThumbnailProcessor } from '../../../src/storage/processing/processors/thumbnail.processor';
import { STORAGE_PROVIDER } from '../../../src/storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../../../src/storage/providers/storage-provider.resolver';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getPlainJpegBuffer, makeGetStream } from '../../fixtures/media/image-fixtures';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// ffmpeg runner mock (the shared package's spawn() wrapper)
// ---------------------------------------------------------------------------
//
// Because jest.mock() is hoisted to the top of the file, we cannot reference
// variables declared in module scope inside the factory.  Instead, the factory
// uses a module-scoped state object (ffmpegMockState) that IS accessible from
// inside the mocked function because it is evaluated at call-time, not at
// hoist-time.  The object is populated immediately, before any test code runs.
//
// mockFfmpegInvokeEnd()   — next runFfmpeg call succeeds (default).
// mockFfmpegInvokeError() — next runFfmpeg call rejects; auto-resets to
//                           'success' afterwards so the fallback call succeeds.

type FfmpegStep = { kind: 'success' } | { kind: 'error'; message?: string };

const ffmpegMockState = {
  mode: 'success' as 'success' | 'error',
  queue: [] as FfmpegStep[],
  runCallCount: 0,
  /** Every argv the processor would have spawned, in order. */
  runArgs: [] as string[][],
};

/** The `-ss` value of each attempt that used an input seek, in order. */
function seekInputCalls(): number[] {
  return ffmpegMockState.runArgs
    .filter((args) => args.includes('-ss'))
    .map((args) => Number(args[args.indexOf('-ss') + 1]));
}

/** The `-filter:v` value of each attempt that used a video filter, in order. */
function videoFiltersCalls(): string[] {
  return ffmpegMockState.runArgs
    .filter((args) => args.includes('-filter:v'))
    .map((args) => args[args.indexOf('-filter:v') + 1]);
}

function mockFfmpegInvokeEnd() {
  ffmpegMockState.mode = 'success';
}

function mockFfmpegInvokeError() {
  ffmpegMockState.mode = 'error';
}

/**
 * Script exact per-attempt ffmpeg outcomes. Each element is consumed by one
 * runFfmpeg call, in order; once the queue is drained, the runner falls back to
 * the legacy single `mode` behaviour.
 */
function mockFfmpegQueue(steps: FfmpegStep[]) {
  ffmpegMockState.queue = [...steps];
}

function resetFfmpegMock() {
  ffmpegMockState.mode = 'success';
  ffmpegMockState.queue = [];
  ffmpegMockState.runCallCount = 0;
  ffmpegMockState.runArgs = [];
}

jest.mock('@memoriahub/enrichment-compute/ffmpeg', () => {
  // ffmpegMockState is in the enclosing module scope and is safely accessible
  // here because this factory is called at import time (after module scope
  // initialisation), not when jest.mock() is hoisted.
  const actual = jest.requireActual('@memoriahub/enrichment-compute/ffmpeg');
  return {
    ...actual,
    runFfmpeg: jest.fn(async (args: string[]) => {
      ffmpegMockState.runCallCount++;
      ffmpegMockState.runArgs.push([...args]);

      const step: FfmpegStep = ffmpegMockState.queue.length
        ? ffmpegMockState.queue.shift()!
        : // Legacy single-mode path (auto-resets to 'success' so a fallback
          // call succeeds), used by the original tests that call
          // mockFfmpegInvokeEnd()/mockFfmpegInvokeError() directly.
          (() => {
            if (ffmpegMockState.mode === 'error') {
              ffmpegMockState.mode = 'success';
              return { kind: 'error', message: 'ffmpeg: clip too short' } as FfmpegStep;
            }
            return { kind: 'success' } as FfmpegStep;
          })();

      if (step.kind === 'error') {
        throw new Error(step.message ?? 'ffmpeg: mock error');
      }
    }),
  };
});

// ---------------------------------------------------------------------------
// fs mock (promises API used by the processor)
// ---------------------------------------------------------------------------
//
// The processor calls fs.writeFile, fs.readFile, fs.stat, and fs.unlink.
// writeFile and unlink are stubs; readFile returns a real JPEG buffer; stat
// reports a non-empty file so the post-extraction output validation passes
// (ffmpeg is mocked, so no real frame is ever written to disk).

let mockFsReadFileBuffer: Buffer = Buffer.alloc(0);

jest.mock('fs', () => {
  const originalFs = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...originalFs,
    promises: {
      ...originalFs.promises,
      writeFile: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(mockFsReadFileBuffer)),
      stat: jest.fn().mockImplementation(() => Promise.resolve({ size: 1 })),
      unlink: jest.fn().mockResolvedValue(undefined),
    },
  };
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const OBJECT_ID = 'obj-thumb-001';
const THUMB_ID = 'thumb-obj-001';
const BUCKET_NAME = 'test-bucket';

function makeObject(overrides: { mimeType?: string; storageKey?: string } = {}) {
  return {
    id: OBJECT_ID,
    mimeType: overrides.mimeType ?? 'image/jpeg',
    name: 'photo.jpg',
    size: BigInt(0),
    storageKey: overrides.storageKey ?? 'originals/photo.jpg',
    storageProvider: 's3',
    bucket: BUCKET_NAME,
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThumbnailProcessor', () => {
  let processor: ThumbnailProcessor;
  let mockUpload: jest.Mock;
  let mockGetBucket: jest.Mock;
  let mockStorageObjectUpsert: jest.Mock;

  beforeEach(async () => {
    mockUpload = jest.fn().mockResolvedValue(undefined);
    mockGetBucket = jest.fn().mockReturnValue(BUCKET_NAME);
    mockStorageObjectUpsert = jest.fn().mockResolvedValue({ id: THUMB_ID });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailProcessor,
        {
          provide: STORAGE_PROVIDER,
          useValue: {
            upload: mockUpload,
            getBucket: mockGetBucket,
          },
        },
        {
          provide: PrismaService,
          useValue: {
            storageObject: {
              upsert: mockStorageObjectUpsert,
            },
          },
        },
        {
          provide: StorageProviderResolver,
          useValue: {
            getActiveProvider: jest.fn().mockResolvedValue({
              id: 's3',
              provider: { upload: mockUpload, getBucket: mockGetBucket },
            }),
            getProviderFor: jest.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<ThumbnailProcessor>(ThumbnailProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Processor identity
  // -------------------------------------------------------------------------

  describe('processor identity', () => {
    it('should have name "thumbnail"', () => {
      expect(processor.name).toBe('thumbnail');
    });

    it('should have priority 40', () => {
      expect(processor.priority).toBe(40);
    });
  });

  // -------------------------------------------------------------------------
  // canProcess
  // -------------------------------------------------------------------------

  describe('canProcess', () => {
    it('should return true for image/jpeg', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'image/jpeg' }))).toBe(true);
    });

    it('should return true for image/png', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'image/png' }))).toBe(true);
    });

    it('should return true for image/heic', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'image/heic' }))).toBe(true);
    });

    it('should return true for image/webp', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'image/webp' }))).toBe(true);
    });

    it('should return true for video/mp4', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'video/mp4' }))).toBe(true);
    });

    it('should return true for video/quicktime', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'video/quicktime' }))).toBe(true);
    });

    it('should return false for application/pdf', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'application/pdf' }))).toBe(false);
    });

    it('should return false for audio/mpeg', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'audio/mpeg' }))).toBe(false);
    });

    // Recursion guard
    it('should return false when storageKey starts with "thumbnails/"', () => {
      expect(
        processor.canProcess(
          makeObject({ mimeType: 'image/jpeg', storageKey: 'thumbnails/obj-001.jpg' }),
        ),
      ).toBe(false);
    });

    it('should return false for a thumbnail-path key even if mimeType is image/*', () => {
      expect(
        processor.canProcess(
          makeObject({ mimeType: 'image/png', storageKey: 'thumbnails/nested/thumb.jpg' }),
        ),
      ).toBe(false);
    });

    it('should return true when key starts with "thumbnails" but not "thumbnails/"', () => {
      // Edge: "thumbnails-other/..." is NOT the thumbnails/ prefix
      expect(
        processor.canProcess(
          makeObject({ mimeType: 'image/jpeg', storageKey: 'thumbnails-extra/photo.jpg' }),
        ),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // process — happy path with a real sharp buffer
  // -------------------------------------------------------------------------

  describe('process — success path (real sharp resize)', () => {
    it('should return success:true', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should include thumbnailObjectId in returned metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.thumbnailObjectId).toBe(THUMB_ID);
    });

    it('should include thumbnailStorageKey in returned metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.thumbnailStorageKey).toBe(`thumbnails/${OBJECT_ID}.jpg`);
    });

    it('should call storageProvider.upload exactly once', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockUpload).toHaveBeenCalledTimes(1);
    });

    it('should call storageProvider.upload with image/jpeg mimeType', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const [key, , options] = mockUpload.mock.calls[0];
      expect(options).toMatchObject({ mimeType: 'image/jpeg' });
      expect(key).toBe(`thumbnails/${OBJECT_ID}.jpg`);
    });

    it('should call storageProvider.upload with a key starting with "thumbnails/"', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const [uploadedKey] = mockUpload.mock.calls[0];
      expect(uploadedKey).toMatch(/^thumbnails\//);
    });

    it('should call prisma.storageObject.upsert exactly once', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockStorageObjectUpsert).toHaveBeenCalledTimes(1);
    });

    it('should upsert with where: { storageKey: thumbnails/<id>.jpg }', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const upsertArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({ storageKey: `thumbnails/${OBJECT_ID}.jpg` });
    });

    it('should create StorageObject with status "ready"', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const createArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(createArg.create.status).toBe('ready');
    });

    it('should create StorageObject with mimeType "image/jpeg"', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const createArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(createArg.create.mimeType).toBe('image/jpeg');
    });

    it('should create StorageObject with metadata.thumbnailOf = original id', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const createArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(createArg.create.metadata).toMatchObject({ thumbnailOf: OBJECT_ID });
    });

    it('should call storageProvider.getBucket() to fill bucket', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockGetBucket).toHaveBeenCalled();
      const createArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(createArg.create.bucket).toBe(BUCKET_NAME);
    });

    it('should upload the processed buffer as a Readable stream', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const [, stream] = mockUpload.mock.calls[0];
      expect(stream).toBeInstanceOf(Readable);
    });
  });

  // -------------------------------------------------------------------------
  // process — error resilience
  // -------------------------------------------------------------------------

  describe('process — error handling', () => {
    it('should return success:false when storageProvider.upload rejects', async () => {
      mockUpload.mockRejectedValueOnce(new Error('S3 connection error'));
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(false);
      expect(result.error).toContain('S3 connection error');
    });

    it('should return success:false when prisma.storageObject.upsert rejects', async () => {
      mockStorageObjectUpsert.mockRejectedValueOnce(new Error('DB constraint violation'));
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(false);
      expect(result.error).toContain('DB constraint violation');
    });

    it('should return success:false when the stream emits an error', async () => {
      const errorStream = new Readable({
        read() {
          this.destroy(new Error('stream error'));
        },
      });
      const result = await processor.process(makeObject(), () =>
        Promise.resolve(errorStream),
      );
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
    });

    it('should not throw — always returns a result object', async () => {
      mockUpload.mockRejectedValueOnce(new Error('any error'));
      const buf = await getPlainJpegBuffer();
      await expect(
        processor.process(makeObject(), makeGetStream(buf)),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Configurable dimensions and quality (env vars read at construction time)
  // -------------------------------------------------------------------------

  describe('configurable dimensions and quality', () => {
    afterEach(() => {
      delete process.env.THUMBNAIL_MAX_DIM;
      delete process.env.THUMBNAIL_QUALITY;
    });

    it('should default maxDim to 800 when THUMBNAIL_MAX_DIM is not set', async () => {
      // Env var is NOT set — the module was compiled in beforeEach without it
      expect((processor as any).maxDim).toBe(800);
    });

    it('should default quality to 85 when THUMBNAIL_QUALITY is not set', () => {
      expect((processor as any).quality).toBe(85);
    });

    it('should pick up custom THUMBNAIL_MAX_DIM when set before module compile', async () => {
      process.env.THUMBNAIL_MAX_DIM = '200';
      process.env.THUMBNAIL_QUALITY = '70';

      const customModule: TestingModule = await Test.createTestingModule({
        providers: [
          ThumbnailProcessor,
          {
            provide: STORAGE_PROVIDER,
            useValue: {
              upload: jest.fn().mockResolvedValue(undefined),
              getBucket: jest.fn().mockReturnValue(BUCKET_NAME),
            },
          },
          {
            provide: PrismaService,
            useValue: {
              storageObject: {
                upsert: jest.fn().mockResolvedValue({ id: THUMB_ID }),
              },
            },
          },
          {
            provide: StorageProviderResolver,
            useValue: {
              getActiveProvider: jest.fn(),
              getProviderFor: jest.fn(),
            },
          },
        ],
      }).compile();

      const customProcessor = customModule.get<ThumbnailProcessor>(ThumbnailProcessor);
      expect((customProcessor as any).maxDim).toBe(200);
      expect((customProcessor as any).quality).toBe(70);
    });

    it('should succeed with default settings (800/85) on a real jpeg buffer', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
    });

    it('should succeed with custom env settings (200/70) on a real jpeg buffer', async () => {
      process.env.THUMBNAIL_MAX_DIM = '200';
      process.env.THUMBNAIL_QUALITY = '70';

      const customUpload = jest.fn().mockResolvedValue(undefined);
      const customUpsert = jest.fn().mockResolvedValue({ id: THUMB_ID });

      const customModule: TestingModule = await Test.createTestingModule({
        providers: [
          ThumbnailProcessor,
          {
            provide: STORAGE_PROVIDER,
            useValue: {
              upload: customUpload,
              getBucket: jest.fn().mockReturnValue(BUCKET_NAME),
            },
          },
          {
            provide: PrismaService,
            useValue: {
              storageObject: { upsert: customUpsert },
            },
          },
          {
            provide: StorageProviderResolver,
            useValue: {
              getActiveProvider: jest.fn().mockResolvedValue({
                id: 's3',
                provider: { upload: customUpload, getBucket: jest.fn().mockReturnValue(BUCKET_NAME) },
              }),
              getProviderFor: jest.fn(),
            },
          },
        ],
      }).compile();

      const customProcessor = customModule.get<ThumbnailProcessor>(ThumbnailProcessor);
      const buf = await getPlainJpegBuffer();
      const result = await customProcessor.process(makeObject(), makeGetStream(buf));

      expect(result.success).toBe(true);
      expect(customUpload).toHaveBeenCalledTimes(1);
      expect(customUpsert).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Video path — poster-frame extraction
  // -------------------------------------------------------------------------

  describe('process — video path (poster-frame thumbnail)', () => {
    let jpegBuf: Buffer;

    beforeAll(async () => {
      jpegBuf = await getPlainJpegBuffer();
    });

    beforeEach(() => {
      resetFfmpegMock();
      mockFfmpegInvokeEnd(); // default: 1s-seek succeeds
      mockFsReadFileBuffer = jpegBuf; // readFile returns a real JPEG
    });

    it('should return success:true for a video/mp4 object', async () => {
      const result = await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return thumbnailObjectId in metadata', async () => {
      const result = await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      expect(result.metadata?.thumbnailObjectId).toBe(THUMB_ID);
    });

    it('should return thumbnailStorageKey = thumbnails/<id>.jpg in metadata', async () => {
      const result = await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      expect(result.metadata?.thumbnailStorageKey).toBe(`thumbnails/${OBJECT_ID}.jpg`);
    });

    it('should call storageProvider.upload with thumbnails/<id>.jpg key', async () => {
      await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      const [uploadedKey, , options] = mockUpload.mock.calls[0];
      expect(uploadedKey).toBe(`thumbnails/${OBJECT_ID}.jpg`);
      expect(options).toMatchObject({ mimeType: 'image/jpeg' });
    });

    it('should call storageProvider.upload with a Readable stream', async () => {
      await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      const [, stream] = mockUpload.mock.calls[0];
      expect(stream).toBeInstanceOf(Readable);
    });

    it('should create a StorageObject with status "ready"', async () => {
      await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      const createArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(createArg.create.status).toBe('ready');
    });

    it('should create a StorageObject with mimeType "image/jpeg"', async () => {
      await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      const createArg = mockStorageObjectUpsert.mock.calls[0][0];
      expect(createArg.create.mimeType).toBe('image/jpeg');
    });

    it('should succeed when 1s-seek fails but 0s-seek (fallback) succeeds', async () => {
      // First extractFrame call (seekInput 1) fires 'error'; second (seekInput 0) fires 'end'.
      mockFfmpegInvokeError(); // mode='error' for the first run() call; stub auto-resets to 'success'

      const result = await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.thumbnailObjectId).toBe(THUMB_ID);
    });

    it('should clean up temp files even when ffmpeg fails', async () => {
      const { promises: fsMock } = require('fs');
      fsMock.readFile.mockRejectedValueOnce(new Error('frame read error'));
      mockFfmpegInvokeError();

      await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );

      // unlink is called in the finally block — must not throw regardless
      expect(fsMock.unlink).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Three-attempt fallback ladder: 1s seek -> 0s seek -> 'thumbnail' filter
    // -----------------------------------------------------------------------

    describe('three-attempt fallback ladder', () => {
      it('should seek to 1s then 0s (no videoFilters) when attempt 1 errors and attempt 2 succeeds', async () => {
        mockFfmpegQueue([
          { kind: 'error', message: 'attempt 1: seek 1s failed' },
          { kind: 'success' },
        ]);

        const result = await processor.process(
          makeObject({ mimeType: 'video/mp4' }),
          makeGetStream(jpegBuf),
        );

        expect(result.success).toBe(true);
        expect(seekInputCalls()).toEqual([1, 0]);
        expect(videoFiltersCalls()).toEqual([]);
      });

      it('should fall through to the "thumbnail" video filter (seekSecs=null) when attempts 1 and 2 both error', async () => {
        mockFfmpegQueue([
          { kind: 'error', message: 'attempt 1: seek 1s failed' },
          { kind: 'error', message: 'attempt 2: seek 0s failed' },
          { kind: 'success' },
        ]);

        const result = await processor.process(
          makeObject({ mimeType: 'video/mp4' }),
          makeGetStream(jpegBuf),
        );

        expect(result.success).toBe(true);
        expect(seekInputCalls()).toEqual([1, 0]);
        expect(videoFiltersCalls()).toEqual(['thumbnail']);
      });

      it('should return success:false with the LAST attempt\'s error message when all three attempts error', async () => {
        mockFfmpegQueue([
          { kind: 'error', message: 'attempt 1: seek 1s failed' },
          { kind: 'error', message: 'attempt 2: seek 0s failed' },
          { kind: 'error', message: 'attempt 3: thumbnail filter failed' },
        ]);

        const result = await processor.process(
          makeObject({ mimeType: 'video/mp4' }),
          makeGetStream(jpegBuf),
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('attempt 3: thumbnail filter failed');
        // All three rungs of the ladder were attempted, in order.
        expect(seekInputCalls()).toEqual([1, 0]);
        expect(videoFiltersCalls()).toEqual(['thumbnail']);
      });

      it('should not throw — total ladder failure still resolves to a result object', async () => {
        mockFfmpegQueue([
          { kind: 'error' },
          { kind: 'error' },
          { kind: 'error' },
        ]);

        await expect(
          processor.process(makeObject({ mimeType: 'video/mp4' }), makeGetStream(jpegBuf)),
        ).resolves.toMatchObject({ success: false });
      });
    });

    // -----------------------------------------------------------------------
    // Empty-output detection: ffmpeg exits cleanly ('end') but writes a
    // zero-byte file — assertNonEmptyFile must treat this as attempt failure.
    // -----------------------------------------------------------------------

    describe('empty-output detection', () => {
      it('should treat an empty output file as a failed attempt and fall back to the next attempt', async () => {
        const { promises: fsMock } = require('fs');
        // Attempt 1's ffmpeg run "succeeds" (fires 'end') but produces a
        // zero-byte file; attempt 2's output is non-empty (default stat mock).
        fsMock.stat.mockResolvedValueOnce({ size: 0 });
        mockFfmpegQueue([{ kind: 'success' }, { kind: 'success' }]);

        const result = await processor.process(
          makeObject({ mimeType: 'video/mp4' }),
          makeGetStream(jpegBuf),
        );

        expect(result.success).toBe(true);
        // Two ffmpeg attempts occurred: the first "succeeded" but was empty.
        expect(seekInputCalls()).toEqual([1, 0]);
        // The empty tmpOut from attempt 1 must be unlinked before attempt 2
        // reuses the same tmpOut path (plus the two finally-block cleanups).
        expect(fsMock.unlink.mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      it('should return success:false with an "empty output file" message when every attempt produces a zero-byte file', async () => {
        const { promises: fsMock } = require('fs');
        fsMock.stat
          .mockResolvedValueOnce({ size: 0 })
          .mockResolvedValueOnce({ size: 0 })
          .mockResolvedValueOnce({ size: 0 });
        mockFfmpegQueue([{ kind: 'success' }, { kind: 'success' }, { kind: 'success' }]);

        const result = await processor.process(
          makeObject({ mimeType: 'video/mp4' }),
          makeGetStream(jpegBuf),
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('empty output file');
        expect(seekInputCalls()).toEqual([1, 0]);
        expect(videoFiltersCalls()).toEqual(['thumbnail']);
      });
    });
  });
});
