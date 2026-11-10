import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MEMORIAHUB_PRISMA } from '../ports/index.js';
import { featureSkipReason } from '../core/index.js';
import { UploadEnrichmentRegistry } from '../media/index.js';
import type { FaceDb } from './host/face-db.js';
import { JobReason, MediaFaceStatusType, MediaType } from './host/face-enums.js';
import { FaceJobs } from './host/face-jobs.js';

/**
 * Registers the photo face-detection fan-out with the media slice (RETRO-J5, #613):
 * `face_detection` at priority 10 and the `pending` face status, behind
 * `features.faceRecognition` and `FACE_AUTO_DETECT`. (Video face detection rides the
 * post-social-media-detection fan-out, `MediaEnrichmentService`.)
 *
 * @stability experimental
 */
@Injectable()
export class FaceUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    private readonly jobs: FaceJobs,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: FaceDb,
  ) {}

  /**
   * Registers the photo fan-out with the media slice.
   */
  onModuleInit(): void {
    registerFaceUploadEnrichment(this.registry, this.jobs, this.prisma);
  }
}

/**
 * The registration itself, callable from a unit test without a Nest module.
 *
 * @stability experimental
 */
export function registerFaceUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<FaceJobs, 'enqueue'>,
  prisma: Pick<FaceDb, 'mediaFaceStatus'>,
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
