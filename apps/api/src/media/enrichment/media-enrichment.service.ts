import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, JobReason, MediaTagStatusType, MediaFaceStatusType, MediaSocialStatusType } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';

// Env kill-switch check helper (extracted for reuse)
function isFaceKilled(): boolean {
  return (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';
}

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
      const videoFaceOn = settings.face?.video?.enabled !== false;
      const socialOn = settings.features?.['socialMediaDetection'] === true;

      // Pre-compute env kill-switches once (exact expressions from old listeners).
      const autoTagKilled = process.env['AUTO_TAG_ENABLED'] === 'false';
      const faceKilled = isFaceKilled();
      const burstKilled = process.env['BURST_DETECTION_ENABLED'] === 'false';
      const socialKilled = process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false';

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
      // Video face detection is deferred when social detection is active (social
      // acts as a gate: not-detected → chain to video_face_detection afterwards).
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
        if (socialOn && !socialKilled) {
          // Social detection is active: defer video_face_detection.
          // The social handler chains to enqueueVideoFaceIfEligible after it
          // finishes and determines the item is NOT flagged as social media.
          skipped.push('video_face_detection(deferred: social gate active)');
        } else {
          // Social is off/killed: enqueue immediately as before.
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
        }
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
      // Social media detection — videos only
      // ------------------------------------------------------------------
      if (item.type === MediaType.video && socialOn && !socialKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'social_media_detection',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 15,
        });

        await this.prisma.mediaSocialStatus.upsert({
          where: { mediaItemId: item.id },
          create: {
            mediaItemId: item.id,
            circleId: item.circleId,
            status: MediaSocialStatusType.pending,
            detected: false,
          },
          update: {
            status: MediaSocialStatusType.pending,
          },
        });

        enqueued.push(`social_media_detection(job=${job.id})`);
      } else if (item.type === MediaType.video) {
        const reason = !socialOn ? 'feature disabled' : 'SOCIAL_MEDIA_DETECTION_ENABLED=false';
        skipped.push(`social_media_detection(${reason})`);
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
   * Enqueue video_face_detection for a video MediaItem if the feature is enabled.
   *
   * Called by SocialDetectionService after confirming the item is NOT flagged as
   * social media (not-detected path), thereby releasing the social gate.
   *
   * Safe to call repeatedly — EnrichmentJobService.enqueue deduplicates
   * pending/running jobs by (type, mediaItemId). Only fires for videos;
   * photo face detection is always enqueued at upload time.
   *
   * @param item Minimal MediaItem shape (id, type, circleId, deletedAt).
   */
  async enqueueVideoFaceIfEligible(item: EnrichmentMediaItem): Promise<void> {
    if (item.type !== MediaType.video) return;
    if (item.deletedAt) return;

    const settings = await this.systemSettings.getSettings();
    const faceOn = settings.features?.['faceRecognition'] === true;
    const videoFaceOn = settings.face?.video?.enabled !== false;
    const killed = isFaceKilled();

    if (!faceOn || !videoFaceOn || killed) return;

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

    this.logger.log(
      `MediaItem ${item.id}: video_face_detection enqueued (social gate cleared) job=${job.id}`,
    );
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
