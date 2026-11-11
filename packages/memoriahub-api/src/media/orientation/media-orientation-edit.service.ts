import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { applyOrientationTransform, type OrientationOp } from '@marinoscar/memoriahub-compute/image';

import { isFeatureEnabled, streamToBuffer, type MemoriahubRequestUser } from '../../core/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
  type MemoriahubObjectStorePort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import {
  MEDIA_OBJECT_REPROCESSOR,
  MEDIA_THUMBNAIL_PRUNER,
  type MediaObjectReprocessor,
  type MediaThumbnailPruner,
} from '../hooks/media-host-hooks.js';
import { enqueueEnrichmentJob } from '../jobs/enrichment-jobs.js';
import { MediaMetadataSyncService } from '../sync/media-metadata-sync.service.js';

/**
 * What an orientation edit reports.
 *
 * @stability experimental
 */
export interface OrientationEditResult {
  status: string;
  width: number;
  height: number;
}

/**
 * MediaOrientationEditService
 *
 * Backs POST /api/media/:id/edit/orientation — a destructive rotate/flip of a
 * photo's ORIGINAL stored bytes. Mirrors the guard/role model of the
 * "Retry thumbnail" action (MediaThumbnailRerunController): media:write
 * permission + per-circle collaborator role, resolved through the access
 * port's `requireOwnerRole`.
 *
 * Flow:
 *   1. Load + authorize the MediaItem (with its StorageObject).
 *   2. Reject non-photos / non-image objects with HTTP 400.
 *   3. Resolve the object's storage provider (per-object, same as the
 *      processing pipeline) and download the original bytes.
 *   4. Apply the transform (bakes EXIF orientation, re-encodes to JPEG q90).
 *   5. Overwrite the SAME storageKey via the provider, update the row's
 *      size/mimeType and the MediaItem's orientation/width/height.
 *   6. Regenerate the thumbnail by re-running the synchronous recovery pipeline
 *      (the object reprocessor hook) — the same path the
 *      thumbnail-rerun action uses; this also re-derives dimensions and content
 *      hash from the new bytes.
 *   7. Await MediaMetadataSyncService.syncFromStorageObject so the MediaItem
 *      points at the NEW content-addressed thumbnail key before the response
 *      returns, then prune the superseded thumbnail (issue #434). Without this
 *      the rotated photo kept its pre-rotation grid tile, because the pipeline's
 *      sync runs on a fire-and-forget `emit()` that races the request.
 *   8. Best-effort re-enqueue face detection (rotation invalidates normalized
 *      bounding boxes); enqueue failures never fail the request.
 *
 * Provided by the host (it needs the host's two post-upload hooks).
 *
 * @stability experimental
 */
