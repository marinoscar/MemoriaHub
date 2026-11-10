import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { UploadEnrichmentRegistry, enqueueEnrichmentJob, featureSkipReason } from '../../media/index.js';
import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';

/**
 * Registers the photo location-inference fan-out with the media slice (RETRO-J5, #613):
 * `location_inference` at priority 10 behind `features.locationInference` and
 * `LOCATION_INFERENCE_ENABLED`; no status upsert (mirrors burst detection).
 *
 * @stability experimental
 */
@Injectable()
export class LocationInferenceUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  /** Registers the fan-out with the media slice. */
  onModuleInit(): void {
    registerLocationInferenceUploadEnrichment(this.registry, this.jobs);
  }
}

/**
 * The registration itself, callable from a unit test without a Nest module.
 *
 * @param registry - the media slice's fan-out registry.
 * @param jobs - the jobs port.
 * @stability experimental
 */
export function registerLocationInferenceUploadEnrichment(registry: UploadEnrichmentRegistry, jobs: MemoriahubJobsPort): void {
  registry.register('location_inference', {
    mediaTypes: ['photo'],
    order: 600,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'locationInference', 'LOCATION_INFERENCE_ENABLED'),
    enqueue: async (item) => {
      const job = await enqueueEnrichmentJob(jobs, {
        type: 'location_inference',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: 'upload',
        priority: 10,
      });
      return `job=${job.id}`;
    },
  });
}
