// =============================================================================
// Thumbnail Node-Result Persistence
// =============================================================================
//
// Shared PERSIST half for the node path of both `thumbnail_regen` and
// `thumbnail_repair` (ThumbnailRegenHandler / ThumbnailRepairHandler). The
// server-side in-process path for both handlers is untouched — it still
// calls ObjectReprocessService.reprocessNow, running the full
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThumbnailResult } from '@marinoscar/memoriahub-compute/dto';

import {
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_PRISMA,
  type MemoriahubObjectStorePort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { MEDIA_THUMBNAIL_PRUNER, type MediaThumbnailPruner } from '../hooks/media-host-hooks.js';
import type { MediaJobContext } from '../jobs/media-item-job.js';
import type { MediaWriteScope } from '../metadata/metadata-extraction.service.js';
import { MediaMetadataSyncService } from '../sync/media-metadata-sync.service.js';
import { thumbnailKeyPrefixFor } from './thumbnail-key.js';

/**
 * Persists the thumbnail a worker node rendered and uploaded: verifies the bytes landed, writes the
 * rows the server-side pipeline would, syncs the media item and prunes the superseded thumbnail.
 *
 * @stability experimental
 */
@Injectable()
export class ThumbnailNodePersistService {
  private readonly logger = new Logger(ThumbnailNodePersistService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_OBJECT_STORE) private readonly objectStore: MemoriahubObjectStorePort,
    private readonly mediaMetadataSyncService: MediaMetadataSyncService,
    @Inject(MEDIA_THUMBNAIL_PRUNER) private readonly thumbnailPrune: MediaThumbnailPruner,
  ) {}

  /**
   * @param scope - where the two `storage_objects` writes run: the handler passes
   *   the platform `JobScope` (the job's organization, RETRO-C3); omitted, they run
   *   on the plain client.
   */
  async persistThumbnail(
    job: MediaJobContext,
    result: ThumbnailResult,
    scope?: MediaWriteScope,
  ): Promise<void> {
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
          select: { id: true, name: true, uploadedById: true, metadata: true, orgId: true },
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

    // The key was chosen by the SERVER (NodesService.getJobUploadUrl); a node
    // that submits anything else is either buggy or hostile. Re-asserting the
    // convention here also keeps ThumbnailPruneService's prefix scan honest —
    // it prunes by `thumbnails/<objectId>` and keeps whatever the object
    // currently points at, which must be one of them.
    if (!result.storageKey.startsWith(thumbnailKeyPrefixFor(originalObject.id))) {
      throw new Error(
        `persistThumbnail: storageKey "${result.storageKey}" is not a thumbnail key for ` +
          `StorageObject ${originalObject.id} — refusing to persist`,
      );
    }

    // The node uploads via whichever provider is currently active — the same
    // resolution ThumbnailProcessor.uploadThumbnail uses, so a thumbnail
    // always lands in the same provider/bucket new uploads go to.
    const { id: activeProviderId, store: activeProvider } = await this.objectStore.active();

    const exists = await activeProvider.exists(result.storageKey);
    if (!exists) {
      throw new Error(
        `persistThumbnail: no object found at storageKey "${result.storageKey}" on the active ` +
          `provider — the node's PUT to its presigned upload URL did not land`,
      );
    }

    // The size probe (S3 `HeadObject`, the local driver's `stat`); `null` when the provider has none
    // or the object is absent (already ruled out above): the check is then skipped.
    const actualSize = await activeProvider.size(result.storageKey);
    if (typeof actualSize === 'number' && actualSize !== result.bytes) {
      throw new Error(
        `persistThumbnail: byte-length mismatch for "${result.storageKey}": node reported ` +
          `${result.bytes} bytes, storage provider reports ${actualSize} bytes`,
      );
    }

    // The two `storage_objects` writes run together, in the job's organization
    // when a scope is given (`JobScope`, RETRO-C3); the provider checks above ran
    // OUTSIDE it, so the transaction stays short.
    const orgId = originalObject.orgId; // the source object's organization (RETRO-D1)
    const runWrites: MediaWriteScope = scope ?? ((fn) => fn(this.prisma));
    const thumbObject = await runWrites(async (tx) => {
      // Upsert the thumbnail's own StorageObject row — mirrors
      // ThumbnailProcessor.uploadThumbnail's upsert exactly (same key
      // convention keyed on the unique storageKey, status='ready',
      // metadata.thumbnailOf pointing back at the original object).
      const thumb = await tx.storageObject.upsert({
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
          orgId,
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
      // _processing keys (re-read here, inside the transaction, so a concurrent
      // pipeline write is not clobbered by the copy read above).
      const current = await tx.storageObject.findUnique({
        where: { id: originalObject.id },
        select: { metadata: true },
      });
      const existingMeta =
        ((current?.metadata ?? originalObject.metadata) as Record<string, unknown> | null) ?? {};
      const existingProcessing =
        (existingMeta['_processing'] as Record<string, unknown> | undefined) ?? {};

      await tx.storageObject.update({
        where: { id: originalObject.id },
        data: {
          metadata: {
            ...existingMeta,
            _processing: {
              ...existingProcessing,
              thumbnail: {
                thumbnailObjectId: thumb.id,
                thumbnailStorageKey: result.storageKey,
              },
            },
          },
        },
      });
      return thumb;
    });

    // Then sync typed MediaItem columns through the same helper the
    // upload/repair pipelines use (reprocess → sync → prune, issue #434).
    await this.mediaMetadataSyncService.syncFromStorageObject(originalObject.id);

    // The node's key carries a RANDOM version (it must be named before the
    // bytes exist), so a re-run always supersedes the previous thumbnail rather
    // than overwriting it. Drop the old one now that the MediaItem points at
    // the new key — best-effort, never fatal (issue #434).
    await this.thumbnailPrune.pruneSupersededThumbnails(originalObject.id);

    this.logger.log(
      `persistThumbnail: job ${job.id}: thumbnail persisted for MediaItem ${mediaItem.id} ` +
        `(thumbObjectId=${thumbObject.id}, key=${result.storageKey}, ${result.bytes}B, ` +
        `${result.width}x${result.height})`,
    );
  }
}
