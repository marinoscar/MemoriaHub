import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { trace, SpanKind, SpanStatusCode, Span } from '@opentelemetry/api';
import {
  EnrichmentJob,
  Prisma,
  WorkflowRunItemStatus,
  WorkflowRunStatus,
} from '@prisma/client';
import { workflowExecuteBatchResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowConditionCompiler, CompiledWorkflow } from '../compiler/workflow-condition.compiler';
import { WorkflowActionExecutor } from '../actions/workflow-action.executor';
import { WorkflowAction, WorkflowActionContext } from '../actions/action-executor.types';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { revalidateItemMatches } from '../execution/item-revalidation.util';

/** Payload shape for a `workflow_execute_batch` job. */
interface WorkflowExecuteBatchPayload {
  runId: string;
  itemIds: string[];
}

/** One per-action outcome record persisted in workflow_run_items.action_results. */
interface OutcomeRecord {
  type: string;
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  detail?: string;
}

/** Terminal per-item outcome (drives run counters). */
type ItemResult =
  | 'applied'
  | 'partially_applied'
  | 'failed'
  | 'skipped'
  | 'already_terminal';

/** Re-check the run's cancellation flag every N items. */
const CANCEL_CHECK_INTERVAL = 25;

/** OTEL tracer for the Media Workflow Automation compute path. */
const tracer = trace.getTracer('workflows');

/**
 * Media Workflow Automation — batch execution handler (issue #140).
 *
 * Applies the run's ordered actions to each item in the batch's `itemIds`,
 * per-item: an idempotency claim (only status='matched' items are eligible),
 * a drift re-validation, ordered action execution via WorkflowActionExecutor,
 * then a conditional terminal-status write. Increments the run's counters and,
 * once the run drains (no 'matched' items left), finalizes it to completed /
 * completed_with_errors.
 *
 * NODE-ELIGIBLE (issue #144): this handler carries the nodeResultSchema /
 * persistNodeResult pair so a distributed worker node can CLAIM a batch and
 * submit a result — but the compute/persist split is deliberately thin. A
 * workflow batch is DB-bound (no CPU-heavy compute to offload), so the node
 * only produces a per-item "intended outcome" declaration from the frozen
 * action list in its claim params; `persistNodeResult` then re-runs the FULL
 * authoritative pipeline (`executeBatch`) server-side from the trusted
 * `job.payload`, exactly as `process()` does. The point is posture completeness
 * (an `ENRICHMENT_WORKER_MODE=off` fleet-only deployment must still execute
 * workflows), not CPU offload. The type is ALSO kept server-claimable in
 * `system` mode (see systemModeEligibleTypes) so a `system`-mode deployment
 * keeps working; `FOR UPDATE SKIP LOCKED` makes both claim paths safe.
 */
