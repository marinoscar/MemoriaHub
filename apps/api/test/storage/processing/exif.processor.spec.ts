/**
 * Unit tests — ExifProcessor
 *
 * Fixture strategy:
 *   - A real sharp-generated 4×4 JPEG is used for the "no EXIF" path (valid
 *     binary, but sharp does not embed EXIF by default).
 *   - For the "has EXIF" path, `exifr` is mocked to return a synthetic record
 *     so the processor's extraction logic is fully exercised without needing a
 *     pre-committed binary with real EXIF tags.  Writing EXIF into a buffer at
 *     test time would require a dependency (`piexifjs`) not present in this
 *     project.  Mocking `exifr` is the spec-recommended deterministic approach.
 */

import { ExifProcessor } from '../../../src/storage/processing/processors/exif.processor';
import { getPlainJpegBuffer, makeGetStream } from '../../fixtures/media/image-fixtures';

// Minimal StorageObject stub
function makeObject(mimeType = 'image/jpeg') {
  return {
    id: 'obj-exif-001',
    mimeType,
    name: 'photo.jpg',
    size: BigInt(0),
    storageKey: 'key',
    storageProvider: 's3',
    bucket: 'bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

// Helper: create a mock exifr parse function
function mockExifrParse(returnValue: Record<string, unknown> | undefined) {
  // exifr is dynamically imported inside the processor using `import()`.
  // We patch the module cache so the dynamic import returns our mock.
  jest.mock('exifr', () => ({
    // exifr default export is accessed as `mod.default ?? mod`
    parse: jest.fn().mockResolvedValue(returnValue),
  }));
}

describe('ExifProcessor', () => {
  let processor: ExifProcessor;

  // Reset module registry so each describe block gets a fresh mock
  beforeEach(() => {
    jest.resetModules();
    processor = new ExifProcessor();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('processor identity', () => {
    it('should have name "exif"', () => {
      expect(processor.name).toBe('exif');
    });

    it('should have priority 20', () => {
      expect(processor.priority).toBe(20);
    });
  });

  describe('canProcess', () => {
    it('should return true for image/jpeg', () => {
      expect(processor.canProcess(makeObject('image/jpeg'))).toBe(true);
    });

    it('should return true for image/png', () => {
      expect(processor.canProcess(makeObject('image/png'))).toBe(true);
    });

    it('should return true for image/heic', () => {
      expect(processor.canProcess(makeObject('image/heic'))).toBe(true);
    });

    it('should return false for video/mp4', () => {
      expect(processor.canProcess(makeObject('video/mp4'))).toBe(false);
    });

    it('should return false for application/pdf', () => {
      expect(processor.canProcess(makeObject('application/pdf'))).toBe(false);
    });

    it('should return false for audio/mpeg', () => {
      expect(processor.canProcess(makeObject('audio/mpeg'))).toBe(false);
    });
  });

  describe('process — with EXIF data (exifr mocked)', () => {
    const MOCK_CAPTURED_AT = new Date('2024-06-15T10:30:00.000Z');
    const MOCK_LAT = 9.9281;
    const MOCK_LNG = -84.0907;
    const MOCK_ALT = 1247.5;

    beforeEach(() => {
      // Mock the exifr module to return a full set of EXIF tags
      jest.doMock('exifr', () => ({
        parse: jest.fn().mockResolvedValue({
          DateTimeOriginal: MOCK_CAPTURED_AT,
          OffsetTimeOriginal: '-06:00',
          latitude: MOCK_LAT,
          longitude: MOCK_LNG,
          altitude: MOCK_ALT,
          Make: 'Apple',
          Model: 'iPhone 15 Pro',
          Orientation: 6,
        }),
      }));
      // Re-create processor after mock is set so the dynamic import picks it up
      processor = new ExifProcessor();
    });

    it('should return success:true', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
    });

    it('should extract capturedAt as ISO 8601 UTC string', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.capturedAt).toBe(MOCK_CAPTURED_AT.toISOString());
    });

    it('should extract capturedAtOffset in minutes from OffsetTimeOriginal', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      // '-06:00' → -(6*60+0) = -360
      expect(result.metadata?.capturedAtOffset).toBe(-360);
    });

    it('should extract GPS latitude', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.latitude).toBe(MOCK_LAT);
    });

    it('should extract GPS longitude', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.longitude).toBe(MOCK_LNG);
    });

    it('should extract GPS altitude', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.altitude).toBe(MOCK_ALT);
    });

    it('should extract cameraMake (trimmed)', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.cameraMake).toBe('Apple');
    });

    it('should extract cameraModel (trimmed)', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.cameraModel).toBe('iPhone 15 Pro');
    });

    it('should extract EXIF orientation', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.orientation).toBe(6);
    });
  });

  describe('process — capturedAtOffset with positive offset', () => {
    beforeEach(() => {
      jest.doMock('exifr', () => ({
        parse: jest.fn().mockResolvedValue({
          DateTimeOriginal: new Date('2024-06-15T10:30:00.000Z'),
          OffsetTimeOriginal: '+05:30',
          latitude: 12.0,
          longitude: 77.0,
          Make: 'Samsung',
          Model: 'Galaxy S24',
          Orientation: 1,
        }),
      }));
      processor = new ExifProcessor();
    });

    it('should parse a positive UTC offset correctly (+05:30 → 330)', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      // '+05:30' → +(5*60+30) = 330
      expect(result.metadata?.capturedAtOffset).toBe(330);
    });
  });

  describe('process — no EXIF data (plain JPEG without EXIF, exifr mocked to return undefined)', () => {
    beforeEach(() => {
      jest.doMock('exifr', () => ({
        parse: jest.fn().mockResolvedValue(undefined),
      }));
      processor = new ExifProcessor();
    });

    it('should return success:true without throwing', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should not include capturedAt in metadata when absent', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.capturedAt).toBeUndefined();
    });

    it('should return empty metadata object', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata).toEqual({});
    });
  });

  describe('process — exifr throws (error resilience)', () => {
    beforeEach(() => {
      jest.doMock('exifr', () => ({
        parse: jest.fn().mockRejectedValue(new Error('parse error')),
      }));
      processor = new ExifProcessor();
    });

    it('should return success:true and empty metadata when exifr.parse rejects', async () => {
      // exifr errors are caught internally via .catch(() => undefined)
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({});
    });
  });

  describe('process — partial EXIF (missing GPS)', () => {
    beforeEach(() => {
      jest.doMock('exifr', () => ({
        parse: jest.fn().mockResolvedValue({
          DateTimeOriginal: new Date('2024-01-01T12:00:00.000Z'),
          Make: 'Canon',
          Model: 'EOS R5',
          Orientation: 1,
          // no GPS, no offset
        }),
      }));
      processor = new ExifProcessor();
    });

    it('should not set latitude/longitude when GPS absent', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.metadata?.latitude).toBeUndefined();
      expect(result.metadata?.longitude).toBeUndefined();
      expect(result.metadata?.capturedAt).toBe('2024-01-01T12:00:00.000Z');
      expect(result.metadata?.cameraMake).toBe('Canon');
    });
  });
});
