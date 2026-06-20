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
 */

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted by Jest before imports)
// ---------------------------------------------------------------------------

jest.mock('./image-orientation.util', () => ({
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

import { computeVisualHash, toSignedInt64 } from './visual-hash.util';
import { prepareImageForProcessing } from './image-orientation.util';

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
  });
});

describe('toSignedInt64', () => {
  const INT64_MIN = -(1n << 63n);
  const INT64_MAX = (1n << 63n) - 1n;
  const UINT64_MASK = (1n << 64n) - 1n;

  it('passes through values already within the signed range', () => {
    expect(toSignedInt64(0n)).toBe(0n);
    expect(toSignedInt64(12345n)).toBe(12345n);
    expect(toSignedInt64(INT64_MAX)).toBe(INT64_MAX);
  });

  it('reinterprets a high-bit-set unsigned hash as a negative signed int64', () => {
    // The exact value from the production "out of range for type bigint" error.
    const unsigned = 16488331711678253075n;
    const signed = toSignedInt64(unsigned);

    expect(signed).toBe(unsigned - (1n << 64n));
    expect(signed).toBeLessThan(0n);
    // Must fit a Postgres signed bigint column.
    expect(signed).toBeGreaterThanOrEqual(INT64_MIN);
    expect(signed).toBeLessThanOrEqual(INT64_MAX);
  });

  it('maps max uint64 (all bits set) to -1 and preserves the bit pattern', () => {
    const allBits = UINT64_MASK;
    expect(toSignedInt64(allBits)).toBe(-1n);
    // Round-trip: masking the signed value back to 64 bits recovers the original.
    expect(toSignedInt64(allBits) & UINT64_MASK).toBe(allBits);
  });
});
