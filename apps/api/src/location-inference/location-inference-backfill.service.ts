import { Injectable, Logger } from '@nestjs/common';
import { JobReason, JobStatus, MediaType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

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
 */
@Injectable()
export class LocationInferenceBackfillService {
  private readonly logger = new Logger(LocationInferenceBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  async backfillAllCircles(
    opts: LocationInferenceBackfillOptions,
  ): Promise<{ enqueued: number; circles: number; estimatedItems: number }> {
    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;

    const groups = await this.prisma.mediaItem.groupBy({
      by: ['circleId'],
      where: {
        deletedAt: null,
        type: MediaType.photo,
        takenLat: null,
        capturedAt: {
          not: null,
          ...(from && { gte: from }),
          ...(to && { lte: to }),
        },
      },
      _count: true,
    });

    const eligibleCircles = groups.filter((g) => g._count > 0);
    let enqueued = 0;
    let estimatedItems = 0;

    for (const group of eligibleCircles) {
      estimatedItems += group._count;

      // Per-circle guard: skip if a sweep is already pending/running for this circle.
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'location_inference',
          circleId: group.circleId,
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `Skipping location-inference sweep for circle ${group.circleId}: job ${existing.id} already ${existing.status}`,
        );
        continue;
      }

      await this.enrichmentJobService.enqueue({
        type: 'location_inference',
        mediaItemId: null,
        circleId: group.circleId,
        reason: JobReason.backfill,
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
