import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  Prisma,
  TrashEmptyRun,
  TrashEmptyRunItemStatus,
  TrashEmptyRunStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TrashEmptyRunService } from './trash-empty-run.service';
import {
  runJobPayload,
  vetoDeleteWhileRunActive,
  type RunJobInput,
} from '../../platform/jobs/run-engine-jobs';

/** Payload shape for a `trash_empty_evaluate` job. */
interface TrashEmptyEvaluatePayload {
  runId: string;
}

/** Keyset page size for streaming the trashed-item scan. */
const PAGE_SIZE = 1000;

/** OTEL tracer for the empty-trash-at-scale compute path. */
const tracer = trace.getTracer('trash-empty');

/**
 * Empty-Trash at scale — evaluation handler (issue #165).
 *
 * A strict simplification of the workflow evaluate handler: no condition
 * compiler, no read-time refinements, no cap. Materializes a run's matched set
 * (every trashed item in the circle: `deletedAt IS NOT NULL`) into
 * trash_empty_run_items (status 'matched') via constant-memory keyset
 * pagination over the gallery ordering (capturedAt DESC NULLS LAST, id DESC),
 * streaming each page straight into the DB. Then transitions the run:
 *   - 0 matches → completed
 *   - otherwise → running (+ enqueues chunked execute-batch jobs)
 *
 * A native platform `JobHandler` (RETRO-C7, #604). SERVER-ONLY by omission: no
 * `nodeResultSchema` / `persistNodeResult` pair, so the platform registry
 * derives it server-only and the `system` worker mode runs it. `canDelete`
 * refuses to delete a pending job of a run still `evaluating`.
 */
@Injectable()
export class TrashEmptyEvaluateHandler implements JobHandler, OnModuleInit {
  readonly type = 'trash_empty_evaluate';

  readonly label = 'Empty trash evaluate';

  /** A keyset scan over one circle's trash: 15 minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(TrashEmptyEvaluateHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runService: TrashEmptyRunService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: RunJobInput): Promise<void> {
    const payload = runJobPayload<TrashEmptyEvaluatePayload>(job);
    if (!payload?.runId) {
      this.logger.warn(`trash_empty_evaluate job ${job.id} missing runId payload; skipping`);
      return;
    }
    const runId = payload.runId;

    const run = await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } });
    // Idempotent no-op: run gone, or already past evaluation.
    if (!run || run.status !== TrashEmptyRunStatus.evaluating) return;

    await tracer.startActiveSpan(
      'trash_empty.evaluate',
      {
        kind: SpanKind.INTERNAL,
        attributes: { 'trash_empty.run_id': run.id, 'trash_empty.circle_id': run.circleId },
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
      engine: 'empty-trash run',
      activeStatuses: [TrashEmptyRunStatus.evaluating],
      readRunStatus: async (runId) =>
        (await this.prisma.trashEmptyRun.findUnique({ where: { id: runId }, select: { status: true } }))
          ?.status ?? null,
    });
  }

  private async runEvaluation(job: RunJobInput, run: TrashEmptyRun): Promise<void> {
    const runId = run.id;
    try {
      const orderBy: Prisma.MediaItemOrderByWithRelationInput[] = [
        { capturedAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ];

      let accepted = 0;
      let cursor: { capturedAt: Date | null; id: string } | null = null;

      for (;;) {
        const baseWhere: Prisma.MediaItemWhereInput = {
          circleId: run.circleId,
          deletedAt: { not: null },
        };
        const where: Prisma.MediaItemWhereInput = cursor
          ? { AND: [baseWhere, this.buildAfterCursor(cursor)] }
          : baseWhere;

        const rows = await this.prisma.mediaItem.findMany({
          where,
          orderBy,
          take: PAGE_SIZE,
          select: { id: true, capturedAt: true },
        });

        if (rows.length === 0) break;

        const last = rows[rows.length - 1];
        cursor = { capturedAt: last.capturedAt, id: last.id };

        await this.prisma.trashEmptyRunItem.createMany({
          data: rows.map((r) => ({
            runId,
            mediaItemId: r.id,
            status: TrashEmptyRunItemStatus.matched,
          })),
          skipDuplicates: true,
        });
        accepted += rows.length;

        if (rows.length < PAGE_SIZE) break; // last page
      }

      await this.prisma.trashEmptyRun.update({
        where: { id: runId },
        data: { matchedCount: accepted },
      });

      if (accepted === 0) {
        await this.prisma.trashEmptyRun.update({
          where: { id: runId },
          data: { status: TrashEmptyRunStatus.completed, finishedAt: new Date() },
        });
        // metrics: RETRO-T3 (app.runs.finished{engine=trash_empty,outcome=completed})
        this.logTransition(run, TrashEmptyRunStatus.completed, { matchedCount: 0 });
        return;
      }

      await this.prisma.trashEmptyRun.update({
        where: { id: runId },
        data: { status: TrashEmptyRunStatus.running, startedAt: new Date() },
      });
      await this.runService.enqueueExecuteBatches(runId, run.circleId);
      this.logTransition(run, TrashEmptyRunStatus.running, { matchedCount: accepted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark the run terminally failed only once the job has exhausted its normal
      // retries (attempts is charged at claim time). Intermediate attempts leave
      // the run 'evaluating' and re-materialize idempotently via createMany
      // skipDuplicates. Then rethrow so the job itself fails/retries too.
      if (job.attempts >= this.maxAttempts()) {
        await this.prisma.trashEmptyRun
          .update({
            where: { id: runId },
            data: {
              status: TrashEmptyRunStatus.failed,
              lastError: message,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        // metrics: RETRO-T3 (app.runs.finished{engine=trash_empty,outcome=failed})
        this.logTransition(run, TrashEmptyRunStatus.failed, { error: message });
      }
      throw err;
    }
  }

  /**
   * Keyset "strictly after cursor" predicate for the (capturedAt DESC NULLS
   * LAST, id DESC) ordering. Copied from the workflow evaluate handler.
   */
  private buildAfterCursor(cursor: {
    capturedAt: Date | null;
    id: string;
  }): Prisma.MediaItemWhereInput {
    if (cursor.capturedAt === null) {
      return { capturedAt: null, id: { lt: cursor.id } };
    }
    return {
      OR: [
        { capturedAt: { lt: cursor.capturedAt } },
        { AND: [{ capturedAt: cursor.capturedAt }, { id: { lt: cursor.id } }] },
        { capturedAt: null },
      ],
    };
  }

  private maxAttempts(): number {
    return this.profile.maxAttempts;
  }

  private logTransition(
    run: TrashEmptyRun,
    toStatus: TrashEmptyRunStatus,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log({
      event: 'trash_empty_run.evaluated',
      runId: run.id,
      circleId: run.circleId,
      status: toStatus,
      ...extra,
    });
  }
}
