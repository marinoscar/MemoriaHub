import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { WorkflowsDb } from '../data/workflows-db.js';
import type { WorkflowDefinition } from '../definition/workflow-definition.schema.js';
import { readWorkflowSettings, type ResolvedWorkflowSettings } from '../settings/workflows-settings.js';
import {
  WORKFLOW_RUN_ITEM_STATUS,
  WORKFLOW_RUN_STATUS,
  WORKFLOW_TRIGGER,
  type WorkflowRunRow as WorkflowRun,
} from '../workflows.constants.js';
import { WORKFLOW_MICRO_RUN_FINALIZE_TYPE } from './workflow-cron-jobs.constants.js';
import { MICRO_RUN_WINDOW_MINUTES } from './workflow-evaluate-item.handler.js';
import { WorkflowRunService } from './workflow-run.service.js';

/** Cap on micro-runs finalized per tick. */
export const MAX_PER_TICK = 100;

/** The micro-runs whose collection window has closed by `now` (shared with the cron's due-check). */
export function dueMicroRunsWhere(now: Date): Record<string, unknown> {
  return {
    triggerType: WORKFLOW_TRIGGER.on_media_enriched,
    status: WORKFLOW_RUN_STATUS.running,
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
export class WorkflowMicroRunFinalizeHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = WORKFLOW_MICRO_RUN_FINALIZE_TYPE;

  readonly label = 'Workflow micro-run finalize';

  /** At most MAX_PER_TICK dispatches: five minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(WorkflowMicroRunFinalizeHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settingsPort: MemoriahubSettingsPort,
    private readonly runService: WorkflowRunService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(): Promise<void> {
    const due = (await this.prisma.workflowRun.findMany({
      where: dueMicroRunsWhere(new Date()),
      orderBy: { startedAt: 'asc' },
      take: MAX_PER_TICK,
    })) as WorkflowRun[];
    if (due.length === 0) return;

    // Loaded once — enqueueExecuteBatches only needs batchSize.
    const settings = await readWorkflowSettings(this.settingsPort);

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
    settings: ResolvedWorkflowSettings,
  ): Promise<void> {
    // Race-safe claim: stamp approvedAt so only ONE finalize attempt dispatches.
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: run.id, status: WORKFLOW_RUN_STATUS.running, approvedAt: null },
      data: { approvedAt: new Date() },
    });
    if (claimed.count === 0) return; // lost the race

    // 0-matched edge case (shouldn't happen — we only open on a match): finalize
    // straight to completed.
    const matched = await this.prisma.workflowRunItem.count({
      where: { runId: run.id, status: WORKFLOW_RUN_ITEM_STATUS.matched },
    });
    if (matched === 0) {
      await this.prisma.workflowRun.updateMany({
        where: { id: run.id, status: WORKFLOW_RUN_STATUS.running },
        data: { status: WORKFLOW_RUN_STATUS.completed, finishedAt: new Date() },
      });
      return;
    }

    const definition = run.definitionSnapshot as unknown as WorkflowDefinition;
    await this.runService.enqueueExecuteBatches(run, definition, settings);
  }
}
