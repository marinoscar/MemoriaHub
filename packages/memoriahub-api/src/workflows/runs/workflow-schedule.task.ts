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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { WorkflowsDb } from '../data/workflows-db.js';
import { isWorkflowsEnabled, readWorkflowSettings } from '../settings/workflows-settings.js';
import { WORKFLOW_SCHEDULE_TICK_TYPE, WORKFLOW_TICK_PRIORITY } from './workflow-cron-jobs.constants.js';
import { dueScheduledWorkflowsWhere } from './workflow-schedule-tick.handler.js';

@Injectable()
export class WorkflowScheduleTask {
  private readonly logger = new Logger(WorkflowScheduleTask.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settingsPort: MemoriahubSettingsPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    try {
      const settings = await readWorkflowSettings(this.settingsPort);
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
        payload: {},
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
