import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaType, FaceJobStatus, FaceJobReason, MediaFaceStatusType } from '@prisma/client';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../storage/processing/events/object-processed.event';

@Injectable()
export class FaceEnqueueListener {
  private readonly logger = new Logger(FaceEnqueueListener.name);

  constructor(private readonly prisma: PrismaService) {}

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

    // 2. Check FACE_AUTO_DETECT env (default: true)
    // TODO Phase 4: replace with per-circle opt-in flag
    const autoDetect = process.env['FACE_AUTO_DETECT'] ?? 'true';
    if (autoDetect === 'false') {
      this.logger.debug(
        `FACE_AUTO_DETECT=false; skipping face enqueue for MediaItem ${mediaItem.id}`,
      );
      return;
    }

    // 3. Idempotency: skip if a pending/running job already exists
    const existingJob = await this.prisma.faceJob.findFirst({
      where: {
        mediaItemId: mediaItem.id,
        status: { in: [FaceJobStatus.pending, FaceJobStatus.running] },
      },
      select: { id: true },
    });

    if (existingJob) {
      this.logger.debug(
        `Active face job ${existingJob.id} already exists for MediaItem ${mediaItem.id}; skipping`,
      );
      return;
    }

    // 4. Create FaceJob
    const job = await this.prisma.faceJob.create({
      data: {
        mediaItemId: mediaItem.id,
        circleId: mediaItem.circleId,
        status: FaceJobStatus.pending,
        reason: FaceJobReason.upload,
        attempts: 0,
      },
    });

    // 5. Upsert MediaFaceStatus to pending
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
