import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  EnrichmentJob,
  JobReason,
  LocationSuggestionRunAction,
  LocationSuggestionRunItemStatus,
  LocationSuggestionRunStatus,
  LocationSuggestionStatus,
} from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';

/** Payload shape for a `location_suggestion_run_execute_batch` job. */
interface LocationSuggestionRunExecuteBatchPayload {
  runId: string;
  suggestionIds: string[];
}

/** OTEL tracer for the location-suggestion bulk-resolve compute path. */
const tracer = trace.getTracer('location-suggestion-run');

/**
 * Location-suggestion bulk accept/reject — batch execution handler.
 *
 * Modelled on TrashEmptyExecuteBatchHandler, but for accept/reject rather than
 * hard-delete. Because an accept/reject does NOT cascade-delete the run-item row
 * (unlike a trash purge), a transient 'processing' claim marker is used so
 * retries are crash-safe without double-counting:
 *   - Cooperative cancellation: bail before doing any work if the run is cancelled.
 *   - Claim: flip still-'matched' items to 'processing' in ONE updateMany.
 *   - Read back every row now 'processing' for this batch (includes rows left
 *     'processing' by a prior crashed attempt) — that is this attempt's work set.
 *   - Per item: accept (write coords + mark accepted + enqueue geocode) or reject
 *     (mark rejected), transitioning the run-item matched→terminal exactly once.
 *   - Atomic counters ({ increment }) and a race-safe finalize (updateMany guarded
 *     on status='running', so only the last batch to drain wins).
 *
 * SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` node pair.
 */
