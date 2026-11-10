import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UploadEnrichmentRegistry } from '@marinoscar/memoriahub-api/media';
import { JobReason, MediaTagStatusType, MediaType } from '@prisma/client';

import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { featureSkipReason } from '../enrichment/upload/upload-enrichment-gates';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Registers the photo auto-tagging fan-out with the media slice (RETRO-J5, #613):
 * `auto_tagging` at priority 20 and the `pending` tag status, behind
 * `features.autoTagging` and `AUTO_TAG_ENABLED`. (Video tagging rides the
 * post-social-media-detection fan-out, `MediaEnrichmentService`.)
 */
@Injectable()
export class TaggingUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    registerTaggingUploadEnrichment(this.registry, this.jobs, this.prisma);
  }
}

/** The registration itself, callable from a unit test without a Nest module. */
export function registerTaggingUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<EnrichmentJobService, 'enqueue'>,
  prisma: Pick<PrismaService, 'mediaTagStatus'>,
): void {
  registry.register('auto_tagging', {
    mediaTypes: [MediaType.photo],
    order: 100,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'autoTagging', 'AUTO_TAG_ENABLED'),
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: 'auto_tagging',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.upload,
        priority: 20,
      });

      await prisma.mediaTagStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: MediaTagStatusType.pending,
          tagCount: 0,
        },
        update: {
          status: MediaTagStatusType.pending,
        },
      });

      return `job=${job.id}`;
    },
  });
}
