import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  EnrichmentJob,
  Prisma,
  WorkflowRunItemStatus,
  WorkflowRunStatus,
} from '@prisma/client';
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
 * Server-only (no nodeResultSchema/persistNodeResult).
 */
@Injectable()
export class WorkflowExecuteBatchHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'workflow_execute_batch';

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
    const { runId, itemIds } = payload;

    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) return; // run gone → nothing to do
    if (run.status === WorkflowRunStatus.cancelled) return; // no-op on a cancelled run

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
