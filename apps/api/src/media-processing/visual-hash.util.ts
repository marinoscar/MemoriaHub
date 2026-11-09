/**
 * Shared visual-hash computation utility.
 *
 * Extracts the dHash (64-bit perceptual hash) and variance-of-Laplacian
 * sharpness score from an image buffer. EXIF orientation is applied via
 * `prepareImageForProcessing` before any computation, so portrait photos
 * rotated by EXIF are compared right-side-up.
 *
 * The computation itself lives in the shared parity package
 * @memoriahub/enrichment-compute (dhash subpath) so distributed worker nodes
 * produce bit-identical hashes to the server. This module keeps the
 * historical bigint-typed signature for existing callers (burst detection,
 * the visual-hash processor); the package's canonical form is the unsigned
 * decimal STRING stored in media_items.perceptual_hash.
 *
 * Returns `null` when the image cannot be decoded or on any unhandled error.
 * Callers handle null. This function never throws.
 */

import { computeVisualHash as computeVisualHashShared } from '@memoriahub/enrichment-compute/dhash';
// Importing the re-export module (not the package directly) guarantees the
// package logger is wired to NestJS before any hash computation runs.
import './image-orientation.util';

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
  const result = await computeVisualHashShared(buffer);
  if (!result) {
    return null;
  }
  return {
    perceptualHash: BigInt(result.perceptualHash),
    sharpnessScore: result.sharpnessScore,
  };
}
