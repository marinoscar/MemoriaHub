import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HOUSEKEEPING_PRIORITY, JobsService, type Job } from '@marinoscar/platform-api/jobs';
import {
  STORAGE_OBJECT_PROCESS_TYPE,
  STORAGE_OBJECT_SUBJECT_TYPE,
} from '@marinoscar/platform-api/storage';

import { STORAGE_PROCESSING_RECOVERY_REASON } from '../../app-registrations/system-access-reasons';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaSystemService } from '../../prisma/prisma-system.service';
import {
  RECOVERY_SCAN_BATCH,
  maxRetriesFromEnv,
  stuckMinutesFromEnv,
} from './storage-recovery.constants';

// =============================================================================
// StorageRecoveryService: the work of the recovery and reprocess jobs (RETRO-D1b, #567)
// =============================================================================
//
// Runs ONLY inside the `media.storage.recover_stuck` and `media.storage.reprocess`
// jobs (never in a cron, never in a request). Each scan is a keyset walk over
// `storage_objects` on the system client (the rows of every organization, reason
// `storage-processing-recovery`); per object it queues the platform's own
// `storage.object.process` job, in the object's organization, instead of running
// the processors inline. The processing job does the work, retries it, and marks
// a still-`processing` object `failed` when it gives up.
//
// The retry cap is unchanged: `metadata._processingRetryCount` is incremented
// BEFORE the processing job is queued, so a crash between the two still spends
// the attempt, and an object at `STORAGE_PROCESSING_MAX_RETRIES` is marked
// `failed` (`_processingRetryExhausted: true`) instead of re-queued.
// =============================================================================

/** What one recovery run did. `reprocessed` counts the processing jobs it queued. */
export interface StorageProcessingRecoveryResult {
  claimed: number;
  reprocessed: number;
  exhausted: number;
  errors: number;
}

/** What one bulk reprocess run did. `reprocessed` counts the processing jobs it queued. */
export interface StorageReprocessResult {
  reprocessed: number;
  failed: number;
}

/** The storage-object columns the scans read. */
const SCAN_SELECT = {
  id: true,
  orgId: true,
  metadata: true,
} as const;

type ScannedObject = { id: string; orgId: string; metadata: Prisma.JsonValue | null };

function metaOf(object: { metadata: Prisma.JsonValue | null }): Record<string, unknown> {
  const meta = object.metadata;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
}

@Injectable()
export class StorageRecoveryService {
  private readonly logger = new Logger(StorageRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly system: PrismaSystemService,
    private readonly jobs: JobsService,
  ) {}

  private get objects() {
    return this.system.asSystem(STORAGE_PROCESSING_RECOVERY_REASON).storageObject;
  }

