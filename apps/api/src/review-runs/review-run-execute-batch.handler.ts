import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  EnrichmentJob,
  Prisma,
  ReviewRunItemStatus,
  ReviewRunStatus,
} from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import { createExecutionContext } from './review-run-subject.strategy';
import { subjectIdOf } from './review-run.service';

/** Payload shape for a `review_run_execute_batch` job. */
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
 * SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` node pair.
 */
@Injectable()
export class ReviewRunExecuteBatchHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'review_run_execute_batch';

  private readonly logger = new Logger(ReviewRunExecuteBatchHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly subjects: ReviewRunSubjectRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as ReviewRunExecuteBatchPayload | null;
    if (!payload?.runId || !Array.isArray(payload.subjectIds)) {
      this.logger.warn(`review_run_execute_batch job ${job.id} missing payload; skipping`);
      return;
    }
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

  /**
   * Public so the deprecated `location_suggestion_run_execute_batch` shim can
   * delegate an already-normalized payload without fabricating a job row.
   */
  async executeBatch(payload: ReviewRunExecuteBatchPayload): Promise<void> {
    const { runId, subjectIds } = payload;

    const run = await this.prisma.reviewRun.findUnique({ where: { id: runId } });
    if (!run) return; // run gone → nothing to do
    // Cooperative cancellation: a cancelled run stops all not-yet-started batches.
    if (run.status === ReviewRunStatus.cancelled) return;

    const strategy = this.subjects.get(run.subjectType);
    const column = strategy.subjectColumn;
    const batchWhere = { runId, [column]: { in: subjectIds } } as Prisma.ReviewRunItemWhereInput;

    // Claim: flip still-'matched' items to 'processing' in one atomic updateMany.
    await this.prisma.reviewRunItem.updateMany({
      where: { ...batchWhere, status: ReviewRunItemStatus.matched },
      data: { status: ReviewRunItemStatus.processing },
    });

    // Read back every row now 'processing' for this batch — includes rows claimed
    // by a PRIOR attempt that crashed before finishing, so a retry re-processes
    // them. Do NOT rely on the claim count for tallying; use this work set.
    const workRows = await this.prisma.reviewRunItem.findMany({
      where: { ...batchWhere, status: ReviewRunItemStatus.processing },
      select: {
        id: true,
        burstGroupId: true,
        duplicateGroupId: true,
        locationSuggestionId: true,
      },
    });

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
                ? ReviewRunItemStatus.applied
                : ReviewRunItemStatus.skipped,
          },
        });
        if (outcome === 'applied') appliedTally++;
        else skippedTally++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.reviewRunItem
          .update({
            where: { id: row.id },
            data: { status: ReviewRunItemStatus.failed, error: message },
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
        status: { in: [ReviewRunItemStatus.matched, ReviewRunItemStatus.processing] },
      },
    });
    if (remaining > 0) return;

    const run = await this.prisma.reviewRun.findUnique({
      where: { id: runId },
      select: { failedCount: true },
    });
    const finalStatus =
      (run?.failedCount ?? 0) > 0
        ? ReviewRunStatus.completed_with_errors
        : ReviewRunStatus.completed;

    const fin = await this.prisma.reviewRun.updateMany({
      where: { id: runId, status: ReviewRunStatus.running },
      data: { status: finalStatus, finishedAt: new Date() },
    });

    if (fin.count > 0) {
      this.logger.log({
        event: 'review_run.finalized',
        runId,
        status: finalStatus,
        failedCount: run?.failedCount ?? 0,
      });
    }
  }
}
