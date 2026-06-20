/**
 * Unit tests for VisualHashProcessor (dHash + sharpness via sharp).
 *
 * Covers:
 *  - dHash: identical images → Hamming distance 0; clearly-different → large distance
 *  - BigInt popcount / Hamming helper correctness (edge cases)
 *  - Sharpness: sharp image > blurred image
 *  - width=0 guard (graceful skip)
 *
 * sharp is fully mocked because real image processing would require test
 * fixtures and a working libvips binary in CI.
 */

// ---------------------------------------------------------------------------
// Top-level mocks (must precede all imports)
// ---------------------------------------------------------------------------

// Minimal mock for prepareImageForProcessing — just returns the buffer unchanged
// with a known width so the processor continues past the guard check.
jest.mock('../storage/processing/image-orientation.util', () => ({
  prepareImageForProcessing: jest.fn().mockResolvedValue({
    buffer: Buffer.from('prepared'),
    width: 100,
    height: 100,
  }),
}));

// We will configure the sharp mock per test via a factory pattern.
// The factory returns a callable that we can override in individual tests.
const mockToBuffer = jest.fn();
const mockRaw = jest.fn().mockReturnThis();
const mockGrayscale = jest.fn().mockReturnThis();
const mockResize = jest.fn().mockReturnThis();
const mockConvolve = jest.fn().mockReturnThis();
const mockSharpPipeline = {
  resize: mockResize,
  grayscale: mockGrayscale,
  convolve: mockConvolve,
  raw: mockRaw,
  toBuffer: mockToBuffer,
};

jest.mock('sharp', () => {
  const mockSharpFn = jest.fn().mockReturnValue(mockSharpPipeline);
  // Also export as .default so dynamic import('sharp').default works
  (mockSharpFn as any).default = mockSharpFn;
  return mockSharpFn;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { Readable } from 'stream';

/**
 * Build a 72-byte grayscale pixel array representing a 9×8 grid.
 * Each row: leftPixel < rightPixel → sets a bit.
 * Returns the pixel data and the expected hash BigInt.
 */
function buildHashPixels(pattern: 'all_left_lt_right' | 'all_left_gt_right' | 'alternating'): {
  pixels: Uint8Array;
  expectedHash: bigint;
} {
  const pixels = new Uint8Array(9 * 8);
  let expectedHash = 0n;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 9; col++) {
      if (pattern === 'all_left_lt_right') {
        // Each pixel is simply col+1 → left always < right
        pixels[row * 9 + col] = col + 1;
      } else if (pattern === 'all_left_gt_right') {
        // Decreasing left to right
        pixels[row * 9 + col] = 10 - col;
      } else {
        // Alternating: even cols = 50, odd cols = 100
        pixels[row * 9 + col] = col % 2 === 0 ? 50 : 100;
      }
    }
  }

  // Compute expected hash using the same algorithm as VisualHashProcessor
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (pixels[row * 9 + col] < pixels[row * 9 + col + 1]) {
        expectedHash |= 1n << BigInt(row * 8 + col);
      }
    }
  }

  return { pixels, expectedHash };
}

/**
 * Compute Hamming distance between two BigInts (reference implementation).
 */
function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/**
 * Build a flat Uint8Array representing Laplacian response pixels.
 * sharpImagePixels: high variance values; blurredImagePixels: near-zero values.
 */
