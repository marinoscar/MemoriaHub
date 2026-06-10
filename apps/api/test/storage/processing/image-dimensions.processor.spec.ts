/**
 * Unit tests — ImageDimensionsProcessor
 *
 * Fixture strategy:
 *   - A real sharp-generated 4×4 JPEG is used.  `sharp` is available in the
 *     project's dependencies so this works without any extra setup.
 *   - A 16×8 PNG is generated for a second dimension assertion to show the
 *     processor correctly reports whatever sharp reports.
 */

import { ImageDimensionsProcessor } from '../../../src/storage/processing/processors/image-dimensions.processor';
import { getPlainJpegBuffer, makeGetStream } from '../../fixtures/media/image-fixtures';

function makeObject(mimeType = 'image/jpeg') {
  return {
    id: 'obj-dim-001',
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

async function makePngBuffer(width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 128, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe('ImageDimensionsProcessor', () => {
  let processor: ImageDimensionsProcessor;

  beforeEach(() => {
    processor = new ImageDimensionsProcessor();
  });

  describe('processor identity', () => {
    it('should have name "dimensions"', () => {
      expect(processor.name).toBe('dimensions');
    });

    it('should have priority 25', () => {
      expect(processor.priority).toBe(25);
    });
  });

  describe('canProcess', () => {
    it('should return true for image/jpeg', () => {
      expect(processor.canProcess(makeObject('image/jpeg'))).toBe(true);
    });

    it('should return true for image/png', () => {
      expect(processor.canProcess(makeObject('image/png'))).toBe(true);
    });

    it('should return true for image/webp', () => {
      expect(processor.canProcess(makeObject('image/webp'))).toBe(true);
    });

    it('should return false for video/mp4', () => {
      expect(processor.canProcess(makeObject('video/mp4'))).toBe(false);
    });

    it('should return false for video/quicktime', () => {
      expect(processor.canProcess(makeObject('video/quicktime'))).toBe(false);
    });

    it('should return false for application/pdf', () => {
      expect(processor.canProcess(makeObject('application/pdf'))).toBe(false);
    });
  });

  describe('process', () => {
    it('should return success:true for a valid JPEG', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject('image/jpeg'), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return the correct width and height for the 4×4 JPEG fixture', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject('image/jpeg'), makeGetStream(buf));
      expect(result.metadata?.width).toBe(4);
      expect(result.metadata?.height).toBe(4);
    });

    it('should return correct width and height for a 16×8 PNG', async () => {
      const buf = await makePngBuffer(16, 8);
      const result = await processor.process(makeObject('image/png'), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.metadata?.width).toBe(16);
      expect(result.metadata?.height).toBe(8);
    });

    it('should return correct width and height for a non-square image', async () => {
      const buf = await makePngBuffer(320, 240);
      const result = await processor.process(makeObject('image/png'), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.metadata?.width).toBe(320);
      expect(result.metadata?.height).toBe(240);
    });

    it('should return success:false when given a corrupt/non-image buffer', async () => {
      const garbage = Buffer.from('this is not an image');
      const result = await processor.process(
        makeObject('image/jpeg'),
        makeGetStream(garbage),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
