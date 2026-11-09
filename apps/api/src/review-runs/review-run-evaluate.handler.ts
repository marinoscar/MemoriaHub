import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  Prisma,
  ReviewRun,
  ReviewRunItemStatus,
  ReviewRunStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewRunService } from './review-run.service';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import { ReviewRunCursor } from './review-run-subject.strategy';
import {
  runJobPayload,
  vetoDeleteWhileRunActive,
  type RunJobInput,
} from '../platform/jobs/run-engine-jobs';

/** Payload shape for a `review_run_evaluate` job. */
export interface ReviewRunEvaluatePayload {
  runId: string;
}

/** Keyset page size for streaming the eligible-subject scan. */
const PAGE_SIZE = 1000;

/** OTEL tracer for the shared review-run compute path. */
const tracer = trace.getTracer('review-run');

/**
 * Shared review-run evaluation handler (issue #190).
 *
 * Materializes a run's matched set into `review_run_items` (status 'matched')
 * via constant-memory keyset pagination, streaming each page straight into the
 * DB. Which subjects are eligible — and in what order — is entirely the
 * strategy's business (`evaluatePage`); this handler only pages, writes and
 * transitions:
 *   - 0 matches → completed
 *   - otherwise → running (+ enqueues chunked execute-batch jobs)
 *
 * `createMany({ skipDuplicates: true })` leans on the per-subject partial unique
 * indexes on `review_run_items`, so a retried attempt re-materializes
 * idempotently rather than double-counting.
 *
 * A native platform `JobHandler` (RETRO-C7, #604). SERVER-ONLY by omission: no
 * `nodeResultSchema` / `persistNodeResult` pair, so the platform registry
 * derives it server-only and the `system` worker mode runs it. `canDelete`
 * refuses to delete a pending job of a run still `evaluating`.
 *
 * `process` takes the structural `RunJobInput` rather than `Job` so the
 * deprecated `location_suggestion_run_evaluate` shim (RETRO-C6) can keep
 * delegating its legacy row unchanged.
 */
@Injectable()
export class ReviewRunEvaluateHandler implements JobHandler, OnModuleInit {
  readonly type = 'review_run_evaluate';

  readonly label = 'Review run evaluate';

  /** A keyset scan over one circle's review queue: 15 minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(ReviewRunEvaluateHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runService: ReviewRunService,
    private readonly subjects: ReviewRunSubjectRegistry,
    // App metrics (RETRO-T3, #628): `app.runs.finished{engine=review}`. Optional for hand-built tests.
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: RunJobInput): Promise<void> {
    const payload = runJobPayload<ReviewRunEvaluatePayload>(job);
    if (!payload?.runId) {
      this.logger.warn(`review_run_evaluate job ${job.id} missing runId payload; skipping`);
      return;
    }
    const runId = payload.runId;

    const run = await this.prisma.reviewRun.findUnique({ where: { id: runId } });
    // Idempotent no-op: run gone, or already past evaluation.
    if (!run || run.status !== ReviewRunStatus.evaluating) return;

    await tracer.startActiveSpan(
      'review_run.evaluate',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'review_run.run_id': run.id,
          'review_run.circle_id': run.circleId,
          'review_run.subject_type': run.subjectType,
          'review_run.action': run.action,
        },
      },
      async (span) => {
        try {
          await this.runEvaluation(job, run);
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

  /** Refuses to delete a pending job whose run is still being evaluated. */
  canDelete(job: Job): Promise<string | null> {
    return vetoDeleteWhileRunActive(job, {
      engine: 'review run',
      activeStatuses: [ReviewRunStatus.evaluating],
      readRunStatus: async (runId) =>
        (await this.prisma.reviewRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status ??
        null,
    });
  }

  private async runEvaluation(job: RunJobInput, run: ReviewRun): Promise<void> {
    const runId = run.id;
    const strategy = this.subjects.get(run.subjectType);

    try {
      let accepted = 0;
      let cursor: ReviewRunCursor | null = null;

      for (;;) {
        const page = await strategy.evaluatePage(run, cursor, PAGE_SIZE);
        if (page.subjectIds.length === 0) break;

        await this.prisma.reviewRunItem.createMany({
          data: page.subjectIds.map(
            (subjectId) =>
              ({
                runId,
                subjectType: run.subjectType,
                [strategy.subjectColumn]: subjectId,
                status: ReviewRunItemStatus.matched,
              }) as Prisma.ReviewRunItemCreateManyInput,
          ),
          skipDuplicates: true,
        });
        accepted += page.subjectIds.length;

        cursor = page.nextCursor;
        // Short page or an exhausted cursor both mean "no more rows".
        if (page.subjectIds.length < PAGE_SIZE || cursor === null) break;
      }

      await this.prisma.reviewRun.update({
        where: { id: runId },
        data: { matchedCount: accepted },
      });

      if (accepted === 0) {
        await this.prisma.reviewRun.update({
          where: { id: runId },
          data: { status: ReviewRunStatus.completed, finishedAt: new Date() },
        });
        this.metrics?.add('runsFinished', 1, { engine: 'review', outcome: 'completed' });
        this.logTransition(run, ReviewRunStatus.completed, { matchedCount: 0 });
        return;
      }

      await this.prisma.reviewRun.update({
        where: { id: runId },
        data: { status: ReviewRunStatus.running, startedAt: new Date() },
      });
      await this.runService.enqueueExecuteBatches(runId, run.circleId, run.subjectType);
      this.logTransition(run, ReviewRunStatus.running, { matchedCount: accepted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark the run terminally failed only once the job has exhausted its normal
      // retries (attempts is charged at claim time). Intermediate attempts leave
      // the run 'evaluating' and re-materialize idempotently via createMany
      // skipDuplicates. Then rethrow so the job itself fails/retries too.
      if (job.attempts >= this.maxAttempts()) {
        await this.prisma.reviewRun
          .update({
            where: { id: runId },
            data: {
              status: ReviewRunStatus.failed,
              lastError: message,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        this.metrics?.add('runsFinished', 1, { engine: 'review', outcome: 'failed' });
        this.logTransition(run, ReviewRunStatus.failed, { error: message });
      }
      throw err;
    }
  }

  private maxAttempts(): number {
    return this.profile.maxAttempts;
  }

  private logTransition(
    run: ReviewRun,
    toStatus: ReviewRunStatus,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log({
      event: 'review_run.evaluated',
      runId: run.id,
      circleId: run.circleId,
      subjectType: run.subjectType,
      status: toStatus,
      ...extra,
    });
  }
}
