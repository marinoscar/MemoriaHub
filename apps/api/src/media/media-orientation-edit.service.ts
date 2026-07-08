import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CircleRole, MediaType, JobReason, MediaFaceStatusType } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import {
  applyOrientationTransform,
  OrientationOp,
} from '../storage/processing/image-orientation.util';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

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
 * permission + per-circle collaborator role, resolved via
 * CircleMembershipService.assertCircleAccess.
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
 *      (StorageProcessingRecoveryService.reprocessObjectNow) — the same path the
 *      thumbnail-rerun action uses; this also re-derives dimensions and content
 *      hash from the new bytes.
 *   7. Best-effort re-enqueue face detection (rotation invalidates normalized
 *      bounding boxes); enqueue failures never fail the request.
 */
@Injectable()
export class MediaOrientationEditService {
  private readonly logger = new Logger(MediaOrientationEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly resolver: StorageProviderResolver,
    private readonly recoveryService: StorageProcessingRecoveryService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  async editOrientation(
    mediaItemId: string,
    op: OrientationOp,
    user: RequestUser,
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
    await this.circleMembershipService.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'collaborator' as CircleRole,
    );

    const storageObject = mediaItem.storageObject;

    // Photos only — reject videos / non-image objects.
    if (
      mediaItem.type !== MediaType.photo ||
      !storageObject.mimeType.startsWith('image/')
    ) {
      throw new BadRequestException(
        'Orientation editing is only supported for photos',
      );
    }

    // Resolve the per-object provider (same pattern as ObjectProcessingService)
    // and download the current original bytes.
    const provider = await this.resolver.getProviderFor(
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
      await this.recoveryService.reprocessObjectNow(refreshed);
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
      const settings = await this.systemSettings.getSettings();
      const faceOn = settings.features?.['faceRecognition'] === true;
      const faceKilled = (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';

      if (!faceOn || faceKilled) {
        return;
      }

      const job = await this.enrichmentJobService.enqueue({
        type: 'face_detection',
        mediaItemId,
        circleId,
        reason: JobReason.rerun,
        priority: 0,
      });

      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          status: MediaFaceStatusType.pending,
          faceCount: 0,
        },
        update: {
          status: MediaFaceStatusType.pending,
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
