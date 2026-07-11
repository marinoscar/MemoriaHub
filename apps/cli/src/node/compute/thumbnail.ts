/**
 * node/compute/thumbnail.ts — Thumbnail (re)generation compute.
 *
 * Shared by both `thumbnail_regen` and `thumbnail_repair` job types.
 *
 * PHOTOS ONLY for now: the server's ThumbnailProcessor also extracts a poster
 * frame from videos via ffmpeg before resizing, which this module does not
 * (yet) replicate. A video input throws CapabilityUnavailableError so the
 * server keeps handling video thumbnails via its existing in-process
 * StorageProcessingRecoveryService.reprocessObjectNow path — nothing regresses,
 * a node just declines the job and the server (or another node) retries it.
 *
 * Geometry/quality PARITY: neither `thumbnail_regen` nor `thumbnail_repair`
 * job payloads carry the target's mimeType today (unlike `metadata_extraction`,
 * which the API now threads mimeType through for — see
 * apps/api/src/metadata/metadata.controller.ts), so this module cannot cheaply
 * tell "photo vs video" ahead of time. It attempts the sharp resize directly;
 * sharp only decodes image formats, so a video input surfaces as a decode
 * failure, which is mapped to the CapabilityUnavailableError above.
 *
 * The resize pipeline intentionally does NOT reuse
 * `@memoriahub/enrichment-compute/image`'s `prepareImageForProcessing` —
 * that helper hardcodes JPEG quality 90, which would silently diverge from
 * the server's thumbnail bytes. Instead this mirrors
 * apps/api/src/storage/processing/processors/thumbnail.processor.ts's
 * `processImage` step by value: `THUMBNAIL_MAX_DIM` (default 800) and
 * `THUMBNAIL_QUALITY` (default 85) are the server's env-configurable
 * defaults; a server running with non-default values will produce
 * differently-sized/quality thumbnails than a node computing with these
 * constants — an accepted parity gap until those knobs are threaded through
 * the job payload too.
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

const computeThumbnail: ComputeFn = async (inputPath, _params, ctx): Promise<ThumbnailComputeResult> => {
  const buffer = await readFile(inputPath);

  // --- 1. Resize via sharp, mirroring ThumbnailProcessor.processImage byte-for-byte ---
  let jpegBuffer: Buffer;
  let width: number;
  let height: number;
  try {
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
    jpegBuffer = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch (err) {
    // sharp only decodes image formats — the primary way this job type's
    // input is NOT a photo is a video, so a decode failure is reported as
    // the "video not yet supported" capability gap rather than a generic
    // compute error.
    throw new CapabilityUnavailableError(
      'video thumbnails not yet supported on nodes (node thumbnail compute is photo-only for now)',
      'thumbnail',
      err instanceof Error ? err.message : String(err),
    );
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
