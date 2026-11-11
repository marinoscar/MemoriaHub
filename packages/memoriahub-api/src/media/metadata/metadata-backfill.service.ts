import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { enqueueEnrichmentJob } from '../jobs/enrichment-jobs.js';
import { whereDateRange } from '../where/media-where.builder.js';

/**
 * Backfills metadata extraction: one `metadata_extraction` job per eligible item, per circle or
 * across all of them.
 *
 * @stability experimental
 */
@Injectable()
export class MetadataBackfillService {
  private readonly logger = new Logger(MetadataBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
  ) {}

  /**
   * Backfill metadata extraction for all eligible media in a single circle.
   * No per-circle opt-in check — metadata extraction has no feature flag.
   * No membership check — intended for admin/internal usage.
   */
  async backfillCircle(
    circleId: string,
    opts: { from?: string; to?: string; force?: boolean },
  ): Promise<number> {
    const { force = false } = opts;

    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;
    const dateWhere = whereDateRange(from, to);

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        deletedAt: null,
        ...dateWhere,
        ...(force
          ? {}
          : {
              OR: [
                { metadataStatus: null },
                {
                  metadataStatus: {
                    status: { notIn: ['processed'] },
                  },
                },
              ],
            }),
      },
      select: { id: true, circleId: true, storageObject: { select: { mimeType: true } } },
    });

    let enqueued = 0;
    for (const item of mediaItems) {
      await enqueueEnrichmentJob(this.jobs, {
        type: 'metadata_extraction',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: 'backfill',
        priority: 100,
        // See MetadataController.rerunMetadata for why mimeType rides in payload.
        payload: { mimeType: item.storageObject?.mimeType ?? 'application/octet-stream' },
      });

      await this.prisma.mediaMetadataStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: 'pending',
        },
        update: {
          status: 'pending',
        },
      });

      enqueued++;
    }

    this.logger.log(
      `Backfill: queued ${enqueued} metadata extraction job(s) for circle ${circleId}`,
    );

    return enqueued;
  }

  /**
   * Backfill metadata extraction across ALL circles.
   * Returns the total number of enqueued jobs and the number of circles processed.
   */
  async backfillAllCircles(opts: {
    from?: string;
    to?: string;
    force?: boolean;
  }): Promise<{ enqueued: number; circles: number }> {
    // Every shared library (a platform group) plus every personal library (RETRO-N29).
    const allCircles = (await this.access.allScopeIds()).map((id) => ({ id }));

    let totalEnqueued = 0;
    const circleCount = allCircles.length;

    for (const circle of allCircles) {
      const count = await this.backfillCircle(circle.id, opts);
      totalEnqueued += count;
    }

    this.logger.log(
      `Global metadata backfill complete: ${totalEnqueued} job(s) enqueued across ${circleCount} circle(s)`,
    );

    return { enqueued: totalEnqueued, circles: circleCount };
  }
}
