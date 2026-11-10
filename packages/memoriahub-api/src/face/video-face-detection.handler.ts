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

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import type { FaceDb } from './host/face-db.js';
import { DEFAULT_VIDEO_JOB_TIMEOUT_MS, FACE_OPTIONS, type FaceModuleOptions } from './host/face-options.js';
import { resolveMediaItemJob, withRateLimits } from './host/media-item-job.js';
import { videoFaceDetectionResultSchema } from '@marinoscar/memoriahub-compute/dto';
import { VideoFaceDetectionService } from './video-face-detection.service.js';

/**
 * The `video_face_detection` job handler: a thin queue entry point; the pipeline is `VideoFaceDetectionService`. Node-eligible: a worker node submits the clusters and the server persists them.
 *
 * @stability experimental
 */
@Injectable()
export class VideoFaceDetectionHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'video_face_detection';
  readonly label = 'Face detection (video)';
  /**
   * A multi-GB download, ffmpeg frame extraction and one sidecar call per frame
   * legitimately run past ten minutes on a small VPS: 20 minutes by default,
   * still overridable for one release through ENRICHMENT_VIDEO_JOB_TIMEOUT_MS.
   */
  readonly profile: MemoriahubJobProfile;
  readonly nodeResultSchema = videoFaceDetectionResultSchema;

  private readonly logger = new Logger(VideoFaceDetectionHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: FaceDb,
    private readonly videoFaceDetectionService: VideoFaceDetectionService,
    @Optional() @Inject(FACE_OPTIONS) options?: FaceModuleOptions,
  ) {
    this.profile = { maxRuntimeMs: options?.videoJobTimeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS, maxAttempts: 3 };
  }

  /**
   * Registers the handler with the queue.
   */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withRateLimits(() => this.videoFaceDetectionService.processMediaItem(context));
  }

  /** Persist a node-computed result (already validated by the data plane; re-parsed to narrow). */
  async persistNodeResult(job: MemoriahubJob, result: unknown): Promise<void> {
    const parsed = videoFaceDetectionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    this.logger.debug(
      `VideoFaceJob ${job.id}: persisting node-computed result (${parsed.clusters.length} cluster(s))`,
    );
    await this.videoFaceDetectionService.persistVideoFaces(context, parsed, 'node');
  }
}
