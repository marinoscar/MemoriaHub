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
import { ReviewRunService } from './review-run.service.js';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry.js';
import type { ReviewRunCursor } from './review-run-subject.strategy.js';
import { REVIEW_RUN_ITEM_STATUS, REVIEW_RUN_STATUS, type ReviewRunRow, type ReviewRunStatus } from './review-runs.constants.js';

/**
 * Payload shape for a `review_run_evaluate` job.
 *
 * @stability experimental
 */
export interface ReviewRunEvaluatePayload {
  /** The run to evaluate. */
  runId: string;
}

/** Keyset page size for streaming the eligible-subject scan. */
const PAGE_SIZE = 1000;

/** OTEL tracer for the shared review-run compute path. */
const tracer = trace.getTracer('review-run');

/**
 * Shared review-run evaluation handler (issue #190).
 *
 * Materializes a run's matched set into `review_run_items` (status 'matched') via constant-memory keyset
 * pagination, streaming each page straight into the DB. Which subjects are eligible, and in what order, is
 * entirely the strategy's business (`evaluatePage`); this handler only pages, writes and transitions:
 * 0 matches completes the run, otherwise it goes `running` and the chunked execute-batch jobs are queued.
 *
 * `createMany({ skipDuplicates: true })` leans on the per-subject partial unique indexes on
 * `review_run_items`, so a retried attempt re-materializes idempotently rather than double-counting.
 *
 * SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` pair. `canDelete` refuses to delete a
 * pending job of a run still `evaluating`. `process` takes the structural run-job input so the deprecated
 * `location_suggestion_run_evaluate` shim can keep delegating its legacy row unchanged.
 *
 * @stability experimental
 */
@Injectable()
export class ReviewRunEvaluateHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'review_run_evaluate';

  /** The label in the admin job list. */
  readonly label = 'Review run evaluate';

  /** A keyset scan over one circle's review queue: 15 minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(ReviewRunEvaluateHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: ReviewRunsDb,
    private readonly runService: ReviewRunService,
    private readonly subjects: ReviewRunSubjectRegistry,
    // App metrics (RETRO-T3, #628): `app.runs.finished{engine=review}`. Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Evaluates one run.
   *
   * @param job - the job (or a legacy row with the same three fields).
   */
  async process(job: MemoriahubRunJobInput): Promise<void> {
    const payload = runJobPayload<ReviewRunEvaluatePayload>(job);
    if (!payload?.runId) {
      this.logger.warn(`review_run_evaluate job ${job.id} missing runId payload; skipping`);
      return;
    }
    const runId = payload.runId;

    const run = (await this.prisma.reviewRun.findUnique({ where: { id: runId } })) as ReviewRunRow | null;
    // Idempotent no-op: run gone, or already past evaluation.
    if (!run || run.status !== REVIEW_RUN_STATUS.evaluating) return;

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
  canDelete(job: MemoriahubJob): Promise<string | null> {
    return vetoDeleteWhileRunActive(job, {
      engine: 'review run',
      activeStatuses: [REVIEW_RUN_STATUS.evaluating],
      readRunStatus: async (runId) =>
        ((await this.prisma.reviewRun.findUnique({ where: { id: runId }, select: { status: true } })) as { status: string } | null)
          ?.status ?? null,
    });
  }

  private async runEvaluation(job: MemoriahubRunJobInput, run: ReviewRunRow): Promise<void> {
    const runId = run.id;
    const strategy = this.subjects.get(run.subjectType);

    try {
      let accepted = 0;
      let cursor: ReviewRunCursor | null = null;

      for (;;) {
        const page = await strategy.evaluatePage(run, cursor, PAGE_SIZE);
        if (page.subjectIds.length === 0) break;

        await this.prisma.reviewRunItem.createMany({
          data: page.subjectIds.map((subjectId) => ({
            runId,
            subjectType: run.subjectType,
            [strategy.subjectColumn]: subjectId,
            status: REVIEW_RUN_ITEM_STATUS.matched,
          })),
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
          data: { status: REVIEW_RUN_STATUS.completed, finishedAt: new Date() },
        });
        this.metrics?.add('runsFinished', 1, { engine: 'review', outcome: 'completed' });
        this.logTransition(run, REVIEW_RUN_STATUS.completed, { matchedCount: 0 });
        return;
      }

      await this.prisma.reviewRun.update({
        where: { id: runId },
        data: { status: REVIEW_RUN_STATUS.running, startedAt: new Date() },
      });
      await this.runService.enqueueExecuteBatches(runId, run.circleId, run.subjectType);
      this.logTransition(run, REVIEW_RUN_STATUS.running, { matchedCount: accepted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark the run terminally failed only once the job has exhausted its normal retries (attempts is
      // charged at claim time). Intermediate attempts leave the run 'evaluating' and re-materialize
      // idempotently via createMany skipDuplicates. Then rethrow so the job itself fails/retries too.
      if (job.attempts >= this.profile.maxAttempts) {
        await this.prisma.reviewRun
          .update({
            where: { id: runId },
            data: {
              status: REVIEW_RUN_STATUS.failed,
              lastError: message,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        this.metrics?.add('runsFinished', 1, { engine: 'review', outcome: 'failed' });
        this.logTransition(run, REVIEW_RUN_STATUS.failed, { error: message });
      }
      throw err;
    }
  }

  private logTransition(run: ReviewRunRow, toStatus: ReviewRunStatus, extra: Record<string, unknown> = {}): void {
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
