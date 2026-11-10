// =============================================================================
// VideoFaceDetectionHandler  (type = 'video_face_detection')
// =============================================================================
//
// A native platform `JobHandler` (RETRO-C3, #585). Thin queue entry point: all
// pipeline logic (compute + persist) lives in VideoFaceDetectionService, which
// also owns the three skips that must happen WITHOUT downloading a byte (the
// item is flagged social media, `face.video.enabled=false`, or the object is
// over `VIDEO_ENRICHMENT_MAX_BYTES`).
//
// NODE-ELIGIBLE: `persistNodeResult` writes Face rows from the node's clusters
// and uploads nothing. The frame thumbnails a node produces land under the key
// the data plane hands it (the platform default `node-outputs/<jobId>/<uuid>`:
// `deriveOutputKey` is one key per job and a video has a frame per cluster, so
// this handler deliberately does not implement it); the cluster carries the key
// back and is recorded as is.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { videoFaceDetectionResultSchema } from '@marinoscar/memoriahub-compute/dto';
import { resolveMediaItemJob, withPlatformRateLimits } from '../platform/jobs/media-item-job';
import { videoJobTimeoutMs } from '../platform/jobs/legacy-env';
import { PrismaService } from '../prisma/prisma.service';
import { VideoFaceDetectionService } from './video-face-detection.service';

@Injectable()
export class VideoFaceDetectionHandler implements JobHandler, OnModuleInit {
  readonly type = 'video_face_detection';
  readonly label = 'Face detection (video)';
  /**
   * A multi-GB download, ffmpeg frame extraction and one sidecar call per frame
   * legitimately run past ten minutes on a small VPS: 20 minutes by default,
   * still overridable for one release through ENRICHMENT_VIDEO_JOB_TIMEOUT_MS.
   */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: videoJobTimeoutMs(), maxAttempts: 3 };
  readonly nodeResultSchema = videoFaceDetectionResultSchema;

  private readonly logger = new Logger(VideoFaceDetectionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly videoFaceDetectionService: VideoFaceDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() => this.videoFaceDetectionService.processMediaItem(context));
  }

  /** Persist a node-computed result (already validated by the data plane; re-parsed to narrow). */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed = videoFaceDetectionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    this.logger.debug(
      `VideoFaceJob ${job.id}: persisting node-computed result (${parsed.clusters.length} cluster(s))`,
    );
    await this.videoFaceDetectionService.persistVideoFaces(context, parsed, 'node');
  }
}
