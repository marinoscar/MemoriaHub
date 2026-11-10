/**
 * node/compute/face-detection.ts — Photo face-detection compute.
 *
 * Runs the full face-detection compute locally via the shared
 * `@marinoscar/memoriahub-compute` parity package so node-computed faces are
 * numerically identical to server-computed ones (distributed-nodes spec §7):
 *
 *   1. EXIF-orient + downscale via prepareImageForProcessing (same maxDim the
 *      server uses — FACE_MAX_IMAGE_DIM's default of 2000, see the constant
 *      below).
 *   2. Detect via a locally-running compreface-core sidecar (128-d
 *      embeddings) reachable at `comprefaceUrl` — CompreFace is the only
 *      supported face provider (Human and AWS Rekognition were removed,
 *      issue #113).
 *
 * A CompreFace-configured node whose local sidecar is unreachable is a HARD
 * failure here — never a silent fallback to any other provider (see
 * `node/capabilities.ts`'s job-type readiness gating).
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'face_detection'`:
 * `{ modelVersion, providerKey, imageWidth, imageHeight, faces: [{ boundingBox px, confidence?, embedding }] }`.
 */

import fs from 'node:fs';

import { prepareImageForProcessing } from '@marinoscar/memoriahub-compute/image';
import {
  detectComprefaceFaces,
  COMPREFACE_MODEL_VERSION,
  COMPREFACE_PROVIDER_KEY,
} from '@marinoscar/memoriahub-compute/face-compreface';

import { comprefaceUrl as resolveComprefaceUrl, intAttribute, runPhase, type ComputeFn } from '../support.js';
import { timedCompreface } from './telemetry-state.js';

/**
 * Downscale ceiling before detection — MUST match the server's
 * FACE_MAX_IMAGE_DIM default (see apps/api/src/face/face-detection.service.ts:
 * `parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10)`), so a node and the
 * server detect against identically-sized inputs and produce comparable
 * pixel-space bounding boxes.
 */
const FACE_MAX_IMAGE_DIM = 2000;

const computeFaceDetection: ComputeFn = async (inputPath, _params, ctx) => {
  const buffer = fs.readFileSync(inputPath);
  const comprefaceUrl = resolveComprefaceUrl();

  // Same EXIF-orientation + downscale step the server runs before detection.
  const prepared = await runPhase(
    ctx,
    'job.app.decode',
    () => prepareImageForProcessing(buffer, { maxDim: FACE_MAX_IMAGE_DIM }),
    (result) => ({ width: intAttribute(result.width), height: intAttribute(result.height) }),
  );
  const uprightBuffer = prepared.width > 0 && prepared.height > 0 ? prepared.buffer : buffer;

  // No catch-and-fallback here: an unreachable sidecar must surface as a
  // normal compute error, routed through the engine's existing /failure +
  // retry/backoff path — never a silent degrade to another provider.
  const faces = await runPhase(
    ctx,
    'job.app.compreface_detect',
    () => timedCompreface(() => detectComprefaceFaces(comprefaceUrl, uprightBuffer)),
    (result) => ({ faces: result.length }),
  );

  // CompreFace's response carries no image dimensions. When
  // prepareImageForProcessing already gave us dimensions, use those;
  // otherwise fall back to a direct sharp metadata read of the same buffer
  // we sent, so imageWidth/imageHeight are never both 0.
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
