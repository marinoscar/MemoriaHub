// =============================================================================
// Review Run History Purge Enrichment Handler (issue #190)
// =============================================================================
//
// Global, server-only enrichment job (mediaItemId/circleId null) that keeps the
// two run-tracking tables from growing without bound and — more importantly —
// unblocks circles wedged behind a dead run. It does two things in one pass,
// over BOTH `review_runs` and `trash_empty_runs`:
//
//   (a) STALE-RUN SWEEP. A run stuck non-terminal (`evaluating` / `running`)
//       whose `updatedAt` has not moved for > STALE_RUN_HOURS is marked
//       `failed` with an explanatory `lastError`. This is NOT cosmetic: both
//       run models enforce a per-circle (per-queue) concurrency guard that
//       rejects a new run with 409 while an active one exists, so a run whose
//       jobs all died permanently LOCKS that circle's queue with no user-facing
//       way out. Sweeping it to a terminal status is the lockout fix. Served by
//       the `(status, updatedAt)` index both tables carry.
//
//   (b) RETENTION PURGE. Terminal runs (`completed`, `completed_with_errors`,
//       `failed`, `cancelled`) whose `finishedAt` — falling back to `updatedAt`
//       when null — is older than `reviewRuns.runHistoryRetentionDays` are
//       hard-deleted in bounded batches. Run ITEMS are never deleted directly:
//       `review_run_items` / `trash_empty_run_items` cascade from their parent
//       run's FK. Non-terminal runs are never deleted at any age.
//
// Ordering matters: the stale sweep runs FIRST so a run it just failed becomes
// eligible for retention deletion in the very same pass once old enough.
//
// Batching mirrors JobHistoryPurgeHandler (5,000-row batches) so each DELETE
// stays short and never holds locks long enough to stall the worker's row
// claims. Runs via the shared enrichment worker queue (retries, visibility in
// /admin/jobs, dedup on `(type, mediaItemId IS NULL)`).
//
// Server-only BY OMISSION — no nodeResultSchema / persistNodeResult. Purging
// run history is a pure SQL sweep with no per-item unit of work for a node,
// the same precedent as job_history_purge / workflow_history_purge.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  EnrichmentJob,
  Prisma,
  ReviewRunStatus,
  TrashEmptyRunStatus,
} from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/** Fallback when `reviewRuns.runHistoryRetentionDays` is unset. */
const DEFAULT_RETENTION_DAYS = 30;

/** Rows deleted per batch — same bound as JobHistoryPurgeHandler. */
const BATCH_SIZE = 5000;

/**
 * Hours of `updatedAt` silence after which a non-terminal run is presumed dead.
 * Generous relative to any legitimate run: an active run's counters are bumped
 * by every execute-batch job, so a whole day of no movement means every one of
 * its jobs has permanently failed.
 */
const STALE_RUN_HOURS = 24;

const STALE_RUN_ERROR =
  'Run swept as stale: no progress for over 24h — every job for this run had ' +
  'permanently failed. Marked failed automatically so the queue is not blocked.';

/** Terminal ReviewRun statuses eligible for retention deletion. */
const TERMINAL_REVIEW_RUN_STATUSES: ReviewRunStatus[] = [
  ReviewRunStatus.completed,
  ReviewRunStatus.completed_with_errors,
  ReviewRunStatus.failed,
  ReviewRunStatus.cancelled,
];

/** Non-terminal ReviewRun statuses eligible for the stale sweep. */
const ACTIVE_REVIEW_RUN_STATUSES: ReviewRunStatus[] = [
  ReviewRunStatus.evaluating,
  ReviewRunStatus.running,
];

/** Terminal TrashEmptyRun statuses eligible for retention deletion. */
const TERMINAL_TRASH_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TrashEmptyRunStatus.completed,
  TrashEmptyRunStatus.completed_with_errors,
  TrashEmptyRunStatus.failed,
  TrashEmptyRunStatus.cancelled,
];

/** Non-terminal TrashEmptyRun statuses eligible for the stale sweep. */
const ACTIVE_TRASH_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TrashEmptyRunStatus.evaluating,
  TrashEmptyRunStatus.running,
];

