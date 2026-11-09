// =============================================================================
// notifications.review_queue_reconcile (epic #240, issue #246; a job since
// RETRO-C9, #612)
// =============================================================================
//
// Re-states every circle's review-queue notifications against the real pending
// counts (`ReviewQueueReconcileService.reconcileAll`). The hourly
// `NotificationReconcileTask` only enqueues it.
//
// A GLOBAL system job (`orgId: null`): the queue's single-flight dedup (one
// pending/running row per type) replaces the old in-process `sweepInFlight`
// overlap guard. Across replicas the writes were already idempotent (upsertState
// folds a concurrent insert into the live row). SERVER-ONLY (no node-result
// pair): it reads every circle and writes notifications.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';

import { REVIEW_QUEUE_RECONCILE_TYPE } from './notification-cron-jobs.constants';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

@Injectable()
export class ReviewQueueReconcileHandler implements JobHandler, OnModuleInit {
  readonly type = REVIEW_QUEUE_RECONCILE_TYPE;

  readonly label = 'Review-queue notification reconcile';

  /** Every circle, keyset-paged: fifteen minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(ReviewQueueReconcileHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly reconcile: ReviewQueueReconcileService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const startedAt = Date.now();
    const result = await this.reconcile.reconcileAll();

    // Quiet on a no-op run: the steady state for a deployment with every queue
    // drained is "nothing changed", and an hourly log line saying so is noise.
    if (result.upserted > 0 || result.resolved > 0 || result.errors > 0) {
      this.logger.log(
        `Review-queue notifications reconciled across ${result.circles} circle(s) in ` +
          `${Date.now() - startedAt}ms: ${result.upserted} upserted, ` +
          `${result.resolved} resolved` +
          (result.errors > 0 ? `, ${result.errors} circle(s) failed` : ''),
      );
    }
  }
}
