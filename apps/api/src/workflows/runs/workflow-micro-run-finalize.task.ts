// =============================================================================
// WorkflowMicroRunFinalizeTask: the every-minute micro-run window closer
// (issue #142; enqueue-only since RETRO-C9, #612)
// =============================================================================
//
// Decides only that an `on_media_enriched` micro-run's collection window has
// closed and ENQUEUES the `workflows.micro_run_finalize` job (root rule: every
// long-running activity is a queue job; `cron-enqueue-only` conformance suite).
// The race-safe claim (`approvedAt`) and the execute-batch fan-out are
// `WorkflowMicroRunFinalizeHandler`'s.
//
// Runs regardless of the feature toggle (as before), so a mid-window feature
// flip never strands a collecting micro-run. One indexed `findFirst` decides; a
// GLOBAL job, so the queue's dedup keeps at most one pending/running pass.
// Never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { WORKFLOW_MICRO_RUN_FINALIZE_TYPE, WORKFLOW_TICK_PRIORITY } from './workflow-cron-jobs.constants';
import { dueMicroRunsWhere } from './workflow-micro-run-finalize.handler';

@Injectable()
export class WorkflowMicroRunFinalizeTask {
  private readonly logger = new Logger(WorkflowMicroRunFinalizeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    try {
      const due = await this.prisma.workflowRun.findFirst({
        where: dueMicroRunsWhere(new Date()),
        select: { id: true },
      });
      if (!due) return;

      await this.jobs.enqueue({
        type: WORKFLOW_MICRO_RUN_FINALIZE_TYPE,
        reason: 'backfill',
        orgId: null,
        priority: WORKFLOW_TICK_PRIORITY,
      });
    } catch (err) {
      this.logger.error(
        `Workflow micro-run finalize enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
