import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  EnrichmentJob,
  LocationSuggestionRun,
  LocationSuggestionRunAction,
  LocationSuggestionRunItemStatus,
  LocationSuggestionRunStatus,
  LocationSuggestionStatus,
  Prisma,
} from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationSuggestionRunService } from './location-suggestion-run.service';

/** Payload shape for a `location_suggestion_run_evaluate` job. */
interface LocationSuggestionRunEvaluatePayload {
  runId: string;
}

/** Keyset page size for streaming the pending-suggestion scan. */
const PAGE_SIZE = 1000;

/** OTEL tracer for the location-suggestion bulk-resolve compute path. */
const tracer = trace.getTracer('location-suggestion-run');

/**
 * Location-suggestion bulk accept/reject — evaluation handler.
 *
 * Mirrors TrashEmptyEvaluateHandler: materializes a run's matched set into
 * location_suggestion_run_items (status 'matched') via constant-memory keyset
 * pagination over (createdAt DESC, id DESC), streaming each page straight into
 * the DB. The confidence filter partitions the pending queue at the threshold
 * by the run's action: an ACCEPT run matches pending suggestions AT/ABOVE the
 * threshold (accept the high-confidence ones), a REJECT run matches pending
 * suggestions BELOW the threshold (reject the low-confidence noise). Then
 * transitions the run:
 *   - 0 matches → completed
 *   - otherwise → running (+ enqueues chunked execute-batch jobs)
 *
 * SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` pair, so
 * EnrichmentHandlerRegistry auto-classifies it server-only and includes it in
 * `system` mode — no enrichment-job.worker.ts edit needed.
 */
@Injectable()
export class LocationSuggestionRunEvaluateHandler
  implements EnrichmentHandler, OnModuleInit
{
  readonly type = 'location_suggestion_run_evaluate';

  private readonly logger = new Logger(LocationSuggestionRunEvaluateHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runService: LocationSuggestionRunService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as LocationSuggestionRunEvaluatePayload | null;
    if (!payload?.runId) {
      this.logger.warn(
        `location_suggestion_run_evaluate job ${job.id} missing runId payload; skipping`,
      );
      return;
    }
    const runId = payload.runId;

    const run = await this.prisma.locationSuggestionRun.findUnique({ where: { id: runId } });
    // Idempotent no-op: run gone, or already past evaluation.
    if (!run || run.status !== LocationSuggestionRunStatus.evaluating) return;

    await tracer.startActiveSpan(
      'location_suggestion_run.evaluate',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'location_suggestion_run.run_id': run.id,
          'location_suggestion_run.circle_id': run.circleId,
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

  private async runEvaluation(job: EnrichmentJob, run: LocationSuggestionRun): Promise<void> {
    const runId = run.id;
    // 0-100 run threshold → 0-1 confidence floor. The comparison direction
    // depends on the action: accept matches AT/ABOVE the floor (high-confidence
    // suggestions), reject matches BELOW the floor (low-confidence noise).
    // LocationSuggestion.confidence is a non-nullable Float, so (unlike the
    // burst/duplicate Float? columns) there are no NULL rows to exclude.
    const confidenceFloor = run.threshold / 100;
    const confidenceFilter: Prisma.FloatFilter =
      run.action === LocationSuggestionRunAction.accept
        ? { gte: confidenceFloor }
        : { lt: confidenceFloor };

    try {
      const orderBy: Prisma.LocationSuggestionOrderByWithRelationInput[] = [
        { createdAt: 'desc' },
        { id: 'desc' },
      ];

      let accepted = 0;
      let cursor: { createdAt: Date; id: string } | null = null;

      for (;;) {
        const baseWhere: Prisma.LocationSuggestionWhereInput = {
          circleId: run.circleId,
          status: LocationSuggestionStatus.pending,
          confidence: confidenceFilter,
        };
        const where: Prisma.LocationSuggestionWhereInput = cursor
          ? { AND: [baseWhere, this.buildAfterCursor(cursor)] }
          : baseWhere;

        const rows = await this.prisma.locationSuggestion.findMany({
          where,
          orderBy,
          take: PAGE_SIZE,
          select: { id: true, createdAt: true },
        });

        if (rows.length === 0) break;

        const last = rows[rows.length - 1];
        cursor = { createdAt: last.createdAt, id: last.id };

        await this.prisma.locationSuggestionRunItem.createMany({
          data: rows.map((r) => ({
            runId,
            suggestionId: r.id,
            status: LocationSuggestionRunItemStatus.matched,
          })),
          skipDuplicates: true,
        });
        accepted += rows.length;

        if (rows.length < PAGE_SIZE) break; // last page
      }

      await this.prisma.locationSuggestionRun.update({
        where: { id: runId },
        data: { matchedCount: accepted },
      });

      if (accepted === 0) {
        await this.prisma.locationSuggestionRun.update({
          where: { id: runId },
          data: { status: LocationSuggestionRunStatus.completed, finishedAt: new Date() },
        });
        this.logTransition(run, LocationSuggestionRunStatus.completed, { matchedCount: 0 });
        return;
      }

      await this.prisma.locationSuggestionRun.update({
        where: { id: runId },
        data: { status: LocationSuggestionRunStatus.running, startedAt: new Date() },
      });
      await this.runService.enqueueExecuteBatches(runId, run.circleId);
      this.logTransition(run, LocationSuggestionRunStatus.running, { matchedCount: accepted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark the run terminally failed only once the job has exhausted its normal
      // retries (attempts is charged at claim time). Intermediate attempts leave
      // the run 'evaluating' and re-materialize idempotently via createMany
      // skipDuplicates. Then rethrow so the job itself fails/retries too.
      if (job.attempts >= this.maxAttempts()) {
        await this.prisma.locationSuggestionRun
          .update({
            where: { id: runId },
            data: {
              status: LocationSuggestionRunStatus.failed,
              lastError: message,
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        this.logTransition(run, LocationSuggestionRunStatus.failed, { error: message });
      }
      throw err;
    }
  }

  /**
   * Keyset "strictly after cursor" predicate for the (createdAt DESC, id DESC)
   * ordering. createdAt is non-null (@default(now)), so this is simpler than the
   * trash-empty capturedAt case — a plain lexicographic (createdAt, id) descent.
   */
  private buildAfterCursor(cursor: {
    createdAt: Date;
    id: string;
  }): Prisma.LocationSuggestionWhereInput {
    return {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
      ],
    };
  }

  private maxAttempts(): number {
    const raw = parseInt(process.env['ENRICHMENT_MAX_ATTEMPTS'] ?? '3', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 3;
  }

  private logTransition(
    run: LocationSuggestionRun,
    toStatus: LocationSuggestionRunStatus,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log({
      event: 'location_suggestion_run.evaluated',
      runId: run.id,
      circleId: run.circleId,
      status: toStatus,
      ...extra,
    });
  }
}
