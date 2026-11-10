import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UploadEnrichmentRegistry } from '@marinoscar/memoriahub-api/media';
import { JobReason, MediaType } from '@prisma/client';

import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { featureSkipReason } from '../enrichment/upload/upload-enrichment-gates';

/**
 * Registers the photo location-inference fan-out with the media slice (RETRO-J5, #613):
 * `location_inference` at priority 10 behind `features.locationInference` and
 * `LOCATION_INFERENCE_ENABLED`; no status upsert (mirrors burst detection).
 */
@Injectable()
export class LocationInferenceUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: EnrichmentJobService,
  ) {}

  onModuleInit(): void {
    registerLocationInferenceUploadEnrichment(this.registry, this.jobs);
  }
}

/** The registration itself, callable from a unit test without a Nest module. */
export function registerLocationInferenceUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<EnrichmentJobService, 'enqueue'>,
): void {
  registry.register('location_inference', {
    mediaTypes: [MediaType.photo],
    order: 600,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'locationInference', 'LOCATION_INFERENCE_ENABLED'),
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: 'location_inference',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.upload,
        priority: 10,
      });
      return `job=${job.id}`;
    },
  });
}