@Injectable()
export class LocationSuggestionRunExecuteBatchHandler
  implements EnrichmentHandler, OnModuleInit
{
  readonly type = 'location_suggestion_run_execute_batch';

  private readonly logger = new Logger(LocationSuggestionRunExecuteBatchHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly enrichmentJobs: EnrichmentJobService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as LocationSuggestionRunExecuteBatchPayload | null;
    if (!payload?.runId || !Array.isArray(payload.suggestionIds)) {
      this.logger.warn(
        `location_suggestion_run_execute_batch job ${job.id} missing payload; skipping`,
      );
      return;
    }
    await tracer.startActiveSpan(
      'location_suggestion_run.execute_batch',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'location_suggestion_run.run_id': payload.runId,
          'location_suggestion_run.batch_size': payload.suggestionIds.length,
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

  private async executeBatch(payload: LocationSuggestionRunExecuteBatchPayload): Promise<void> {
    const { runId, suggestionIds } = payload;

    const run = await this.prisma.locationSuggestionRun.findUnique({ where: { id: runId } });
    if (!run) return; // run gone → nothing to do
    // Cooperative cancellation: a cancelled run stops all not-yet-started batches.
    if (run.status === LocationSuggestionRunStatus.cancelled) return;

    // Claim: flip still-'matched' items to 'processing' in one atomic updateMany.
    await this.prisma.locationSuggestionRunItem.updateMany({
      where: {
        runId,
        suggestionId: { in: suggestionIds },
        status: LocationSuggestionRunItemStatus.matched,
      },
      data: { status: LocationSuggestionRunItemStatus.processing },
    });

    // Read back every row now 'processing' for this batch — includes rows claimed
    // by a PRIOR attempt that crashed before finishing, so a retry re-processes
    // them. Do NOT rely on the claim count for tallying; use this work set.
    const workRows = await this.prisma.locationSuggestionRunItem.findMany({
      where: {
        runId,
        suggestionId: { in: suggestionIds },
        status: LocationSuggestionRunItemStatus.processing,
      },
      select: { id: true, suggestionId: true },
    });

    if (workRows.length === 0) {
      await this.maybeFinalizeRun(runId);
      return;
    }

    const runItemIdBySuggestion = new Map(workRows.map((r) => [r.suggestionId, r.id]));
    const workSuggestionIds = workRows.map((r) => r.suggestionId);

    const suggestions = await this.prisma.locationSuggestion.findMany({
      where: { id: { in: workSuggestionIds } },
      select: { id: true, mediaItemId: true, circleId: true, lat: true, lng: true, status: true },
    });
    const suggestionById = new Map(suggestions.map((s) => [s.id, s]));

    let appliedTally = 0;
    let skippedTally = 0;
    let failedTally = 0;

    // Media items to geocode AFTER their accept tx commits (never inside the tx —
    // job enqueue is a separate table; a rolled-back coord write must not leave an
    // orphaned geocode job behind).
    const geocodeQueue: { mediaItemId: string; circleId: string }[] = [];

    for (const suggestionId of workSuggestionIds) {
      const runItemId = runItemIdBySuggestion.get(suggestionId);
      if (!runItemId) continue; // defensive — should always be present
      const suggestion = suggestionById.get(suggestionId);

      try {
        // Someone resolved this suggestion individually since evaluation, or it
        // vanished → skip (don't clobber a manual decision).
        if (!suggestion || suggestion.status !== LocationSuggestionStatus.pending) {
          await this.prisma.locationSuggestionRunItem.update({
            where: { id: runItemId },
            data: { status: LocationSuggestionRunItemStatus.skipped },
          });
          skippedTally++;
          continue;
        }

        if (run.action === LocationSuggestionRunAction.accept) {
          await this.prisma.$transaction([
            this.prisma.mediaItem.update({
              where: { id: suggestion.mediaItemId },
              data: {
                takenLat: suggestion.lat,
                takenLng: suggestion.lng,
                coordSource: 'inferred',
              },
            }),
            this.prisma.locationSuggestion.update({
              where: { id: suggestion.id },
              data: {
                status: LocationSuggestionStatus.accepted,
                resolvedById: run.startedById,
                resolvedAt: new Date(),
              },
            }),
            this.prisma.locationSuggestionRunItem.update({
              where: { id: runItemId },
              data: { status: LocationSuggestionRunItemStatus.applied },
            }),
          ]);
          geocodeQueue.push({
            mediaItemId: suggestion.mediaItemId,
            circleId: suggestion.circleId,
          });
          appliedTally++;
        } else {
          // reject — no coord write, no geocode job.
          await this.prisma.$transaction([
            this.prisma.locationSuggestion.update({
              where: { id: suggestion.id },
              data: {
                status: LocationSuggestionStatus.rejected,
                resolvedById: run.startedById,
                resolvedAt: new Date(),
              },
            }),
            this.prisma.locationSuggestionRunItem.update({
              where: { id: runItemId },
              data: { status: LocationSuggestionRunItemStatus.applied },
            }),
          ]);
          appliedTally++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.locationSuggestionRunItem
          .update({
            where: { id: runItemId },
            data: { status: LocationSuggestionRunItemStatus.failed, error: message },
          })
          .catch(() => undefined);
        failedTally++;
      }
    }

    // Enqueue geocode jobs for accepted items after all txs committed. Dedup-safe
    // default (no skipDedup) — collapses with any pending geocode for the item.
    for (const g of geocodeQueue) {
      await this.enrichmentJobs
        .enqueue({
          type: 'geocode',
          mediaItemId: g.mediaItemId,
          circleId: g.circleId,
          reason: JobReason.backfill,
          priority: 100,
        })
        .catch((err) =>
          this.logger.warn(
            `geocode enqueue failed for media item ${g.mediaItemId}: ${
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
      await this.prisma.locationSuggestionRun.update({
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
    const remaining = await this.prisma.locationSuggestionRunItem.count({
      where: {
        runId,
        status: {
          in: [
            LocationSuggestionRunItemStatus.matched,
            LocationSuggestionRunItemStatus.processing,
          ],
        },
      },
    });
    if (remaining > 0) return;

    const run = await this.prisma.locationSuggestionRun.findUnique({
      where: { id: runId },
      select: { failedCount: true },
    });
    const finalStatus =
      (run?.failedCount ?? 0) > 0
        ? LocationSuggestionRunStatus.completed_with_errors
        : LocationSuggestionRunStatus.completed;

    const fin = await this.prisma.locationSuggestionRun.updateMany({
      where: { id: runId, status: LocationSuggestionRunStatus.running },
      data: { status: finalStatus, finishedAt: new Date() },
    });

    if (fin.count > 0) {
      this.logger.log({
        event: 'location_suggestion_run.finalized',
        runId,
        status: finalStatus,
        failedCount: run?.failedCount ?? 0,
      });
    }
  }
}