@Injectable()
export class ReviewRunHistoryPurgeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'review_run_history_purge';

  private readonly logger = new Logger(ReviewRunHistoryPurgeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    const retentionDays =
      (await this.systemSettings.getSettingValue<number>(
        'reviewRuns.runHistoryRetentionDays',
      )) ?? DEFAULT_RETENTION_DAYS;

    const now = Date.now();
    const staleCutoff = new Date(now - STALE_RUN_HOURS * 3_600_000);
    const retentionCutoff = new Date(now - retentionDays * 86_400_000);

    this.logger.log(
      `review_run_history_purge: starting — retentionDays=${retentionDays}, ` +
        `retentionCutoff=${retentionCutoff.toISOString()}, staleCutoff=${staleCutoff.toISOString()}`,
    );

    // -----------------------------------------------------------------------
    // (a) Stale-run sweep — unblocks the per-circle concurrency guard.
    // -----------------------------------------------------------------------
    const sweptAt = new Date();

    const staleReviewRuns = await this.prisma.reviewRun.updateMany({
      where: {
        status: { in: ACTIVE_REVIEW_RUN_STATUSES },
        updatedAt: { lt: staleCutoff },
      },
      data: {
        status: ReviewRunStatus.failed,
        lastError: STALE_RUN_ERROR,
        finishedAt: sweptAt,
      },
    });

    const staleTrashRuns = await this.prisma.trashEmptyRun.updateMany({
      where: {
        status: { in: ACTIVE_TRASH_RUN_STATUSES },
        updatedAt: { lt: staleCutoff },
      },
      data: {
        status: TrashEmptyRunStatus.failed,
        lastError: STALE_RUN_ERROR,
        finishedAt: sweptAt,
      },
    });

    if (staleReviewRuns.count > 0 || staleTrashRuns.count > 0) {
      this.logger.warn(
        `review_run_history_purge: swept ${staleReviewRuns.count} stale review run(s) and ` +
          `${staleTrashRuns.count} stale trash-empty run(s) to failed`,
      );
    }

    // -----------------------------------------------------------------------
    // (b) Retention purge — items cascade with their run.
    // -----------------------------------------------------------------------
    const reviewWhere: Prisma.ReviewRunWhereInput = {
      status: { in: TERMINAL_REVIEW_RUN_STATUSES },
      OR: [
        { finishedAt: { lt: retentionCutoff } },
        { finishedAt: null, updatedAt: { lt: retentionCutoff } },
      ],
    };

    const trashWhere: Prisma.TrashEmptyRunWhereInput = {
      status: { in: TERMINAL_TRASH_RUN_STATUSES },
      OR: [
        { finishedAt: { lt: retentionCutoff } },
        { finishedAt: null, updatedAt: { lt: retentionCutoff } },
      ],
    };

    const deletedReviewRuns = await this.purgeInBatches(
      () => this.prisma.reviewRun.findMany({ where: reviewWhere, select: { id: true }, take: BATCH_SIZE }),
      (ids) => this.prisma.reviewRun.deleteMany({ where: { id: { in: ids } } }),
    );

    const deletedTrashRuns = await this.purgeInBatches(
      () =>
        this.prisma.trashEmptyRun.findMany({
          where: trashWhere,
          select: { id: true },
          take: BATCH_SIZE,
        }),
      (ids) => this.prisma.trashEmptyRun.deleteMany({ where: { id: { in: ids } } }),
    );

    this.logger.log(
      `review_run_history_purge: deleted ${deletedReviewRuns} review run(s) and ` +
        `${deletedTrashRuns} trash-empty run(s) past cutoff (items cascaded)`,
    );
  }

  /**
   * Lock-safe batched delete: select a bounded id set, delete it, repeat until
   * a short batch signals the eligible set is exhausted.
   */
  private async purgeInBatches(
    selectBatch: () => Promise<Array<{ id: string }>>,
    deleteBatch: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> {
    let totalDeleted = 0;

    for (;;) {
      const batch = await selectBatch();
      if (batch.length === 0) break;

      const result = await deleteBatch(batch.map((b) => b.id));
      totalDeleted += result.count;

      if (batch.length < BATCH_SIZE) break;
    }

    return totalDeleted;
  }
}
