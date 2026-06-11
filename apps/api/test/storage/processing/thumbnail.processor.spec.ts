/**
 * Unit tests — ThumbnailProcessor
 *
 * Mock strategy:
 *   - STORAGE_PROVIDER (upload, getBucket) → jest.fn()
 *   - PrismaService (storageObject.create)  → jest.fn()
 *   - sharp is NOT mocked; we use a real sharp-generated 4×4 JPEG buffer so the
 *     full resize path is exercised end-to-end.  See image-fixtures.ts for the
 *     pattern this follows (identical to exif.processor.spec.ts).
 *
 * Recursion guard:
 *   canProcess must return false for any storageKey that starts with
 *   'thumbnails/', and false for non-image MIME types.
 */

import { ThumbnailProcessor } from '../../../src/storage/processing/processors/thumbnail.processor';
import { STORAGE_PROVIDER } from '../../../src/storage/providers/storage-provider.interface';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getPlainJpegBuffer, makeGetStream } from '../../fixtures/media/image-fixtures';
import { Readable } from 'stream';

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
  let mockStorageObjectCreate: jest.Mock;

  beforeEach(async () => {
    mockUpload = jest.fn().mockResolvedValue(undefined);
    mockGetBucket = jest.fn().mockReturnValue(BUCKET_NAME);
    mockStorageObjectCreate = jest.fn().mockResolvedValue({ id: THUMB_ID });

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
              create: mockStorageObjectCreate,
            },
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

    it('should return false for video/mp4', () => {
      expect(processor.canProcess(makeObject({ mimeType: 'video/mp4' }))).toBe(false);
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

    it('should call prisma.storageObject.create exactly once', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockStorageObjectCreate).toHaveBeenCalledTimes(1);
    });

    it('should create StorageObject with status "ready"', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const createArg = mockStorageObjectCreate.mock.calls[0][0];
      expect(createArg.data.status).toBe('ready');
    });

    it('should create StorageObject with mimeType "image/jpeg"', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const createArg = mockStorageObjectCreate.mock.calls[0][0];
      expect(createArg.data.mimeType).toBe('image/jpeg');
    });

    it('should create StorageObject with metadata.thumbnailOf = original id', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      const createArg = mockStorageObjectCreate.mock.calls[0][0];
      expect(createArg.data.metadata).toMatchObject({ thumbnailOf: OBJECT_ID });
    });

    it('should call storageProvider.getBucket() to fill bucket', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockGetBucket).toHaveBeenCalled();
      const createArg = mockStorageObjectCreate.mock.calls[0][0];
      expect(createArg.data.bucket).toBe(BUCKET_NAME);
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

    it('should return success:false when prisma.storageObject.create rejects', async () => {
      mockStorageObjectCreate.mockRejectedValueOnce(new Error('DB constraint violation'));
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
});
