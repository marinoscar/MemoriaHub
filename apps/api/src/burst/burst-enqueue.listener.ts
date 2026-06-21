import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MediaType, JobReason } from '@prisma/client';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../storage/processing/events/object-processed.event';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';

@Injectable()
export class BurstEnqueueListener {
  private readonly logger = new Logger(BurstEnqueueListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handleObjectProcessed(event: ObjectProcessedEvent): Promise<void> {
    try {
      await this.enqueueForObject(event.storageObjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `BurstEnqueueListener failed for StorageObject ${event.storageObjectId}: ${message}`,
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
      this.logger.debug(`No MediaItem for StorageObject ${storageObjectId}; skipping burst enqueue`);
      return;
    }

    // Only photos are supported for burst detection
    if (mediaItem.type !== MediaType.photo) {
      this.logger.debug(
        `MediaItem ${mediaItem.id} is type ${mediaItem.type}; skipping burst enqueue`,
      );
      return;
    }

    if (mediaItem.deletedAt) {
      this.logger.debug(`MediaItem ${mediaItem.id} is deleted; skipping burst enqueue`);
      return;
    }

    // 2. Check global kill-switch (BURST_DETECTION_ENABLED=false disables all auto-enqueue)
    if (process.env['BURST_DETECTION_ENABLED'] === 'false') {
      this.logger.debug(`BURST_DETECTION_ENABLED=false; skipping burst enqueue for MediaItem ${mediaItem.id}`);
      return;
    }

    // 3. Check global system-settings feature flag
    const burstDetectionEnabled = await this.systemSettings.isFeatureEnabled(FEATURE_KEYS.BURST_DETECTION);
    if (!burstDetectionEnabled) {
      this.logger.debug(
        `Burst detection disabled globally; skipping burst enqueue for MediaItem ${mediaItem.id}`,
      );
      return;
    }

    // 4. Enqueue via EnrichmentJobService (idempotency handled by service)
    const job = await this.enrichmentJobService.enqueue({
      type: 'burst_detection',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.upload,
      priority: 10,
    });

    this.logger.log(
      `Enqueued burst detection job ${job.id} for MediaItem ${mediaItem.id} (reason: upload)`,
    );
  }
}
