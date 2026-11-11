import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { runJobPayload, vetoDeleteWhileRunActive, type MemoriahubRunJobInput } from '../core/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
} from '../ports/index.js';
import type { ReviewRunsDb } from './data/review-runs-db.js';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry.js';
import { createExecutionContext } from './review-run-subject.strategy.js';
import { subjectIdOf } from './review-run.service.js';
import { REVIEW_RUN_ITEM_STATUS, REVIEW_RUN_STATUS, type ReviewRunRow } from './review-runs.constants.js';

/**
 * Payload shape for a `review_run_execute_batch` job.
 *
 * @stability experimental
 */
export interface ReviewRunExecuteBatchPayload {
  runId: string;
  subjectIds: string[];
}

/** OTEL tracer for the shared review-run compute path. */
const tracer = trace.getTracer('review-run');

/**
 * Shared review-run batch execution handler (issue #190).
 *
 * Applies the run's action to one chunk of matched subjects. Because applying an
 * action does NOT (in general) delete the run-item row, a transient 'processing'
 * claim marker keeps retries crash-safe without double-counting:
 *   - Cooperative cancellation: bail before doing any work if the run is cancelled.
 *   - Claim: flip still-'matched' items to 'processing' in ONE updateMany.
 *   - Read back every row now 'processing' for this batch (includes rows left
 *     'processing' by a prior crashed attempt) — that is this attempt's work set.
 *   - Per item: delegate to the strategy, transitioning the run-item
 *     processing → applied / skipped / failed exactly once.
 *   - Fire the strategy's deferred effects once, AFTER every per-item
 *     transaction has committed.
 *   - Atomic counters ({ increment }) and a race-safe finalize (updateMany guarded
 *     on status='running', so only the last batch to drain wins).
 *
 * A subject that was cascade-deleted mid-run takes its run-item row with it, so
 * it simply drops out of the work set — finalize keys off "no rows remain in
 * matched/processing", never on processedCount === matchedCount.
 *
 * SERVER-ONLY by omission: no
 * `nodeResultSchema` / `persistNodeResult` node pair (resolving a group calls
 * the archive/trash services, which need the database). `canDelete` refuses to
 * delete a pending batch of a run that is still `running`.
 *
 * @stability experimental
 */
