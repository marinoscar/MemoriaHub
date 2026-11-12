import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { UploadEnrichmentService } from '../enrichment-fanout/upload-enrichment.service.js';
import type { MediaEnrichment } from '../hooks/media-host-hooks.js';
import { enqueueEnrichmentJob } from '../jobs/enrichment-jobs.js';

/** Minimal shape of a media item needed to decide which enrichment jobs to enqueue. @stability experimental */
export interface EnrichmentMediaItem {
  /** The item. */
  id: string;
  /** `photo` or `video` (anything else is skipped). */
  type: string;
  /** The owner scope of the item. */
  circleId: string;
  /** When the item was moved to Trash, or null. */
  deletedAt: Date | null;
}

/** Why an enrichment job was queued; sets its priority. @stability experimental */
export type EnrichmentReason = 'upload' | 'rerun' | 'backfill' | (string & {});

/** The job type strings this service enqueues. Permanent. */
const JOB = {
  videoFaceDetection: 'video_face_detection',
  faceDetection: 'face_detection',
  videoAutoTagging: 'video_auto_tagging',
  autoTagging: 'auto_tagging',
  thumbnailRegen: 'thumbnail_regen',
} as const;

/**
 * The upload-time enrichment entry point and the post-detection video fan-out (RETRO-J5, #613).
 *
 * The photo fan-out is the media slice's registry (`UploadEnrichmentRegistry`, which each slice registers
 * into); this service keeps what is not a registration:
 *
 * - `enqueueUploadEnrichment` delegates to {@link UploadEnrichmentService} (called synchronously from the
 *   upload path, so every job row exists before the response, whichever client uploaded).
 * - `enqueueVideoPostDetectionEnrichment` is the video fan-out `social_media_detection` withholds until a
 *   video is classified: `video_face_detection` behind `features.faceRecognition` + `face.video.enabled` +
 *   `FACE_AUTO_DETECT`, and `video_auto_tagging` behind `features.autoTagging` +
 *   `autoTagging.video.enabled` + `AUTO_TAG_ENABLED`. A TikTok re-share is therefore never sent to the
 *   vision model. Never rethrows.
 * - the per-item rerun helpers (`enqueueTagRerun`, `enqueueFaceRerun`, `enqueueThumbnailRerun`) that the
 *   single-item and bulk selection endpoints share: priority 0, reason `rerun`, and the `pending` status
 *   upsert. They do NOT check the feature flags (matching per-item rerun behaviour; the handlers do).
 *
 * It is the packaged `MEDIA_ENRICHMENT` hook the gallery calls, and the host binds the social-media slice's
 * `SOCIAL_MEDIA_POST_DETECTION` hook to it.
 *
 * @stability experimental
 */
@Injectable()
export class MediaEnrichmentService implements MediaEnrichment {
  private readonly logger = new Logger(MediaEnrichmentService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly uploadEnrichment: UploadEnrichmentService,
  ) {}

  /**
   * Enqueues every upload-time enrichment job the registered slices want for a newly registered item.
   * Never rethrows.
   *
   * @param item - the item's own fields.
   */
  async enqueueUploadEnrichment(item: EnrichmentMediaItem): Promise<void> {
    await this.uploadEnrichment.enqueueUploadEnrichment(item);
  }

