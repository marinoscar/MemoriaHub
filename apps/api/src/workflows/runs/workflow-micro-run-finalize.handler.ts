import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';
import { Prisma, WorkflowRun, WorkflowRunItemStatus, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { WorkflowRunService } from './workflow-run.service';
import { MICRO_RUN_WINDOW_MINUTES } from './workflow-evaluate-item.handler';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';
import { WORKFLOW_MICRO_RUN_FINALIZE_TYPE } from './workflow-cron-jobs.constants';

/** Cap on micro-runs finalized per tick. */
export const MAX_PER_TICK = 100;

/** The micro-runs whose collection window has closed by `now` (shared with the cron's due-check). */
export function dueMicroRunsWhere(now: Date): Prisma.WorkflowRunWhereInput {
  return {
    triggerType: WorkflowTrigger.on_media_enriched,
    status: WorkflowRunStatus.running,
    approvedAt: null,
    startedAt: { lte: new Date(now.getTime() - MICRO_RUN_WINDOW_MINUTES * 60_000) },
  };
}

/**
 * Media Workflow Automation — micro-run window closer (issue #142), as the
 * `workflows.micro_run_finalize` job (RETRO-C9, #612).
 *
 * `WorkflowMicroRunFinalizeTask` (every minute) only checks that a micro-run's
 * window has closed and enqueues this job. Here: finds on_media_enriched
 * micro-runs whose collection window has elapsed (`status='running' AND
 * approvedAt IS NULL AND startedAt <= now - MICRO_RUN_WINDOW_MINUTES`) and
 * dispatches each: it race-safely claims the run by stamping `approvedAt` (only
 * the winner proceeds), then enqueues the run's execute-batch jobs via
 * WorkflowRunService.enqueueExecuteBatches — after which the existing
 * workflow_execute_batch drain + maybeFinalizeRun terminates it. A micro-run
 * with 0 matched items at dispatch is finalized straight to completed. Runs
 * regardless of the feature toggle so a mid-window feature flip never strands a
 * collecting micro-run. A per-run failure is logged; a failure of the whole
 * pass is thrown so the queue retries it.
 *
 * A GLOBAL system job (single-flight by the queue's dedup). SERVER-ONLY.
 */
@Injectable()
export class WorkflowMicroRunFinalizeHandler implements JobHandler, OnModuleInit {
  readonly type = WORKFLOW_MICRO_RUN_FINALIZE_TYPE;

  readonly label = 'Workflow micro-run finalize';

  /** At most MAX_PER_TICK dispatches: five minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(WorkflowMicroRunFinalizeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly runService: WorkflowRunService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const due = await this.prisma.workflowRun.findMany({
      where: dueMicroRunsWhere(new Date()),
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
  }

  private async dispatch(
    run: WorkflowRun,
    settings: Awaited<ReturnType<AppSystemSettingsService['getSettings']>>,
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