@Injectable()
export class WorkflowExecuteBatchHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'workflow_execute_batch';

  /**
   * Node-eligibility (distributed workers): the shape a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type. Advisory only —
   * `persistNodeResult` re-does the authoritative work from `job.payload`.
   */
  readonly nodeResultSchema = workflowExecuteBatchResultSchema;

  private readonly logger = new Logger(WorkflowExecuteBatchHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly compiler: WorkflowConditionCompiler,
    private readonly executor: WorkflowActionExecutor,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as WorkflowExecuteBatchPayload | null;
    if (!payload?.runId || !Array.isArray(payload.itemIds)) {
      this.logger.warn(`workflow_execute_batch job ${job.id} missing payload; skipping`);
      return;
    }
    await this.runBatchSpan('workflow.execute_batch', payload);
  }

  /**
   * Persist a node-computed result (issue #144 — the persist half of the
   * compute/persist split).
   *
   * SECURITY: the node's `result` is IGNORED as a source of truth. The
   * authoritative item set comes from the TRUSTED `job.payload` (`runId`,
   * `itemIds`), and this method re-runs the identical `executeBatch` pipeline
   * `process()` runs — per-item idempotent claim, drift re-validation (so a
   * stale node result can never bypass the guard), `move_to_circle`'s
   * cross-circle dedup + both-circle permission checks, counters, and run
   * finalization. Late submissions after lease expiry are already 409-rejected
   * by the shared job-scoped guard in NodesService.assertJobHeldByNode, so no
   * extra staleness check is needed here. A throw routes the job through the
   * shared failure/retry state machine, exactly as an in-process throw would.
   */
  async persistNodeResult(job: EnrichmentJob, _result: unknown): Promise<void> {
    const payload = job.payload as unknown as WorkflowExecuteBatchPayload | null;
    if (!payload?.runId || !Array.isArray(payload.itemIds)) {
      this.logger.warn(
        `workflow_execute_batch job ${job.id} missing payload; skipping node persist`,
      );
      return;
    }
    // The submitted result was already validated against nodeResultSchema by the
    // ingestion endpoint; we deliberately do not read `items` from it — the
    // server re-does the authoritative work from job.payload.
    await this.runBatchSpan('workflow.execute_batch.persist_node_result', payload);
  }

  /** OTEL-wrapped batch execution shared by process() and persistNodeResult(). */
  private async runBatchSpan(
    spanName: string,
    payload: WorkflowExecuteBatchPayload,
  ): Promise<void> {
    await tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'workflow.run_id': payload.runId,
          'workflow.batch_size': payload.itemIds.length,
        },
      },
      async (span) => {
        try {
          await this.executeBatch(payload, span);
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

  private async executeBatch(
    payload: WorkflowExecuteBatchPayload,
    span: Span,
  ): Promise<void> {
    const { runId, itemIds } = payload;

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) return; // run gone → nothing to do
    if (run.status === WorkflowRunStatus.cancelled) return; // no-op on a cancelled run

    span.setAttribute('workflow.id', run.workflowId);
    span.setAttribute('workflow.circle_id', run.circleId);

    const definition = run.definitionSnapshot as unknown as WorkflowDefinition;
    const compiled = this.compiler.compile(run.circleId, definition);

    // Ordered action list: strip `type` off each definition action; the rest is
    // the action's params bag the executor reads by key.
    const actions: WorkflowAction[] = definition.actions.map((a) => {
      const { type, ...params } = a as Record<string, unknown>;
      return { type: String(type), params };
    });

    // Actor = approver (else the run creator). Both fall through startedById set
    // at create time; guard defensively if somehow absent.
    const actorUserId = run.approvedById ?? run.startedById;
    if (!actorUserId) {
      this.logger.warn(`Run ${runId} has no actor; cannot execute batch`);
      return;
    }
    const actorPermissions = await this.loadActorPermissions(actorUserId);

    // Fresh per-batch handledGroups Set. Within-batch group dedup is handled by
    // the Set; ACROSS batches, once one batch resolves/dismisses a group its
    // status flips off 'pending', so the executor's own status check skips it in
    // later batches ('no_pending_target'). A per-batch Set is therefore correct —
    // no cross-batch persistence of the Set is needed.
    const ctx: WorkflowActionContext = {
      runId,
      circleId: run.circleId,
      actorUserId,
      actorPermissions,
      handledGroups: new Set<string>(),
    };

    for (let i = 0; i < itemIds.length; i++) {
      // Periodic cancellation check — bail out of the remaining items.
      if (i > 0 && i % CANCEL_CHECK_INTERVAL === 0) {
        const fresh = await this.prisma.workflowRun.findUnique({
          where: { id: runId },
          select: { status: true },
        });
        if (fresh?.status === WorkflowRunStatus.cancelled) return;
      }

      const result = await this.processItem(runId, itemIds[i], actions, compiled, ctx);
      await this.applyCounters(runId, result);
    }

    await this.maybeFinalizeRun(runId);
  }

  // ---------------------------------------------------------------------------
  // Per-item processing
  // ---------------------------------------------------------------------------

  private async processItem(
    runId: string,
    itemId: string,
    actions: WorkflowAction[],
    compiled: CompiledWorkflow,
    ctx: WorkflowActionContext,
  ): Promise<ItemResult> {
    try {
      // Idempotency claim: only items still 'matched' are eligible. On a batch
      // retry, an already-terminal (or excluded) item's count is 0 → skip WITHOUT
      // re-counting (it was counted by the original run).
      const claim = await this.prisma.workflowRunItem.updateMany({
        where: { runId, mediaItemId: itemId, status: WorkflowRunItemStatus.matched },
        data: { updatedAt: new Date() },
      });
      if (claim.count === 0) return 'already_terminal';

      // Drift re-validation: the item may have changed between selection and now.
      const stillMatches = await revalidateItemMatches(this.prisma, compiled, itemId);
      if (!stillMatches) {
        await this.finalizeItem(runId, itemId, WorkflowRunItemStatus.skipped, null, null);
        return 'skipped';
      }

      // Execute actions in definition order; stop after a terminal (hard_delete).
      const outcomes: OutcomeRecord[] = [];
      let appliedCount = 0;
      let firstFailedDetail: string | undefined;
      for (const action of actions) {
        const outcome = await this.executor.execute(action, { id: itemId }, ctx);
        outcomes.push({
          type: action.type,
          status: outcome.status,
          reason: outcome.reason,
          detail: outcome.detail,
        });
        if (outcome.status === 'applied') appliedCount += 1;
        else if (outcome.status === 'failed' && firstFailedDetail === undefined) {
          firstFailedDetail = outcome.detail ?? 'action failed';
        }
        if (outcome.terminal) break;
      }

      // Item status: any failure with prior progress → partially_applied; a
      // failure with no progress → failed; some progress → applied; all skips → skipped.
      let status: WorkflowRunItemStatus;
      if (firstFailedDetail !== undefined && appliedCount > 0) {
        status = WorkflowRunItemStatus.partially_applied;
      } else if (firstFailedDetail !== undefined) {
        status = WorkflowRunItemStatus.failed;
      } else if (appliedCount > 0) {
        status = WorkflowRunItemStatus.applied;
      } else {
        status = WorkflowRunItemStatus.skipped;
      }

      // NOTE: a successful hard_delete purges the MediaItem, which cascade-deletes
      // this workflow_run_item row; the conditional write below then updates 0 rows
      // (harmless) and the item is counted via the returned result instead.
      await this.finalizeItem(runId, itemId, status, outcomes, firstFailedDetail ?? null);

      switch (status) {
        case WorkflowRunItemStatus.partially_applied:
          return 'partially_applied';
        case WorkflowRunItemStatus.failed:
          return 'failed';
        case WorkflowRunItemStatus.applied:
          return 'applied';
        default:
          return 'skipped';
      }
    } catch (err) {
      // An unexpected throw (outside the executor's own catch) must not fail the
      // whole batch — record the item failed and continue.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Item ${itemId} (run ${runId}) failed unexpectedly: ${detail}`);
      await this.finalizeItem(runId, itemId, WorkflowRunItemStatus.failed, null, detail).catch(
        () => undefined,
      );
      return 'failed';
    }
  }

  /** Write an item's terminal status, guarded on it still being 'matched'. */
  private async finalizeItem(
    runId: string,
    itemId: string,
    status: WorkflowRunItemStatus,
    outcomes: OutcomeRecord[] | null,
    error: string | null,
  ): Promise<void> {
    const data: Prisma.WorkflowRunItemUncheckedUpdateManyInput = { status, error };
    if (outcomes) {
      data.actionResults = outcomes as unknown as Prisma.InputJsonValue;
    }
    await this.prisma.workflowRunItem.updateMany({
      where: { runId, mediaItemId: itemId, status: WorkflowRunItemStatus.matched },
      data,
    });
  }

  /** Increment the run's aggregate counters for one processed item. */
  private async applyCounters(runId: string, result: ItemResult): Promise<void> {
    if (result === 'already_terminal') return; // counted by the original run

    const data: Prisma.WorkflowRunUncheckedUpdateInput = {
      processedCount: { increment: 1 },
    };
    switch (result) {
      case 'applied':
        data.succeededCount = { increment: 1 };
        break;
      case 'partially_applied':
        // Counts as both progress AND an error, forcing completed_with_errors.
        data.succeededCount = { increment: 1 };
        data.failedCount = { increment: 1 };
        break;
      case 'failed':
        data.failedCount = { increment: 1 };
        break;
      case 'skipped':
        data.skippedCount = { increment: 1 };
        break;
    }
    await this.prisma.workflowRun.update({ where: { id: runId }, data });
  }

  /**
   * Finalize the run once every item has left 'matched'. Race-safe: the
   * transition is a conditional updateMany on status='running', so only ONE
   * batch (the last to drain the queue) wins and audits.
   */
  private async maybeFinalizeRun(runId: string): Promise<void> {
    const remaining = await this.prisma.workflowRunItem.count({
      where: { runId, status: WorkflowRunItemStatus.matched },
    });
    if (remaining > 0) return;

    // Drift-safe error decision from the surviving item rows (hard_deleted items
    // are gone — they were successes, never failures).
    const grouped = await this.prisma.workflowRunItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const errorItems = grouped
      .filter(
        (g) =>
          g.status === WorkflowRunItemStatus.failed ||
          g.status === WorkflowRunItemStatus.partially_applied,
      )
      .reduce((sum, g) => sum + g._count._all, 0);

    const finalStatus =
      errorItems > 0
        ? WorkflowRunStatus.completed_with_errors
        : WorkflowRunStatus.completed;

    const fin = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: WorkflowRunStatus.running },
      data: { status: finalStatus, finishedAt: new Date() },
    });

    if (fin.count > 0) {
      const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
      if (run?.startedById) {
        await this.audit(run.startedById, 'workflow_run:completed', runId, {
          status: finalStatus,
          errorItems,
        });
      }
      this.logger.log({
        event: 'workflow_run.finalized',
        runId,
        workflowId: run?.workflowId ?? null,
        circleId: run?.circleId ?? null,
        status: finalStatus,
        errorItems,
      });
      this.executor.clearRunCache(runId);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Resolve the actor's effective (distinct) system permission-string list. */
  private async loadActorPermissions(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            rolePermissions: { select: { permission: { select: { name: true } } } },
          },
        },
      },
    });
    const perms = new Set<string>();
    for (const ur of rows) {
      for (const rp of ur.role.rolePermissions) perms.add(rp.permission.name);
    }
    return [...perms];
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent
      .create({
        data: {
          actorUserId,
          action,
          targetType: 'workflow_run',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }
}
