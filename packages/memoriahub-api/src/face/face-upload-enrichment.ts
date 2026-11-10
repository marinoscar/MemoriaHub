import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UploadEnrichmentRegistry } from '@marinoscar/memoriahub-api/media';
import { JobReason, MediaFaceStatusType, MediaType } from '@prisma/client';

import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { featureSkipReason } from '../enrichment/upload/upload-enrichment-gates';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Registers the photo face-detection fan-out with the media slice (RETRO-J5, #613):
 * `face_detection` at priority 10 and the `pending` face status, behind
 * `features.faceRecognition` and `FACE_AUTO_DETECT`. (Video face detection rides the
 * post-social-media-detection fan-out, `MediaEnrichmentService`.)
 */
@Injectable()
export class FaceUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    registerFaceUploadEnrichment(this.registry, this.jobs, this.prisma);
  }
}

/** The registration itself, callable from a unit test without a Nest module. */
export function registerFaceUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<EnrichmentJobService, 'enqueue'>,
  prisma: Pick<PrismaService, 'mediaFaceStatus'>,
): void {
  registry.register('face_detection', {
    mediaTypes: [MediaType.photo],
    order: 200,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'faceRecognition', 'FACE_AUTO_DETECT'),
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: 'face_detection',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.upload,
        priority: 10,
      });

      await prisma.mediaFaceStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: MediaFaceStatusType.pending,
          faceCount: 0,
        },
        update: {
          status: MediaFaceStatusType.pending,
        },
      });

      return `job=${job.id}`;
    },
  });
}
