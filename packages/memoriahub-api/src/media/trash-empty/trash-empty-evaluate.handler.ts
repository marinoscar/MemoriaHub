import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { runJobPayload, vetoDeleteWhileRunActive, type MemoriahubRunJobInput } from '../../core/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { TRASH_EMPTY_ITEM_STATUS, TRASH_EMPTY_RUN_STATUS, type TrashEmptyRunRow } from './trash-empty.constants.js';
import { TrashEmptyRunService } from './trash-empty-run.service.js';



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
/**
 * The `trash_empty_evaluate` job handler.
 *
 * @stability experimental
 */
@Injectable()
/**
 * Trash empty evaluate handler.
 *
 * @stability experimental
 */
export class TrashEmptyEvaluateHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'trash_empty_evaluate';

  readonly label = 'Empty trash evaluate';

  /** A keyset scan over one circle's trash: 15 minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(TrashEmptyEvaluateHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    private readonly runService: TrashEmptyRunService,
    // App metrics (RETRO-T3, #628): `app.runs.finished{engine=trash_empty}`. Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubRunJobInput): Promise<void> {
    const payload = runJobPayload<TrashEmptyEvaluatePayload>(job);
    if (!payload?.runId) {
      this.logger.warn(`trash_empty_evaluate job ${job.id} missing runId payload; skipping`);
      return;
    }
    const runId = payload.runId;

    const run = await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } });
    // Idempotent no-op: run gone, or already past evaluation.
    if (!run || run.status !== TRASH_EMPTY_RUN_STATUS.evaluating) return;

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
  canDelete(job: MemoriahubJob): Promise<string | null> {
    return vetoDeleteWhileRunActive(job, {
      engine: 'empty-trash run',
      activeStatuses: [TRASH_EMPTY_RUN_STATUS.evaluating],
      readRunStatus: async (runId) =>
        ((await this.prisma.trashEmptyRun.findUnique({ where: { id: runId }, select: { status: true } })) as { status: string } | null)
          ?.status ?? null,
    });
  }

  private async runEvaluation(job: MemoriahubRunJobInput, run: TrashEmptyRunRow): Promise<void> {
    const runId = run.id;
    try {
      const orderBy = [
        { capturedAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ];

      let accepted = 0;
      let cursor: { capturedAt: Date | null; id: string } | null = null;

      for (;;) {
        const baseWhere: Record<string, unknown> = {
          circleId: run.circleId,
          deletedAt: { not: null },
        };
        const where: Record<string, unknown> = cursor
          ? { AND: [baseWhere, this.buildAfterCursor(cursor)] }
          : baseWhere;

        const rows = (await this.prisma.mediaItem.findMany({
          where,
          orderBy,
          take: PAGE_SIZE,
          select: { id: true, capturedAt: true },
        })) as Array<{ id: string; capturedAt: Date | null }>;

        if (rows.length === 0) break;

        const last = rows[rows.length - 1];
        cursor = { capturedAt: last.capturedAt, id: last.id };

        await this.prisma.trashEmptyRunItem.createMany({
          data: rows.map((r) => ({
            runId,
            mediaItemId: r.id,
            status: TRASH_EMPTY_ITEM_STATUS.matched,
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
          data: { status: TRASH_EMPTY_RUN_STATUS.completed, finishedAt: new Date() },
        });
        this.metrics?.add('runsFinished', 1, { engine: 'trash_empty', outcome: 'completed' });
        this.logTransition(run, TRASH_EMPTY_RUN_STATUS.completed, { matchedCount: 0 });
        return;
      }

      await this.prisma.trashEmptyRun.update({
        where: { id: runId },
        data: { status: TRASH_EMPTY_RUN_STATUS.running, startedAt: new Date() },
      });
      await this.runService.enqueueExecuteBatches(runId, run.circleId);
      this.logTransition(run, TRASH_EMPTY_RUN_STATUS.running, { matchedCount: accepted });
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
              status: TRASH_EMPTY_RUN_STATUS.failed,
              lastError: message,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        this.metrics?.add('runsFinished', 1, { engine: 'trash_empty', outcome: 'failed' });
        this.logTransition(run, TRASH_EMPTY_RUN_STATUS.failed, { error: message });
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
  }): Record<string, unknown> {
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
    run: TrashEmptyRunRow,
    toStatus: TrashEmptyRunRow['status'],
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
