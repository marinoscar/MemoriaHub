/**
 * Perceptual hash (dHash) + variance-of-Laplacian sharpness compute (moved
 * from apps/api/src/storage/processing/visual-hash.util.ts).
 *
 * The dHash is an UNSIGNED 64-bit value. It is returned as a decimal STRING —
 * never a bigint — matching the media_items.perceptual_hash TEXT column and
 * the repo-wide "Why TEXT and not bigint" rule (Postgres bigint is signed;
 * JS BigInt is not JSON-serializable). Parse with BigInt(string) only where
 * bit arithmetic is needed (see hammingDistance below).
 *
 * EXIF orientation is applied via `prepareImageForProcessing` before any
 * computation, so portrait photos rotated by EXIF are compared right-side-up.
 */

import { prepareImageForProcessing } from '../image/index.js';
import { computeLog } from '../logging.js';

export interface VisualHashResult {
  /** Unsigned 64-bit dHash as a decimal string. */
  perceptualHash: string;
  /** Variance-of-Laplacian sharpness measure. */
  sharpnessScore: number;
}

/**
 * Compute the dHash and Laplacian sharpness score for an image buffer.
 *
 * Returns `null` when the image cannot be decoded (width === 0 from
 * prepareImageForProcessing) or on any unhandled error. Callers handle null.
 * This function never throws.
 */
export async function computeVisualHash(
  buffer: Buffer,
): Promise<VisualHashResult | null> {
  try {
    // Apply EXIF orientation and downscale to 512px max dimension
    const { buffer: preparedBuffer, width } = await prepareImageForProcessing(buffer, {
      maxDim: 512,
    });

    if (width === 0) {
      computeLog.warn(
        'prepareImageForProcessing returned width=0; skipping visual-hash computation',
      );
      return null;
    }

    const sharp = (await import('sharp')).default;

    // --- dHash: resize to 9x8 grayscale, compare adjacent pixels ---
    // 8 columns × 8 rows of left-right comparisons = 64 bits
    const { data: hashData } = await sharp(preparedBuffer)
      .resize(9, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let hash = 0n;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (hashData[row * 9 + col] < hashData[row * 9 + col + 1]) {
          hash |= 1n << BigInt(row * 8 + col);
        }
      }
    }

    // --- Laplacian sharpness: variance of Laplacian response ---
    const { data: lapData, info: lapInfo } = await sharp(preparedBuffer)
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const n = lapInfo.width * lapInfo.height;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = lapData[i];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sharpnessScore = sumSq / n - mean * mean;

    return { perceptualHash: hash.toString(), sharpnessScore };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    computeLog.error(`computeVisualHash failed: ${message}`);
    return null;
  }
}

/**
 * Compute just the dHash (decimal-string unsigned 64-bit) for an image
 * buffer. Returns null when the image cannot be decoded; never throws.
 */
export async function computeDHash(buffer: Buffer): Promise<string | null> {
  const result = await computeVisualHash(buffer);
  return result?.perceptualHash ?? null;
}

/** Popcount of a XOR b — number of differing bits between two 64-bit hashes. */
export function hammingDistanceBigInt(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/**
 * Hamming distance between two dHashes in their canonical decimal-string
 * form (as stored in media_items.perceptual_hash).
 */
export function hammingDistance(a: string, b: string): number {
  return hammingDistanceBigInt(BigInt(a), BigInt(b));
}
