import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, JobReason, MediaTagStatusType, MediaFaceStatusType } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';

/** Minimal shape of a MediaItem needed to decide which enrichment jobs to enqueue. */
export interface EnrichmentMediaItem {
  id: string;
  type: MediaType;
  circleId: string;
  deletedAt: Date | null;
}

/**
 * MediaEnrichmentService
 *
 * Single, authoritative source for all upload-time enrichment enqueueing
 * (auto_tagging, face_detection, video_face_detection, burst_detection).
 *
 * Called directly from createMedia (synchronous, awaited) so that all
 * enrichment job rows exist before createMedia returns — regardless of
 * which client (CLI, web, Android) or timing performed the upload.
 *
 * Also used as the backing implementation of MediaEnrichmentEnqueueListener
 * so that re-processing via OBJECT_PROCESSED_EVENT remains consistent.
 *
 * Routing rules:
 *   - Soft-deleted items (deletedAt non-null) are skipped regardless of type.
 *   - Photos → auto_tagging (priority 20), face_detection (priority 10), burst_detection (priority 10).
 *   - Videos → video_face_detection (priority 20) when faceRecognition + face.video.enabled.
 *   - Other types are silently skipped.
 *   - Each feature has an environment kill-switch AND a system-settings flag.
 *   - EnrichmentJobService.enqueue is idempotent (deduplicates pending/running).
 *   - Errors are caught and logged; this method never rethrows.
 */
@Injectable()
export class MediaEnrichmentService {
  private readonly logger = new Logger(MediaEnrichmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /**
   * Enqueue all upload-time enrichment jobs for a newly registered MediaItem.
   *
   * Called with the item's own fields — no extra DB lookup needed.
   * Uses a single getSettings() call (5-second TTL cache) to read all feature
   * flags without extra DB round-trips during bulk imports.
   */
  async enqueueUploadEnrichment(item: EnrichmentMediaItem): Promise<void> {
    try {
      if (item.deletedAt) {
        this.logger.debug(
          `MediaItem ${item.id} is deleted; skipping upload enrichment`,
        );
        return;
      }

      // Single cached settings read for all flags — avoids N×DB during bulk imports.
      const settings = await this.systemSettings.getSettings();
      const taggingOn = settings.features?.['autoTagging'] === true;
      const faceOn = settings.features?.['faceRecognition'] === true;
      const burstOn = settings.features?.['burstDetection'] === true;
      const dedupOn = settings.features?.['duplicateDetection'] === true;
      const videoFaceOn = settings.face?.video?.enabled !== false;

      // Pre-compute env kill-switches once (exact expressions from old listeners).
      const autoTagKilled = process.env['AUTO_TAG_ENABLED'] === 'false';
      const faceAutoDetect = process.env['FACE_AUTO_DETECT'] ?? 'true';
      const faceKilled = faceAutoDetect === 'false';
      const burstKilled = process.env['BURST_DETECTION_ENABLED'] === 'false';
      const dedupKilled = process.env['DUPLICATE_DETECTION_ENABLED'] === 'false';

      const enqueued: string[] = [];
      const skipped: string[] = [];

      // ------------------------------------------------------------------
      // Auto-tagging — photos only
      // ------------------------------------------------------------------
      if (item.type === MediaType.photo && taggingOn && !autoTagKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'auto_tagging',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 20,
        });

        await this.prisma.mediaTagStatus.upsert({
          where: { mediaItemId: item.id },
          create: {
            mediaItemId: item.id,
            circleId: item.circleId,
            status: MediaTagStatusType.pending,
            tagCount: 0,
          },
          update: {
            status: MediaTagStatusType.pending,
          },
        });

        enqueued.push(`auto_tagging(job=${job.id})`);
      } else if (item.type === MediaType.photo) {
        const reason = !taggingOn ? 'feature disabled' : 'AUTO_TAG_ENABLED=false';
        skipped.push(`auto_tagging(${reason})`);
      }

      // ------------------------------------------------------------------
      // Face detection — photo path (priority 10) vs video path (priority 20)
      // ------------------------------------------------------------------
      if (item.type === MediaType.photo && faceOn && !faceKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'face_detection',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 10,
        });

