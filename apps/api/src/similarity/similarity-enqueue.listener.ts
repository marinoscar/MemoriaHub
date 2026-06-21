import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MediaType, JobReason } from '@prisma/client';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../storage/processing/events/object-processed.event';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

@Injectable()
export class SimilarityEnqueueListener {
  private readonly logger = new Logger(SimilarityEnqueueListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handleObjectProcessed(event: ObjectProcessedEvent): Promise<void> {
    try {
      await this.enqueueForObject(event.storageObjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `SimilarityEnqueueListener failed for StorageObject ${event.storageObjectId}: ${message}`,
      );
      // Do NOT rethrow
    }
  }

  private async enqueueForObject(storageObjectId: string): Promise<void> {
    // 1. Find MediaItem by storageObjectId
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { storageObjectId },
      select: { id: true, circleId: true, type: true, deletedAt: true },
    });

    if (!mediaItem) {
      this.logger.debug(
        `No MediaItem for StorageObject ${storageObjectId}; skipping similarity enqueue`,
      );
      return;
    }

    // Only photos are supported for visual deduplication
    if (mediaItem.type !== MediaType.photo) {
      this.logger.debug(
        `MediaItem ${mediaItem.id} is type ${mediaItem.type}; skipping similarity enqueue`,
      );
      return;
    }

    if (mediaItem.deletedAt) {
      this.logger.debug(`MediaItem ${mediaItem.id} is deleted; skipping similarity enqueue`);
      return;
    }

    // 2. Check global kill-switch (VISUAL_DEDUP_ENABLED=false disables all auto-enqueue)
    if (process.env['VISUAL_DEDUP_ENABLED'] === 'false') {
      this.logger.debug(
        `VISUAL_DEDUP_ENABLED=false; skipping similarity enqueue for MediaItem ${mediaItem.id}`,
      );
      return;
    }

    // 3. Check per-circle opt-in flag (default: false)
    const circle = await this.prisma.circle.findUnique({
      where: { id: mediaItem.circleId },
      select: { visualDedupEnabled: true },
    });
    if (!circle?.visualDedupEnabled) {
      this.logger.debug(
        `Circle ${mediaItem.circleId} has visualDedupEnabled=false; skipping similarity enqueue for MediaItem ${mediaItem.id}`,
      );
      return;
    }

    // 4. Enqueue via EnrichmentJobService (idempotency handled by service)
    const job = await this.enrichmentJobService.enqueue({
      type: 'similarity_detection',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.upload,
      priority: 10,
    });

    this.logger.log(
      `Enqueued similarity detection job ${job.id} for MediaItem ${mediaItem.id} (reason: upload)`,
    );
  }
}
