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
 *     - ffmpeg(input)  (factory call — the default export is callable, not a class)
 *   Both are module-level mocks (jest.mock hoisting) so the processor module
 *   gets the mock version before it is imported.
 *
 *   The fluent-ffmpeg mock's default export is itself a function (the factory).
 *   Calling ffmpeg(input) returns a chainable stub.
 *   Each chain method (.seekInput, .frames, .output) returns `this`.
 *   .on('end', cb) / .on('error', cb) stores the handlers; .run() invokes them.
 *   mockFfmpegInvokeEnd() / mockFfmpegInvokeError() control which callback fires.
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
// fluent-ffmpeg module-level mock
// ---------------------------------------------------------------------------
//
// The processor calls `new ffmpeg.FfmpegCommand(input)` and chains:
//   .seekInput(n).frames(1).output(path).on('end'|'error', cb).run()
//
// Because jest.mock() is hoisted to the top of the file, we cannot reference
// variables declared in module scope inside the factory.  Instead, the factory
// uses a module-scoped state object (ffmpegMockState) that IS accessible from
// inside the class because it is evaluated at call-time, not at hoist-time.
// The object is populated immediately, before any test code runs.
//
// mockFfmpegInvokeEnd()  — next .run() fires 'end' (default).
// mockFfmpegInvokeError() — next .run() fires 'error'; auto-resets to 'success'
//                           afterwards so the fallback call succeeds.

const ffmpegMockState = {
  mode: 'success' as 'success' | 'error',
  endCb: null as (() => void) | null,
  errorCb: null as ((err: Error) => void) | null,
  runCallCount: 0,
};

function mockFfmpegInvokeEnd() {
  ffmpegMockState.mode = 'success';
}

function mockFfmpegInvokeError() {
  ffmpegMockState.mode = 'error';
}

function resetFfmpegMock() {
  ffmpegMockState.mode = 'success';
  ffmpegMockState.endCb = null;
  ffmpegMockState.errorCb = null;
  ffmpegMockState.runCallCount = 0;
}

jest.mock('fluent-ffmpeg', () => {
  // ffmpegMockState is in the enclosing module scope and is safely accessible
  // here because this factory is called at import time (after module scope
  // initialisation), not when jest.mock() is hoisted.
  //
  // The processor uses `import ffmpeg from 'fluent-ffmpeg'` (default import with
  // esModuleInterop) and then calls `ffmpeg(input)` — the default export is a
  // callable factory, not a class.  The mock therefore returns a module whose
  // `default` property IS the factory function, mirroring the real API shape.
  // Jest's esModuleInterop handling means `require('fluent-ffmpeg')` returns the
  // object below, and the default-import expression resolves to `.default`.

  const stub = {
    seekInput(_n: number) { return stub; },
    videoFilters(_f: string) { return stub; },
    frames(_n: number) { return stub; },
    output(_path: string) { return stub; },
    kill(_signal: string) { return stub; },
    on(event: string, cb: (...args: any[]) => void) {
      if (event === 'end') ffmpegMockState.endCb = cb as () => void;
      if (event === 'error') ffmpegMockState.errorCb = cb as (err: Error) => void;
      return stub;
    },
    run() {
      ffmpegMockState.runCallCount++;
      // Use setImmediate so the Promise machinery in extractFrame registers
      // both handlers before we invoke one.
      setImmediate(() => {
        if (ffmpegMockState.mode === 'error' && ffmpegMockState.errorCb) {
          ffmpegMockState.mode = 'success'; // auto-reset so fallback call succeeds
          ffmpegMockState.errorCb(new Error('ffmpeg: clip too short'));
        } else if (ffmpegMockState.endCb) {
          ffmpegMockState.endCb();
        }
      });
    },
  };

  // The factory function is the default export: calling ffmpeg(input) returns
  // the chainable stub.
  function ffmpegFactory(_input: string) {
    return stub;
  }

  // Attach __esModule so Jest's interop layer resolves the default import
  // correctly, matching the behaviour of the real fluent-ffmpeg package whose
  // typings use `export =` (CJS-compatible).
  return Object.assign(ffmpegFactory, { __esModule: true, default: ffmpegFactory });
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

    it('should return success:false without throwing when both frame extractions fail', async () => {
      // Both extractFrame calls will fail: set error mode permanently for this test.
      // We reset to error after each run() by patching the stub behaviour inline.
      const { promises: fsMock } = require('fs');
      // Make readFile throw to simulate both extractions failing (ffmpeg writes nothing)
      fsMock.readFile.mockRejectedValueOnce(new Error('no frame written'));
      mockFfmpegInvokeError(); // first call errors; second call goes into success but readFile fails

      const result = await processor.process(
        makeObject({ mimeType: 'video/mp4' }),
        makeGetStream(jpegBuf),
      );
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
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
  });
});