@Injectable()
export class ReviewRunExecuteBatchHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'review_run_execute_batch';

  readonly label = 'Review run execute batch';

  /** 200 subjects, each one short transaction: 10 minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 600_000, maxAttempts: 3 };

  private readonly logger = new Logger(ReviewRunExecuteBatchHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: ReviewRunsDb,
    private readonly subjects: ReviewRunSubjectRegistry,
    // App metrics (RETRO-T3, #628): `app.runs.finished` / `app.runs.items` (engine `review`). Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubRunJobInput): Promise<void> {
    const raw = runJobPayload<ReviewRunExecuteBatchPayload>(job);
    if (typeof raw?.runId !== 'string' || raw.runId === '' || !Array.isArray(raw.subjectIds)) {
      this.logger.warn(`review_run_execute_batch job ${job.id} missing payload; skipping`);
      return;
    }
    const payload: ReviewRunExecuteBatchPayload = { runId: raw.runId, subjectIds: raw.subjectIds };
    await tracer.startActiveSpan(
      'review_run.execute_batch',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'review_run.run_id': payload.runId,
          'review_run.batch_size': payload.subjectIds.length,
        },
      },
      async (span) => {
        try {
          await this.executeBatch(payload);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Refuses to delete a pending batch of a run that is still running. */
  canDelete(job: MemoriahubJob): Promise<string | null> {
    return vetoDeleteWhileRunActive(job, {
      engine: 'review run',
      activeStatuses: [REVIEW_RUN_STATUS.running],
      readRunStatus: async (runId) =>
        ((await this.prisma.reviewRun.findUnique({ where: { id: runId }, select: { status: true } })) as { status: string } | null)
          ?.status ?? null,
    });
  }

  /**
   * Public so the deprecated `location_suggestion_run_execute_batch` shim can
   * delegate an already-normalized payload without fabricating a job row.
   */
  async executeBatch(payload: ReviewRunExecuteBatchPayload): Promise<void> {
    const { runId, subjectIds } = payload;

    const run = (await this.prisma.reviewRun.findUnique({ where: { id: runId } })) as ReviewRunRow | null;
    if (!run) return; // run gone → nothing to do
    // Cooperative cancellation: a cancelled run stops all not-yet-started batches.
    if (run.status === REVIEW_RUN_STATUS.cancelled) return;

    const strategy = this.subjects.get(run.subjectType);
    const column = strategy.subjectColumn;
    const batchWhere: Record<string, unknown> = { runId, [column]: { in: subjectIds } };

    // Claim: flip still-'matched' items to 'processing' in one atomic updateMany.
    await this.prisma.reviewRunItem.updateMany({
      where: { ...batchWhere, status: REVIEW_RUN_ITEM_STATUS.matched },
      data: { status: REVIEW_RUN_ITEM_STATUS.processing },
    });

    // Read back every row now 'processing' for this batch — includes rows claimed
    // by a PRIOR attempt that crashed before finishing, so a retry re-processes
    // them. Do NOT rely on the claim count for tallying; use this work set.
    const workRows = (await this.prisma.reviewRunItem.findMany({
      where: { ...batchWhere, status: REVIEW_RUN_ITEM_STATUS.processing },
      select: {
        id: true,
        burstGroupId: true,
        duplicateGroupId: true,
        locationSuggestionId: true,
      },
    })) as Array<{ id: string; burstGroupId: string | null; duplicateGroupId: string | null; locationSuggestionId: string | null }>;

    if (workRows.length === 0) {
      await this.maybeFinalizeRun(runId);
      return;
    }

    const ctx = createExecutionContext();

    let appliedTally = 0;
    let skippedTally = 0;
    let failedTally = 0;

    for (const row of workRows) {
      const subjectId = subjectIdOf(row, column);
      if (!subjectId) continue; // defensive — the CHECK constraints make this unreachable

      try {
        const outcome = await strategy.executeItem(run, subjectId, ctx);
        await this.prisma.reviewRunItem.update({
          where: { id: row.id },
          data: {
            status:
              outcome === 'applied'
                ? REVIEW_RUN_ITEM_STATUS.applied
                : REVIEW_RUN_ITEM_STATUS.skipped,
          },
        });
        if (outcome === 'applied') appliedTally++;
        else skippedTally++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.reviewRunItem
          .update({
            where: { id: row.id },
            data: { status: REVIEW_RUN_ITEM_STATUS.failed, error: message },
          })
          .catch(() => undefined);
        failedTally++;
      }
    }

    // Follow-up enqueues, fired once per batch AFTER every per-item transaction
    // has committed. Best-effort: never fail the batch on a follow-up failure.
    if (strategy.deferredEffects) {
      await strategy.deferredEffects(run, ctx).catch((err) =>
        this.logger.warn(
          `review_run ${runId} deferred effects failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }

    // Atomic counter increments for the items processed this attempt. Each row
    // leaves 'processing' exactly once (the work set only contains rows currently
    // 'processing'), so there is no double counting across retries.
    const processedThisAttempt = appliedTally + skippedTally + failedTally;
    if (processedThisAttempt > 0) {
      await this.prisma.reviewRun.update({
        where: { id: runId },
        data: {
          processedCount: { increment: processedThisAttempt },
          succeededCount: { increment: appliedTally },
          skippedCount: { increment: skippedTally },
          failedCount: { increment: failedTally },
        },
      });
      this.metrics?.add('runItems', appliedTally, { engine: 'review', outcome: 'applied' });
      this.metrics?.add('runItems', skippedTally, { engine: 'review', outcome: 'skipped' });
      this.metrics?.add('runItems', failedTally, { engine: 'review', outcome: 'failed' });
    }

    await this.maybeFinalizeRun(runId);
  }

  /**
   * Finalize the run once every item has left 'matched' AND 'processing'.
   * Race-safe: the transition is a conditional updateMany on status='running',
   * so only ONE batch (the last to drain the queue) wins.
   */
  private async maybeFinalizeRun(runId: string): Promise<void> {
    const remaining = await this.prisma.reviewRunItem.count({
      where: {
        runId,
        status: { in: [REVIEW_RUN_ITEM_STATUS.matched, REVIEW_RUN_ITEM_STATUS.processing] },
      },
    });
    if (remaining > 0) return;

    const run = (await this.prisma.reviewRun.findUnique({
      where: { id: runId },
      select: { failedCount: true },
    })) as { failedCount: number } | null;
    const finalStatus =
      (run?.failedCount ?? 0) > 0
        ? REVIEW_RUN_STATUS.completed_with_errors
        : REVIEW_RUN_STATUS.completed;

    const fin = await this.prisma.reviewRun.updateMany({
      where: { id: runId, status: REVIEW_RUN_STATUS.running },
      data: { status: finalStatus, finishedAt: new Date() },
    });

    if (fin.count > 0) {
      this.metrics?.add('runsFinished', 1, { engine: 'review', outcome: finalStatus });
      this.logger.log({
        event: 'review_run.finalized',
        runId,
        status: finalStatus,
        failedCount: run?.failedCount ?? 0,
      });
    }
  }
}
