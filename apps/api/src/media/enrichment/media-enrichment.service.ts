import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, JobReason, MediaTagStatusType, MediaFaceStatusType, MediaSocialStatusType } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';
import { UploadEnrichmentService } from '@marinoscar/memoriahub-api/media';

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
 * The upload-time enrichment entry point (auto_tagging, face_detection,
 * video_face_detection, burst_detection, ...). Since RETRO-J5 (#613) the fan-out is the
 * media slice's registry (`UploadEnrichmentRegistry`); this service keeps the
 * post-detection video fan-out and the per-item rerun helpers until the slices
 * they belong to move.
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
 *   - Videos → video_face_detection (priority 20) when faceRecognition + face.video.enabled,
 *     and video_auto_tagging (priority 20) when autoTagging + autoTagging.video.enabled.
 *     Both ride the post-social-media-detection fan-out, so a TikTok re-share is
 *     never sent to the vision model.
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
    private readonly systemSettings: AppSystemSettingsService,
    private readonly uploadEnrichment: UploadEnrichmentService,
  ) {}

  /**
   * Enqueue all upload-time enrichment jobs for a newly registered MediaItem.
   *
   * The fan-out is the media slice's `UploadEnrichmentService` walking the registrations each
   * slice made (`tagging/tagging-upload-enrichment.ts`, `face/...`, `social-media/...`,
   * `burst/...`, `dedup/...`, `location-inference/...`); this service no longer names them.
   * Called with the item's own fields — no extra DB lookup needed. Never rethrows.
   */
  async enqueueUploadEnrichment(item: EnrichmentMediaItem): Promise<void> {
    await this.uploadEnrichment.enqueueUploadEnrichment(item);
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
    resolvedSettings?: Awaited<ReturnType<AppSystemSettingsService['getSettings']>>,
  ): Promise<void> {
    try {
      if (item.deletedAt) return;
      if (item.type !== MediaType.video) return;

      // Reuse the caller's already-resolved settings when provided (upload path)
      // to avoid a redundant read; the social handler calls without them.
      const settings = resolvedSettings ?? (await this.systemSettings.getSettings());
      const priority =
        reason === JobReason.rerun ? 0 : reason === JobReason.backfill ? 100 : 20;
      const enqueued: string[] = [];

      // --- Video face detection ---
      const faceOn = settings.features?.['faceRecognition'] === true;
      const videoFaceOn = settings.face?.video?.enabled !== false;
      const faceKilled = (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';

      if (faceOn && !faceKilled && videoFaceOn) {
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

        enqueued.push(`video_face_detection(job=${job.id})`);
      } else {
        const why = !faceOn
          ? 'feature disabled'
          : faceKilled
            ? 'FACE_AUTO_DETECT=false'
            : 'face.video.enabled=false';
        this.logger.debug(
          `MediaItem ${item.id} (video) video_face_detection skipped: ${why}`,
        );
      }

      // --- Video AI tagging (epic #452, issue #458) ---
      //
      // Deliberately part of the post-detection fan-out rather than enqueued
      // directly at upload: `social_media_detection` withholds video
      // enrichment until a video is classified, so routing through here means
      // a TikTok/Instagram re-share is NEVER sent to the vision model —
      // cheaper and more correct. Gated on autoTagging + AUTO_TAG_ENABLED +
      // autoTagging.video.enabled, all read from the one settings object the
      // caller already resolved.
      const taggingOn = settings.features?.['autoTagging'] === true;
      const videoTaggingOn = (settings as { autoTagging?: { video?: { enabled?: boolean } } })
        .autoTagging?.video?.enabled === true;
      const autoTagKilled = process.env['AUTO_TAG_ENABLED'] === 'false';

      if (taggingOn && !autoTagKilled && videoTaggingOn) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'video_auto_tagging',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason,
          priority,
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

        enqueued.push(`video_auto_tagging(job=${job.id})`);
      } else {
        const why = !taggingOn
          ? 'feature disabled'
          : autoTagKilled
            ? 'AUTO_TAG_ENABLED=false'
            : 'autoTagging.video.enabled=false';
        this.logger.debug(
          `MediaItem ${item.id} (video) video_auto_tagging skipped: ${why}`,
        );
      }

      if (enqueued.length > 0) {
        this.logger.log(
          `MediaItem ${item.id} (video) post-detection enrichment: enqueued ${enqueued.join(', ')} (reason=${reason}, priority=${priority})`,
        );
      }
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
   * Re-enqueue AI tagging for a single item and mark its tag status pending.
   *
   * Routes to `video_auto_tagging` for videos and `auto_tagging` otherwise —
   * mirroring `enqueueFaceRerun` below, which has always branched this way.
   * Before issue #458 this enqueued `auto_tagging` unconditionally, so any
   * caller handed a video produced a job the handler then failed.
   *
   * `type` is optional so a caller that already knows it avoids a lookup; when
   * absent it is resolved here, which keeps every call site correct by default
   * rather than correct only if it remembered to pass one.
   */
  async enqueueTagRerun(item: { id: string; circleId: string; type?: MediaType }): Promise<void> {
    const type =
      item.type ??
      (
        await this.prisma.mediaItem.findUnique({
          where: { id: item.id },
          select: { type: true },
        })
      )?.type;

    await this.enrichmentJobService.enqueue({
      type: type === MediaType.video ? 'video_auto_tagging' : 'auto_tagging',
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
