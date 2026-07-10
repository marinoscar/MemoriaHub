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
 * The PURE compute (preprocessing, session creation, inference) lives in the
 * shared parity package @memoriahub/enrichment-compute (clip subpath) so
 * distributed worker nodes produce numerically identical vectors — see
 * docs/specs/distributed-nodes.md §7. This service keeps the HOST concerns:
 * model download/MODELS_DIR resolution, degraded-mode tracking, idle session
 * release, and Prisma persistence.
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
import {
  createClipSession,
  embedImageWithSession,
  looksLikeOnnxModel,
  VISUAL_EMBEDDING_MODEL_TAG,
} from '@memoriahub/enrichment-compute/clip';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
// Imported for the side effect of wiring the shared package's logger into
// NestJS logging (and kept as the canonical orientation-prep import site).
import '../storage/processing/image-orientation.util';

// -----------------------------------------------------------------------------
// Re-exports for import-compat — the pure functions/constants moved to the
// shared parity package but existing import sites reference this module.
// -----------------------------------------------------------------------------

export {
  preprocessImageForClip,
  l2Normalize,
  looksLikeOnnxModel,
  VISUAL_EMBEDDING_MODEL_TAG,
  VISUAL_EMBEDDING_DIMENSIONS,
} from '@memoriahub/enrichment-compute/clip';

// -----------------------------------------------------------------------------
// Host-side constants (model download/lifecycle — NOT part of the compute)
// -----------------------------------------------------------------------------

const MODEL_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx';
const MODEL_FILENAME = 'clip-vit-b32-vision-quantized.onnx';

const MIN_MODEL_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB — the quantized vision tower is ~87 MB
const IDLE_RELEASE_MS = 5 * 60 * 1000; // 5 minutes

export type EnsureEmbeddingResult = 'exists' | 'created' | 'unavailable';

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
      const session = await createClipSession(modelPath);
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
      return await embedImageWithSession(session, buffer);
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
