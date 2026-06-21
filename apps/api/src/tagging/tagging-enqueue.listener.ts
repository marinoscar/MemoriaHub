import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MediaType, JobReason, MediaTagStatusType } from '@prisma/client';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../storage/processing/events/object-processed.event';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../common/types/settings.types';

@Injectable()
export class TaggingEnqueueListener {
  private readonly logger = new Logger(TaggingEnqueueListener.name);

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
        `TaggingEnqueueListener failed for StorageObject ${event.storageObjectId}: ${message}`,
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
      this.logger.debug(`No MediaItem for StorageObject ${storageObjectId}; skipping auto-tagging enqueue`);
      return;
    }

    // Only photos are supported for auto-tagging
    if (mediaItem.type !== MediaType.photo) {
      this.logger.debug(
        `MediaItem ${mediaItem.id} is type ${mediaItem.type}; skipping auto-tagging enqueue`,
      );
      return;
    }

    if (mediaItem.deletedAt) {
      this.logger.debug(`MediaItem ${mediaItem.id} is deleted; skipping auto-tagging enqueue`);
      return;
    }

    // 2. Check global kill-switch (AUTO_TAG_ENABLED=false disables all auto-enqueue)
    if (process.env['AUTO_TAG_ENABLED'] === 'false') {
      this.logger.debug(`AUTO_TAG_ENABLED=false; skipping auto-tagging enqueue for MediaItem ${mediaItem.id}`);
      return;
    }

    // 3. Check global system-settings feature flag
    const autoTaggingGloballyEnabled = await this.systemSettings.isFeatureEnabled(FEATURE_KEYS.AUTO_TAGGING);
    if (!autoTaggingGloballyEnabled) {
      this.logger.debug(
        `Auto-tagging disabled globally; skipping auto-tagging enqueue for MediaItem ${mediaItem.id}`,
      );
      return;
    }

    // 4. Enqueue via EnrichmentJobService
    const job = await this.enrichmentJobService.enqueue({
      type: 'auto_tagging',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.upload,
      priority: 20,
    });

    // 5. Upsert MediaTagStatus to pending
    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId: mediaItem.id },
      create: {
        mediaItemId: mediaItem.id,
        circleId: mediaItem.circleId,
        status: MediaTagStatusType.pending,
        tagCount: 0,
      },
      update: {
        status: MediaTagStatusType.pending,
      },
    });

    this.logger.log(
      `Enqueued auto-tagging job ${job.id} for MediaItem ${mediaItem.id} (reason: upload)`,
    );
  }
}
