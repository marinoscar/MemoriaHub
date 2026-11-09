import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';
import { Prisma, Workflow, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isWorkflowsEnabled } from '../../settings/feature-gates';
import { nextCronDate } from '../util/cron.util';
import { WorkflowRunService } from './workflow-run.service';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';
import { WORKFLOW_SCHEDULE_TICK_TYPE } from './workflow-cron-jobs.constants';

/** Statuses that count a run as still in flight (overlap / concurrency gate). */
export const ACTIVE_RUN_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.evaluating,
  WorkflowRunStatus.awaiting_approval,
  WorkflowRunStatus.running,
];

/** Cap on due workflows handled per tick so a backlog can't blow up one run. */
export const MAX_DUE_PER_TICK = 100;

/** Enabled `scheduled` workflows whose `nextRunAt` has elapsed by `now` (shared with the cron's due-check). */
export function dueScheduledWorkflowsWhere(now: Date): Prisma.WorkflowWhereInput {
  return { trigger: WorkflowTrigger.scheduled, enabled: true, nextRunAt: { lte: now } };
}

/**
 * Media Workflow Automation — scheduled (cron) trigger (issue #142), as the
 * `workflows.schedule_tick` job (RETRO-C9, #612).
 *
 * `WorkflowScheduleTask` (every minute) only decides that a scheduled workflow
 * is due and enqueues this job; the run creation happens here. Finds
 * `trigger='scheduled'` + enabled workflows whose `nextRunAt <= now` (served by
 * the (trigger, enabled, next_run_at) index) and starts an unattended run for
 * each — subject to an overlap guard (no second run while one is in flight for
 * the same workflow) and an app-wide concurrency guard
 * (`workflows.maxConcurrentRuns`). A skipped or started workflow always has its
 * `nextRunAt` rolled forward to the next cron fire, so the scheduler never
 * backlogs and a poison workflow can't wedge the tick. A per-workflow failure is
 * logged and rolled forward; a failure of the whole tick (settings or the due
 * read) is thrown so the queue records and retries it.
 *
 * A GLOBAL system job: the queue's single-flight dedup (one pending/running row
 * per type) replaces the old in-process overlap of ticks. SERVER-ONLY (no
 * node-result pair): it writes `workflows` and `workflow_runs`.
 */
@Injectable()
export class WorkflowScheduleTickHandler implements JobHandler, OnModuleInit {
  readonly type = WORKFLOW_SCHEDULE_TICK_TYPE;

  readonly label = 'Workflow schedule tick';

  /** At most MAX_DUE_PER_TICK run starts: five minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(WorkflowScheduleTickHandler.name);

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
    const settings = await this.systemSettings.getSettings();
    // Re-checked here: the switches may have flipped since the tick was queued.
    if (!isWorkflowsEnabled(settings)) return;
    if (settings.workflows?.triggers?.scheduled === false) return;

    const now = new Date();
    const due = await this.prisma.workflow.findMany({
      where: dueScheduledWorkflowsWhere(now),
      orderBy: { nextRunAt: 'asc' },
      take: MAX_DUE_PER_TICK,
    });
    if (due.length === 0) return;

    const maxConcurrent = settings.workflows?.maxConcurrentRuns ?? 2;

    for (const workflow of due) {
      try {
        await this.processDueWorkflow(workflow, maxConcurrent);
      } catch (err) {
        this.logger.error(
          `Scheduled trigger failed for workflow ${workflow.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Roll forward regardless so a failing workflow doesn't re-fire every tick.
        await this.rollForward(workflow).catch(() => undefined);
      }
    }
  }

  private async processDueWorkflow(workflow: Workflow, maxConcurrent: number): Promise<void> {
    // Overlap guard: never start a second run for the same workflow while one is
    // still in flight. Roll forward and wait for the next tick.
    const overlapping = await this.prisma.workflowRun.count({
      where: { workflowId: workflow.id, status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (overlapping > 0) {
      await this.rollForward(workflow);
      return;
    }

    // App-wide concurrency guard: drop this tick's start (roll forward) rather
    // than backlog it.
    const active = await this.prisma.workflowRun.count({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
    });
    if (active >= maxConcurrent) {
      await this.rollForward(workflow);
      return;
    }

    await this.runService.startUnattendedRun(workflow, WorkflowTrigger.scheduled);
    await this.rollForward(workflow);
  }

  /** Advance `nextRunAt` to the next cron fire strictly after now. */
  private async rollForward(workflow: Workflow): Promise<void> {
    if (!workflow.cronExpression) return;
    const next = nextCronDate(workflow.cronExpression, new Date());
    await this.prisma.workflow.update({
      where: { id: workflow.id },
      data: { nextRunAt: next },
    });
  }
}
