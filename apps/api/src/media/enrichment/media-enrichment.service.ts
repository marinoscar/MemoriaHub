import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, JobReason, MediaTagStatusType, MediaFaceStatusType, MediaSocialStatusType } from '@prisma/client';
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
      const locationInferenceOn = settings.features?.['locationInference'] === true;
      const socialOn = settings.features?.['socialMediaDetection'] === true;

      // Pre-compute env kill-switches once (exact expressions from old listeners).
      const autoTagKilled = process.env['AUTO_TAG_ENABLED'] === 'false';
      const faceAutoDetect = process.env['FACE_AUTO_DETECT'] ?? 'true';
      const faceKilled = faceAutoDetect === 'false';
      const burstKilled = process.env['BURST_DETECTION_ENABLED'] === 'false';
      const dedupKilled = process.env['DUPLICATE_DETECTION_ENABLED'] === 'false';
      const locationInferenceKilled = process.env['LOCATION_INFERENCE_ENABLED'] === 'false';
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
      // Face detection — photo path (priority 10)
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
      } else if (item.type === MediaType.photo) {
        const reason = !faceOn ? 'feature disabled' : 'FACE_AUTO_DETECT=false';
        skipped.push(`face_detection(${reason})`);
      }

      // ------------------------------------------------------------------
      // Video routing — social-media detection first, else video face detection
      // ------------------------------------------------------------------
      // When social-media detection is enabled we run it FIRST and withhold
      // video_face_detection until classification clears the item: the social
      // handler fans out the post-detection enrichment on its clean path (and
      // skips it entirely for detected social re-uploads). When social detection
      // is off, video_face_detection is enqueued directly — unchanged behavior.
      if (item.type === MediaType.video) {
        if (socialOn && !socialKilled) {
          const job = await this.enrichmentJobService.enqueue({
            type: 'social_media_detection',
            mediaItemId: item.id,
            circleId: item.circleId,
            reason: JobReason.upload,
            priority: 10,
          });

          await this.prisma.mediaSocialStatus.upsert({
            where: { mediaItemId: item.id },
            create: {
              mediaItemId: item.id,
              status: MediaSocialStatusType.pending,
            },
            update: {
              status: MediaSocialStatusType.pending,
            },
          });

          enqueued.push(`social_media_detection(job=${job.id})`);
        } else {
          // Social detection off — preserve prior behavior: enqueue video face
          // detection directly (priority 20 for upload). Pass the already-read
          // settings so the video path still performs a single getSettings call.
          await this.enqueueVideoPostDetectionEnrichment(item, JobReason.upload, settings);
          skipped.push(
            `social_media_detection(${socialKilled ? 'SOCIAL_MEDIA_DETECTION_ENABLED=false' : 'feature disabled'})`,
          );
        }
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

      // ------------------------------------------------------------------
      // Location inference — photos only; no status upsert (mirrors burst_detection)
      // ------------------------------------------------------------------
      if (item.type === MediaType.photo && locationInferenceOn && !locationInferenceKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'location_inference',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 10,
        });
        enqueued.push(`location_inference(job=${job.id})`);
      } else if (item.type === MediaType.photo) {
        const reason = !locationInferenceOn ? 'feature disabled' : 'LOCATION_INFERENCE_ENABLED=false';
        skipped.push(`location_inference(${reason})`);
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
   * Enqueue the post-classification video enrichment (video_face_detection) that
   * is withheld while social-media detection is pending.
   *
   * Called:
   *   - directly from the upload path when social-media detection is OFF (so
   *     behavior is unchanged), and
   *   - from SocialMediaDetectionHandler on the CLEAN path once a video has been
   *     confirmed not to be a social re-upload.
   *
   * Guarded by the same faceRecognition / face.video.enabled / FACE_AUTO_DETECT
   * checks as the upload router. Priority is mapped from the job reason:
   * rerun → 0, upload → 20, backfill → 100.
   */
  async enqueueVideoPostDetectionEnrichment(
    item: EnrichmentMediaItem,
    reason: JobReason,
    resolvedSettings?: Awaited<ReturnType<SystemSettingsService['getSettings']>>,
  ): Promise<void> {
    try {
      if (item.deletedAt) return;
      if (item.type !== MediaType.video) return;

      // Reuse the caller's already-resolved settings when provided (upload path)
      // to avoid a redundant read; the social handler calls without them.
      const settings = resolvedSettings ?? (await this.systemSettings.getSettings());
      const faceOn = settings.features?.['faceRecognition'] === true;
      const videoFaceOn = settings.face?.video?.enabled !== false;
      const faceKilled = (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';

      if (!faceOn || faceKilled || !videoFaceOn) {
        const why = !faceOn
          ? 'feature disabled'
          : faceKilled
            ? 'FACE_AUTO_DETECT=false'
            : 'face.video.enabled=false';
        this.logger.debug(
          `MediaItem ${item.id} (video) post-detection enrichment skipped: ${why}`,
        );
        return;
      }

      const priority =
        reason === JobReason.rerun ? 0 : reason === JobReason.backfill ? 100 : 20;

      const job = await this.enrichmentJobService.enqueue({
        type: 'video_face_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason,
        priority,
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
        `MediaItem ${item.id} (video) post-detection enrichment: enqueued video_face_detection(job=${job.id}, reason=${reason}, priority=${priority})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `MediaEnrichmentService.enqueueVideoPostDetectionEnrichment failed for MediaItem ${item.id}: ${message}`,
      );
      // Never rethrow — enrichment enqueue failure must not fail the caller.
    }
  }

  // ---------------------------------------------------------------------------
  // Per-item rerun helpers (priority 0, reason=rerun)
  //
  // These mirror the single-item rerun controllers (TaggingController.rerunTagging,
  // FaceDetectionController.rerunFaceDetection, MediaThumbnailRerunController) so
  // the bulk selection-scoped endpoints (MediaService.bulkRerun*) share exactly one
  // enqueue+status-upsert implementation instead of replicating it. Feature flags
  // are intentionally NOT checked here — matching per-item rerun behavior; the
  // handlers themselves respect the global toggles.
  // ---------------------------------------------------------------------------

  /**
   * Re-enqueue auto-tagging for a single item and mark its tag status pending.
   * Mirrors TaggingController.rerunTagging.
   */
  async enqueueTagRerun(item: { id: string; circleId: string }): Promise<void> {
    await this.enrichmentJobService.enqueue({
      type: 'auto_tagging',
      mediaItemId: item.id,
      circleId: item.circleId,
      reason: JobReason.rerun,
      priority: 0,
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
  }

  /**
   * Re-enqueue face detection for a single item and mark its face status pending.
   * Routes to video_face_detection for video items, face_detection otherwise —
   * mirrors FaceDetectionController.rerunFaceDetection.
   */
  async enqueueFaceRerun(item: {
    id: string;
    type: MediaType;
    circleId: string;
  }): Promise<void> {
    const jobType =
      item.type === MediaType.video ? 'video_face_detection' : 'face_detection';

    await this.enrichmentJobService.enqueue({
      type: jobType,
      mediaItemId: item.id,
      circleId: item.circleId,
      reason: JobReason.rerun,
      priority: 0,
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
  }

  /**
   * Re-enqueue thumbnail regeneration for a single item via the async
   * `thumbnail_regen` job (ThumbnailRegenHandler). Unlike the synchronous
   * single-item endpoint this does NOT block on reprocessing — it is the
   * bulk-safe path. There is no per-item status table for thumbnails.
   */
  async enqueueThumbnailRerun(item: { id: string; circleId: string }): Promise<void> {
    await this.enrichmentJobService.enqueue({
      type: 'thumbnail_regen',
      mediaItemId: item.id,
      circleId: item.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });
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
