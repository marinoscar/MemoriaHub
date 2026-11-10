import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  ProviderThrottleService,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { resolveMediaItemJob, withPlatformRateLimits } from '../platform/jobs/media-item-job';
import { PrismaService } from '../prisma/prisma.service';
import { AutoTaggingService } from './auto-tagging.service';

/**
 * `auto_tagging`: a native platform `JobHandler` (RETRO-C4, #590).
 *
 * SERVER-ONLY, permanently (AI rule 3): the provider key is resolved on the API
 * and never brokered to a worker node, so the handler has no node pair
 * (`nodeResultSchema` + `persistNodeResult`) and the platform derives it as
 * server-only. Compute (one vision call over an image of at most 1568px) and
 * persist both run in `AutoTaggingService.processMediaItem`.
 *
 * Provider throttles (HTTP 429/529, `retry-after`) reach the queue as the
 * platform `RateLimitError`: the job is deferred and no attempt is consumed, and
 * the `tagging` gate (shared with `video_auto_tagging`, the same provider quota)
 * pauses.
 */
@Injectable()
export class AutoTaggingHandler implements JobHandler, OnModuleInit {
  readonly type = 'auto_tagging';
  readonly label = 'Auto-tagging';
  /** One vision call on a downscaled image: minutes, never ten. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 180_000, maxAttempts: 3 };

  private readonly logger = new Logger(AutoTaggingHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly prisma: PrismaService,
    private readonly autoTaggingService: AutoTaggingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.throttle.registerProviderKey(this.type, 'tagging');
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() => this.autoTaggingService.processMediaItem(context));
  }
}
