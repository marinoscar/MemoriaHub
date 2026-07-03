/**
 * Shared on-demand visual-hash backfill helper.
 *
 * Extracted from BurstDetectionService so both burst detection and
 * duplicate detection can compute + persist a legacy item's perceptualHash /
 * sharpnessScore via the exact same code path, instead of duplicating the
 * "download bytes → computeVisualHash → persist" sequence in two services.
 *
 * This is a plain function (not an injectable) — callers pass their own
 * PrismaService/StorageProviderResolver/Logger instances — so there is no
 * new DI wiring or circular-module-dependency risk between the burst and
 * dedup feature modules.
 *
 * Best-effort semantics (matches the original BurstDetectionService behavior):
 *  - Transient storage errors (network, throttling) are re-thrown so the
 *    enrichment worker's normal retry logic kicks in.
 *  - A permanently undecodable image (computeVisualHash returns null) is
 *    logged and returns null — callers should continue without a hash.
 */

import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProviderResolver } from '../providers/storage-provider.resolver';
import { streamToBuffer } from './processors/stream-utils';
import { computeVisualHash } from './visual-hash.util';

export interface HashBackfillResult {
  perceptualHash: bigint;
  sharpnessScore: number;
}

/**
 * Downloads the image bytes for `storageObjectId`, computes the dHash +
 * sharpness score, and persists both onto the MediaItem row.
 *
 * @returns the computed values, or null when the object/hash is unavailable
 *          (not an error — callers should skip hash-based matching).
 */
export async function computeAndPersistVisualHash(
  prisma: PrismaService,
  resolver: StorageProviderResolver,
  mediaItemId: string,
  storageObjectId: string,
  logger: Logger,
): Promise<HashBackfillResult | null> {
  const storageObject = await prisma.storageObject.findUnique({
    where: { id: storageObjectId },
    select: { storageKey: true, storageProvider: true, bucket: true },
  });

  if (!storageObject?.storageKey) {
    logger.warn(
      `MediaItem ${mediaItemId}: storageObject ${storageObjectId} not found or has no storageKey; cannot compute hash`,
    );
    return null;
  }

  // Stream the object bytes from the object's own provider+bucket.
  // Transient errors (network, throttle) propagate so the worker retries.
  const objectProvider = await resolver.getProviderFor(
    storageObject.storageProvider,
    storageObject.bucket,
  );
  const stream = await objectProvider.download(storageObject.storageKey);
  const buffer = await streamToBuffer(stream);

  const result = await computeVisualHash(buffer);

  if (!result) {
    logger.warn(
      `MediaItem ${mediaItemId}: computeVisualHash returned null for key ${storageObject.storageKey}; item will skip hash-based matching`,
    );
    return null;
  }

  const { perceptualHash, sharpnessScore } = result;

  // Persist so subsequent runs (burst grouping, dedup matching, score
  // recompute) benefit without re-downloading the image.
  await prisma.mediaItem.update({
    where: { id: mediaItemId },
    data: {
      // Store as unsigned decimal string — the TEXT column accepts any uint64.
      perceptualHash: perceptualHash.toString(),
      sharpnessScore,
    },
  });

  logger.log(
    `MediaItem ${mediaItemId}: on-demand hash computed and persisted (dHash=${perceptualHash}, sharpness=${sharpnessScore.toFixed(2)})`,
  );

  return { perceptualHash, sharpnessScore };
}
