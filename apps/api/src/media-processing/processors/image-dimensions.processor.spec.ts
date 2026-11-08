/**
 * Unit tests for ImageDimensionsProcessor.
 *
 * The processor delegates to getOrientedDimensions from the image-orientation
 * utility, which is mocked here so sharp is never invoked.
 *
 * REGRESSION test verifies that the processor stores display-oriented dims
 * (width/height swapped for portrait photos stored with orientation 6).
 */

// ---------------------------------------------------------------------------
// Mock the image-orientation utility so we control what getOrientedDimensions
// returns without pulling in sharp.
// ---------------------------------------------------------------------------

jest.mock('../image-orientation.util', () => ({
  getOrientedDimensions: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { StorageObject, StorageObjectStatus } from '@prisma/client';
import { ImageDimensionsProcessor } from './image-dimensions.processor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrientedDimensionsMock(): jest.Mock {
  return jest.requireMock('../image-orientation.util').getOrientedDimensions as jest.Mock;
}

function makeStorageObject(overrides: Partial<StorageObject> = {}): StorageObject {
  return {
    id: 'obj-1',
    name: 'photo.jpg',
    size: BigInt(12345),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: null,
    status: StorageObjectStatus.ready,
    s3UploadId: null,
    metadata: null,
    uploadedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as StorageObject;
}

function makeGetStream(content: Buffer = Buffer.from('fake-image-data')): () => Promise<Readable> {
  return () => Promise.resolve(Readable.from([content]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageDimensionsProcessor', () => {
  let processor: ImageDimensionsProcessor;
  let getOrientedDimensions: jest.Mock;

  beforeEach(async () => {
    getOrientedDimensions = getOrientedDimensionsMock();
    getOrientedDimensions.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ImageDimensionsProcessor],
    }).compile();

    processor = module.get<ImageDimensionsProcessor>(ImageDimensionsProcessor);
  });

  // -------------------------------------------------------------------------
  // canProcess
  // -------------------------------------------------------------------------

  describe('canProcess', () => {
    it('returns true for image/jpeg', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/jpeg' }))).toBe(true);
    });

    it('returns true for image/png', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/png' }))).toBe(true);
    });

    it('returns true for image/webp', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/webp' }))).toBe(true);
    });

    it('returns true for image/heic', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/heic' }))).toBe(true);
    });

    it('returns true for any image/* MIME type', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/avif' }))).toBe(true);
    });

    it('returns false for video/mp4', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'video/mp4' }))).toBe(false);
    });

    it('returns false for video/* MIME types', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'video/quicktime' }))).toBe(false);
    });

    it('returns false for application/pdf', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'application/pdf' }))).toBe(false);
    });

    it('returns false for application/* MIME types', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'application/octet-stream' }))).toBe(false);
    });

    it('returns false for text/plain', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'text/plain' }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // process
  // -------------------------------------------------------------------------

  describe('process', () => {
    it('returns width and height from getOrientedDimensions', async () => {
      getOrientedDimensions.mockResolvedValue({ width: 1920, height: 1080 });

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({ width: 1920, height: 1080 });
    });

    it('passes the image buffer to getOrientedDimensions', async () => {
      getOrientedDimensions.mockResolvedValue({ width: 800, height: 600 });
      const imageContent = Buffer.from('image-bytes');

      await processor.process(makeStorageObject(), makeGetStream(imageContent));

      expect(getOrientedDimensions).toHaveBeenCalledTimes(1);
      const calledWith = getOrientedDimensions.mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(calledWith)).toBe(true);
      expect(calledWith).toEqual(imageContent);
    });

    it('returns empty metadata when getOrientedDimensions returns null', async () => {
      getOrientedDimensions.mockResolvedValue(null);

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({});
    });

    it('returns { success: false } with error message when getStream throws', async () => {
      const getStream = () => Promise.reject(new Error('stream failed'));

      const result = await processor.process(makeStorageObject(), getStream);

      expect(result.success).toBe(false);
      expect(result.error).toContain('stream failed');
    });

    it('returns { success: false } when getOrientedDimensions throws', async () => {
      getOrientedDimensions.mockRejectedValue(new Error('unexpected error'));

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result.success).toBe(false);
      expect(result.error).toContain('unexpected error');
    });

    it('does not throw when processing fails — always returns a result object', async () => {
      getOrientedDimensions.mockRejectedValue(new Error('processing error'));

      await expect(
        processor.process(makeStorageObject(), makeGetStream()),
      ).resolves.toBeDefined();
    });

    it('includes both width and height in metadata for a normal landscape image', async () => {
      getOrientedDimensions.mockResolvedValue({ width: 3840, height: 2160 });

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result.success).toBe(true);
      expect(result.metadata).toHaveProperty('width', 3840);
      expect(result.metadata).toHaveProperty('height', 2160);
    });

    // -----------------------------------------------------------------------
    // REGRESSION guard: orientation-corrected dims must be stored, not raw dims.
    // This test must fail if the getOrientedDimensions call is replaced with
    // a raw metadata read that doesn't swap axes for portrait-EXIF photos.
    // -----------------------------------------------------------------------
    it('REGRESSION: stores display dims (2252x4000) for orientation-6 image with raw dims 4000x2252', async () => {
      // A portrait photo taken on a phone is stored landscape (4000 wide × 2252 tall)
      // with EXIF orientation=6 (needs 90° CW rotation). The display dimensions
      // must be width=2252, height=4000. getOrientedDimensions returns the swapped
      // values; the processor must store whatever getOrientedDimensions returns.
      getOrientedDimensions.mockResolvedValue({ width: 2252, height: 4000 });

      const result = await processor.process(
        makeStorageObject({ mimeType: 'image/jpeg' }),
        makeGetStream(Buffer.from('portrait-exif-photo')),
      );

      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({ width: 2252, height: 4000 });
      // Explicitly assert the axes are swapped (portrait orientation)
      expect(result.metadata!.width).toBeLessThan(result.metadata!.height as number);
    });
  });
});
