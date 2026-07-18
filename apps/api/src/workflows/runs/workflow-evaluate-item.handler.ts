import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  EnrichmentJob,
  Prisma,
  WorkflowRunItemStatus,
  WorkflowRunStatus,
  WorkflowTrigger,
} from '@prisma/client';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { isWorkflowsEnabled } from '../../common/types/settings.types';
import { WorkflowConditionCompiler } from '../compiler/workflow-condition.compiler';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';

/**
 * Length of the rolling micro-run collection window, in minutes. A CODE
 * CONSTANT (there is deliberately no system setting for it) shared with
 * WorkflowMicroRunFinalizeTask.
 */
export const MICRO_RUN_WINDOW_MINUTES = 5;

/** Payload shape for a `workflow_evaluate_item` job. */
interface WorkflowEvaluateItemPayload {
  workflowId: string;
  mediaItemId: string;
}

/**
 * Media Workflow Automation — per-item on_media_enriched evaluation (issue #142).
 *
 * Enqueued (server-side, reason=rerun) by WorkflowTriggerListener once an item's
 * enrichment dependencies are all settled and its circle has at least one
 * on_media_enriched workflow. Evaluates ONE item against ONE workflow and, on a
 * match, appends it to a rolling MICRO-RUN.
 *
 * Rolling micro-run design
 * ------------------------
 *   - A micro-run is a `workflow_run` with triggerType='on_media_enriched',
 *     status='running', opened when the first match for the workflow arrives.
 *     `startedAt` marks window-open; the window deadline is
 *     `startedAt + MICRO_RUN_WINDOW_MINUTES`. `approvedAt` is repurposed as the
 *     DISPATCH marker: null = still collecting / not yet dispatched, set =
 *     execute batches enqueued (claimed by WorkflowMicroRunFinalizeTask).
 *   - Open-or-append is atomic per workflow: a `SELECT ... FOR UPDATE` on the
 *     workflow row serializes concurrent openers, so there is AT MOST ONE open
 *     micro-run per workflow. An arriving match either appends to the open
 *     micro-run (createMany skipDuplicates + matchedCount++) or opens a fresh
 *     one (status='running', matchedCount=1, first item inserted).
 *   - During the window NO execute-batch jobs exist for the micro-run, so the
 *     execute-batch handler's maybeFinalizeRun (its only caller) never
 *     prematurely finalizes it. After the finalize task dispatches, batches
 *     drain matched→terminal and the last one finalizes the run.
 *   - A crash mid-window leaves the micro-run status='running' with approvedAt
 *     IS NULL; the finalize task claims and dispatches it on the next tick.
 *
 * Loop / backpressure protection: the evaluate-once guard (an item already has a
 * workflow_run_item on ANY run of this workflow → skip) stops a workflow-applied
 * mutation from re-firing evaluation, breaking workflow→enrichment→workflow
 * cascades. Server-only (no nodeResultSchema/persistNodeResult).
 */
@Injectable()
export class WorkflowEvaluateItemHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'workflow_evaluate_item';

  private readonly logger = new Logger(WorkflowEvaluateItemHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly compiler: WorkflowConditionCompiler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as unknown as WorkflowEvaluateItemPayload | null;
    if (!payload?.workflowId || !payload?.mediaItemId) {
      this.logger.warn(`workflow_evaluate_item job ${job.id} missing payload; skipping`);
      return;
    }
    const { workflowId, mediaItemId } = payload;

    // 1. Feature/trigger gate + workflow eligibility.
    const settings = await this.systemSettings.getSettings();
    if (!isWorkflowsEnabled(settings)) return;
    if (settings.workflows?.triggers?.onEnrichment === false) return;

    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) return;
    if (!workflow.enabled) return;
    if (workflow.trigger !== WorkflowTrigger.on_media_enriched) return;
    if (!workflow.createdById) {
      // No creator → the micro-run could never be authorized/executed. Skip.
      this.logger.warn(
        `Workflow ${workflowId} has no creator; skipping on_media_enriched evaluation`,
      );
      return;
    }

    // 2. Evaluate-once guard: this item already has a run item on some run of
    // THIS workflow → it has been evaluated once already (also the loop backstop).
    const already = await this.prisma.workflowRunItem.findFirst({
      where: { mediaItemId, run: { workflowId } },
      select: { id: true },
    });
    if (already) return;

    // 3. Single-item condition check against the workflow's CURRENT definition.
    const definition = workflow.definition as unknown as WorkflowDefinition;
    const compiled = this.compiler.compile(workflow.circleId, definition);
    const needRefine = compiled.refinements.length > 0;
    const select: Prisma.MediaItemSelect = { id: true };
    if (needRefine) {
      for (const r of compiled.refinements) Object.assign(select, r.select);
    }
    const row = await this.prisma.mediaItem.findFirst({
      where: { AND: [{ id: mediaItemId }, compiled.where] },
      select,
    });
    if (!row) return;
    if (needRefine && !compiled.refinements.every((r) => r.predicate(row))) return;

    // 4. Append to (or open) the rolling micro-run.
    await this.appendToMicroRun(workflow.id, workflow.circleId, workflow.createdById, mediaItemId, definition);
  }

  /**
   * Atomically (per workflow) append the matched item to the open micro-run, or
   * open a fresh one. Serialized via `SELECT ... FOR UPDATE` on the workflow row
   * so at most one micro-run per workflow is ever open.
   */
  private async appendToMicroRun(
    workflowId: string,
    circleId: string,
    createdById: string,
    mediaItemId: string,
    definition: WorkflowDefinition,
  ): Promise<void> {
    let freshRunId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent openers for THIS workflow.
      await tx.$queryRaw`SELECT id FROM workflows WHERE id = ${workflowId}::uuid FOR UPDATE`;

      const windowStart = new Date(Date.now() - MICRO_RUN_WINDOW_MINUTES * 60_000);
      const open = await tx.workflowRun.findFirst({
        where: {
          workflowId,
          triggerType: WorkflowTrigger.on_media_enriched,
          status: WorkflowRunStatus.running,
          approvedAt: null,
          startedAt: { gt: windowStart },
        },
        orderBy: { startedAt: 'desc' },
      });

      if (open) {
        const inserted = await tx.workflowRunItem.createMany({
          data: [{ runId: open.id, mediaItemId, status: WorkflowRunItemStatus.matched }],
          skipDuplicates: true,
        });
        if (inserted.count > 0) {
          await tx.workflowRun.update({
            where: { id: open.id },
            data: { matchedCount: { increment: 1 } },
          });
        }
        return;
      }

      const now = new Date();
      const run = await tx.workflowRun.create({
        data: {
          workflowId,
          circleId,
          status: WorkflowRunStatus.running,
          triggerType: WorkflowTrigger.on_media_enriched,
          definitionSnapshot: definition as unknown as Prisma.InputJsonValue,
          startedById: createdById,
          startedAt: now,
          matchedCount: 1,
        },
      });
      await tx.workflowRunItem.create({
        data: { runId: run.id, mediaItemId, status: WorkflowRunItemStatus.matched },
      });
      freshRunId = run.id;
    });

    // Audit a fresh micro-run open outside the transaction (best-effort).
    if (freshRunId) {
      await this.audit(createdById, 'workflow_run:started', freshRunId, {
        workflowId,
        circleId,
        trigger: WorkflowTrigger.on_media_enriched,
      });
    }
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
