import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  EnrichmentJob,
  Prisma,
  TrashEmptyRun,
  TrashEmptyRunItemStatus,
  TrashEmptyRunStatus,
} from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { TrashEmptyRunService } from './trash-empty-run.service';

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
 * SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` pair, so
 * EnrichmentHandlerRegistry.serverOnlyTypes() auto-classifies it server-only and
 * systemModeEligibleTypes() auto-includes it in `system` mode — no
 * enrichment-job.worker.ts edit is needed.
 */
@Injectable()
export class TrashEmptyEvaluateHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'trash_empty_evaluate';

  private readonly logger = new Logger(TrashEmptyEvaluateHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runService: TrashEmptyRunService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as TrashEmptyEvaluatePayload | null;
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

  private async runEvaluation(job: EnrichmentJob, run: TrashEmptyRun): Promise<void> {
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
    const raw = parseInt(process.env['ENRICHMENT_MAX_ATTEMPTS'] ?? '3', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 3;
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
