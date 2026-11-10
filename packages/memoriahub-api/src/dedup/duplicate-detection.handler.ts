import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { duplicateDetectionResultSchema } from '@marinoscar/memoriahub-compute/dto';

import { resolveMediaItemJob } from '../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import type { DedupDb } from './data/dedup-db.js';
import { DuplicateDetectionService } from './duplicate-detection.service.js';

/**
 * `duplicate_detection`: a native platform `JobHandler` (RETRO-C5, #594).
 *
 * NODE-ELIGIBLE (derived from the pair `nodeResultSchema` + `persistNodeResult`):
 * a node downloads the original through a presigned GET, computes the CLIP
 * ViT-B/32 embedding (512-d) and the dHash with the shared
 * `@marinoscar/memoriahub-compute` code, and submits
 * `{ model, embedding, dHash }`. `persistNodeResult` writes the embedding row
 * and the hash, then runs the pgvector KNN, the hash scan and the union-find
 * grouping. It never recomputes the embedding and never downloads a byte.
 *
 * BURST WINS: `burst_detection` is enqueued at priority 5, this type at 10, and
 * the persist half re-reads the item's `burst_group_id` under `SELECT ... FOR
 * UPDATE` before writing `duplicate_group_id` (DuplicateDetectionService), on
 * the server path and the node path alike.
 *
 * The subject is the media item; a media item that no longer exists settles the
 * job as a no-op. Degraded (dHash-only) mode is logged once per process by
 * VisualEmbeddingService.
 */
/**
 * `duplicate_detection`: the per-photo near-duplicate job, node-eligible.
 *
 * @stability experimental
 */
@Injectable()
export class DuplicateDetectionHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'duplicate_detection';

  /** The label in the admin job list. */
  readonly label = 'Duplicate detection';

  /** One download, one CLIP embed, one KNN query and a hash scan: minutes, never ten. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  /** The node result contract (model, embedding, dHash). */
  readonly nodeResultSchema = duplicateDetectionResultSchema;

  private readonly logger = new Logger(DuplicateDetectionHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: DedupDb,
    private readonly duplicateDetectionService: DuplicateDetectionService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs one attempt on the server: download, compute, persist. */
  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.duplicateDetectionService.processMediaItem(context.mediaItemId);
  }

  /**
   * Persist a node-computed result (already validated by the data plane; re-parsed
   * to narrow). The node contract carries `{ model, embedding, dHash }` but no
   * sharpness score: `sharpnessScore: null` makes persistDuplicate skip the
   * sharpness column write, exactly what the server path does when sharpness is
   * unavailable.
   */
  async persistNodeResult(job: MemoriahubJob, result: unknown): Promise<void> {
    const parsed = duplicateDetectionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.duplicateDetectionService.persistDuplicate(context, {
      model: parsed.model,
      embedding: parsed.embedding,
      dHash: parsed.dHash,
      sharpnessScore: null,
    });
  }
}
