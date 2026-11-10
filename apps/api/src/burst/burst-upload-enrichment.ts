import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UploadEnrichmentRegistry } from '@marinoscar/memoriahub-api/media';
import { JobReason, MediaType } from '@prisma/client';

import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { featureSkipReason } from '../enrichment/upload/upload-enrichment-gates';

/**
 * Registers the photo burst-detection fan-out with the media slice (RETRO-J5, #613):
 * `burst_detection` behind `features.burstDetection` and `BURST_DETECTION_ENABLED`; no status
 * upsert (by design).
 *
 * Priority 5, so it is claimed BEFORE `duplicate_detection` (priority 10): claim order is
 * (priority ASC, created_at ASC), and burst precedence needs burst to claim items first.
 */
@Injectable()
export class BurstUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: EnrichmentJobService,
  ) {}

  onModuleInit(): void {
    registerBurstUploadEnrichment(this.registry, this.jobs);
  }
}

/** The registration itself, callable from a unit test without a Nest module. */
export function registerBurstUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<EnrichmentJobService, 'enqueue'>,
): void {
  registry.register('burst_detection', {
    mediaTypes: [MediaType.photo],
    order: 400,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'burstDetection', 'BURST_DETECTION_ENABLED'),
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: 'burst_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.upload,
        // burst must run before dedup so it can claim items first (burst precedence).
        priority: 5,
      });
      return `job=${job.id}`;
    },
  });
}
