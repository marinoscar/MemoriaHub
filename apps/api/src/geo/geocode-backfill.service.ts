import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobReason, MediaMetadataStatusType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

@Injectable()
export class GeocodeBackfillService {
  private readonly logger = new Logger(GeocodeBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  async backfill(input: { from?: string; to?: string; force?: boolean }): Promise<{ enqueued: number }> {
    const { from, to, force = false } = input;

    const dateWhere: Record<string, unknown> = {};
    if (from || to) {
      const range: Record<string, unknown> = {};
      if (from) range['gte'] = new Date(from);
      if (to) range['lte'] = new Date(to);
      dateWhere['capturedAt'] = range;
    }

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        deletedAt: null,
        takenLat: { not: null },
        takenLng: { not: null },
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { geocodeStatus: null },
                { geocodeStatus: { status: { not: MediaMetadataStatusType.processed } } },
              ],
            }),
      },
      select: { id: true, circleId: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await this.enrichmentJobService.enqueue({
        type: 'geocode',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.backfill,
        priority: 100,
      });

      await this.prisma.mediaGeocodeStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: MediaMetadataStatusType.pending,
        },
        update: {
          status: MediaMetadataStatusType.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(`Geocode backfill: queued ${enqueued} job(s)`);
    return { enqueued };
  }

  async enqueueRerun(
    mediaItemId: string,
    userId: string,
  ): Promise<{ jobId: string; status: string }> {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    const job = await this.enrichmentJobService.enqueue({
      type: 'geocode',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    await this.prisma.mediaGeocodeStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaMetadataStatusType.pending,
      },
      update: { status: MediaMetadataStatusType.pending },
    });

    this.logger.log(`Geocode rerun job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`);
    return { jobId: job.id, status: job.status };
  }

  async getStatus(mediaItemId: string) {
    const status = await this.prisma.mediaGeocodeStatus.findUnique({
      where: { mediaItemId },
    });

    if (!status) {
      return {
        status: 'not_processed',
        processedAt: null,
        lastError: null,
      };
    }

    return {
      status: status.status,
      processedAt: status.processedAt,
      lastError: status.lastError,
    };
  }
}
