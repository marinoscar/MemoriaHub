import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { featureSkipReason } from '../core/index.js';
import { UploadEnrichmentRegistry } from '../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { JOB_REASON, MEDIA_TYPE, TAG_STATUS, TAGGING_JOB_TYPES } from './constants.js';
import type { TaggingDb } from './data/tagging-db.js';

/**
 * Registers the photo auto-tagging fan-out with the media slice (RETRO-J5 #613, RETRO-J7 #618):
 * `auto_tagging` at priority 20 and the `pending` tag status, behind
 * `features.autoTagging` and `AUTO_TAG_ENABLED`. (Video tagging rides the
 * post-social-media-detection fan-out, which the host's media enrichment service owns.)
 *
 * @stability experimental
 */
@Injectable()
export class TaggingUploadEnrichment implements OnModuleInit {
  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: TaggingDb,
  ) {}

  /** Registers the fan-out. */
  onModuleInit(): void {
    registerTaggingUploadEnrichment(this.registry, this.jobs, this.prisma);
  }
}

/**
 * The registration itself, callable from a unit test without a Nest module.
 *
 * @param registry - the media slice's upload fan-out registry.
 * @param jobs - the jobs port.
 * @param prisma - the database port.
 * @stability experimental
 */
export function registerTaggingUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  jobs: Pick<MemoriahubJobsPort, 'enqueue'>,
  prisma: Pick<TaggingDb, 'mediaTagStatus'>,
): void {
  registry.register(TAGGING_JOB_TYPES.autoTagging, {
    mediaTypes: [MEDIA_TYPE.photo],
    order: 100,
    skipReason: (_item, ctx) => featureSkipReason(ctx.settings, 'autoTagging', 'AUTO_TAG_ENABLED'),
    enqueue: async (item) => {
      const job = await jobs.enqueue({
        type: TAGGING_JOB_TYPES.autoTagging,
        reason: JOB_REASON.upload,
        subjectType: 'media_item',
        subjectId: item.id,
        payload: { circleId: item.circleId },
        priority: 20,
      });

      await prisma.mediaTagStatus.upsert({
        where: { mediaItemId: item.id },
        create: {
          mediaItemId: item.id,
          circleId: item.circleId,
          status: TAG_STATUS.pending,
          tagCount: 0,
        },
        update: {
          status: TAG_STATUS.pending,
        },
      });

      return `job=${job.id}`;
    },
  });
}