function buildLaplacianPixels(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function computeVariance(pixels: Uint8Array): number {
  const n = pixels.length;
  let sum = 0;
  let sumSq = 0;
  for (const v of pixels) {
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// ---------------------------------------------------------------------------
// Import processor after mocks are set up
// ---------------------------------------------------------------------------

import { VisualHashProcessor } from '../storage/processing/processors/visual-hash.processor';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { StorageObject } from '@prisma/client';

function makeStorageObject(overrides: Partial<StorageObject> = {}): StorageObject {
  return {
    id: 'obj-1',
    storageKey: 'images/photo.jpg',
    mimeType: 'image/jpeg',
    size: 1024,
    status: 'completed' as any,
    userId: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as StorageObject;
}

async function makeStream(): Promise<Readable> {
  return Readable.from([Buffer.from('fake-image-data')]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VisualHashProcessor', () => {
  let processor: VisualHashProcessor;

  beforeEach(() => {
    processor = new VisualHashProcessor();
    jest.clearAllMocks();
    // Default: prepareImageForProcessing returns valid dimensions
    (prepareImageForProcessing as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('prepared'),
      width: 100,
      height: 100,
    });
  });

  // -------------------------------------------------------------------------
  // canProcess guard
  // -------------------------------------------------------------------------

  describe('canProcess', () => {
    it('returns true for image/* MIME types with non-thumbnail key', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/jpeg', storageKey: 'images/photo.jpg' }))).toBe(true);
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/png', storageKey: 'originals/photo.png' }))).toBe(true);
    });

    it('returns false for video MIME types', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'video/mp4', storageKey: 'videos/clip.mp4' }))).toBe(false);
    });

    it('returns false for thumbnail keys even if MIME type is image', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/jpeg', storageKey: 'thumbnails/photo.jpg' }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // dHash: identical pixel patterns → Hamming distance 0
  // -------------------------------------------------------------------------

  describe('dHash computation', () => {
    it('produces distance 0 between two calls with identical pixel data', async () => {
      const { pixels } = buildHashPixels('all_left_lt_right');

      // Both calls get the same pixel data
      mockToBuffer
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        // Second call: Laplacian pixels (doesn't affect hash)
        .mockResolvedValueOnce({ data: buildLaplacianPixels([50, 50, 50]), info: { width: 1, height: 3 } })
        // Second processor invocation
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: buildLaplacianPixels([50, 50, 50]), info: { width: 1, height: 3 } });

      const result1 = await processor.process(makeStorageObject(), makeStream);
      const result2 = await processor.process(makeStorageObject(), makeStream);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      const hash1 = BigInt(result1.metadata!['perceptualHash'] as string);
      const hash2 = BigInt(result2.metadata!['perceptualHash'] as string);

      expect(hammingDistance(hash1, hash2)).toBe(0);
    });

    it('produces large Hamming distance between clearly-different pixel patterns', async () => {
      const { pixels: pixelsA } = buildHashPixels('all_left_lt_right');
      const { pixels: pixelsB } = buildHashPixels('all_left_gt_right');

      mockToBuffer
        .mockResolvedValueOnce({ data: pixelsA, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: buildLaplacianPixels([10, 10]), info: { width: 1, height: 2 } })
        .mockResolvedValueOnce({ data: pixelsB, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: buildLaplacianPixels([10, 10]), info: { width: 1, height: 2 } });

      const result1 = await processor.process(makeStorageObject(), makeStream);
      const result2 = await processor.process(makeStorageObject(), makeStream);

      const hash1 = BigInt(result1.metadata!['perceptualHash'] as string);
      const hash2 = BigInt(result2.metadata!['perceptualHash'] as string);

      // all_left_lt_right → all 64 bits set; all_left_gt_right → 0 bits set
      // Distance should be 64
      expect(hammingDistance(hash1, hash2)).toBeGreaterThanOrEqual(30);
    });

    it('stores perceptualHash as a string (not raw BigInt) in metadata', async () => {
      const { pixels } = buildHashPixels('alternating');

      mockToBuffer
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: buildLaplacianPixels([10]), info: { width: 1, height: 1 } });

      const result = await processor.process(makeStorageObject(), makeStream);

      expect(result.success).toBe(true);
      expect(typeof result.metadata!['perceptualHash']).toBe('string');
      // Must be convertible back to BigInt
      expect(() => BigInt(result.metadata!['perceptualHash'] as string)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Hamming distance utility edge cases
  // -------------------------------------------------------------------------

  describe('Hamming distance helper (reference implementation)', () => {
    it('returns 0 for identical BigInts', () => {
      expect(hammingDistance(0n, 0n)).toBe(0);
      expect(hammingDistance(0xDEADBEEFn, 0xDEADBEEFn)).toBe(0);
    });

    it('returns 64 when all bits differ (0 vs max-64-bit)', () => {
      const max64 = (1n << 64n) - 1n;
      expect(hammingDistance(0n, max64)).toBe(64);
    });

    it('returns 1 for single-bit difference', () => {
      expect(hammingDistance(0n, 1n)).toBe(1);
      expect(hammingDistance(0n, 1n << 63n)).toBe(1);
    });

    it('counts correctly for known patterns', () => {
      // 0b1010 vs 0b0101 → 4 bits differ
      expect(hammingDistance(0b1010n, 0b0101n)).toBe(4);
      // 0b1111 vs 0b0000 → 4 bits differ
      expect(hammingDistance(0b1111n, 0b0000n)).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Sharpness: sharp > blurred
  // -------------------------------------------------------------------------

  describe('sharpness computation', () => {
    it('produces higher sharpnessScore for sharp images than blurred images', async () => {
      const { pixels } = buildHashPixels('alternating');

      // Sharp image: high-variance Laplacian response (large pixel differences)
      const sharpLaplacian = buildLaplacianPixels([
        0, 200, 0, 200, 0, 200, 0, 200,
        200, 0, 200, 0, 200, 0, 200, 0,
      ]);
      // Blurred image: near-zero Laplacian response (no edges)
      const blurredLaplacian = buildLaplacianPixels([
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
      ]);

      const sharpVariance = computeVariance(sharpLaplacian);
      const blurredVariance = computeVariance(blurredLaplacian);

      mockToBuffer
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: sharpLaplacian, info: { width: 4, height: 4 } })
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: blurredLaplacian, info: { width: 4, height: 4 } });

      const sharpResult = await processor.process(makeStorageObject(), makeStream);
      const blurredResult = await processor.process(makeStorageObject(), makeStream);

      const sharpScore = sharpResult.metadata!['sharpnessScore'] as number;
      const blurredScore = blurredResult.metadata!['sharpnessScore'] as number;

      expect(sharpScore).toBeCloseTo(sharpVariance, 0);
      expect(blurredScore).toBeCloseTo(blurredVariance, 0);
      expect(sharpScore).toBeGreaterThan(blurredScore);
    });
  });

  // -------------------------------------------------------------------------
  // width=0 guard: skip gracefully
  // -------------------------------------------------------------------------

  describe('width=0 guard', () => {
    it('returns success with empty metadata when prepareImageForProcessing returns width=0', async () => {
      (prepareImageForProcessing as jest.Mock).mockResolvedValueOnce({
        buffer: Buffer.alloc(0),
        width: 0,
        height: 0,
      });

      const result = await processor.process(makeStorageObject(), makeStream);

      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({});
      // sharp should not be called for pixel extraction
      expect(mockToBuffer).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    // computeVisualHash swallows processing errors and returns null, so the
    // processor skips gracefully (success:true, empty metadata) rather than
    // marking the whole storage object as failed. A missing perceptual hash is
    // non-critical — the burst detection job recomputes it on demand.
    it('skips gracefully (success:true, no metadata) when sharp throws', async () => {
      mockToBuffer.mockRejectedValueOnce(new Error('sharp decode failed'));

      const result = await processor.process(makeStorageObject(), makeStream);

      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({});
      expect(result.error).toBeUndefined();
    });

    it('never throws and never fails the object when image prep rejects', async () => {
      (prepareImageForProcessing as jest.Mock).mockRejectedValueOnce(new Error('corrupt EXIF'));

      await expect(processor.process(makeStorageObject(), makeStream)).resolves.toMatchObject({
        success: true,
        metadata: {},
      });
    });
  });
});
