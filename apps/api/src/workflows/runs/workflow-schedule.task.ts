// =============================================================================
// WorkflowScheduleTask: the every-minute scheduled-trigger cron (issue #142;
// enqueue-only since RETRO-C9, #612)
// =============================================================================
//
// Decides only that a scheduled workflow is due and ENQUEUES the
// `workflows.schedule_tick` job (root rule: every long-running activity is a
// queue job; `cron-enqueue-only` conformance suite). The run creation and the
// `nextRunAt` roll-forward are `WorkflowScheduleTickHandler`'s.
//
// Gates, cheapest first: `features.workflows` and
// `workflows.triggers.scheduled` (one cached settings read), then one indexed
// `findFirst` for a due workflow. A GLOBAL job: the queue's dedup index keeps at
// most one pending/running tick, so a tick still in flight absorbs this one.
// Never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { isWorkflowsEnabled } from '../../settings/feature-gates';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';
import { WORKFLOW_SCHEDULE_TICK_TYPE, WORKFLOW_TICK_PRIORITY } from './workflow-cron-jobs.constants';
import { dueScheduledWorkflowsWhere } from './workflow-schedule-tick.handler';

@Injectable()
export class WorkflowScheduleTask {
  private readonly logger = new Logger(WorkflowScheduleTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    try {
      const settings = await this.systemSettings.getSettings();
      if (!isWorkflowsEnabled(settings)) return;
      if (settings.workflows?.triggers?.scheduled === false) return;

      const due = await this.prisma.workflow.findFirst({
        where: dueScheduledWorkflowsWhere(new Date()),
        select: { id: true },
      });
      if (!due) return;

      await this.jobs.enqueue({
        type: WORKFLOW_SCHEDULE_TICK_TYPE,
        reason: 'backfill',
        orgId: null,
        priority: WORKFLOW_TICK_PRIORITY,
      });
    } catch (err) {
      this.logger.error(
        `Workflow schedule tick enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