@Injectable()
export class MediaOrientationEditService {
  private readonly logger = new Logger(MediaOrientationEditService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly circleMembershipService: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_OBJECT_STORE) private readonly resolver: MemoriahubObjectStorePort,
    @Inject(MEDIA_OBJECT_REPROCESSOR) private readonly recoveryService: MediaObjectReprocessor,
    private readonly metadataSync: MediaMetadataSyncService,
    @Inject(MEDIA_THUMBNAIL_PRUNER) private readonly thumbnailPrune: MediaThumbnailPruner,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /**
   * Applies a rotate or flip to the photo's original bytes, overwriting them, then regenerates the
   * thumbnail and re-queues face detection.
   *
   * @param mediaItemId - the photo.
   * @param op - the transform.
   * @param user - the caller (needs the collaborator role of the item's circle).
   * @returns the resulting storage status and the new dimensions.
   * @throws NotFoundException for an unknown or trashed item; BadRequestException for a non-photo.
   */
  async editOrientation(
    mediaItemId: string,
    op: OrientationOp,
    user: MemoriahubRequestUser,
  ): Promise<OrientationEditResult> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        deletedAt: true,
        type: true,
        storageObject: true,
      },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // Mirror thumbnail-rerun: collaborator role (or super-admin bypass) required.
    await this.circleMembershipService.requireOwnerRole(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'editor',
    );

    const storageObject = mediaItem.storageObject;

    // Photos only — reject videos / non-image objects.
    if (
      mediaItem.type !== 'photo' ||
      !storageObject.mimeType.startsWith('image/')
    ) {
      throw new BadRequestException(
        'Orientation editing is only supported for photos',
      );
    }

    // Resolve the per-object provider (same pattern as ObjectProcessingService)
    // and download the current original bytes.
    const provider = await this.resolver.forLocation(
      storageObject.storageProvider,
      storageObject.bucket,
    );
    const originalStream = await provider.download(storageObject.storageKey);
    const originalBuffer = await streamToBuffer(originalStream);

    // Apply the destructive transform. Throws on sharp failure → HTTP 500.
    const { buffer: transformed, width, height } = await applyOrientationTransform(
      originalBuffer,
      op,
    );

    // Overwrite the SAME key on the SAME provider/bucket with the new JPEG bytes.
    await provider.upload(storageObject.storageKey, Readable.from(transformed), {
      mimeType: 'image/jpeg',
      contentLength: transformed.length,
    });

    // Persist the new byte size / declared type and the corrected orientation +
    // dimensions. contentHash is intentionally left to the reprocess pipeline
    // below, which recomputes it (and dimensions) from the new bytes.
    await this.prisma.$transaction([
      this.prisma.storageObject.update({
        where: { id: storageObject.id },
        data: {
          size: BigInt(transformed.length),
          mimeType: 'image/jpeg',
        },
      }),
      this.prisma.mediaItem.update({
        where: { id: mediaItem.id },
        data: {
          orientation: 1,
          width,
          height,
        },
      }),
    ]);

    this.logger.log(
      `Orientation edit (${op}) applied to MediaItem ${mediaItemId} by user ${user.id} — new dims ${width}x${height}`,
    );

    // Regenerate the thumbnail + re-derive metadata from the new bytes via the
    // same synchronous recovery path used by the thumbnail-rerun action.
    let status = 'failed';
    const refreshed = await this.prisma.storageObject.findUnique({
      where: { id: storageObject.id },
    });
    if (refreshed) {
      await this.recoveryService.reprocessNow(refreshed);

      // Repoint the MediaItem at the freshly-rendered thumbnail INSIDE the
      // request (issue #434). The pipeline's OBJECT_PROCESSED_EVENT listener
      // does this too, but it is emitted with `emit()`, not `emitAsync()`, so
      // it races the response — and the new thumbnail lives at a new,
      // content-addressed key, so until it lands every grid surface keeps
      // signing the pre-rotation key. Also recomputes contentHash/dimensions.
      await this.metadataSync.syncFromStorageObject(storageObject.id);

      // Only now is it safe to delete the superseded thumbnail bytes.
      await this.thumbnailPrune.pruneSupersededThumbnails(storageObject.id);

      const after = await this.prisma.storageObject.findUnique({
        where: { id: storageObject.id },
        select: { status: true },
      });
      status = after?.status ?? 'unknown';
    }

    // Best-effort: re-enqueue face detection because rotating/flipping
    // invalidates the normalized face bounding boxes. Never fail the request.
    await this.reenqueueFaceDetection(mediaItem.id, mediaItem.circleId);

    return { status, width, height };
  }

  /**
   * Re-enqueue photo face detection for the edited item, mirroring the exact
   * call the POST /api/media/:id/faces/rerun controller makes (priority 0,
   * reason=rerun) plus the MediaFaceStatus → pending upsert. Gated on the
   * global faceRecognition feature flag and the FACE_AUTO_DETECT kill-switch;
   * enqueue failures are swallowed so they never fail the edit.
   */
  private async reenqueueFaceDetection(
    mediaItemId: string,
    circleId: string,
  ): Promise<void> {
    try {
      if (!(await isFeatureEnabled(this.settings, 'faceRecognition', 'FACE_AUTO_DETECT'))) {
        return;
      }

      const job = await enqueueEnrichmentJob(this.jobs, {
        type: 'face_detection',
        mediaItemId,
        circleId,
        reason: 'rerun',
        priority: 0,
      });

      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          status: 'pending',
          faceCount: 0,
        },
        update: {
          status: 'pending',
        },
      });

      this.logger.log(
        `Orientation edit re-enqueued face_detection job ${job.id} for MediaItem ${mediaItemId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Orientation edit: face_detection re-enqueue failed for MediaItem ${mediaItemId} (non-fatal): ${msg}`,
      );
    }
  }
}
