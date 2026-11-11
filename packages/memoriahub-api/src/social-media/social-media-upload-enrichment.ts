import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { UploadEnrichmentRegistry, enqueueEnrichmentJob, type UploadEnrichmentItem } from '../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { SOCIAL_JOB_REASON, SOCIAL_MEDIA_JOB_TYPE, SOCIAL_MEDIA_TYPE, SOCIAL_STATUS } from './constants.js';
import type { SocialMediaDb } from './data/social-media-db.js';
import {
  SOCIAL_MEDIA_POST_DETECTION,
  type SocialMediaPostDetection,
} from './social-media-host-hooks.js';

/**
 * Registers the video fan-out with the media slice (RETRO-J5, #613; moved RETRO-J10, #624).
 *
 * When social-media detection is on it runs FIRST (`social_media_detection`, priority 10, the `pending`
 * social status) and the face and tagging jobs are withheld: the detection handler fans them out on its
 * clean path (the host's `SOCIAL_MEDIA_POST_DETECTION` hook) and never for a detected social re-upload.
 * When it is off (or killed) that same post-detection fan-out runs directly, which is the behaviour
 * before the feature existed.
 *
 * @stability experimental
 */
@Injectable()
export class SocialMediaUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: Pick<SocialMediaDb, 'mediaSocialStatus'>,
    @Inject(SOCIAL_MEDIA_POST_DETECTION) private readonly postDetection: SocialMediaPostDetection,
  ) {}

  /** Registers the fan-out with the media slice. */
  onModuleInit(): void {
    registerSocialMediaUploadEnrichment(this.registry, this.jobs, this.prisma, (item) =>
      this.postDetection.enqueueVideoPostDetectionEnrichment(item, SOCIAL_JOB_REASON.upload),
    );
  }
}

/**
 * The registration itself, callable from a unit test without a Nest module.
 *
 * @param registry - the media slice's fan-out registry.
 * @param jobs - the jobs port.
 * @param prisma - the database port (the `pending` social status upsert).
 * @param postDetection - the fan-out to run directly when detection is off.
 * @stability experimental
 */
export function registerSocialMediaUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: MemoriahubJobsPort,
  prisma: Pick<SocialMediaDb, 'mediaSocialStatus'>,
  postDetection: (item: UploadEnrichmentItem) => Promise<void>,
): void {
  registry.register(SOCIAL_MEDIA_JOB_TYPE, {
    mediaTypes: [SOCIAL_MEDIA_TYPE.video],
    order: 300,
    skipReason: async (_item, ctx) => {
      const { value } = await ctx.settings.readSystem<Record<string, unknown>>('features');
      const on = value?.['socialMediaDetection'] === true;
      const killed = process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false';
      if (on && !killed) return null;
      return killed ? 'SOCIAL_MEDIA_DETECTION_ENABLED=false' : 'feature disabled';
    },
    enqueue: async (item) => {
      const job = await enqueueEnrichmentJob(jobs, {
        type: SOCIAL_MEDIA_JOB_TYPE,
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: SOCIAL_JOB_REASON.upload,
        priority: 10,
      });

      await prisma.mediaSocialStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          status: SOCIAL_STATUS.pending,
        },
        update: {
          status: SOCIAL_STATUS.pending,
        },
      });

      return `job=${job.id}`;
    },
    // Social detection off: preserve prior behaviour, enqueue the post-detection fan-out directly.
    onSkipped: async (item) => postDetection(item),
  });
}
