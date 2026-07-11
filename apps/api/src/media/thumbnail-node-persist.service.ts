// =============================================================================
// Thumbnail Node-Result Persistence
// =============================================================================
//
// Shared PERSIST half for the node path of both `thumbnail_regen` and
// `thumbnail_repair` (ThumbnailRegenHandler / ThumbnailRepairHandler). The
// server-side in-process path for both handlers is untouched — it still
// calls StorageProcessingRecoveryService.reprocessObjectNow, running the full
// sharp/ffmpeg pipeline synchronously on the server.
//
// This is the NEW path for a distributed worker node: the node computes the
// JPEG locally (node/compute/thumbnail.ts), PUTs the bytes directly to a
// presigned URL obtained via `POST /api/nodes/:id/jobs/:jobId/upload-url`
// (NodesService.getJobUploadUrl — the server chooses the storage key, never
// the node), then submits `{ storageKey, width, height, bytes }` as its
// result. persistThumbnail() here only needs to (1) verify the upload
// actually landed at the expected size, then (2) write the exact same DB
// rows the server-side ThumbnailProcessor.uploadThumbnail writes, so both
// paths converge on identical columns:
//   - a StorageObject row for the thumbnail itself (status='ready',
//     metadata.thumbnailOf = original object id)
//   - the ORIGINAL StorageObject's metadata._processing.thumbnail entry
//     ({ thumbnailObjectId, thumbnailStorageKey })
//   - MediaItem.metadata.{thumbnailObjectId,thumbnailStorageKey} via
//     MediaMetadataSyncService.syncFromStorageObject (same helper the
//     upload/repair pipelines already use)
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, Prisma } from '@prisma/client';
import type { ThumbnailResult } from '@memoriahub/enrichment-compute/dto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';

@Injectable()
export class ThumbnailNodePersistService {
  private readonly logger = new Logger(ThumbnailNodePersistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly mediaMetadataSyncService: MediaMetadataSyncService,
  ) {}

  async persistThumbnail(job: EnrichmentJob, result: ThumbnailResult): Promise<void> {
    if (!job.mediaItemId) {
      this.logger.warn(`persistThumbnail: job ${job.id} has no mediaItemId; skipping`);
      return;
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: {
        id: true,
        deletedAt: true,
        storageObject: {
          select: { id: true, name: true, uploadedById: true, metadata: true },
        },
      },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `persistThumbnail: job ${job.id}: MediaItem ${job.mediaItemId} is missing, deleted, or has no storageObject — skipping`,
      );
      return;
    }

    const originalObject = mediaItem.storageObject;

    // The node uploads via whichever provider is currently active — the same
    // resolution ThumbnailProcessor.uploadThumbnail uses, so a thumbnail
    // always lands in the same provider/bucket new uploads go to.
    const { id: activeProviderId, provider: activeProvider } =
      await this.resolver.getActiveProvider();

    const exists = await activeProvider.exists(result.storageKey);
    if (!exists) {
      throw new Error(
        `persistThumbnail: no object found at storageKey "${result.storageKey}" on the active ` +
          `provider — the node's PUT to its presigned upload URL did not land`,
      );
    }

    const actualSize = await activeProvider.getObjectSize(result.storageKey);
    if (actualSize !== null && actualSize !== result.bytes) {
      throw new Error(
        `persistThumbnail: byte-length mismatch for "${result.storageKey}": node reported ` +
          `${result.bytes} bytes, storage provider reports ${actualSize} bytes`,
      );
    }

    // Upsert the thumbnail's own StorageObject row — mirrors
    // ThumbnailProcessor.uploadThumbnail's upsert exactly (same key
    // convention keyed on the unique storageKey, status='ready',
    // metadata.thumbnailOf pointing back at the original object).
    const thumbObject = await this.prisma.storageObject.upsert({
      where: { storageKey: result.storageKey },
      update: {
        name: `thumb-${originalObject.name}`,
        size: BigInt(result.bytes),
        mimeType: 'image/jpeg',
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'ready',
        metadata: { thumbnailOf: originalObject.id },
        updatedAt: new Date(),
      },
      create: {
        name: `thumb-${originalObject.name}`,
        size: BigInt(result.bytes),
        mimeType: 'image/jpeg',
        storageKey: result.storageKey,
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'ready',
        uploadedById: originalObject.uploadedById ?? null,
        metadata: { thumbnailOf: originalObject.id },
      },
    });

    // Merge into the ORIGINAL object's _processing.thumbnail entry — the same
    // shape ThumbnailProcessor's return value takes — preserving any existing
    // _processing keys, then sync typed MediaItem columns through the same
    // helper the upload/repair pipelines use.
    const existingMeta = (originalObject.metadata as Record<string, unknown> | null) ?? {};
    const existingProcessing =
      (existingMeta['_processing'] as Record<string, unknown> | undefined) ?? {};

    await this.prisma.storageObject.update({
      where: { id: originalObject.id },
      data: {
        metadata: {
          ...existingMeta,
          _processing: {
            ...existingProcessing,
            thumbnail: {
              thumbnailObjectId: thumbObject.id,
              thumbnailStorageKey: result.storageKey,
            },
          },
        } as Prisma.InputJsonValue,
      },
    });

    await this.mediaMetadataSyncService.syncFromStorageObject(originalObject.id);

    this.logger.log(
      `persistThumbnail: job ${job.id}: thumbnail persisted for MediaItem ${mediaItem.id} ` +
        `(thumbObjectId=${thumbObject.id}, key=${result.storageKey}, ${result.bytes}B, ` +
        `${result.width}x${result.height})`,
    );
  }
}
