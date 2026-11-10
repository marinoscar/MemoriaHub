import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  ProviderThrottleService,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { faceDetectionResultSchema } from '@marinoscar/memoriahub-compute/dto';
import { resolveMediaItemJob, withPlatformRateLimits } from '../platform/jobs/media-item-job';
import { PrismaService } from '../prisma/prisma.service';
import { FaceDetectionService } from './face-detection.service';

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
 */
@Injectable()
export class FaceDetectionHandler implements JobHandler, OnModuleInit {
  readonly type = 'face_detection';
  readonly label = 'Face detection (photo)';
  /** One download, one EXIF-oriented downscale, one sidecar call: minutes, never ten. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };
  readonly nodeResultSchema = faceDetectionResultSchema;

  private readonly logger = new Logger(FaceDetectionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly prisma: PrismaService,
    private readonly faceDetectionService: FaceDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // The face provider's quota: a cooldown on one face job holds the others.
    this.throttle.registerProviderKey(this.type, 'face');
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() => this.faceDetectionService.processMediaItem(context));
  }

  /** Persist a node-computed result (already validated by the data plane; re-parsed to narrow). */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed = faceDetectionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    this.logger.debug(`FaceJob ${job.id}: persisting node-computed result (${parsed.faces.length} face(s))`);
    await this.faceDetectionService.persistFaces(context, parsed, 'node');
  }
}