  /**
   * Enqueues the post-classification video enrichment withheld while social-media detection is pending.
   * Priority maps from the reason: rerun 0, upload 20, backfill 100. Never rethrows.
   *
   * @param item - the item.
   * @param reason - why the detection job was queued.
   */
  async enqueueVideoPostDetectionEnrichment(item: EnrichmentMediaItem, reason: EnrichmentReason): Promise<void> {
    try {
      if (item.deletedAt) return;
      if (item.type !== 'video') return;

      const [features, face, autoTagging] = await Promise.all([
        this.settings.readSystem<Record<string, unknown> | undefined>('features'),
        this.settings.readSystem<{ video?: { enabled?: boolean } } | undefined>('face'),
        this.settings.readSystem<{ video?: { enabled?: boolean } } | undefined>('autoTagging'),
      ]);
      const priority = reason === 'rerun' ? 0 : reason === 'backfill' ? 100 : 20;
      const enqueued: string[] = [];

      // --- Video face detection ---
      const faceOn = features.value?.['faceRecognition'] === true;
      const videoFaceOn = face.value?.video?.enabled !== false;
      const faceKilled = (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';

      if (faceOn && !faceKilled && videoFaceOn) {
        const job = await enqueueEnrichmentJob(this.jobs, {
          type: JOB.videoFaceDetection,
          mediaItemId: item.id,
          circleId: item.circleId,
          reason,
          priority,
        });

        await this.prisma.mediaFaceStatus.upsert({
          where: { mediaItemId: item.id },
          create: { mediaItemId: item.id, status: 'pending', faceCount: 0 },
          update: { status: 'pending' },
        });

        enqueued.push(`${JOB.videoFaceDetection}(job=${job.id})`);
      } else {
        const why = !faceOn ? 'feature disabled' : faceKilled ? 'FACE_AUTO_DETECT=false' : 'face.video.enabled=false';
        this.logger.debug(`MediaItem ${item.id} (video) video_face_detection skipped: ${why}`);
      }

      // --- Video AI tagging (epic #452) ---
      // Part of the post-detection fan-out rather than enqueued at upload: social-media detection withholds
      // video enrichment until a video is classified, so a TikTok/Instagram re-share is never sent to the
      // vision model.
      const taggingOn = features.value?.['autoTagging'] === true;
      const videoTaggingOn = autoTagging.value?.video?.enabled === true;
      const autoTagKilled = process.env['AUTO_TAG_ENABLED'] === 'false';

      if (taggingOn && !autoTagKilled && videoTaggingOn) {
        const job = await enqueueEnrichmentJob(this.jobs, {
          type: JOB.videoAutoTagging,
          mediaItemId: item.id,
          circleId: item.circleId,
          reason,
          priority,
        });

        await this.prisma.mediaTagStatus.upsert({
          where: { mediaItemId: item.id },
          create: { mediaItemId: item.id, circleId: item.circleId, status: 'pending', tagCount: 0 },
          update: { status: 'pending' },
        });

        enqueued.push(`${JOB.videoAutoTagging}(job=${job.id})`);
      } else {
        const why = !taggingOn ? 'feature disabled' : autoTagKilled ? 'AUTO_TAG_ENABLED=false' : 'autoTagging.video.enabled=false';
        this.logger.debug(`MediaItem ${item.id} (video) video_auto_tagging skipped: ${why}`);
      }

      if (enqueued.length > 0) {
        this.logger.log(
          `MediaItem ${item.id} (video) post-detection enrichment: enqueued ${enqueued.join(', ')} (reason=${reason}, priority=${priority})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`MediaEnrichmentService.enqueueVideoPostDetectionEnrichment failed for MediaItem ${item.id}: ${message}`);
      // Never rethrow: an enqueue failure must not fail the caller.
    }
  }

  /**
   * Re-enqueues AI tagging for one item and marks its tag status pending. Routes to `video_auto_tagging`
   * for videos and `auto_tagging` otherwise; `type` is read from the row when the caller does not know it.
   *
   * @param item - the item.
   */
  async enqueueTagRerun(item: { id: string; circleId: string; type?: string }): Promise<void> {
    const type =
      item.type ??
      (await this.prisma.mediaItem.findUnique({ where: { id: item.id }, select: { type: true } }))?.type;

    await enqueueEnrichmentJob(this.jobs, {
      type: type === 'video' ? JOB.videoAutoTagging : JOB.autoTagging,
      mediaItemId: item.id,
      circleId: item.circleId,
      reason: 'rerun',
      priority: 0,
    });

    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId: item.id },
      create: { mediaItemId: item.id, circleId: item.circleId, status: 'pending', tagCount: 0 },
      update: { status: 'pending' },
    });
  }

  /**
   * Re-enqueues face detection for one item and marks its face status pending: `video_face_detection` for
   * videos, `face_detection` otherwise.
   *
   * @param item - the item.
   */
  async enqueueFaceRerun(item: { id: string; type: string; circleId: string }): Promise<void> {
    await enqueueEnrichmentJob(this.jobs, {
      type: item.type === 'video' ? JOB.videoFaceDetection : JOB.faceDetection,
      mediaItemId: item.id,
      circleId: item.circleId,
      reason: 'rerun',
      priority: 0,
    });

    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId: item.id },
      create: { mediaItemId: item.id, status: 'pending', faceCount: 0 },
      update: { status: 'pending' },
    });
  }

  /**
   * Re-enqueues thumbnail regeneration for one item through the asynchronous `thumbnail_regen` job (the
   * bulk-safe path; there is no per-item status table for thumbnails).
   *
   * @param item - the item.
   */
  async enqueueThumbnailRerun(item: { id: string; circleId: string }): Promise<void> {
    await enqueueEnrichmentJob(this.jobs, {
      type: JOB.thumbnailRegen,
      mediaItemId: item.id,
      circleId: item.circleId,
      reason: 'rerun',
      priority: 0,
    });
  }

  /**
   * Resolves the media item of a stored object and enqueues its upload enrichment: the backstop the host's
   * `OBJECT_PROCESSED_EVENT` listener calls for any path that finishes processing without going through
   * the registration.
   *
   * @param storageObjectId - the processed object.
   */
  async enqueueForStorageObject(storageObjectId: string): Promise<void> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { storageObjectId },
      select: { id: true, type: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem) {
      this.logger.debug(`No MediaItem for StorageObject ${storageObjectId}; skipping upload enrichment enqueue`);
      return;
    }

    await this.enqueueUploadEnrichment(mediaItem);
  }
}
