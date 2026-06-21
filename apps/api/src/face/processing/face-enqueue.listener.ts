import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, JobReason, MediaFaceStatusType } from '@prisma/client';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../storage/processing/events/object-processed.event';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { FEATURE_KEYS } from '../../common/types/settings.types';

@Injectable()
export class FaceEnqueueListener {
  private readonly logger = new Logger(FaceEnqueueListener.name);

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
        `FaceEnqueueListener failed for StorageObject ${event.storageObjectId}: ${message}`,
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
      this.logger.debug(`No MediaItem for StorageObject ${storageObjectId}; skipping face enqueue`);
      return;
    }

    // Only photos are supported for face detection
    if (mediaItem.type !== MediaType.photo) {
      this.logger.debug(
        `MediaItem ${mediaItem.id} is type ${mediaItem.type}; skipping face enqueue`,
      );
      return;
    }

    if (mediaItem.deletedAt) {
      this.logger.debug(`MediaItem ${mediaItem.id} is deleted; skipping face enqueue`);
      return;
    }

    // 2. Check global kill-switch (FACE_AUTO_DETECT=false disables all auto-enqueue)
    const autoDetect = process.env['FACE_AUTO_DETECT'] ?? 'true';
    if (autoDetect === 'false') {
      this.logger.debug(`FACE_AUTO_DETECT=false; skipping face enqueue for MediaItem ${mediaItem.id}`);
      return;
    }

    // 3. Check global system-settings feature flag
    const faceRecognitionGloballyEnabled = await this.systemSettings.isFeatureEnabled(FEATURE_KEYS.FACE_RECOGNITION);
    if (!faceRecognitionGloballyEnabled) {
      this.logger.debug(
        `Face recognition disabled globally; skipping face enqueue for MediaItem ${mediaItem.id}`,
      );
      return;
    }

    // 4. Enqueue via EnrichmentJobService (idempotency handled by service)
    const job = await this.enrichmentJobService.enqueue({
      type: 'face_detection',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.upload,
      priority: 10,
    });

    // 5. Upsert MediaFaceStatus to pending (face domain status — kept here)
    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId: mediaItem.id },
      create: {
        mediaItemId: mediaItem.id,
        status: MediaFaceStatusType.pending,
        faceCount: 0,
      },
      update: {
        status: MediaFaceStatusType.pending,
      },
    });

    this.logger.log(
      `Enqueued face job ${job.id} for MediaItem ${mediaItem.id} (reason: upload)`,
    );
  }
}
