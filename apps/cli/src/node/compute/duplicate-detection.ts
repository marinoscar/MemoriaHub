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
  releaseClipSession,
  DEFAULT_CLIP_RECYCLE_AFTER,
  VISUAL_EMBEDDING_MODEL_TAG,
} from '@memoriahub/enrichment-compute/clip';
import { computeDHash } from '@memoriahub/enrichment-compute/dhash';

import { modelsDir } from '../../paths.js';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';

const CLIP_MODEL_FILENAME = 'clip-vit-b32-vision-quantized.onnx';

/** Session type derived from the factory so onnxruntime-node types aren't imported directly. */
type ClipSession = Awaited<ReturnType<typeof createClipSession>>;

/**
 * Number of embeds after which the CLIP session is recycled (released +
 * recreated) to bound any native memory onnxruntime accumulates across
 * `run()` calls over a multi-hour import. `MEMORIAHUB_CLIP_RECYCLE_AFTER`
 * overrides; `0` disables. See `DEFAULT_CLIP_RECYCLE_AFTER`.
 */
function resolveRecycleAfter(): number {
  const env = process.env['MEMORIAHUB_CLIP_RECYCLE_AFTER'];
  if (env !== undefined && env.trim() !== '') {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_CLIP_RECYCLE_AFTER;
}

/**
 * A CLIP session plus its per-session lifetime counters. Counters live on the
 * holder (not module-level) so a retired session and its replacement never
 * share state — retirement detaches the holder, and concurrent in-flight
 * embeds on the old session drain against ITS own counter before it is
 * released. Creating a session costs ~220 ms, so it is reused across jobs.
 */
interface SessionHolder {
  session: ClipSession;
  useCount: number;
  inFlight: number;
  retiring: boolean;
  released: boolean;
}

let currentHolder: SessionHolder | null = null;
let holderLoadPromise: Promise<SessionHolder> | null = null;

function getHolder(): Promise<SessionHolder> {
  if (currentHolder) return Promise.resolve(currentHolder);
  if (!holderLoadPromise) {
    const modelPath = path.join(process.env.MODELS_DIR ?? modelsDir(), CLIP_MODEL_FILENAME);
    if (!fs.existsSync(modelPath)) {
      throw new CapabilityUnavailableError(
        'CLIP model not present — run `node doctor`/`node start` to download models',
        'onnxruntime',
      );
    }
    holderLoadPromise = createClipSession(modelPath)
      .then((session): SessionHolder => {
        const holder: SessionHolder = {
          session,
          useCount: 0,
          inFlight: 0,
          retiring: false,
          released: false,
        };
        currentHolder = holder;
        holderLoadPromise = null;
        return holder;
      })
      .catch((err: unknown) => {
        holderLoadPromise = null; // allow retry on a later job
        throw err;
      });
  }
  return holderLoadPromise;
}

/**
 * Recycle the current session once it has served `recycleAfter` embeds:
 * detach it so no NEW embed is routed to it (the next `getHolder()` builds a
 * fresh one), and release its native resources once its own in-flight embeds
 * have drained to zero.
 */
function maybeRetire(holder: SessionHolder, recycleAfter: number): void {
  if (recycleAfter <= 0) return;
  if (!holder.retiring && holder.useCount >= recycleAfter) {
    holder.retiring = true;
    if (currentHolder === holder) currentHolder = null;
  }
  if (holder.retiring && holder.inFlight === 0 && !holder.released) {
    holder.released = true;
    void releaseClipSession(holder.session);
  }
}

async function embedWithRecycling(buffer: Buffer): Promise<number[] | null> {
  const recycleAfter = resolveRecycleAfter();
  const holder = await getHolder();
  holder.inFlight += 1;
  try {
    return await embedImageWithSession(holder.session, buffer);
  } finally {
    holder.inFlight -= 1;
    holder.useCount += 1;
    maybeRetire(holder, recycleAfter);
  }
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

  const embedding = await embedWithRecycling(buffer);
  if (embedding === null) {
    throw new Error('duplicate_detection: CLIP embedding failed (image not embeddable)');
  }

  return { model: VISUAL_EMBEDDING_MODEL_TAG, embedding, dHash };
};

export default computeDuplicateDetection;
