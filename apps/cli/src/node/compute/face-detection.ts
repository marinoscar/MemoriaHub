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
 *   2. Detect via the keyless Human WASM provider (1024-d embeddings).
 *
 * A node ALWAYS uses the Human provider, regardless of the server's active
 * face-detection provider (which may be compreface or a delegated provider
 * like rekognition) — see FaceDetectionService.warnOnProviderMismatch on the
 * API side for what a provider mismatch implies for person-matching.
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

import { modelsDir } from '../../paths.js';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';

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

  // Same EXIF-orientation + downscale step the server runs before detection.
  const prepared = await prepareImageForProcessing(buffer, { maxDim: FACE_MAX_IMAGE_DIM });
  const uprightBuffer = prepared.width > 0 && prepared.height > 0 ? prepared.buffer : buffer;

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
