/**
 * Unit tests for the computeVisualHash utility.
 *
 * Covers:
 *  - Returns null (not throws) when prepareImageForProcessing returns width=0
 *  - Returns null (not throws) when sharp throws internally
 *  - Returns null (not throws) when prepareImageForProcessing rejects
 *  - Returns { perceptualHash, sharpnessScore } on success
 *  - Identical buffer → same hash (Hamming distance 0 between two calls)
 *  - Never throws under any circumstances (all errors become null)
 *  - High-bit hash survives a store→read round-trip as an unsigned decimal string
 */

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted by Jest before imports)
// ---------------------------------------------------------------------------

// The dHash computation moved into the shared parity package — mock the
// package's image module (the package dhash module imports
// prepareImageForProcessing from there internally). setComputeLogger must be
// present because the API's image-orientation.util re-export module calls it
// at import time.
jest.mock('@memoriahub/enrichment-compute/image', () => ({
  setComputeLogger: jest.fn(),
  prepareImageForProcessing: jest.fn().mockResolvedValue({
    buffer: Buffer.from('prepared'),
    width: 100,
    height: 100,
  }),
}));

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
  (mockSharpFn as any).default = mockSharpFn;
  return mockSharpFn;
});

// ---------------------------------------------------------------------------
// Imports (after mocks are hoisted)
// ---------------------------------------------------------------------------

import { computeVisualHash } from './visual-hash.util';
import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build 72-byte grayscale pixel buffer for a 9×8 dHash grid.
 * 'asc': each pixel = col+1 → left always < right → all 64 bits set (hash = max).
 * 'desc': decreasing → left always > right → all bits 0 (hash = 0).
 */
function build9x8Pixels(dir: 'asc' | 'desc'): Uint8Array {
  const pixels = new Uint8Array(9 * 8);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 9; col++) {
      pixels[row * 9 + col] = dir === 'asc' ? col + 1 : 10 - col;
    }
  }
  return pixels;
}

/** Build a flat Laplacian-response pixel array. */
function buildLapPixels(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

const FAKE_BUFFER = Buffer.from('fake-image-bytes');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeVisualHash', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default: valid prepared buffer
    (prepareImageForProcessing as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('prepared'),
      width: 100,
      height: 100,
    });
  });

  // -------------------------------------------------------------------------
  // width=0 guard
  // -------------------------------------------------------------------------

  describe('width=0 guard', () => {
    it('returns null (does not throw) when prepareImageForProcessing returns width=0', async () => {
      (prepareImageForProcessing as jest.Mock).mockResolvedValue({
        buffer: Buffer.alloc(0),
        width: 0,
        height: 0,
      });

      const result = await computeVisualHash(FAKE_BUFFER);

      expect(result).toBeNull();
      // sharp should never be invoked — no pixels to process
      expect(mockToBuffer).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling: never throws
  // -------------------------------------------------------------------------

  describe('error handling — never throws', () => {
    it('returns null (does not throw) when prepareImageForProcessing rejects', async () => {
      (prepareImageForProcessing as jest.Mock).mockRejectedValue(new Error('corrupt EXIF'));

      await expect(computeVisualHash(FAKE_BUFFER)).resolves.toBeNull();
    });

    it('returns null (does not throw) when sharp toBuffer rejects', async () => {
      mockToBuffer.mockRejectedValue(new Error('libvips decode failed'));

      await expect(computeVisualHash(FAKE_BUFFER)).resolves.toBeNull();
    });

    it('returns null (does not throw) when sharp throws synchronously', async () => {
      // First toBuffer call throws synchronously (simulated via rejection)
      mockToBuffer.mockImplementationOnce(() => {
        throw new Error('sync sharp failure');
      });

      await expect(computeVisualHash(FAKE_BUFFER)).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: returns { perceptualHash, sharpnessScore }
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    function setupSuccessfulRun(hashPixels: Uint8Array, lapPixels: Uint8Array) {
      mockToBuffer
        // First call: 9×8 grayscale for dHash
        .mockResolvedValueOnce({ data: hashPixels, info: { width: 9, height: 8 } })
        // Second call: Laplacian response
        .mockResolvedValueOnce({ data: lapPixels, info: { width: lapPixels.length, height: 1 } });
    }

    it('returns an object with perceptualHash (bigint) and sharpnessScore (number)', async () => {
      setupSuccessfulRun(build9x8Pixels('asc'), buildLapPixels([50, 100, 50, 100]));

      const result = await computeVisualHash(FAKE_BUFFER);

      expect(result).not.toBeNull();
      expect(typeof result!.perceptualHash).toBe('bigint');
      expect(typeof result!.sharpnessScore).toBe('number');
    });

    it('two calls with identical pixel data produce the same perceptualHash (distance 0)', async () => {
      const pixels = build9x8Pixels('asc');
      const lapPx = buildLapPixels([10, 20, 10]);

      // First call
      mockToBuffer
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: lapPx, info: { width: 3, height: 1 } });

      const result1 = await computeVisualHash(FAKE_BUFFER);

      // Second call
      mockToBuffer
        .mockResolvedValueOnce({ data: pixels, info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: lapPx, info: { width: 3, height: 1 } });

      const result2 = await computeVisualHash(FAKE_BUFFER);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(hammingDistance(result1!.perceptualHash, result2!.perceptualHash)).toBe(0);
    });

    it('clearly-different pixel patterns produce a large Hamming distance', async () => {
      const lapPx = buildLapPixels([10, 10]);

      // 'asc' → all 64 bits set; 'desc' → all bits 0; distance should be 64
      mockToBuffer
        .mockResolvedValueOnce({ data: build9x8Pixels('asc'), info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: lapPx, info: { width: 2, height: 1 } });
      const result1 = await computeVisualHash(FAKE_BUFFER);

      mockToBuffer
        .mockResolvedValueOnce({ data: build9x8Pixels('desc'), info: { width: 9, height: 8 } })
        .mockResolvedValueOnce({ data: lapPx, info: { width: 2, height: 1 } });
      const result2 = await computeVisualHash(FAKE_BUFFER);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(hammingDistance(result1!.perceptualHash, result2!.perceptualHash)).toBeGreaterThanOrEqual(32);
    });

    it('sharpnessScore is a non-negative number', async () => {
      const lapPx = buildLapPixels([0, 255, 0, 255, 0, 255]);
      setupSuccessfulRun(build9x8Pixels('asc'), lapPx);

      const result = await computeVisualHash(FAKE_BUFFER);

      expect(result!.sharpnessScore).toBeGreaterThanOrEqual(0);
    });

    it('high-bit hash survives a store→read round-trip as an unsigned decimal string', () => {
      // 16488331711678253075 is the exact value that previously caused
      // "value out of range for type bigint" when stored in the signed bigint column.
      // With TEXT storage: bigint.toString() → stored string → BigInt(string) recovers the original.
      const highBitHash = 16488331711678253075n;

      // Simulate what the processor emits and what the sync service stores:
      const stored: string = highBitHash.toString();

      // Simulate what burst-detection reads back from the DB and parses:
      const recovered: bigint = BigInt(stored);

      expect(stored).toBe('16488331711678253075');
      expect(recovered).toBe(highBitHash);
      // Confirm the value has the high bit set (it would overflow a signed int64).
      expect(highBitHash).toBeGreaterThan((1n << 63n) - 1n);
    });
  });
});
