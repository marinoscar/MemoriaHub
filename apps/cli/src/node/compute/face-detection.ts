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
 *   2. Detect via the configured provider — the keyless Human WASM provider
 *      (1024-d embeddings, default) or, when this node's `faceProvider`
 *      config is set to `'compreface'`, a locally-running compreface-core
 *      sidecar (128-d embeddings) reachable at `comprefaceUrl`.
 *
 * A node defaults to the Human provider regardless of the server's active
 * face-detection provider (which may be compreface or a delegated provider
 * like rekognition) — see FaceDetectionService.warnOnProviderMismatch on the
 * API side for what a provider mismatch implies for person-matching. An
 * operator running the server with CompreFace as the active provider can
 * opt individual nodes into CompreFace too (`--face-provider compreface`) to
 * match it and eliminate that mismatch warning. A CompreFace-configured node
 * whose local sidecar is unreachable is a HARD failure here — never a silent
 * fallback to Human (see `node/capabilities.ts`'s job-type readiness gating).
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'face_detection'`:
 * `{ modelVersion, providerKey, imageWidth, imageHeight, faces: [{ boundingBox px, confidence?, embedding }] }`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';
import {
  createFaceDetector,
  FACE_MODEL_VERSION,
  FACE_PROVIDER_KEY,
  type FaceDetector,
} from '@memoriahub/enrichment-compute/face';
import {
  detectComprefaceFaces,
  COMPREFACE_MODEL_VERSION,
  COMPREFACE_PROVIDER_KEY,
} from '@memoriahub/enrichment-compute/face-compreface';

import { loadConfig } from '../../config.js';
import { modelsDir } from '../../paths.js';
import { CapabilityUnavailableError, DEFAULT_COMPREFACE_URL, type ComputeFn } from '../capabilities.js';

/**
 * Downscale ceiling before detection — MUST match the server's
 * FACE_MAX_IMAGE_DIM default (see apps/api/src/face/face-detection.service.ts:
 * `parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10)`), so a node and the
 * server detect against identically-sized inputs and produce comparable
 * pixel-space bounding boxes.
 */
const FACE_MAX_IMAGE_DIM = 2000;

/**
 * Module-level lazy singleton for the Human face detector — model load +
 * warmup costs real time, so it is cached across jobs for the lifetime of the
 * worker process. The promise (not the detector) is cached so concurrent jobs
 * share a single in-flight initialization; a failed init clears the cache so
 * the next job can retry.
 */
let detectorPromise: Promise<FaceDetector> | null = null;

/**
 * Resolve the Human model directory: `FACE_HUMAN_MODEL_PATH` (set by the CLI's
 * `ensureModels` once models are downloaded) takes precedence; otherwise fall
 * back to `${MODELS_DIR ?? modelsDir()}/human`.
 */
function resolveModelBasePath(): string {
  const override = process.env['FACE_HUMAN_MODEL_PATH'];
  if (override) return override;
  return path.join(process.env['MODELS_DIR'] ?? modelsDir(), 'human');
}

function getFaceDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    const modelBasePath = resolveModelBasePath();
    if (!fs.existsSync(modelBasePath)) {
      throw new CapabilityUnavailableError(
        `Human face model not present at ${modelBasePath} — run \`node doctor\`/\`node start\` to download models`,
        'human',
      );
    }
    detectorPromise = createFaceDetector({ modelBasePath }).catch((err: unknown) => {
      detectorPromise = null; // allow retry on a later job
      throw err;
    });
  }
  return detectorPromise;
}

const computeFaceDetection: ComputeFn = async (inputPath, _params) => {
  const buffer = fs.readFileSync(inputPath);
  const cfg = loadConfig();
  const faceProvider = cfg?.node?.faceProvider ?? 'human';

  // Same EXIF-orientation + downscale step the server runs before detection.
  const prepared = await prepareImageForProcessing(buffer, { maxDim: FACE_MAX_IMAGE_DIM });
  const uprightBuffer = prepared.width > 0 && prepared.height > 0 ? prepared.buffer : buffer;

  if (faceProvider === 'compreface') {
    const comprefaceUrl = cfg?.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL;
    // No catch-and-fallback here: an unreachable sidecar must surface as a
    // normal compute error, routed through the engine's existing /failure +
    // retry/backoff path — never a silent degrade to the Human provider.
    const faces = await detectComprefaceFaces(comprefaceUrl, uprightBuffer);

    // CompreFace's response carries no image dimensions (unlike the Human
    // detector, which decodes uprightBuffer itself via sharp and hands back
    // real width/height regardless of whether prepareImageForProcessing
    // succeeded). When prepareImageForProcessing already gave us dimensions,
    // use those; otherwise fall back to a direct sharp metadata read of the
    // same buffer we sent, so imageWidth/imageHeight are never both 0.
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
  }

  const detector = await getFaceDetector();
  const { width, height, faces } = await detector.detect(uprightBuffer);

  return {
    modelVersion: FACE_MODEL_VERSION,
    providerKey: FACE_PROVIDER_KEY,
    imageWidth: width,
    imageHeight: height,
    // ComputeDetectedFace.boundingBox is already { x, y, width, height } in
    // PIXEL space — the exact shape the server-side DTO expects, no remapping.
    faces: faces.map((face) => ({
      boundingBox: face.boundingBox,
      confidence: face.confidence,
      embedding: face.embedding ?? [],
    })),
  };
};

export default computeFaceDetection;
