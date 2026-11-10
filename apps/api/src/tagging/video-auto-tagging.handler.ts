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
import { VideoAutoTaggingService } from './video-auto-tagging.service';

/**
 * `video_auto_tagging`: AI tags + description for videos (epic #452), a native
 * platform `JobHandler` (RETRO-C4, #590).
 *
 * A SEPARATE job type from `auto_tagging`: the execution profile differs (a video
 * legitimately runs far longer), and the admin Jobs filters, labels and per-type
 * insights key on the type. Everything downstream is shared (`tag_labels`,
 * `media_tag_status`, `media_items.description`, the `media_item_embedding`
 * upsert, through `AutoTaggingService.persistAutoTagging`).
 *
 * SERVER-ONLY, permanently (AI rule 3): the provider keys (vision and the
 * optional transcription provider) are resolved on the API and never brokered to
 * a node, so there is no node pair. ffmpeg reads the video on the API host, from
 * a presigned URL when the provider honours Range (`autoTagging.video.streamInput`,
 * issue #456), else from a temp file the platform janitor sweeps
 * (`memoriahub-job-` prefix).
 *
 * The resource ceiling is duration-independent: at most `autoTagging.video.maxFrames`
 * frames and `leadSeconds` of audio regardless of runtime, so one profile fits.
 * It shares the `tagging` provider gate with `auto_tagging`.
 */
@Injectable()
export class VideoAutoTaggingHandler implements JobHandler, OnModuleInit {
  readonly type = 'video_auto_tagging';
  readonly label = 'Video auto-tagging';
  /** Frame sampling, optional transcription and one multi-image call: the video budget (20 minutes). */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 1_200_000, maxAttempts: 3 };

  private readonly logger = new Logger(VideoAutoTaggingHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly prisma: PrismaService,
    private readonly videoAutoTaggingService: VideoAutoTaggingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // The same configured tagging provider as the photo path: one shared cooldown.
    this.throttle.registerProviderKey(this.type, 'tagging');
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() => this.videoAutoTaggingService.processMediaItem(context));
  }
}
