import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { UploadEnrichmentRegistry, enqueueEnrichmentJob, featureSkipReason } from '../media/index.js';
import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../ports/index.js';

/**
 * Registers the photo burst-detection fan-out with the media slice (RETRO-J5, #613):
 * `burst_detection` behind `features.burstDetection` and `BURST_DETECTION_ENABLED`; no status
 * upsert (by design).
 *
 * Priority 5, so it is claimed BEFORE `duplicate_detection` (priority 10): claim order is
 * (priority ASC, created_at ASC), and burst precedence needs burst to claim items first.
 *
 * @stability experimental
 */
@Injectable()
export class BurstUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  /** Registers the fan-out with the media slice. */
  onModuleInit(): void {
    registerBurstUploadEnrichment(this.registry, this.jobs);
  }
}

/**
 * The registration itself, callable from a unit test without a Nest module.
 *
 * @param registry - the media slice's fan-out registry.
 * @param jobs - the jobs port.
 * @stability experimental
 */
export function registerBurstUploadEnrichment(registry: UploadEnrichmentRegistry, jobs: MemoriahubJobsPort): void {
  registry.register('burst_detection', {
    mediaTypes: ['photo'],
    order: 400,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'burstDetection', 'BURST_DETECTION_ENABLED'),
    enqueue: async (item) => {
      const job = await enqueueEnrichmentJob(jobs, {
        type: 'burst_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: 'upload',
        // burst must run before dedup so it can claim items first (burst precedence).
        priority: 5,
      });
      return `job=${job.id}`;
    },
  });
}
