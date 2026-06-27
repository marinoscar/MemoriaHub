import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, JobReason, MediaTagStatusType, MediaFaceStatusType } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../../common/types/settings.types';

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
 * (auto_tagging, face_detection, burst_detection).
 *
 * Called directly from createMedia (synchronous, awaited) so that all
 * enrichment job rows exist before createMedia returns — regardless of
 * which client (CLI, web, Android) or timing performed the upload.
 *
 * Also used as the backing implementation of MediaEnrichmentEnqueueListener
 * so that re-processing via OBJECT_PROCESSED_EVENT remains consistent.
 *
 * Rules preserved from the old per-domain listeners:
 *   - Only MediaType.photo items are eligible.
 *   - Soft-deleted items (deletedAt non-null) are skipped.
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
   * Reads all three feature flags in a single parallel query to avoid N×DB
   * round-trips during a bulk import.
   */
  async enqueueUploadEnrichment(item: EnrichmentMediaItem): Promise<void> {
    try {
      // Only photos are eligible for all three enrichment types.
      if (item.type !== MediaType.photo) {
        this.logger.debug(
          `MediaItem ${item.id} is type ${item.type}; skipping upload enrichment`,
        );
        return;
      }

      if (item.deletedAt) {
        this.logger.debug(
          `MediaItem ${item.id} is deleted; skipping upload enrichment`,
        );
        return;
      }

      // Read all three feature flags in one parallel batch to avoid
      // multiple sequential DB reads during a bulk import.
      const [taggingOn, faceOn, burstOn] = await Promise.all([
        this.systemSettings.isFeatureEnabled(FEATURE_KEYS.AUTO_TAGGING),
        this.systemSettings.isFeatureEnabled(FEATURE_KEYS.FACE_RECOGNITION),
        this.systemSettings.isFeatureEnabled(FEATURE_KEYS.BURST_DETECTION),
      ]);

      // Pre-compute env kill-switches once (exact expressions from old listeners).
      const autoTagKilled = process.env['AUTO_TAG_ENABLED'] === 'false';
      const faceAutoDetect = process.env['FACE_AUTO_DETECT'] ?? 'true';
      const faceKilled = faceAutoDetect === 'false';
      const burstKilled = process.env['BURST_DETECTION_ENABLED'] === 'false';

      const enqueued: string[] = [];
      const skipped: string[] = [];

      // ------------------------------------------------------------------
      // Auto-tagging
      // ------------------------------------------------------------------
      if (taggingOn && !autoTagKilled) {
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
      } else {
        const reason = !taggingOn ? 'feature disabled' : 'AUTO_TAG_ENABLED=false';
        skipped.push(`auto_tagging(${reason})`);
      }

      // ------------------------------------------------------------------
      // Face detection
      // ------------------------------------------------------------------
      if (faceOn && !faceKilled) {
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
      } else {
        const reason = !faceOn ? 'feature disabled' : 'FACE_AUTO_DETECT=false';
        skipped.push(`face_detection(${reason})`);
      }

      // ------------------------------------------------------------------
      // Burst detection — no status upsert (by design, matches old listener)
      // ------------------------------------------------------------------
      if (burstOn && !burstKilled) {
        const job = await this.enrichmentJobService.enqueue({
          type: 'burst_detection',
          mediaItemId: item.id,
          circleId: item.circleId,
          reason: JobReason.upload,
          priority: 10,
        });

        enqueued.push(`burst_detection(job=${job.id})`);
      } else {
        const reason = !burstOn ? 'feature disabled' : 'BURST_DETECTION_ENABLED=false';
        skipped.push(`burst_detection(${reason})`);
      }

      this.logger.log(
        `MediaItem ${item.id} upload enrichment: enqueued=[${enqueued.join(', ') || 'none'}] skipped=[${skipped.join(', ') || 'none'}]`,
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
