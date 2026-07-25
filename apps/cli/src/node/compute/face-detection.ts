/**
 * node/compute/face-detection.ts — Photo face-detection compute.
 *
 * Runs the full face-detection compute locally via the shared
 * `@memoriahub/enrichment-compute` parity package so node-computed faces are
 * numerically identical to server-computed ones (distributed-nodes spec §7):
 *
 *   1. EXIF-orient + downscale via prepareImageForProcessing (same maxDim the
 *      server uses — FACE_MAX_IMAGE_DIM's default of 2000, see the constant
 *      below).
 *   2. Detect via a locally-running compreface-core sidecar (128-d
 *      embeddings) reachable at this node's configured `comprefaceUrl`.
 *
 * CompreFace is the ONLY face provider a worker node runs (issue #113) — it is
 * also the server's standard provider, so a node and the server always write
 * embeddings in the same 128-d space and person matching never sees a
 * provider mismatch. An unreachable sidecar is a HARD failure here, routed
 * through the engine's normal /failure + retry/backoff path — there is no
 * fallback provider to degrade to (see `node/capabilities.ts`'s job-type
 * readiness gating, which keys `face_detection` on the `compreface`
 * capability).
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'face_detection'`:
 * `{ modelVersion, providerKey, imageWidth, imageHeight, faces: [{ boundingBox px, confidence?, embedding }] }`.
 */

import fs from 'node:fs';

import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';
import {
  detectComprefaceFaces,
  COMPREFACE_MODEL_VERSION,
  COMPREFACE_PROVIDER_KEY,
} from '@memoriahub/enrichment-compute/face-compreface';

import { loadConfig } from '../../config.js';
import { CapabilityUnavailableError, DEFAULT_COMPREFACE_URL, type ComputeFn } from '../capabilities.js';

/**
 * Downscale ceiling before detection — MUST match the server's
 * FACE_MAX_IMAGE_DIM default (see apps/api/src/face/face-detection.service.ts:
 * `parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10)`), so a node and the
 * server detect against identically-sized inputs and produce comparable
 * pixel-space bounding boxes.
 */
const FACE_MAX_IMAGE_DIM = 2000;

const computeFaceDetection: ComputeFn = async (inputPath, _params) => {
  const buffer = fs.readFileSync(inputPath);
  const cfg = loadConfig();
  const comprefaceUrl = cfg?.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL;

  // Same EXIF-orientation + downscale step the server runs before detection.
  const prepared = await prepareImageForProcessing(buffer, { maxDim: FACE_MAX_IMAGE_DIM });
  const uprightBuffer = prepared.width > 0 && prepared.height > 0 ? prepared.buffer : buffer;

  // No catch-and-fallback here: an unreachable sidecar must surface as a
  // normal compute error, routed through the engine's existing /failure +
  // retry/backoff path. CapabilityUnavailableError carries the capability key
  // the doctor/startup self-test also gates on.
  let faces: Awaited<ReturnType<typeof detectComprefaceFaces>>;
  try {
    faces = await detectComprefaceFaces(comprefaceUrl, uprightBuffer);
  } catch (err) {
    throw new CapabilityUnavailableError(
      `compreface-core sidecar at ${comprefaceUrl} could not process this image — ` +
        'start the sidecar (see `memoriahub node install-deps`) or point ' +
        '--compreface-url / MEMORIAHUB_COMPREFACE_URL at a running instance',
      'compreface',
      err instanceof Error ? err.message : String(err),
    );
  }

  // CompreFace's response carries no image dimensions. When
  // prepareImageForProcessing already gave us dimensions, use those;
  // otherwise fall back to a direct sharp metadata read of the same buffer we
  // sent, so imageWidth/imageHeight are never both 0.
  let imageWidth = prepared.width;
  let imageHeight = prepared.height;
  if (imageWidth === 0 || imageHeight === 0) {
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(uprightBuffer).metadata();
      imageWidth = meta.width ?? 0;
      imageHeight = meta.height ?? 0;
    } catch {
      // leave at 0 — the result will fail server-side DTO validation and
      // route through the normal job-failure path, same as any other
      // undecodable-image compute error.
    }
  }

  return {
    modelVersion: COMPREFACE_MODEL_VERSION,
    providerKey: COMPREFACE_PROVIDER_KEY,
    imageWidth,
    imageHeight,
    faces: faces.map((face) => ({
      boundingBox: {
        x: face.boundingBox.x,
        y: face.boundingBox.y,
        width: face.boundingBox.w,
        height: face.boundingBox.h,
      },
      confidence: face.confidence,
      landmarks: face.landmarks,
      embedding: face.embedding ?? [],
    })),
  };
};

export default computeFaceDetection;
