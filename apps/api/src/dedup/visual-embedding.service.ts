/**
 * VisualEmbeddingService
 *
 * Computes and persists 512-d CLIP ViT-B/32 image embeddings used for
 * visual near-duplicate detection (see docs/specs — Duplicate Detection).
 *
 * The model (Xenova/clip-vit-base-patch32 vision tower, int8-quantized ONNX)
 * is NOT bundled in the repo. It is lazily downloaded to disk on first use
 * and lazily loaded into an onnxruntime-node InferenceSession on first embed
 * call, then released after a period of inactivity to free memory.
 *
 * Degraded-mode contract: any failure to download/load/run the model is
 * caught internally. `isAvailable()` reflects the degraded flag, and
 * `embedImage` / `ensureEmbedding` return `null` / `'unavailable'` rather
 * than throwing. Callers (DuplicateDetectionService) MUST fall back to
 * hash-only matching when embeddings are unavailable — visual embeddings are
 * a best-effort enhancement, never a hard dependency for the dedup feature
 * to function.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { InferenceSession } from 'onnxruntime-node';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MODEL_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx';
const MODEL_FILENAME = 'clip-vit-b32-vision-quantized.onnx';
/** Tag stored in media_visual_embedding.model so future model swaps are traceable. */
export const VISUAL_EMBEDDING_MODEL_TAG = 'clip-vit-b32-q8';
export const VISUAL_EMBEDDING_DIMENSIONS = 512;

const MIN_MODEL_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB — the quantized vision tower is ~87 MB
const IDLE_RELEASE_MS = 5 * 60 * 1000; // 5 minutes

const CLIP_IMAGE_SIZE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

export type EnsureEmbeddingResult = 'exists' | 'created' | 'unavailable';

// -----------------------------------------------------------------------------
// Pure, testable preprocessing helpers (no DI, no I/O beyond the buffer given)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

@Injectable()
export class VisualEmbeddingService implements OnModuleDestroy {
  private readonly logger = new Logger(VisualEmbeddingService.name);

