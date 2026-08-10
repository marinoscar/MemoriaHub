import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, JobReason } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

/** Payload for a `location_group_rebuild` job. Both fields optional. */
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

export const LOCATION_GROUP_REBUILD_TYPE = 'location_group_rebuild';

/**
 * Enqueue helper for the `location_group_rebuild` job (issue #373).
 *
 * Issue #374's group/alias mutation endpoints call this after every write, so
 * an admin edit propagates to `media_items.geo_canonical_*` without a manual
 * backfill step.
 */
@Injectable()
export class LocationGroupRebuildService {
  private readonly logger = new Logger(LocationGroupRebuildService.name);

  constructor(private readonly enrichmentJobService: EnrichmentJobService) {}

  async enqueueRebuild(payload: LocationGroupRebuildPayload = {}): Promise<EnrichmentJob> {
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
    const job = await this.enrichmentJobService.enqueue({
      type: LOCATION_GROUP_REBUILD_TYPE,
      mediaItemId: null,
      circleId: null,
      reason: JobReason.backfill,
      priority: 100,
      payload: { ...payload },
    });

    this.logger.log(
      `location_group_rebuild enqueued (job ${job.id}, status=${job.status}, circleId=${
        payload.circleId ?? 'all'
      }, groupIds=${payload.groupIds?.length ?? 'all'})`,
    );

    return job;
  }
}
