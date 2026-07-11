/**
 * node/compute/duplicate-detection.ts — Near-duplicate compute.
 *
 * Runs the full duplicate-detection compute locally via the shared
 * `@memoriahub/enrichment-compute` parity package so node-computed vectors are
 * numerically identical to server-computed ones (distributed-nodes spec §7):
 *
 *   1. dHash (64-bit perceptual hash, decimal string) via sharp
 *   2. CLIP ViT-B/32 512-d visual embedding via onnxruntime-node
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'duplicate_detection'`:
 * `{ model: string, embedding: number[] (512), dHash: string }`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createClipSession,
  embedImageWithSession,
  VISUAL_EMBEDDING_MODEL_TAG,
} from '@memoriahub/enrichment-compute/clip';
import { computeDHash } from '@memoriahub/enrichment-compute/dhash';

import { modelsDir } from '../../paths.js';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';

const CLIP_MODEL_FILENAME = 'clip-vit-b32-vision-quantized.onnx';

/** Session type derived from the factory so onnxruntime-node types aren't imported directly. */
type ClipSession = Awaited<ReturnType<typeof createClipSession>>;

/**
 * Module-level lazy singleton for the ONNX InferenceSession — creating a
 * session costs ~220ms, so it is cached across jobs for the lifetime of the
 * worker process. The promise (not the session) is cached so concurrent jobs
 * share a single in-flight initialization; a failed init clears the cache so
 * the next job can retry.
 */
let sessionPromise: Promise<ClipSession> | null = null;

function getClipSession(): Promise<ClipSession> {
  if (!sessionPromise) {
    const modelPath = path.join(process.env.MODELS_DIR ?? modelsDir(), CLIP_MODEL_FILENAME);
    if (!fs.existsSync(modelPath)) {
      throw new CapabilityUnavailableError(
        'CLIP model not present — run `node doctor`/`node start` to download models',
        'onnxruntime',
      );
    }
    sessionPromise = createClipSession(modelPath).catch((err: unknown) => {
      sessionPromise = null; // allow retry on a later job
      throw err;
    });
  }
  return sessionPromise;
}

const computeDuplicateDetection: ComputeFn = async (inputPath, _params) => {
  const buffer = fs.readFileSync(inputPath);

  const dHash = await computeDHash(buffer);
  // The server DTO requires BOTH fields — node-side degraded (dHash-only) mode
  // is a later enhancement. An undecodable image is a regular Error so the
  // engine routes it to /failure and the server retries (or runs it itself).
  if (dHash === null) {
    throw new Error('duplicate_detection: image could not be decoded for dHash');
  }

  const session = await getClipSession();
  const embedding = await embedImageWithSession(session, buffer);
  if (embedding === null) {
    throw new Error('duplicate_detection: CLIP embedding failed (image not embeddable)');
  }

  return { model: VISUAL_EMBEDDING_MODEL_TAG, embedding, dHash };
};

export default computeDuplicateDetection;
