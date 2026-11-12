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

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { MEMORIAHUB_JOBS, type MemoriahubJobHandler, type MemoriahubJobProfile, type MemoriahubJobsPort } from '../../ports/index.js';
import { REVIEW_QUEUE_RECONCILE_TYPE } from './review-queue.constants.js';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service.js';

/** The `notifications.review_queue_reconcile` job (server-only, a system job). @stability experimental */
@Injectable()
export class ReviewQueueReconcileHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = REVIEW_QUEUE_RECONCILE_TYPE;

  readonly label = 'Review-queue notification reconcile';

  /** Every circle, keyset-paged: fifteen minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 3 };

  private readonly logger = new Logger(ReviewQueueReconcileHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly reconcile: ReviewQueueReconcileService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Reconciles every library. */
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
