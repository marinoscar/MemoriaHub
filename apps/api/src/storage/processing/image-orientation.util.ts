/**
 * ALL server-side image processing must obtain pixels via prepareImageForProcessing
 * so EXIF orientation is applied consistently. Do not call sharp directly in new
 * image handlers.
 */

import { Logger } from '@nestjs/common';

const logger = new Logger('ImageOrientationUtil');

/**
 * Applies EXIF orientation (rotate to upright), optionally downscales to
 * `opts.maxDim` on the longest side, and re-encodes as JPEG at quality 90.
 *
 * Returns `{ buffer, width, height }` of the processed image.
 * On sharp failure, logs a warning and returns `{ buffer, width: 0, height: 0 }`
 * so callers can detect the failure and fall back — this function never throws.
 */
export async function prepareImageForProcessing(
  buffer: Buffer,
  opts?: { maxDim?: number },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const sharp = (await import('sharp')).default;

    let pipeline = sharp(buffer).rotate();

    if (opts?.maxDim) {
      pipeline = pipeline.resize({
        width: opts.maxDim,
        height: opts.maxDim,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const result = await pipeline
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`prepareImageForProcessing failed: ${msg}`);
    return { buffer, width: 0, height: 0 };
  }
}

/**
 * Returns the display-oriented dimensions of an image by reading EXIF metadata
 * and swapping width/height for 90°/270° rotations (orientations 5–8).
 *
 * This is cheap — no re-encode occurs.
 * Returns null if dimensions cannot be determined or on any sharp error.
 */
export async function getOrientedDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buffer).metadata();

    if (meta.width === undefined || meta.height === undefined) {
      return null;
    }

    // Orientations 5, 6, 7, 8 encode a 90° or 270° rotation: swap axes
    const rotated90or270 = [5, 6, 7, 8].includes(meta.orientation ?? 0);
    if (rotated90or270) {
      return { width: meta.height ?? 0, height: meta.width ?? 0 };
    }

    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`getOrientedDimensions failed: ${msg}`);
    return null;
  }
}