        await this.prisma.mediaFaceStatus.upsert({
          where: { mediaItemId: item.id },
          create: {
            mediaItemId: item.id,
            status: MediaFaceStatusType.pending,
            faceCount: 0,
          },
          update: {
            status: MediaFaceStatusType.pending,
          },
        });

        enqueued.push(`face_detection(job=${job.id})`);
      } else if (item.type === MediaType.video && faceOn && !faceKilled && videoFaceOn) {
        // Video face detection uses a higher priority number (20) so cheap photo
        // face jobs drain first and a long video cannot head-of-line-block them.
        const job = await this.enrichmentJobService.enqueue({
          type: 'video_face_detection',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 20,
        });

        await this.prisma.mediaFaceStatus.upsert({
          where: { mediaItemId: item.id },
          create: {
            mediaItemId: item.id,
            status: MediaFaceStatusType.pending,
            faceCount: 0,
          },
          update: {
            status: MediaFaceStatusType.pending,
          },
        });

        enqueued.push(`video_face_detection(job=${job.id})`);
      } else if (item.type === MediaType.photo || item.type === MediaType.video) {
        // Only log skip for face-eligible types
        const reason = !faceOn
          ? 'feature disabled'
          : !videoFaceOn && item.type === MediaType.video
            ? 'face.video.enabled=false'
            : 'FACE_AUTO_DETECT=false';
        skipped.push(`face_detection(${reason})`);
      }

      // ------------------------------------------------------------------
      // Burst detection — photos only; no status upsert (by design)
      // ------------------------------------------------------------------
      if (item.type === MediaType.photo && burstOn && !burstKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'burst_detection',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 10,
        });

        enqueued.push(`burst_detection(job=${job.id})`);
      } else if (item.type === MediaType.photo) {
        const reason = !burstOn ? 'feature disabled' : 'BURST_DETECTION_ENABLED=false';
        skipped.push(`burst_detection(${reason})`);
      }

      // ------------------------------------------------------------------
      // Duplicate detection — photos only; no status upsert (by design,
      // mirrors burst_detection which has no per-item status table either)
      // ------------------------------------------------------------------
      if (item.type === MediaType.photo && dedupOn && !dedupKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'duplicate_detection',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 10,
        });

        enqueued.push(`duplicate_detection(job=${job.id})`);
      } else if (item.type === MediaType.photo) {
        const reason = !dedupOn ? 'feature disabled' : 'DUPLICATE_DETECTION_ENABLED=false';
        skipped.push(`duplicate_detection(${reason})`);
      }

      this.logger.log(
        `MediaItem ${item.id} (${item.type}) upload enrichment: enqueued=[${enqueued.join(', ') || 'none'}] skipped=[${skipped.join(', ') || 'none'}]`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `MediaEnrichmentService.enqueueUploadEnrichment failed for MediaItem ${item.id}: ${message}`,
      );
      // Never rethrow — enrichment failure must not fail the parent createMedia call.
    }
  }

  /**
   * Resolve a MediaItem by its storageObjectId, then call enqueueUploadEnrichment.
   *
   * Used by MediaEnrichmentEnqueueListener to handle OBJECT_PROCESSED_EVENT as a
   * backstop for the storage-processing path (e.g. re-processing triggers).
   */
  async enqueueForStorageObject(storageObjectId: string): Promise<void> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { storageObjectId },
      select: { id: true, type: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem) {
      this.logger.debug(
        `No MediaItem for StorageObject ${storageObjectId}; skipping upload enrichment enqueue`,
      );
      return;
    }

    await this.enqueueUploadEnrichment(mediaItem);
  }
}
