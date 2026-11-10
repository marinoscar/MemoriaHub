import { Inject, Injectable, Logger } from '@nestjs/common';

import { enqueueEnrichmentJob } from '../../media/index.js';
import { MEMORIAHUB_JOBS, MEMORIAHUB_PRISMA, type MemoriahubJobsPort } from '../../ports/index.js';
import type { LocationDb } from '../data/location-db.js';

/**
 * Options of {@link LocationInferenceBackfillService.backfillAllCircles}.
 *
 * @stability experimental
 */
export interface LocationInferenceBackfillOptions {
  from?: string;
  to?: string;
  force?: boolean;
}

/**
 * LocationInferenceBackfillService
 *
 * App-wide backfill: one `location_inference` sweep job per eligible circle
 * (mediaItemId: null, payload.mode: 'sweep'). Sweep jobs use `skipDedup: true`
 * (many distinct global jobs share the same type with a null mediaItemId), so
 * THIS service is solely responsible for preventing duplicate concurrent
 * sweeps of the SAME circle — the default EnrichmentJobService.enqueue dedup
 * check only filters by (type, mediaItemId IS NULL), not by circleId, so
 * without this manual per-circle guard, sweep jobs for DIFFERENT circles
 * could incorrectly dedup against each other.
 *
 * @stability experimental
 */
@Injectable()
export class LocationInferenceBackfillService {
  private readonly logger = new Logger(LocationInferenceBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  /**
   * Queues one sweep job per circle that has photos without coordinates and a capture date.
   *
   * @param opts - an optional capture-date range and a force flag.
   */
  async backfillAllCircles(
    opts: LocationInferenceBackfillOptions,
  ): Promise<{ enqueued: number; circles: number; estimatedItems: number }> {
    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;

    const groups = await this.prisma.mediaItem.groupBy({
      by: ['circleId'],
      where: {
        deletedAt: null,
        type: 'photo',
        takenLat: null,
        capturedAt: {
          not: null,
          ...(from && { gte: from }),
          ...(to && { lte: to }),
        },
      },
      _count: true,
    });

    const eligibleCircles = groups.filter((g: { _count: number }) => g._count > 0);
    let enqueued = 0;
    let estimatedItems = 0;

    for (const group of eligibleCircles) {
      estimatedItems += group._count;

      // Per-circle guard: skip if a sweep is already pending/running for this circle.
      const existing = await this.prisma.job.findFirst({
        where: {
          type: 'location_inference',
          subjectType: 'circle',
          subjectId: group.circleId,
          status: { in: ['pending', 'running'] },
        },
      });

      if (existing) {
        this.logger.debug(
          `Skipping location-inference sweep for circle ${group.circleId}: job ${existing.id} already ${existing.status}`,
        );
        continue;
      }

      await enqueueEnrichmentJob(this.jobs, {
        type: 'location_inference',
        circleId: group.circleId,
        reason: 'backfill',
        priority: 100,
        payload: { mode: 'sweep', from: opts.from, to: opts.to, force: opts.force ?? false },
        skipDedup: true,
      });
      enqueued++;
    }

    this.logger.log(
      `Global location-inference backfill: ${enqueued} sweep job(s) enqueued across ${eligibleCircles.length} eligible circle(s) (~${estimatedItems} item(s))`,
    );

    // `enqueued` = jobs actually created (circles that passed the pending/running
    // guard); `circles` = circles that HAD eligible items at all. These can
    // diverge when a circle already has a sweep in flight.
    return { enqueued, circles: eligibleCircles.length, estimatedItems };
  }
}
