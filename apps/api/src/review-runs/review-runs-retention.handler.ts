import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import {
  JobHandlerRegistry,
  runRetentionPolicyPurge,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { Prisma, ReviewRunStatus, TrashEmptyRunStatus } from '@prisma/client';

import { readRetentionPolicy } from '../platform/jobs/run-engine-jobs';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  REVIEW_RUNS_PURGE_TYPE,
  REVIEW_RUNS_RETENTION_KEY,
  REVIEW_RUNS_RETENTION_POLICY,
} from './review-runs.retention';

/**
 * Hours of `updatedAt` silence after which a non-terminal run is presumed dead.
 * Generous relative to any legitimate run: an active run's counters are bumped
 * by every execute-batch job, so a whole day of no movement means every one of
 * its jobs has permanently failed.
 */
export const STALE_RUN_HOURS = 24;

export const STALE_RUN_ERROR =
  'Run swept as stale: no progress for over 24h — every job for this run had ' +
  'permanently failed. Marked failed automatically so the queue is not blocked.';

const TERMINAL_REVIEW_RUN_STATUSES: ReviewRunStatus[] = [
  ReviewRunStatus.completed,
  ReviewRunStatus.completed_with_errors,
  ReviewRunStatus.failed,
  ReviewRunStatus.cancelled,
];

const ACTIVE_REVIEW_RUN_STATUSES: ReviewRunStatus[] = [ReviewRunStatus.evaluating, ReviewRunStatus.running];

const TERMINAL_TRASH_RUN_STATUSES: TrashEmptyRunStatus[] = [
  TrashEmptyRunStatus.completed,
  TrashEmptyRunStatus.completed_with_errors,
  TrashEmptyRunStatus.failed,
  TrashEmptyRunStatus.cancelled,
];

const ACTIVE_TRASH_RUN_STATUSES: TrashEmptyRunStatus[] = [TrashEmptyRunStatus.evaluating, TrashEmptyRunStatus.running];

/** Terminal review runs finished (or, with no `finishedAt`, last touched) before `cutoff`. */
export function reviewRunsPurgeWhere(cutoff: Date): Prisma.ReviewRunWhereInput {
  return {
    status: { in: TERMINAL_REVIEW_RUN_STATUSES },
    OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, updatedAt: { lt: cutoff } }],
  };
}

/** The same rule for `trash_empty_runs`. */
export function trashEmptyRunsPurgeWhere(cutoff: Date): Prisma.TrashEmptyRunWhereInput {
  return {
    status: { in: TERMINAL_TRASH_RUN_STATUSES },
    OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, updatedAt: { lt: cutoff } }],
  };
}

/**
 * The `retention.reviewRuns` purge (RETRO-C7, #604): the native successor of the
 * old `review_run_history_purge` handler and its nightly task, under the same
 * permanent type string. Over BOTH `review_runs` and `trash_empty_runs`:
 *
 *   (a) STALE-RUN SWEEP — a run stuck `evaluating`/`running` whose `updatedAt`
 *       has not moved for over 24 hours is marked `failed`. Not cosmetic: both
 *       run models refuse a new run of the same circle (and queue) with 409 while
 *       an active one exists, so a run whose jobs all died locks that queue.
 *       Runs first and whatever the retention switch says, so a run it fails is
 *       eligible for deletion in the same pass once old enough.
 *   (b) RETENTION — two `runRetentionPolicyPurge` loops (review runs, then
 *       empty-trash runs) delete terminal runs older than
 *       `retention.reviewRuns.days` in 5 000-id batches; items cascade. A logged
 *       no-op while the policy is disabled.
 *
 * SERVER-ONLY (no node-result pair).
 */
@Injectable()
export class ReviewRunsRetentionHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(ReviewRunsRetentionHandler.name);

  readonly type = REVIEW_RUNS_PURGE_TYPE;

  readonly label = 'Review run history purge';

  /** Deletes only; thirty minutes covers millions of rows. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 1_800_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
    // App metrics (RETRO-T3, #628): `app.runs.finished{outcome=failed}` for swept runs. Optional for hand-built tests.
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.sweepStaleRuns();

    const policy = await readRetentionPolicy(this.systemSettings, REVIEW_RUNS_RETENTION_POLICY);
    const setting = `retention.${REVIEW_RUNS_RETENTION_KEY}`;

    await runRetentionPolicyPurge({
      job,
      logger: this.logger,
      policy,
      setting,
      what: 'review run history purge',
      rows: 'review run(s)',
      selectIds: async (cutoff, take) =>
        (
          await this.prisma.reviewRun.findMany({
            where: reviewRunsPurgeWhere(cutoff),
            select: { id: true },
            orderBy: { updatedAt: 'asc' },
            take,
          })
        ).map((row) => row.id),
      deleteIds: async (ids) => (await this.prisma.reviewRun.deleteMany({ where: { id: { in: ids } } })).count,
    });

    await runRetentionPolicyPurge({
      job,
      logger: this.logger,
      policy,
      setting,
      what: 'empty-trash run history purge',
      rows: 'empty-trash run(s)',
      selectIds: async (cutoff, take) =>
        (
          await this.prisma.trashEmptyRun.findMany({
            where: trashEmptyRunsPurgeWhere(cutoff),
            select: { id: true },
            orderBy: { updatedAt: 'asc' },
            take,
          })
        ).map((row) => row.id),
      deleteIds: async (ids) => (await this.prisma.trashEmptyRun.deleteMany({ where: { id: { in: ids } } })).count,
    });
  }

  /** (a) Fails review and empty-trash runs with no progress for over {@link STALE_RUN_HOURS}. */
  async sweepStaleRuns(now: number = Date.now()): Promise<{ reviewRuns: number; trashEmptyRuns: number }> {
    const staleCutoff = new Date(now - STALE_RUN_HOURS * 3_600_000);
    const sweptAt = new Date(now);

    const review = await this.prisma.reviewRun.updateMany({
      where: { status: { in: ACTIVE_REVIEW_RUN_STATUSES }, updatedAt: { lt: staleCutoff } },
      data: { status: ReviewRunStatus.failed, lastError: STALE_RUN_ERROR, finishedAt: sweptAt },
    });
    const trash = await this.prisma.trashEmptyRun.updateMany({
      where: { status: { in: ACTIVE_TRASH_RUN_STATUSES }, updatedAt: { lt: staleCutoff } },
      data: { status: TrashEmptyRunStatus.failed, lastError: STALE_RUN_ERROR, finishedAt: sweptAt },
    });

    if (review.count > 0 || trash.count > 0) {
      this.metrics?.add('runsFinished', review.count, { engine: 'review', outcome: 'failed' });
      this.metrics?.add('runsFinished', trash.count, { engine: 'trash_empty', outcome: 'failed' });
      this.logger.warn(
        `${this.type}: swept ${review.count} stale review run(s) and ` +
          `${trash.count} stale empty-trash run(s) to failed`,
      );
    }
    return { reviewRuns: review.count, trashEmptyRuns: trash.count };
  }
}
