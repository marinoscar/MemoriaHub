/**
 * Shared visual-hash computation utility.
 *
 * Extracts the dHash (64-bit perceptual hash) and variance-of-Laplacian
 * sharpness score from an image buffer. EXIF orientation is applied via
 * `prepareImageForProcessing` before any computation, so portrait photos
 * rotated by EXIF are compared right-side-up.
 *
 * Returns `null` when the image cannot be decoded (width === 0 from
 * prepareImageForProcessing) or on any unhandled error. Callers handle null.
 * This function never throws.
 */

import { Logger } from '@nestjs/common';
import { prepareImageForProcessing } from './image-orientation.util';

const logger = new Logger('VisualHashUtil');

export interface VisualHashResult {
  perceptualHash: bigint;
  sharpnessScore: number;
}

/**
 * Compute the dHash and Laplacian sharpness score for an image buffer.
 *
 * @param buffer - Raw image bytes (any format supported by sharp)
 * @returns `{ perceptualHash, sharpnessScore }` or `null` on failure
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
      logger.warn('prepareImageForProcessing returned width=0; skipping visual-hash computation');
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

    return { perceptualHash: hash, sharpnessScore };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`computeVisualHash failed: ${message}`);
    return null;
  }
}

const TWO_POW_63 = 1n << 63n;
const TWO_POW_64 = 1n << 64n;
const UINT64_MASK = TWO_POW_64 - 1n;

/**
 * The dHash is an UNSIGNED 64-bit value (0 .. 2^64-1), but a Postgres `bigint`
 * column is SIGNED (-2^63 .. 2^63-1). Hashes with the high bit set exceed the
 * positive range and fail to store ("value out of range for type bigint").
 *
 * Reinterpret the unsigned value as its two's-complement signed equivalent so
 * it fits the column without information loss. Reading it back yields the same
 * bit pattern (as a possibly-negative BigInt); Hamming distance is computed on
 * the masked low 64 bits, so the sign is irrelevant for matching.
 */
export function toSignedInt64(value: bigint): bigint {
  const masked = value & UINT64_MASK;
  return masked >= TWO_POW_63 ? masked - TWO_POW_64 : masked;
}
