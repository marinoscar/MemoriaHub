import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { thumbnailResultSchema } from '@marinoscar/memoriahub-compute/dto';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { MEDIA_OBJECT_REPROCESSOR, type MediaObjectReprocessor } from '../hooks/media-host-hooks.js';
import { resolveMediaItemJob } from '../jobs/enrichment-jobs.js';
import { withMediaRateLimits } from '../jobs/media-item-job.js';
import { buildThumbnailKey, thumbnailVersionForJob } from './thumbnail-key.js';
import { ThumbnailNodePersistService } from './thumbnail-node-persist.service.js';

/**
 * ThumbnailRegenHandler: the `thumbnail_regen` job handler.
 *
 * Worker-side (asynchronous) counterpart to the synchronous per-item
 * `POST /api/media/:id/thumbnail/rerun` endpoint (MediaThumbnailRerunController).
 * Bulk thumbnail reruns must NOT loop the synchronous reprocess path, so each
 * item enqueues a `thumbnail_regen` job whose server path does the same work the
 * single-item endpoint does: resolve the MediaItem's StorageObject and call
 * the object reprocessor's `reprocessNow`, inside the worker.
 *
 * Graceful skip (missing/deleted item, no storageObject): log and return so the
 * job succeeds rather than retrying forever on a permanently-invalid target.
 *
 * NODE PATH: a worker node renders the JPEG locally and PUTs it to the key the
 * SERVER chose through `deriveOutputKey` (the content-addressed thumbnail
 * namespace `thumbnails/<sourceObjectId>-<version>.jpg`, version derived from
 * the job id so the answer is the same on every request of the same job), then
 * submits `{ storageKey, width, height, bytes }`. `persistNodeResult` delegates
 * to ThumbnailNodePersistService: verify the bytes landed, record the rows (in
 * the job's organization, `JobScope`), sync the MediaItem, prune the superseded
 * thumbnail (sync before prune, issue #434).
 */
/**
 * Regenerates a media item's thumbnail on the worker, or persists a node's rendering of it.
 *
 * @stability experimental
 */
@Injectable()
export class ThumbnailRegenHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'thumbnail_regen';
  readonly label = 'Thumbnail regeneration';
  /** The full sharp/ffmpeg pipeline on one object; a large video's frame grab takes minutes. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 600_000, maxAttempts: 3 };
  readonly nodeResultSchema = thumbnailResultSchema;

  private readonly logger = new Logger(ThumbnailRegenHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEDIA_OBJECT_REPROCESSOR) private readonly recoveryService: MediaObjectReprocessor,
    private readonly thumbnailNodePersistService: ThumbnailNodePersistService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: context.mediaItemId },
      select: { id: true, deletedAt: true, storageObject: true },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      this.logger.warn(
        `thumbnail_regen job ${job.id}: MediaItem ${context.mediaItemId} is missing, deleted, or has no storageObject — skipping`,
      );
      return;
    }

    await withMediaRateLimits(() => this.recoveryService.reprocessNow(mediaItem.storageObject));

    this.logger.log(
      `thumbnail_regen job ${job.id}: reprocessed StorageObject ${mediaItem.storageObject.id} for MediaItem ${context.mediaItemId}`,
    );
  }

  /**
   * Where a node's thumbnail lands: the source object's versioned thumbnail key.
   * Idempotent per job (the platform contract): every request for the same job
   * answers the same key.
   */
  async deriveOutputKey(job: MemoriahubJob): Promise<string> {
    if (job.subjectType !== 'media_item' || !job.subjectId) {
      throw new Error(`thumbnail_regen job ${job.id} is not about a media item`);
    }
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.subjectId },
      select: { storageObjectId: true },
    });
    if (!mediaItem?.storageObjectId) {
      throw new Error(`MediaItem ${job.subjectId} for job ${job.id} has no linked StorageObject`);
    }
    return buildThumbnailKey(mediaItem.storageObjectId, thumbnailVersionForJob(job.id));
  }

  async persistNodeResult(job: MemoriahubJob, result: unknown): Promise<void> {
    const parsed = thumbnailResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.thumbnailNodePersistService.persistThumbnail(context, parsed, (fn) => this.jobs.runInJobScope(job, fn));
  }
}
