import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UploadEnrichmentRegistry, type UploadEnrichmentItem } from '@marinoscar/memoriahub-api/media';
import { JobReason, MediaSocialStatusType, MediaType } from '@prisma/client';

import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Registers the video fan-out with the media slice (RETRO-J5, #613).
 *
 * When social-media detection is on it runs FIRST (`social_media_detection`, priority 10,
 * the `pending` social status) and the face and tagging jobs are withheld: the detection
 * handler fans them out on its clean path (`MediaEnrichmentService.enqueueVideoPostDetectionEnrichment`)
 * and never for a detected social re-upload. When it is off (or killed) that same
 * post-detection fan-out runs directly, which is the behaviour before the feature existed.
 */
@Injectable()
export class SocialMediaUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: EnrichmentJobService,
    private readonly prisma: PrismaService,
    private readonly mediaEnrichment: MediaEnrichmentService,
  ) {}

  onModuleInit(): void {
    registerSocialMediaUploadEnrichment(this.registry, this.jobs, this.prisma, (item) =>
      this.mediaEnrichment.enqueueVideoPostDetectionEnrichment(item as never, JobReason.upload),
    );
  }
}

/** The registration itself, callable from a unit test without a Nest module. */
export function registerSocialMediaUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<EnrichmentJobService, 'enqueue'>,
  prisma: Pick<PrismaService, 'mediaSocialStatus'>,
  postDetection: (item: UploadEnrichmentItem) => Promise<void>,
): void {
  registry.register('social_media_detection', {
    mediaTypes: [MediaType.video],
    order: 300,
    skipReason: async (_item, ctx) => {
      const { value } = await ctx.settings.readSystem<Record<string, unknown>>('features');
      const on = value?.['socialMediaDetection'] === true;
      const killed = process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false';
      if (on && !killed) return null;
      return killed ? 'SOCIAL_MEDIA_DETECTION_ENABLED=false' : 'feature disabled';
    },
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: 'social_media_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.upload,
        priority: 10,
      });

      await prisma.mediaSocialStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: MediaSocialStatusType.pending,
        },
        update: {
          status: MediaSocialStatusType.pending,
        },
      });

      return `job=${job.id}`;
    },
    // Social detection off: preserve prior behaviour, enqueue the post-detection fan-out directly.
    onSkipped: async (item) => postDetection(item),
  });
}