  /**
   * Re-queues processing for objects orphaned at `processing` past the threshold
   * (default `STORAGE_PROCESSING_STUCK_MINUTES`). An object that still has a live
   * `storage.object.process` job is merely waiting in a busy queue and is left alone.
   */
  async recoverStuckObjects(olderThanMinutes?: number): Promise<StorageProcessingRecoveryResult> {
    const thresholdMinutes = olderThanMinutes ?? stuckMinutesFromEnv();
    const maxRetries = maxRetriesFromEnv();
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
    const result: StorageProcessingRecoveryResult = { claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 };

    let cursor: string | undefined;
    for (;;) {
      const page: ScannedObject[] = await this.objects.findMany({
        where: {
          status: 'processing',
          updatedAt: { lt: cutoff },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: SCAN_SELECT,
        orderBy: { id: 'asc' },
        take: RECOVERY_SCAN_BATCH,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;

      const candidates = await this.withoutLiveProcessingJob(page);
      result.claimed += candidates.length;
      for (const object of candidates) {
        try {
          await this.recoverOne(object, maxRetries, result);
        } catch (err) {
          result.errors++;
          this.logger.error(
            `recoverStuckObjects: could not recover object ${object.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (page.length < RECOVERY_SCAN_BATCH) break;
    }

    if (result.claimed > 0) {
      this.logger.log(
        `recoverStuckObjects: ${result.claimed} object(s) stuck past ${thresholdMinutes}m: ` +
          `${result.reprocessed} re-queued, ${result.exhausted} exhausted, ${result.errors} errors`,
      );
    }
    return result;
  }

  private async recoverOne(
    object: ScannedObject,
    maxRetries: number,
    result: StorageProcessingRecoveryResult,
  ): Promise<void> {
    const meta = metaOf(object);
    const retryCount = typeof meta['_processingRetryCount'] === 'number' ? (meta['_processingRetryCount'] as number) : 0;

    if (retryCount >= maxRetries) {
      await this.objects.update({
        where: { id: object.id },
        data: {
          status: 'failed',
          metadata: { ...meta, _processingRetryExhausted: true } as Prisma.InputJsonValue,
        },
      });
      result.exhausted++;
      this.logger.warn(
        `recoverStuckObjects: object ${object.id} exhausted ${retryCount} retries — marked failed, will not retry again`,
      );
      return;
    }

    // The counter is persisted BEFORE the job is queued: a crash between the two
    // still spends the attempt, so an object can never be re-queued for ever.
    // The write also bumps `updatedAt`, keeping the object off the next scan for
    // another threshold window.
    await this.objects.update({
      where: { id: object.id },
      data: { metadata: { ...meta, _processingRetryCount: retryCount + 1 } as Prisma.InputJsonValue },
    });
    await this.enqueueProcessing(object, { priority: 0, reason: 'rerun' });
    result.reprocessed++;
    this.logger.log(`recoverStuckObjects: re-queued object ${object.id} (attempt ${retryCount + 1}/${maxRetries})`);
  }

  /**
   * Re-queues processing for image objects that ended `failed` (a HEIC backlog,
   * issue #106). Thumbnails are excluded. Each object is reset to `processing`
   * with its retry bookkeeping cleared, as an upload would be; no retry cap
   * applies (an explicit request always gets a fresh attempt).
   */
  async recoverFailedImageObjects(opts: { limit?: number } = {}): Promise<StorageProcessingRecoveryResult> {
    const result: StorageProcessingRecoveryResult = { claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 };
    let cursor: string | undefined;
    for (;;) {
      const remaining = opts.limit === undefined ? RECOVERY_SCAN_BATCH : opts.limit - result.claimed;
      if (remaining <= 0) break;
      const take = Math.min(RECOVERY_SCAN_BATCH, remaining);
      const page: ScannedObject[] = await this.objects.findMany({
        where: {
          status: 'failed',
          mimeType: { startsWith: 'image/' },
          NOT: { storageKey: { startsWith: 'thumbnails/' } },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: SCAN_SELECT,
        orderBy: { id: 'asc' },
        take,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      result.claimed += page.length;

      for (const object of page) {
        try {
          const { _processingRetryCount, _processingRetryExhausted, ...rest } = metaOf(object);
          await this.objects.update({
            where: { id: object.id },
            data: { status: 'processing', metadata: rest as Prisma.InputJsonValue },
          });
          await this.enqueueProcessing(object, { priority: 0, reason: 'rerun' });
          result.reprocessed++;
        } catch (err) {
          result.errors++;
          this.logger.error(
            `recoverFailedImageObjects: could not re-queue object ${object.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (page.length < take) break;
    }

    if (result.claimed > 0) {
      this.logger.log(
        `recoverFailedImageObjects: ${result.reprocessed}/${result.claimed} failed image object(s) re-queued (${result.errors} errors)`,
      );
    }
    return result;
  }

  /**
   * Re-queues processing for the ready/failed image and video objects behind the
   * live media items of one circle, or of every circle. The objects keep their
   * status (they stay usable while they wait); the queued run rewrites it.
   * Background priority: an upload is always claimed first.
   */
  async reprocessMediaObjects(circleId?: string): Promise<StorageReprocessResult> {
    const result: StorageReprocessResult = { reprocessed: 0, failed: 0 };
    let cursor: string | undefined;
    for (;;) {
      // `media_items` carries no row-level security: the main client reads it.
      const items = await this.prisma.mediaItem.findMany({
        where: {
          deletedAt: null,
          ...(circleId ? { circleId } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, storageObjectId: true },
        orderBy: { id: 'asc' },
        take: RECOVERY_SCAN_BATCH,
      });
      if (items.length === 0) break;
      cursor = items[items.length - 1].id;

      const ids = [...new Set(items.map((item) => item.storageObjectId))];
      const objects: ScannedObject[] = await this.objects.findMany({
        where: {
          id: { in: ids },
          status: { in: ['ready', 'failed'] },
          OR: [{ mimeType: { startsWith: 'image/' } }, { mimeType: { startsWith: 'video/' } }],
          NOT: { storageKey: { startsWith: 'thumbnails/' } },
        },
        select: SCAN_SELECT,
      });
      for (const object of objects) {
        try {
          await this.enqueueProcessing(object, { priority: HOUSEKEEPING_PRIORITY, reason: 'backfill' });
          result.reprocessed++;
        } catch (err) {
          result.failed++;
          this.logger.error(
            `reprocessMediaObjects: could not queue object ${object.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (items.length < RECOVERY_SCAN_BATCH) break;
    }

    this.logger.log(
      `reprocessMediaObjects: queued ${result.reprocessed} object(s) (${result.failed} failed, circleId=${circleId ?? 'all'})`,
    );
    return result;
  }

  /**
   * Queues the platform's `storage.object.process` job for one object, in its
   * organization, with the payload the storage slice's own upload path writes.
   * Dedup is by subject: an object already queued keeps its one job.
   */
  private enqueueProcessing(
    object: { id: string; orgId: string },
    opts: { priority: number; reason: 'rerun' | 'backfill' },
  ): Promise<Job> {
    return this.jobs.enqueue({
      type: STORAGE_OBJECT_PROCESS_TYPE,
      reason: opts.reason,
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: object.id,
      payload: { objectId: object.id, orgId: object.orgId },
      orgId: object.orgId,
      priority: opts.priority,
    });
  }

  /** `objects` minus those with a pending or running `storage.object.process` job. */
  private async withoutLiveProcessingJob<T extends { id: string }>(objects: T[]): Promise<T[]> {
    if (objects.length === 0) return objects;
    // `jobs` has no row-level security: the main client reads it.
    const live = await this.prisma.job.findMany({
      where: {
        type: STORAGE_OBJECT_PROCESS_TYPE,
        status: { in: ['pending', 'running'] },
        subjectId: { in: objects.map((object) => object.id) },
      },
      select: { subjectId: true },
    });
    const queued = new Set(live.map((job) => job.subjectId));
    return objects.filter((object) => !queued.has(object.id));
  }
}
