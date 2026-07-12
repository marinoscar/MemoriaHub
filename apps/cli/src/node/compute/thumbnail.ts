/**
 * node/compute/thumbnail.ts — Thumbnail (re)generation compute.
 *
 * Shared by both `thumbnail_regen` and `thumbnail_repair` job types.
 *
 * PHOTOS AND VIDEOS: photos are resized directly via sharp. Videos are
 * handled by a fallback path — since neither `thumbnail_regen` nor
 * `thumbnail_repair` job payloads carry the target's mimeType today (unlike
 * `metadata_extraction`, which the API now threads mimeType through for —
 * see apps/api/src/metadata/metadata.controller.ts), this module cannot
 * cheaply tell "photo vs video" ahead of time. It always attempts the sharp
 * resize first; sharp only decodes image formats, so a video input surfaces
 * as a decode failure. On that failure, this module falls back to
 * `@memoriahub/enrichment-compute/video`'s `extractPosterFrame()` — the same
 * three-attempt ffmpeg fallback ladder (seek 1s → seek 0s → `thumbnail`
 * filter) the server's `ThumbnailProcessor.processVideo` uses — to pull a
 * poster frame from the video, then runs that frame through the same sharp
 * resize pipeline as the photo path. `CapabilityUnavailableError` is now only
 * thrown when BOTH sharp decode AND ffmpeg extraction fail (e.g. ffmpeg is
 * missing on this node, or the file is genuinely corrupt/unparseable) — a
 * legitimate "this node truly cannot do it" case, not "nodes categorically
 * can't do video thumbnails." In that case the server (or another node)
 * retries the job via its existing
 * StorageProcessingRecoveryService.reprocessObjectNow path.
 *
 * Geometry/quality PARITY: The resize pipeline intentionally does NOT reuse
 * `@memoriahub/enrichment-compute/image`'s `prepareImageForProcessing` —
 * that helper hardcodes JPEG quality 90, which would silently diverge from
 * the server's thumbnail bytes. Instead this mirrors
 * apps/api/src/storage/processing/processors/thumbnail.processor.ts's
 * `processImage`/`processVideo` steps by value: `THUMBNAIL_MAX_DIM` (default
 * 800) and `THUMBNAIL_QUALITY` (default 85) are the server's
 * env-configurable defaults; a server running with non-default values will
 * produce differently-sized/quality thumbnails than a node computing with
 * these constants — an accepted parity gap until those knobs are threaded
 * through the job payload too.
 *
 * UPLOAD FLOW: unlike every other node-compute module, thumbnail output
 * bytes are not returned inline in the job result — they must be PUT to a
 * server-issued presigned URL first (see distributed-nodes spec §6:
 * "Thumbnail bytes are uploaded FIRST via a presigned PUT"). That requires
 * the claimed job's id (to call `POST /nodes/:id/jobs/:jobId/upload-url`),
 * which is NOT part of a compute module's normal `(inputPath, params)`
 * arguments — see the `ctx` parameter added to `ComputeFn` in
 * ../capabilities.ts. `node-engine.ts` populates `{ nodeId, jobId }` on every
 * claimed job, so `ctx` is always present in practice; the guard below stays
 * as a defensive check for any future caller (e.g. a test harness) that
 * constructs a `ComputeDispatcher` without it.
 */

import { readFile } from 'node:fs/promises';
import { extractPosterFrame } from '@memoriahub/enrichment-compute/video';
import {
  CapabilityUnavailableError,
  type ComputeFn,
} from '../capabilities.js';
import { ApiClient } from '../../api.js';
import { loadConfig } from '../../config.js';

/** Mirrors ThumbnailProcessor's THUMBNAIL_MAX_DIM default (env-configurable server-side). */
const THUMBNAIL_MAX_DIM = 800;
/** Mirrors ThumbnailProcessor's THUMBNAIL_QUALITY default (env-configurable server-side). */
const THUMBNAIL_QUALITY = 85;

interface ThumbnailComputeResult {
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
}

interface ResizedThumbnail {
  jpegBuffer: Buffer;
  width: number;
  height: number;
}

/**
 * Run the shared resize/JPEG pipeline (mirrors ThumbnailProcessor byte-for-
 * byte: `.rotate().resize({ width/height: THUMBNAIL_MAX_DIM, fit: 'inside',
 * withoutEnlargement: true }).jpeg({ quality: THUMBNAIL_QUALITY })`) over any
 * decodable image buffer — used for both the direct photo path and the
 * video poster-frame fallback below, so both paths produce byte-identical
 * output for the same pixels.
 */
async function resizeToThumbnail(buffer: Buffer): Promise<ResizedThumbnail> {
  const sharp = (await import('sharp')).default;
  const result = await sharp(buffer)
    .rotate()
    .resize({
      width: THUMBNAIL_MAX_DIM,
      height: THUMBNAIL_MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { jpegBuffer: result.data, width: result.info.width, height: result.info.height };
}

const computeThumbnail: ComputeFn = async (inputPath, _params, ctx): Promise<ThumbnailComputeResult> => {
  const buffer = await readFile(inputPath);

  // --- 1. Resize via sharp, mirroring ThumbnailProcessor.processImage byte-for-byte ---
  //     Falls back to ffmpeg poster-frame extraction (mirrors
  //     ThumbnailProcessor.processVideo) when sharp cannot decode the input —
  //     the primary way that happens is the input being a video.
  let jpegBuffer: Buffer;
  let width: number;
  let height: number;
  try {
    const resized = await resizeToThumbnail(buffer);
    jpegBuffer = resized.jpegBuffer;
    width = resized.width;
    height = resized.height;
  } catch (sharpErr) {
    try {
      const frameBuffer = await extractPosterFrame(inputPath);
      const resized = await resizeToThumbnail(frameBuffer);
      jpegBuffer = resized.jpegBuffer;
      width = resized.width;
      height = resized.height;
    } catch (ffmpegErr) {
      // Both sharp direct decode AND ffmpeg poster-frame extraction failed —
      // this node genuinely cannot produce a thumbnail for this input (e.g.
      // ffmpeg missing on PATH, or a corrupt/unparseable file), unlike the
      // earlier photo-only implementation where any video input hit this path.
      throw new CapabilityUnavailableError(
        'node cannot generate a thumbnail for this input: sharp decode failed and ffmpeg ' +
          'poster-frame extraction also failed',
        'thumbnail',
        `sharp: ${sharpErr instanceof Error ? sharpErr.message : String(sharpErr)}; ffmpeg: ${
          ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr)
        }`,
      );
    }
  }

  // --- 2. Job context required to request an upload URL — see file header ---
  if (!ctx) {
    throw new Error(
      'job context not provided — thumbnail compute needs { nodeId, jobId } to request an ' +
        'upload URL via ComputeDispatcher.compute(); the running node engine always supplies ' +
        'this, so seeing this error means the dispatcher was invoked directly without it ' +
        '(e.g. from a test harness) — see ../capabilities.ts',
    );
  }

  // --- 3. Ask the server where to PUT the bytes, then upload directly ---
  const config = loadConfig();
  if (!config) {
    throw new Error('not logged in — no CLI config found (run `memoriahub login`)');
  }
  const client = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

  const { url, storageKey } = await client.getJobUploadUrl(ctx.nodeId, ctx.jobId);
  await client.putRaw(url, jpegBuffer, 'image/jpeg');

  return { storageKey, width, height, bytes: jpegBuffer.length };
};

export default computeThumbnail;
