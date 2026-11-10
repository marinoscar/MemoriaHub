import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { classifyProviderThrottle } from '../core/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { AutoTaggingService } from './auto-tagging.service.js';
import { TAGGING_JOB_TYPES, TAGGING_THROTTLE_KEY } from './constants.js';
import type { TaggingDb } from './data/tagging-db.js';
import { resolveMediaItemJob } from './job-context.js';

/**
 * `auto_tagging`: a native job handler registered through the jobs port (RETRO-C4 #590, RETRO-J7 #618).
 *
 * SERVER-ONLY, permanently (AI rule 3): the provider key is resolved on the API
 * and never brokered to a worker node, so the handler has no node pair
 * (`nodeResultSchema` + `persistNodeResult`), declares `usesAi`, and the queue derives it as
 * server-only. Compute (one vision call over an image of at most 1568px) and
 * persist both run in `AutoTaggingService.processMediaItem`.
 *
 * Provider throttles (HTTP 429/529, `retry-after`) reach the queue as a
 * `MemoriahubRateLimitError`: the job is deferred and no attempt is consumed, and
 * the `tagging` gate (shared with `video_auto_tagging`, the same provider quota)
 * pauses.
 *
 * @stability experimental
 */
@Injectable()
export class AutoTaggingHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = TAGGING_JOB_TYPES.autoTagging;
  readonly label = 'Auto-tagging';
  /** The queue's throttle bucket, shared with `video_auto_tagging`. */
  readonly throttleKey = TAGGING_THROTTLE_KEY;
  /** The handler calls a model: AI jobs are server-only. */
  readonly usesAi = true;
  /** One vision call on a downscaled image: minutes, never ten. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 180_000, maxAttempts: 3 };

  private readonly logger = new Logger(AutoTaggingHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: TaggingDb,
    private readonly autoTaggingService: AutoTaggingService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Tags one photo.
   *
   * @param job - the queue row; its subject is the media item.
   */
  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    try {
      await this.autoTaggingService.processMediaItem(context);
    } catch (error) {
      throw classifyProviderThrottle(error, TAGGING_THROTTLE_KEY) ?? error;
    }
  }
}
