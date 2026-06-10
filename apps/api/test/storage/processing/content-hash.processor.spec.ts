/**
 * Unit tests — ContentHashProcessor
 *
 * No database, no storage provider, no exifr needed here.
 * The getStream callback is mocked to return a Readable over a known buffer.
 * The expected SHA-256 is computed in-test with Node's `crypto` module so
 * the assertion is self-validating.
 */

import { createHash, randomBytes } from 'crypto';
import { ContentHashProcessor } from '../../../src/storage/processing/processors/content-hash.processor';
import { bufferToStream } from '../../fixtures/media/image-fixtures';

// Minimal StorageObject stub — only the fields the processor needs
function makeObject(mimeType = 'image/jpeg') {
  return {
    id: 'obj-001',
    mimeType,
    name: 'test.jpg',
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

describe('ContentHashProcessor', () => {
  let processor: ContentHashProcessor;

  beforeEach(() => {
    processor = new ContentHashProcessor();
  });

  describe('processor identity', () => {
    it('should have name "content-hash"', () => {
      expect(processor.name).toBe('content-hash');
    });

    it('should have priority 10', () => {
      expect(processor.priority).toBe(10);
    });
  });

  describe('canProcess', () => {
    it('should return true for image/jpeg', () => {
      expect(processor.canProcess(makeObject('image/jpeg'))).toBe(true);
    });

    it('should return true for video/mp4', () => {
      expect(processor.canProcess(makeObject('video/mp4'))).toBe(true);
    });

    it('should return true for application/pdf', () => {
      expect(processor.canProcess(makeObject('application/pdf'))).toBe(true);
    });

    it('should return true for arbitrary mime type', () => {
      expect(processor.canProcess(makeObject('application/octet-stream'))).toBe(true);
    });
  });

  describe('process', () => {
    it('should return success:true and a correct sha256 for known bytes', async () => {
      const fixture = Buffer.from('hello memoriaHub');
      const expectedHash = createHash('sha256').update(fixture).digest('hex');

      const result = await processor.process(
        makeObject('image/jpeg'),
        () => Promise.resolve(bufferToStream(fixture)),
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.sha256).toBe(expectedHash);
      expect(result.error).toBeUndefined();
    });

    it('should compute a different hash for different content', async () => {
      const buf1 = Buffer.from('content-a');
      const buf2 = Buffer.from('content-b');
      const hash1 = createHash('sha256').update(buf1).digest('hex');

      const r1 = await processor.process(makeObject(), () =>
        Promise.resolve(bufferToStream(buf1)),
      );
      const r2 = await processor.process(makeObject(), () =>
        Promise.resolve(bufferToStream(buf2)),
      );

      expect(r1.metadata?.sha256).toBe(hash1);
      expect(r1.metadata?.sha256).not.toBe(r2.metadata?.sha256);
    });

    it('should compute the correct sha256 for a larger random buffer', async () => {
      const fixture = randomBytes(4096);
      const expectedHash = createHash('sha256').update(fixture).digest('hex');

      const result = await processor.process(
        makeObject('application/octet-stream'),
        () => Promise.resolve(bufferToStream(fixture)),
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.sha256).toBe(expectedHash);
    });

    it('should produce a 64-character hex string (SHA-256 digest length)', async () => {
      const buf = Buffer.from('any data');
      const result = await processor.process(makeObject(), () =>
        Promise.resolve(bufferToStream(buf)),
      );

      expect(result.success).toBe(true);
      expect(typeof result.metadata?.sha256).toBe('string');
      expect((result.metadata?.sha256 as string).length).toBe(64);
      expect((result.metadata?.sha256 as string)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return success:false when the stream emits an error', async () => {
      const { Readable } = await import('stream');
      const errorStream = new Readable({
        read() {
          this.destroy(new Error('simulated stream error'));
        },
      });

      const result = await processor.process(makeObject(), () =>
        Promise.resolve(errorStream),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('simulated stream error');
    });
  });
});
