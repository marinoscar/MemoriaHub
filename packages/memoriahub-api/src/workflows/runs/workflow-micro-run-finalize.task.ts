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
import { WORKFLOW_MICRO_RUN_FINALIZE_TYPE, WORKFLOW_TICK_PRIORITY } from './workflow-cron-jobs.constants.js';
import { dueMicroRunsWhere } from './workflow-micro-run-finalize.handler.js';

/**
 * The every-minute cron that enqueues `workflows.micro_run_finalize` when a micro-run window has closed.
 *
 * @stability experimental
 */
@Injectable()
export class WorkflowMicroRunFinalizeTask {
  private readonly logger = new Logger(WorkflowMicroRunFinalizeTask.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  /** The minute tick: decides a micro-run is due and enqueues the finalize job. */
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
        payload: {},
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
