import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { MEMORIAHUB_JOBS, MEMORIAHUB_PRISMA, type MemoriahubJobsPort } from '../../ports/index.js';
import type { LocationDb } from '../data/location-db.js';
import { enqueueGeocodeJob } from './enqueue-geocode.js';

/** The `media_geocode_status` values this service writes and filters on. */
const GeocodeStatus = { pending: 'pending', processed: 'processed' } as const;

/**
 * Queues `geocode` jobs: the app-wide backfill, the per-item rerun, and the per-item status read.
 *
 * @stability experimental
 */
@Injectable()
export class GeocodeBackfillService {
  private readonly logger = new Logger(GeocodeBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  /**
   * Queues a `geocode` job for every media item with coordinates (every circle), optionally bounded by
   * capture date; without `force` only items whose geocode status is absent or not `processed`.
   *
   * @param input - the optional date range and force flag.
   * @returns how many jobs were queued.
   */
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
                { geocodeStatus: { status: { not: GeocodeStatus.processed } } },
              ],
            }),
      },
      select: { id: true, circleId: true },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await enqueueGeocodeJob(this.jobs, this.prisma, {
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: 'backfill',
        priority: 100,
      }, this.logger);

      await this.prisma.mediaGeocodeStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: GeocodeStatus.pending,
        },
        update: {
          status: GeocodeStatus.pending,
        },
      });

      enqueued++;
    }

    this.logger.log(`Geocode backfill: queued ${enqueued} job(s)`);
    return { enqueued };
  }

  /**
   * Re-queues geocoding for one item at top priority and marks its status `pending`.
   *
   * @param mediaItemId - the item.
   * @param userId - who asked.
   * @throws NotFoundException when the item does not exist or is trashed.
   */
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

    const { id: jobId } = await enqueueGeocodeJob(this.jobs, this.prisma, {
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: 'rerun',
      priority: 0,
    }, this.logger);
    const jobRow = await this.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    const job = { id: jobId, status: (jobRow?.status as string | undefined) ?? 'pending' };

    await this.prisma.mediaGeocodeStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId: mediaItem.circleId,
        status: GeocodeStatus.pending,
      },
      update: { status: GeocodeStatus.pending },
    });

    this.logger.log(`Geocode rerun job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`);
    return { jobId: job.id, status: job.status };
  }

  /**
   * The per-item geocode status (`not_processed` when the item has no status row).
   *
   * @param mediaItemId - the item.
   */
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
