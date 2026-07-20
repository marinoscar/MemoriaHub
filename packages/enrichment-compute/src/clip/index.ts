/**
 * CLIP ViT-B/32 visual-embedding compute (moved from
 * apps/api/src/dedup/visual-embedding.service.ts).
 *
 * This module holds ONLY the pure compute half: preprocessing, session
 * creation from an explicit model path, and inference. Model download,
 * MODELS_DIR resolution, degraded-mode tracking, idle session release, and
 * Prisma persistence all stay in the host (the API's VisualEmbeddingService,
 * or the CLI worker's model manager). The package never reads env vars.
 *
 * Parity contract (docs/specs/distributed-nodes.md §7): a vector produced by
 * `embedImageWithSession` on a worker node must be numerically identical to
 * one produced on the server for the same bytes — same sharp preprocessing,
 * same CLIP mean/std, same onnxruntime-node version (exact-pinned).
 */

import type { InferenceSession } from 'onnxruntime-node';
import { prepareImageForProcessing } from '../image/index.js';

/** Tag stored in media_visual_embedding.model so future model swaps are traceable. */
export const VISUAL_EMBEDDING_MODEL_TAG = 'clip-vit-b32-q8';
export const VISUAL_EMBEDDING_DIMENSIONS = 512;

export const CLIP_IMAGE_SIZE = 224;
export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

/**
 * onnxruntime-node is CommonJS; depending on the importing runtime (real ESM,
 * transpiled CJS, jest) the namespace may or may not nest the module under
 * `.default`. Normalize both shapes.
 */
async function loadOrt(): Promise<typeof import('onnxruntime-node')> {
  const mod = await import('onnxruntime-node');
  return ((mod as { default?: unknown }).default ??
    mod) as typeof import('onnxruntime-node');
}

/**
 * Resize an image buffer to 224x224 (fit=fill, matching CLIP's preprocessor),
 * apply EXIF orientation first via prepareImageForProcessing, then normalize
 * to CLIP's mean/std and lay out as a CHW float32 tensor.
 *
 * Returns null when the image cannot be decoded.
 */
