import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { resolveCircleJob } from '../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  type MemoriahubAccessPort,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { DuplicateDetectionService } from './duplicate-detection.service.js';

interface DuplicateDetectionBatchPayload {
  mediaItemIds?: unknown;
}

/**
 * `duplicate_detection_batch`: a native platform `JobHandler` (RETRO-C5, #594).
 *
 * The admin backfill (`DuplicateBackfillService`) enqueues one job per chunk of
 * 100 media item ids (`payload.mediaItemIds`, subject the circle, priority 100,
 * `skipDedup` so each chunk keeps its own row) instead of one job per item, so a
 * large circle-wide backfill does not flood the queue with tens of thousands of
 * single-item rows. Each job processes its chunk sequentially, collecting
 * per-item failures rather than aborting on the first; if any item failed, the
 * job throws at the end so the queue retries the whole chunk. That is safe
 * because DuplicateDetectionService.processMediaItem is idempotent (the
 * embedding existence check and the union-find grouping make an already-done
 * item a no-op).
 *
 * CHUNK SIZE. The 100-id chunk was sized to stay under the old queue's 3-minute
 * stuck threshold, which no longer exists: the platform lease derives from this
 * profile's `maxRuntimeMs` (30 minutes). It stays 100: a chunk of 100 downloads
 * plus CLIP embeds runs in a few minutes on a small VPS, far inside the profile,
 * and a smaller retry unit re-does less work when one item fails. No profiling
 * data argues for a larger chunk.
 *
 * SERVER-ONLY (no node pair): one job spans 100 items, each with its own
 * download and its own KNN + grouping; the node-eligible unit of this work is
 * `duplicate_detection`. A circle that no longer exists settles the job as a
 * no-op.
 *
 * @stability experimental
 */
@Injectable()
export class DuplicateDetectionBatchHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'duplicate_detection_batch';

  /** The label in the admin job list. */
  readonly label = 'Duplicate detection (batch)';

  /** Up to 100 sequential downloads + embeds: a 30-minute ceiling. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 1_800_000, maxAttempts: 3 };

  private readonly logger = new Logger(DuplicateDetectionBatchHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
    private readonly duplicateDetectionService: DuplicateDetectionService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs one chunk of media item ids; throws at the end when any item failed so the queue retries the chunk. */
  async process(job: MemoriahubJob): Promise<void> {
    if (job.subjectType === 'circle') {
      const circleId = await resolveCircleJob(this.scopes, job, this.logger);
      if (!circleId) return;
    }

    const payload = (job.payload ?? null) as DuplicateDetectionBatchPayload | null;
    const mediaItemIds = Array.isArray(payload?.mediaItemIds)
      ? payload.mediaItemIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    if (mediaItemIds.length === 0) {
      this.logger.warn(`duplicate_detection_batch job ${job.id} has no mediaItemIds; skipping`);
      return;
    }

    let processed = 0;
    const failures: Array<{ id: string; error: string }> = [];

    for (const mediaItemId of mediaItemIds) {
      try {
        await this.duplicateDetectionService.processMediaItem(mediaItemId);
        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ id: mediaItemId, error: message });
        this.logger.warn(`duplicate_detection_batch job ${job.id}: item ${mediaItemId} failed: ${message}`);
      }
    }

    this.logger.log(
      `duplicate_detection_batch job ${job.id}: processed=${processed} failed=${failures.length} (chunk size ${mediaItemIds.length})`,
    );

    if (failures.length > 0) {
      throw new Error(
        `duplicate_detection_batch job ${job.id}: ${failures.length}/${mediaItemIds.length} item(s) failed: ` +
          failures.map((f) => `${f.id} (${f.error})`).join('; '),
      );
    }
  }
}
