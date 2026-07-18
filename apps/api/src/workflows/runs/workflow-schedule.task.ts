import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Workflow, WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { isWorkflowsEnabled } from '../../common/types/settings.types';
import { nextCronDate } from '../util/cron.util';
import { WorkflowRunService } from './workflow-run.service';

/** Statuses that count a run as still in flight (overlap / concurrency gate). */
const ACTIVE_RUN_STATUSES: WorkflowRunStatus[] = [
  WorkflowRunStatus.evaluating,
  WorkflowRunStatus.awaiting_approval,
  WorkflowRunStatus.running,
];

/** Cap on due workflows handled per tick so a backlog can't blow up one run. */
const MAX_DUE_PER_TICK = 100;

/**
 * Media Workflow Automation — scheduled (cron) trigger (issue #142).
 *
 * Every minute, finds `trigger='scheduled'` + enabled workflows whose
 * `nextRunAt <= now` (served by the (trigger, enabled, next_run_at) index) and
 * starts an unattended run for each — subject to an overlap guard (no second
 * run while one is in flight for the same workflow) and an app-wide concurrency
 * guard (`workflows.maxConcurrentRuns`). A skipped or started workflow always
 * has its `nextRunAt` rolled forward to the next cron fire, so the scheduler
 * never backlogs and a poison workflow can't wedge the tick. Never throws.
 */
@Injectable()
export class WorkflowScheduleTask {
  private readonly logger = new Logger(WorkflowScheduleTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly runService: WorkflowRunService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    try {
      const settings = await this.systemSettings.getSettings();
      if (!isWorkflowsEnabled(settings)) return;
      if (settings.workflows?.triggers?.scheduled === false) return;

      const now = new Date();
      const due = await this.prisma.workflow.findMany({
        where: {
          trigger: WorkflowTrigger.scheduled,
          enabled: true,
          nextRunAt: { lte: now },
        },
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
    } catch (err) {
      this.logger.error(
        `WorkflowScheduleTask tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
