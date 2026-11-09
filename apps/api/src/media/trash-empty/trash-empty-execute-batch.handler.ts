import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { TrashEmptyRunItemStatus, TrashEmptyRunStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../media.service';
import {
  runJobPayload,
  vetoDeleteWhileRunActive,
  type RunJobInput,
} from '../../platform/jobs/run-engine-jobs';

/** Payload shape for a `trash_empty_execute_batch` job. */
interface TrashEmptyExecuteBatchPayload {
  runId: string;
  itemIds: string[];
}

/** OTEL tracer for the empty-trash-at-scale compute path. */
const tracer = trace.getTracer('trash-empty');

/**
 * Empty-Trash at scale — batch execution handler (issue #165).
 *
 * The load-bearing correctness template, modelled on the workflow
 * execute-batch handler but simplified to a single fixed action (hard-delete):
 *   - Cooperative cancellation: bail before doing any work if the run is cancelled.
 *   - Idempotency claim: flip still-'matched' items to 'deleted' in ONE
 *     updateMany; claim.count is how many this attempt newly owns (0 for rows
 *     already handled by a prior attempt — not re-counted).
 *   - Purge: hard-delete the claimed set via MediaService.purgeMediaItemsBatched.
 *     A successful purge cascade-deletes the run-item row itself. Rows whose
 *     purge failed (MediaItem survives) are flipped to 'failed'.
 *   - Atomic counters ({ increment }) and a race-safe finalize (updateMany
 *     guarded on status='running', so only the last batch to drain wins).
 *
 * A native platform `JobHandler` (RETRO-C7, #604). SERVER-ONLY by omission: this
 * handler deliberately does NOT declare the `nodeResultSchema` /
 * `persistNodeResult` node pair, because purging requires storage credentials a
 * distributed worker node never holds. The platform registry therefore derives
 * it server-only and the `system` worker mode runs it (unlike
 * workflow_execute_batch, which is pinned into `JOBS_SYSTEM_MODE_EXTRA_TYPES`
 * precisely because it CARRIES the node pair). `canDelete` refuses to delete a
 * pending batch of a run that is still `running`.
 */
@Injectable()
export class TrashEmptyExecuteBatchHandler implements JobHandler, OnModuleInit {
  readonly type = 'trash_empty_execute_batch';

  readonly label = 'Empty trash execute batch';

  /** 200 items: a batched hard-delete of rows and objects. 15 minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(TrashEmptyExecuteBatchHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly mediaService: MediaService,
    // App metrics (RETRO-T3, #628): `app.runs.finished` / `app.runs.items` (engine `trash_empty`). Optional for hand-built tests.
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: RunJobInput): Promise<void> {
    const raw = runJobPayload<TrashEmptyExecuteBatchPayload>(job);
    if (typeof raw?.runId !== 'string' || raw.runId === '' || !Array.isArray(raw.itemIds)) {
      this.logger.warn(`trash_empty_execute_batch job ${job.id} missing payload; skipping`);
      return;
    }
    const payload: TrashEmptyExecuteBatchPayload = { runId: raw.runId, itemIds: raw.itemIds };
    await tracer.startActiveSpan(
      'trash_empty.execute_batch',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'trash_empty.run_id': payload.runId,
          'trash_empty.batch_size': payload.itemIds.length,
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
  canDelete(job: Job): Promise<string | null> {
    return vetoDeleteWhileRunActive(job, {
      engine: 'empty-trash run',
      activeStatuses: [TrashEmptyRunStatus.running],
      readRunStatus: async (runId) =>
        (await this.prisma.trashEmptyRun.findUnique({ where: { id: runId }, select: { status: true } }))
          ?.status ?? null,
    });
  }

  private async executeBatch(payload: TrashEmptyExecuteBatchPayload): Promise<void> {
    const { runId, itemIds } = payload;

    const run = await this.prisma.trashEmptyRun.findUnique({ where: { id: runId } });
    if (!run) return; // run gone → nothing to do
    // Cooperative cancellation: a cancelled run stops all not-yet-started batches.
    if (run.status === TrashEmptyRunStatus.cancelled) return;

    // Claim: flip still-'matched' items to 'deleted' in one atomic updateMany.
    // claim.count is how many THIS attempt newly owns (already-handled rows are
    // not re-counted — they were counted by the original attempt).
    const claim = await this.prisma.trashEmptyRunItem.updateMany({
      where: {
        runId,
        mediaItemId: { in: itemIds },
        status: TrashEmptyRunItemStatus.matched,
      },
      data: { status: TrashEmptyRunItemStatus.deleted },
    });
    const claimedCount = claim.count;

    // Read back every row now in 'deleted' for this batch's itemIds — includes
    // rows claimed by a PRIOR attempt that crashed before purging, so a retry
    // re-purges them (the underlying MediaItem still exists in that case).
    const claimedRows = await this.prisma.trashEmptyRunItem.findMany({
      where: {
        runId,
        mediaItemId: { in: itemIds },
        status: TrashEmptyRunItemStatus.deleted,
      },
      select: { mediaItemId: true },
    });
    const purgeIds = claimedRows.map((r) => r.mediaItemId);

    let failedCount = 0;
    if (purgeIds.length > 0) {
      // Hard-delete the claimed items. A successful purge cascade-deletes the
      // corresponding trash_empty_run_item row (onDelete: Cascade on mediaItem).
      const { failedIds } = await this.mediaService.purgeMediaItemsBatched(purgeIds);
      failedCount = failedIds.length;

      if (failedIds.length > 0) {
        // The MediaItem survived (row still present at status='deleted') — mark failed.
        await this.prisma.trashEmptyRunItem.updateMany({
          where: {
            runId,
            mediaItemId: { in: failedIds },
            status: TrashEmptyRunItemStatus.deleted,
          },
          data: {
            status: TrashEmptyRunItemStatus.failed,
            error: 'Hard-delete failed',
          },
        });
      }
    }

    // Atomic counter increments for the items newly processed this attempt.
    if (claimedCount > 0) {
      const succeeded = Math.max(0, claimedCount - failedCount);
      await this.prisma.trashEmptyRun.update({
        where: { id: runId },
        data: {
          processedCount: { increment: claimedCount },
          succeededCount: { increment: succeeded },
          failedCount: { increment: failedCount },
        },
      });
      this.metrics?.add('runItems', succeeded, { engine: 'trash_empty', outcome: 'applied' });
      this.metrics?.add('runItems', failedCount, { engine: 'trash_empty', outcome: 'failed' });
    }

    await this.maybeFinalizeRun(runId);
  }

  /**
   * Finalize the run once every item has left 'matched'. Race-safe: the
   * transition is a conditional updateMany on status='running', so only ONE
   * batch (the last to drain the queue) wins.
   */
  private async maybeFinalizeRun(runId: string): Promise<void> {
    const remaining = await this.prisma.trashEmptyRunItem.count({
      where: { runId, status: TrashEmptyRunItemStatus.matched },
    });
    if (remaining > 0) return;

    // Read the accumulated failed counter to decide the terminal status.
    const run = await this.prisma.trashEmptyRun.findUnique({
      where: { id: runId },
      select: { failedCount: true },
    });
    const finalStatus =
      (run?.failedCount ?? 0) > 0
        ? TrashEmptyRunStatus.completed_with_errors
        : TrashEmptyRunStatus.completed;

    const fin = await this.prisma.trashEmptyRun.updateMany({
      where: { id: runId, status: TrashEmptyRunStatus.running },
      data: { status: finalStatus, finishedAt: new Date() },
    });

    if (fin.count > 0) {
      this.metrics?.add('runsFinished', 1, { engine: 'trash_empty', outcome: finalStatus });
      this.logger.log({
        event: 'trash_empty_run.finalized',
        runId,
        status: finalStatus,
        failedCount: run?.failedCount ?? 0,
      });
    }
  }
}
