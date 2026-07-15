/**
 * Shared image-preparation primitives (moved verbatim from
 * apps/api/src/storage/processing/image-orientation.util.ts).
 *
 * ALL image compute — server-side handlers AND distributed worker nodes —
 * must obtain pixels via `prepareImageForProcessing` so EXIF orientation is
 * applied consistently. Do not call sharp directly in new image handlers.
 *
 * This module is the single most important parity primitive (see
 * docs/specs/distributed-nodes.md §7): a different sharp/libvips build or a
 * divergent copy of this preprocessing re-encodes JPEG bytes differently →
 * different tensors → different embedding vectors. That is why `sharp` is
 * exact-pinned in this package's dependencies and hoisted identically for
 * apps/api and apps/cli via root `overrides`.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { nodeRequire } from '../node-require.cjs';
import { computeLog, setComputeLogger } from '../logging.js';

export { setComputeLogger } from '../logging.js';
export type { ComputeLogger, ComputeLogFn } from '../logging.js';

// ---------------------------------------------------------------------------
// ffmpeg-transcode fallback for formats sharp's prebuilt libvips can't decode
// (chiefly HEIC/HEIF — the HEVC decoder is omitted from sharp's bundled libvips
// for patent/licensing reasons). ffmpeg reliably decodes HEIC and is already a
// runtime dependency, so we transcode the input to a plain JPEG that sharp can
// then process through the normal pipeline. See issue #106.
// ---------------------------------------------------------------------------

type FfmpegChain = {
  frames(n: number): FfmpegChain;
  output(path: string): FfmpegChain;
  on(event: 'end' | 'error', cb: (err?: Error) => void): FfmpegChain;
  run(): void;
  kill(signal: string): void;
};
type FfmpegModule = (input: string) => FfmpegChain;

function loadFfmpeg(): FfmpegModule {
  const mod = nodeRequire('fluent-ffmpeg') as Record<string, unknown>;
  return (typeof mod === 'function' ? mod : mod['default']) as FfmpegModule;
}

/**
 * Reject unless `path` exists with size > 0 — ffmpeg can exit 0 without writing
 * an output file (mirrors the same guard in ../video/index.ts).
 */
async function assertNonEmptyFile(path: string): Promise<void> {
  const stats = await fs.stat(path);
  if (stats.size === 0) {
    throw new Error(`ffmpeg produced an empty output file: ${path}`);
  }
}

/**
 * Transcode an image buffer (typically HEIC/HEIF) to a decodable JPEG buffer
 * via ffmpeg — the fallback used when sharp's bundled libvips cannot decode the
 * input directly. Writes the input to a temp file, runs a single-frame ffmpeg
 * transcode to a temp JPEG, validates the output is non-empty, reads it back,
 * and cleans up BOTH temp files in a finally block.
 *
 * Temp files use the `memoriaHub-` prefix so TempFileJanitorTask sweeps any
 * leak left behind by a SIGKILL'd process. The ffmpeg run is bounded by
 * `opts.ffmpegTimeoutMs` (or `FFMPEG_TIMEOUT_MS`, default 60000) and killed
 * with SIGKILL if it hangs.
 *
 * Unlike the other helpers in this module, this function THROWS on failure
 * (corrupt/undecodable input) — callers wrap it in their own try/catch so a
 * genuinely-broken file still fails that one item cleanly.
 */
export async function transcodeToDecodableJpeg(
  buffer: Buffer,
  opts?: { fileExtension?: string; ffmpegTimeoutMs?: number },
): Promise<Buffer> {
  const rawExt = opts?.fileExtension?.trim();
  const ext = rawExt ? (rawExt.startsWith('.') ? rawExt : `.${rawExt}`) : '.heic';
  const ffmpegTimeoutMs =
    opts?.ffmpegTimeoutMs ?? parseInt(process.env.FFMPEG_TIMEOUT_MS ?? '60000', 10);

  const tmpIn = join(tmpdir(), `memoriaHub-heic-in-${randomUUID()}${ext}`);
  const tmpOut = join(tmpdir(), `memoriaHub-heic-out-${randomUUID()}.jpg`);

  try {
    await fs.writeFile(tmpIn, buffer);
    await transcodeAttempt(tmpIn, tmpOut, ffmpegTimeoutMs);
    await assertNonEmptyFile(tmpOut);
    return await fs.readFile(tmpOut);
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

/**
 * Run a single ffmpeg transcode of `tmpIn` into `tmpOut` (one output frame).
 *
 * Mirrors the timeout-bounded, SIGKILL-guarded, once-settled Promise pattern of
 * `extractPosterFrameAttempt` in ../video/index.ts. The command is killed with
 * SIGKILL once `timeoutMs` elapses; the `settled` guard ensures the promise
 * settles exactly once.
 */
function transcodeAttempt(tmpIn: string, tmpOut: string, timeoutMs: number): Promise<void> {
  const ffmpeg = loadFfmpeg();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const cmd = ffmpeg(tmpIn);
    cmd
      .frames(1)
      .output(tmpOut)
      .on('end', () => settle())
      .on('error', (err?: Error) => settle(err));

    timer = setTimeout(() => {
      // SIGKILL — ffmpeg can ignore the default SIGTERM mid-decode
      try {
        cmd.kill('SIGKILL');
      } catch {
        // Process already gone
      }
      settle(new Error(`ffmpeg image transcode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    cmd.run();
  });
}

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
  opts?: { maxDim?: number; fileExtension?: string },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const runPipeline = async (
    sharp: (typeof import('sharp'))['default'],
    input: Buffer,
    rotate: boolean,
  ): Promise<{ buffer: Buffer; width: number; height: number }> => {
    // ffmpeg bakes EXIF orientation into the pixels when transcoding, so the
    // fallback path skips the (now-redundant, and on some transcoded JPEGs
    // incorrect) `.rotate()` pass.
    let pipeline = rotate ? sharp(input).rotate() : sharp(input);

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
  };

  const sharp = (await import('sharp')).default;

  try {
    return await runPipeline(sharp, buffer, true);
  } catch (err) {
    // sharp's bundled libvips can't decode this format (e.g. HEIC). Fall back
    // to transcoding via ffmpeg, then re-run the SAME pipeline on the JPEG.
    try {
      const jpeg = await transcodeToDecodableJpeg(buffer, {
        fileExtension: opts?.fileExtension,
      });
      return await runPipeline(sharp, jpeg, false);
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      computeLog.warn(`prepareImageForProcessing failed: ${msg}`);
      return { buffer, width: 0, height: 0 };
    }
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
    computeLog.error(`applyOrientationTransform failed (op=${op}): ${msg}`);
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
  const sharp = (await import('sharp')).default;

  try {
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
    // sharp's bundled libvips can't decode this format (e.g. HEIC). Transcode
    // via ffmpeg and read the JPEG's dimensions. ffmpeg bakes orientation into
    // the pixels, so no axis-swap is needed on the fallback path.
    try {
      const jpeg = await transcodeToDecodableJpeg(buffer);
      const meta = await sharp(jpeg).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      computeLog.warn(`getOrientedDimensions failed: ${msg}`);
      return null;
    }
  }
}