export async function preprocessImageForClip(buffer: Buffer): Promise<Float32Array | null> {
  try {
    const { buffer: prepared, width } = await prepareImageForProcessing(buffer);
    if (width === 0) {
      return null;
    }

    const sharp = (await import('sharp')).default;
    const { data } = await sharp(prepared)
      .resize(CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const numPixels = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE;
    const out = new Float32Array(3 * numPixels);

    for (let i = 0; i < numPixels; i++) {
      const r = data[i * 3] / 255;
      const g = data[i * 3 + 1] / 255;
      const b = data[i * 3 + 2] / 255;
      out[i] = (r - CLIP_MEAN[0]) / CLIP_STD[0]; // R plane
      out[numPixels + i] = (g - CLIP_MEAN[1]) / CLIP_STD[1]; // G plane
      out[2 * numPixels + i] = (b - CLIP_MEAN[2]) / CLIP_STD[2]; // B plane
    }

    return out;
  } catch {
    return null;
  }
}

/** L2-normalize a vector so cosine similarity == dot product downstream. */
export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Heuristic ONNX file sanity check.
 *
 * ONNX files are serialized protobuf (ModelProto). There is no official
 * magic number, but protobuf serializers near-universally emit the first
 * field (ir_version, field #1, varint wiretype) first, producing a leading
 * byte of 0x08. This is a heuristic, not a guarantee.
 *
 * We deliberately do NOT pin a SHA-256 checksum here: Hugging Face may
 * rebuild/re-quantize the file over time, and this function must keep
 * working in offline/air-gapped deployments where a checksum could never be
 * refreshed without a code change. Combined with the size check and the fact
 * that `InferenceSession.create()` will throw on a genuinely corrupt file,
 * this heuristic is sufficient defense against downloading an HTML error
 * page or a truncated file in place of the real model.
 */
export function looksLikeOnnxModel(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x08;
}

/**
 * Create an onnxruntime InferenceSession for the CLIP vision model at the
 * given path. The model path is an explicit PARAMETER — the host owns model
 * download/location (env vars, MODELS_DIR, manifest verification); this
 * function only loads what it is handed. Throws on load failure; the host is
 * responsible for degraded-mode handling.
 */
export async function createClipSession(modelPath: string): Promise<InferenceSession> {
  const ort = await loadOrt();
  return ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: 2,
    // Memory-stability options for a long-lived worker running sustained
    // inference (hours of bulk-import image jobs). Both are PARITY-SAFE — they
    // change only onnxruntime's internal memory management, never the computed
    // embedding, so a node stays numerically identical to the server:
    //   - enableCpuMemArena: the CPU arena allocator grows to an inference's
    //     high-water mark and holds it; disabling trades a little per-call
    //     allocation cost for not pinning that peak for the process lifetime.
    //   - enableMemPattern: pre-planned reuse buffers, another retained pool.
    // "Slow but alive" is the queue's design goal, so we favor lower steady-
    // state memory over marginal throughput here.
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
}

/**
 * Default number of embeds after which a host should recycle (release +
 * recreate) its CLIP `InferenceSession`, bounding any native memory the session
 * accumulates across `run()` calls over a multi-hour import. Recreating a
 * session costs ~200 ms, so amortized over this many jobs the overhead is
 * negligible. Hosts read their own env override (`MEMORIAHUB_CLIP_RECYCLE_AFTER`
 * on the worker, `CLIP_SESSION_RECYCLE_AFTER` on the API) and fall back to this;
 * `0` disables recycling.
 */
export const DEFAULT_CLIP_RECYCLE_AFTER = 1000;

/**
 * Best-effort release of a CLIP `InferenceSession`'s NATIVE resources.
 * `InferenceSession.release()` (present in the pinned onnxruntime-node) frees
 * the native session and its allocator; unlike a CPU `Tensor.dispose()` (which
 * is a GPU/WebNN no-op), this actually reclaims memory. The host owns *when* to
 * call it (bounded-lifetime recycling / shutdown); this helper just
 * encapsulates the version-specific call so both hosts stay in sync. Swallows
 * errors — a failed release must never fail a job.
 */
export async function releaseClipSession(session: InferenceSession): Promise<void> {
  const release = (session as { release?: unknown }).release;
  if (typeof release === 'function') {
    try {
      await (release as () => Promise<void>).call(session);
    } catch {
      /* best-effort — GC reclaims it eventually */
    }
  }
}

/**
 * Compute an L2-normalized 512-d CLIP image embedding for the given bytes
 * using an already-created session.
 *
 * Returns null when the image cannot be decoded (preprocessing failure) or
 * inference produces no output. Inference ERRORS propagate to the caller —
 * session lifecycle/degraded-mode policy is a host concern, not a compute
 * concern.
 */
export async function embedImageWithSession(
  session: InferenceSession,
  buffer: Buffer,
): Promise<number[] | null> {
  const tensorData = await preprocessImageForClip(buffer);
  if (!tensorData) {
    return null;
  }

  const ort = await loadOrt();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const tensor = new ort.Tensor('float32', tensorData, [1, 3, CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE]);
  const outputs = await session.run({ [inputName]: tensor });
  const raw = outputs[outputName]?.data as Float32Array | undefined;

  // Copy out what we need, then promptly release the input + output tensors'
  // native backing rather than waiting on V8 GC / finalizers to catch up — a
  // long-lived worker running sustained inference must not accumulate one
  // undisposed OrtValue per image. `dispose()` exists on onnxruntime-node's
  // Tensor in recent versions; guard so older versions (no-op) still work.
  const result = raw && raw.length > 0 ? l2Normalize(Array.from(raw)) : null;
  disposeTensor(tensor);
  for (const key of Object.keys(outputs)) disposeTensor(outputs[key]);

  return result;
}

/** Best-effort release of an onnxruntime tensor's native backing (version-guarded). */
function disposeTensor(t: unknown): void {
  const d = (t as { dispose?: unknown } | null | undefined)?.dispose;
  if (typeof d === 'function') {
    try {
      (d as () => void).call(t);
    } catch {
      /* older onnxruntime-node: no-op / not disposable — GC will reclaim it */
    }
  }
}