  private session: InferenceSession | null = null;
  private sessionLoadPromise: Promise<InferenceSession | null> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private degraded = false;
  private degradedWarned = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
  ) {}

  onModuleDestroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.releaseSession();
  }

  /** Whether the model has loaded successfully at least once and has not entered degraded mode. */
  isAvailable(): boolean {
    return !this.degraded;
  }

  // ---------------------------------------------------------------------------
  // Model file management
  // ---------------------------------------------------------------------------

  private getModelsDir(): string {
    return process.env['MODELS_DIR'] ?? './data/models';
  }

  getModelPath(): string {
    return path.join(this.getModelsDir(), MODEL_FILENAME);
  }

  private async ensureModel(): Promise<string> {
    const dir = this.getModelsDir();
    const filePath = this.getModelPath();

    await fs.promises.mkdir(dir, { recursive: true });

    if (fs.existsSync(filePath)) {
      return filePath;
    }

    this.logger.log(`Downloading CLIP vision model to ${filePath}...`);

    const res = await fetch(MODEL_URL);
    if (!res.ok) {
      throw new Error(`Model download failed: HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length < MIN_MODEL_SIZE_BYTES) {
      throw new Error(
        `Downloaded model file too small (${buffer.length} bytes; expected > ${MIN_MODEL_SIZE_BYTES})`,
      );
    }
    if (!looksLikeOnnxModel(buffer)) {
      throw new Error('Downloaded file failed ONNX magic-byte sanity check');
    }

    // Write to a temp file in the SAME directory (so the rename below is
    // atomic — same filesystem/mount) then rename into place.
    const tmpPath = path.join(dir, `.${MODEL_FILENAME}.${randomUUID()}.tmp`);
    await fs.promises.writeFile(tmpPath, buffer);
    await fs.promises.rename(tmpPath, filePath);

    this.logger.log(
      `CLIP vision model downloaded and verified (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`,
    );

    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => this.releaseSession(), IDLE_RELEASE_MS);
    this.idleTimer.unref?.();
  }

  private releaseSession(): void {
    if (this.session) {
      const s = this.session;
      this.session = null;
      s.release().catch((err: unknown) => {
        this.logger.warn(
          `Failed to release idle ONNX session: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      this.logger.debug('Released idle CLIP ONNX session');
    }
  }

  private async loadSession(): Promise<InferenceSession | null> {
    try {
      const modelPath = await this.ensureModel();
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: 2,
      });
      this.session = session;
      this.resetIdleTimer();
      return session;
    } catch (err) {
      this.degraded = true;
      if (!this.degradedWarned) {
        this.degradedWarned = true;
        this.logger.warn(
          `VisualEmbeddingService running in degraded mode (visual embeddings unavailable, ` +
            `dedup will fall back to hash-only matching): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }

  private async getSession(): Promise<InferenceSession | null> {
    if (this.degraded) {
      return null;
    }
    if (this.session) {
      this.resetIdleTimer();
      return this.session;
    }
    if (!this.sessionLoadPromise) {
      this.sessionLoadPromise = this.loadSession().finally(() => {
        this.sessionLoadPromise = null;
      });
    }
    return this.sessionLoadPromise;
  }

  // ---------------------------------------------------------------------------
  // Embedding
  // ---------------------------------------------------------------------------

  /**
   * Compute an L2-normalized 512-d CLIP image embedding for the given bytes.
   * Returns null on any failure (degraded mode, undecodable image, inference error).
   */
  async embedImage(buffer: Buffer): Promise<number[] | null> {
    const session = await this.getSession();
    if (!session) {
      return null;
    }

    try {
      const tensorData = await preprocessImageForClip(buffer);
      if (!tensorData) {
        return null;
      }

      const ort = await import('onnxruntime-node');
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];

      const tensor = new ort.Tensor('float32', tensorData, [1, 3, CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE]);
      const outputs = await session.run({ [inputName]: tensor });
      const raw = outputs[outputName]?.data as Float32Array | undefined;

      if (!raw || raw.length === 0) {
        return null;
      }

      return l2Normalize(Array.from(raw));
    } catch (err) {
      this.logger.warn(`embedImage failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Ensure a visual embedding row exists for a media item — idempotent and
   * resumable (checks existence first so backfill/batch handlers can retry
   * freely without re-embedding already-processed items).
   */
  async ensureEmbedding(mediaItemId: string): Promise<EnsureEmbeddingResult> {
    const existing = await this.prisma.$queryRaw<{ exists: number }[]>`
      SELECT 1 AS exists FROM media_visual_embedding WHERE media_item_id = ${mediaItemId}::uuid LIMIT 1`;

    if (existing.length > 0) {
      return 'exists';
    }

    const item = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { storageObjectId: true, circleId: true },
    });

    if (!item?.storageObjectId) {
      return 'unavailable';
    }

    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: item.storageObjectId },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });

    if (!storageObject?.storageKey) {
      return 'unavailable';
    }

    let buffer: Buffer;
    try {
      const provider = await this.resolver.getProviderFor(storageObject.storageProvider, storageObject.bucket);
      const stream = await provider.download(storageObject.storageKey);
      buffer = await streamToBuffer(stream);
    } catch (err) {
      this.logger.warn(
        `ensureEmbedding: failed to download bytes for MediaItem ${mediaItemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'unavailable';
    }

    const embedding = await this.embedImage(buffer);
    if (!embedding) {
      return 'unavailable';
    }

    const vectorLiteral = `[${embedding.join(',')}]`;
    await this.prisma.$executeRaw`
      INSERT INTO media_visual_embedding (media_item_id, circle_id, embedding, model)
      VALUES (${mediaItemId}::uuid, ${item.circleId}::uuid, ${vectorLiteral}::vector, ${VISUAL_EMBEDDING_MODEL_TAG})
      ON CONFLICT (media_item_id) DO UPDATE
        SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`;

    return 'created';
  }
}
