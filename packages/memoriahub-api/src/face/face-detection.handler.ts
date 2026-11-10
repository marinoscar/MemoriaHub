import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import type { FaceDb } from './host/face-db.js';
import { FACE_THROTTLE_KEY, resolveMediaItemJob, withRateLimits } from './host/media-item-job.js';
import { faceDetectionResultSchema } from '@marinoscar/memoriahub-compute/dto';
import { FaceDetectionService } from './face-detection.service.js';

/**
 * `face_detection`: a native platform `JobHandler` (RETRO-C3, #585).
 *
 * NODE-ELIGIBLE (derived from the pair `nodeResultSchema` + `persistNodeResult`):
 * a node computes with the keyless CompreFace sidecar beside it and submits the
 * shared DTO from `@marinoscar/memoriahub-compute/dto`; `persistNodeResult` only
 * writes Face rows, matches people and marks the status row: no download, no
 * second CompreFace call. See FaceDetectionService.warnOnProviderMismatch for the
 * cross-provider embedding-space caveat.
 *
 * The subject is the media item (`job.subjectType === 'media_item'`); a media
 * item that no longer exists settles the job as a no-op.
 *
 * @stability experimental
 */
@Injectable()
export class FaceDetectionHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'face_detection';
  readonly label = 'Face detection (photo)';
  /** One download, one EXIF-oriented downscale, one sidecar call: minutes, never ten. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };
  /** The face provider's quota: a cooldown on one face job holds the others. */
  readonly throttleKey = FACE_THROTTLE_KEY;
  readonly nodeResultSchema = faceDetectionResultSchema;

  private readonly logger = new Logger(FaceDetectionHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: FaceDb,
    private readonly faceDetectionService: FaceDetectionService,
  ) {}

  /**
   * Registers the handler with the queue.
   */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withRateLimits(() => this.faceDetectionService.processMediaItem(context));
  }

  /** Persist a node-computed result (already validated by the data plane; re-parsed to narrow). */
  async persistNodeResult(job: MemoriahubJob, result: unknown): Promise<void> {
    const parsed = faceDetectionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    this.logger.debug(`FaceJob ${job.id}: persisting node-computed result (${parsed.faces.length} face(s))`);
    await this.faceDetectionService.persistFaces(context, parsed, 'node');
  }
}
