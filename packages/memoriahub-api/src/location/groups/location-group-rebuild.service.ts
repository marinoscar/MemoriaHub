import { Inject, Injectable, Logger } from '@nestjs/common';

import { MEMORIAHUB_JOBS, MEMORIAHUB_PRISMA, type MemoriahubJobsPort } from '../../ports/index.js';
import { enqueueEnrichmentJob } from '../../media/index.js';
import type { LocationDb } from '../data/location-db.js';

/**
 * Payload for a `location_group_rebuild` job. Both fields optional.
 *
 * @stability experimental
 */
export interface LocationGroupRebuildPayload {
  /** Restrict the rebuild to one circle; absent ⇒ the whole library. */
  circleId?: string;
  /**
   * Restrict the alias/radius passes to specific groups. The RESET pass always
   * runs over the full scope regardless, since a rebuild's whole purpose is to
   * re-derive canonical values from scratch.
   */
  groupIds?: string[];
}

/**
 * The job type. Permanent.
 *
 * @stability experimental
 */
export const LOCATION_GROUP_REBUILD_TYPE = 'location_group_rebuild';

/**
 * Enqueue helper for the `location_group_rebuild` job (issue #373).
 *
 * Issue #374's group/alias mutation endpoints call this after every write, so
 * an admin edit propagates to `media_items.geo_canonical_*` without a manual
 * backfill step.
 *
 * @stability experimental
 */
@Injectable()
export class LocationGroupRebuildService {
  private readonly logger = new Logger(LocationGroupRebuildService.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
  ) {}

  /**
   * Queues a full or scoped rebuild and answers the job id and its status (`pending`, or `running`
   * when a rebuild was already in flight and this request folded into it).
   *
   * @param payload - an optional circle and group restriction.
   */
  async enqueueRebuild(payload: LocationGroupRebuildPayload = {}): Promise<{ id: string; status: string }> {
    // ⚠️ DELIBERATELY NO `skipDedup` — do NOT copy it in from
    // LocationInferenceBackfillService, which passes `skipDedup: true` for the
    // OPPOSITE requirement.
    //
    // EnrichmentJobService.enqueue dedups global jobs on (type, mediaItemId IS
    // NULL), collapsing pending jobs of the same type into one. That is exactly
    // right HERE: a burst of admin edits (rename a group, add three aliases,
    // adjust a radius) should produce ONE rebuild, not five identical
    // full-library passes. The rebuild is idempotent and always re-derives from
    // current state, so the single surviving job subsumes the others.
    //
    // Location inference needs `skipDedup: true` because it enqueues one global
    // job PER CIRCLE — without it the first circle's job would swallow every
    // other circle's. Same mechanism, opposite requirement.
    const { id } = await enqueueEnrichmentJob(this.jobs, {
      type: LOCATION_GROUP_REBUILD_TYPE,
      reason: 'backfill',
      priority: 100,
      payload: { ...payload },
    });
    const row = await this.prisma.job.findUnique({ where: { id }, select: { status: true } });
    const job = { id, status: (row?.status as string | undefined) ?? 'pending' };

    this.logger.log(
      `location_group_rebuild enqueued (job ${job.id}, status=${job.status}, circleId=${
        payload.circleId ?? 'all'
      }, groupIds=${payload.groupIds?.length ?? 'all'})`,
    );

    return job;
  }
}
