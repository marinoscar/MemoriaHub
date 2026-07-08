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
 * Supported orientation-edit operations for applyOrientationTransform.
 *
 *  - rotate_left     → rotate 90° counter-clockwise (270°)
 *  - rotate_right    → rotate 90° clockwise (90°)
 *  - flip_horizontal → mirror left↔right (flop)
 *  - flip_vertical   → mirror top↔bottom (flip)
 */
export type OrientationOp =
  | 'rotate_left'
  | 'rotate_right'
  | 'flip_horizontal'
  | 'flip_vertical';

/**
 * Applies a destructive orientation edit (rotate/flip) to an image's raw bytes
 * and re-encodes as JPEG at quality 90.
 *
 * Any existing EXIF orientation is baked in FIRST (via a no-arg `sharp().rotate()`
 * pass that renders the pixels upright and strips the orientation tag) so the
 * subsequent transform operates on visually-upright pixels. A two-stage pipeline
 * is used deliberately: chaining a no-arg `.rotate()` with a second angle-based
 * `.rotate(90)` does NOT compose predictably in sharp, so the EXIF bake and the
 * requested op are applied in separate passes to guarantee a correct result.
 *
 * Returns `{ buffer, width, height }` where width/height are the output image's
 * actual pixel dimensions (already axis-swapped for the rotate cases).
 *
 * Unlike the other helpers in this file this function DOES throw on failure — a
 * destructive edit that silently produced garbage bytes would be worse than a
 * surfaced error. The error is logged before it is thrown so the caller can turn
 * it into an HTTP 500.
 */
export async function applyOrientationTransform(
  buffer: Buffer,
  op: OrientationOp,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const sharp = (await import('sharp')).default;

    // Stage 1 — bake in EXIF orientation so pixels are upright and the
    // orientation tag is removed from the intermediate buffer.
    const upright = await sharp(buffer).rotate().toBuffer();

    // Stage 2 — apply the requested transform on the upright pixels.
    let pipeline = sharp(upright);
    switch (op) {
      case 'rotate_left':
        pipeline = pipeline.rotate(-90);
        break;
      case 'rotate_right':
        pipeline = pipeline.rotate(90);
        break;
      case 'flip_horizontal':
        pipeline = pipeline.flop();
        break;
      case 'flip_vertical':
        pipeline = pipeline.flip();
        break;
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
    logger.error(`applyOrientationTransform failed (op=${op}): ${msg}`);
    throw new Error(`Image orientation transform failed: ${msg}`);
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
