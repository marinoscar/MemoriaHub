import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WorkflowRun, WorkflowRunItemStatus, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { WorkflowRunService } from './workflow-run.service';
import { MICRO_RUN_WINDOW_MINUTES } from './workflow-evaluate-item.handler';

/** Cap on micro-runs finalized per tick. */
const MAX_PER_TICK = 100;

/**
 * Media Workflow Automation — micro-run window closer (issue #142).
 *
 * Every minute, finds on_media_enriched micro-runs whose collection window has
 * elapsed (`status='running' AND approvedAt IS NULL AND startedAt <= now -
 * MICRO_RUN_WINDOW_MINUTES`) and dispatches each: it race-safely claims the run
 * by stamping `approvedAt` (only the winner proceeds), then enqueues the run's
 * execute-batch jobs via WorkflowRunService.enqueueExecuteBatches — after which
 * the existing workflow_execute_batch drain + maybeFinalizeRun terminates it.
 * A micro-run with 0 matched items at dispatch is finalized straight to
 * completed. Runs regardless of the feature toggle so a mid-window feature flip
 * never strands a collecting micro-run. Never throws.
 */
@Injectable()
export class WorkflowMicroRunFinalizeTask {
  private readonly logger = new Logger(WorkflowMicroRunFinalizeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly runService: WorkflowRunService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    try {
      const deadline = new Date(Date.now() - MICRO_RUN_WINDOW_MINUTES * 60_000);
      const due = await this.prisma.workflowRun.findMany({
        where: {
          triggerType: WorkflowTrigger.on_media_enriched,
          status: WorkflowRunStatus.running,
          approvedAt: null,
          startedAt: { lte: deadline },
        },
        orderBy: { startedAt: 'asc' },
        take: MAX_PER_TICK,
      });
      if (due.length === 0) return;

      // Loaded once — enqueueExecuteBatches only needs batchSize.
      const settings = await this.systemSettings.getSettings();

      for (const run of due) {
        try {
          await this.dispatch(run, settings);
        } catch (err) {
          this.logger.error(
            `Micro-run finalize failed for run ${run.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `WorkflowMicroRunFinalizeTask tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async dispatch(
    run: WorkflowRun,
    settings: Awaited<ReturnType<SystemSettingsService['getSettings']>>,
  ): Promise<void> {
    // Race-safe claim: stamp approvedAt so only ONE finalize attempt dispatches.
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: run.id, status: WorkflowRunStatus.running, approvedAt: null },
      data: { approvedAt: new Date() },
    });
    if (claimed.count === 0) return; // lost the race

    // 0-matched edge case (shouldn't happen — we only open on a match): finalize
    // straight to completed.
    const matched = await this.prisma.workflowRunItem.count({
      where: { runId: run.id, status: WorkflowRunItemStatus.matched },
    });
    if (matched === 0) {
      await this.prisma.workflowRun.updateMany({
        where: { id: run.id, status: WorkflowRunStatus.running },
        data: { status: WorkflowRunStatus.completed, finishedAt: new Date() },
      });
      return;
    }

    const definition = run.definitionSnapshot as unknown as WorkflowDefinition;
    await this.runService.enqueueExecuteBatches(run, definition, settings);
  }
}
