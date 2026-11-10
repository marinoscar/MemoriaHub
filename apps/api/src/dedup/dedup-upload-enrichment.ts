import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UploadEnrichmentRegistry } from '@marinoscar/memoriahub-api/media';
import { JobReason, MediaType } from '@prisma/client';

import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { featureSkipReason } from '../enrichment/upload/upload-enrichment-gates';

/**
 * Registers the photo duplicate-detection fan-out with the media slice (RETRO-J5, #613):
 * `duplicate_detection` at priority 10 behind `features.duplicateDetection` and
 * `DUPLICATE_DETECTION_ENABLED`; no status upsert (by design, mirrors burst detection).
 */
@Injectable()
export class DedupUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: EnrichmentJobService,
  ) {}

  onModuleInit(): void {
    registerDedupUploadEnrichment(this.registry, this.jobs);
  }
}

/** The registration itself, callable from a unit test without a Nest module. */
export function registerDedupUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<EnrichmentJobService, 'enqueue'>,
): void {
  registry.register('duplicate_detection', {
    mediaTypes: [MediaType.photo],
    order: 500,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'duplicateDetection', 'DUPLICATE_DETECTION_ENABLED'),
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: 'duplicate_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.upload,
        priority: 10,
      });
      return `job=${job.id}`;
    },
  });
}
