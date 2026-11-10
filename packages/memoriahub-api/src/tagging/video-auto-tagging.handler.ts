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
import { TAGGING_JOB_TYPES, TAGGING_THROTTLE_KEY } from './constants.js';
import type { TaggingDb } from './data/tagging-db.js';
import { resolveMediaItemJob } from './job-context.js';
import { VideoAutoTaggingService } from './video-auto-tagging.service.js';

/**
 * `video_auto_tagging`: AI tags + description for videos (epic #452), a native
 * job handler registered through the jobs port (RETRO-C4 #590, RETRO-J7 #618).
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
 * issue #456), else from a temp file the host's janitor sweeps
 * (`memoriahub-job-` prefix).
 *
 * The resource ceiling is duration-independent: at most `autoTagging.video.maxFrames`
 * frames and `leadSeconds` of audio regardless of runtime, so one profile fits.
 * It shares the `tagging` provider gate with `auto_tagging`.
 *
 * @stability experimental
 */
@Injectable()
export class VideoAutoTaggingHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = TAGGING_JOB_TYPES.videoAutoTagging;
  readonly label = 'Video auto-tagging';
  /** The same configured tagging provider as the photo path: one shared cooldown. */
  readonly throttleKey = TAGGING_THROTTLE_KEY;
  /** The handler calls a model: AI jobs are server-only. */
  readonly usesAi = true;
  /** Frame sampling, optional transcription and one multi-image call: the video budget (20 minutes). */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 1_200_000, maxAttempts: 3 };

  private readonly logger = new Logger(VideoAutoTaggingHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: TaggingDb,
    private readonly videoAutoTaggingService: VideoAutoTaggingService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Tags one video.
   *
   * @param job - the queue row; its subject is the media item.
   */
  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    try {
      await this.videoAutoTaggingService.processMediaItem(context);
    } catch (error) {
      throw classifyProviderThrottle(error, TAGGING_THROTTLE_KEY) ?? error;
    }
  }
}
