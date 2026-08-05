// =============================================================================
// Review-Queue Notification Reconcile Scheduled Task (epic #240, issue #246)
// =============================================================================
//
// Hourly cron that re-states every circle's review-queue notifications against
// the real pending counts. Mirrors TrashPurgeTask / ThumbnailRepairTask in
// shape (hourly @Cron, `*_ENABLED=false` env kill-switch, never throws), but
// does its work IN PROCESS rather than enqueuing an enrichment job: the sweep
// is a bounded set of small reads and upserts, and adding a job type would
// require a schema change for no benefit.
//
// Deliberately NOT per-request and NOT per-upload. Producing a notification on
// every burst/duplicate/suggestion created is precisely the fan-out this
// feature exists to avoid — 929 pending duplicate groups must be ONE row whose
// count is 929, and a periodic reconcile is what guarantees that no matter how
// many (or how few) of the underlying events were observed.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

@Injectable()
export class NotificationReconcileTask {
  private readonly logger = new Logger(NotificationReconcileTask.name);

  /**
   * In-process overlap guard. A sweep over a large deployment can outlive its
   * hourly slot, and two concurrent sweeps would do identical work twice.
   *
   * Single-process only, by design and sufficient: across replicas the writes
   * are already idempotent (upsertState folds a concurrent insert into the
   * existing row rather than racing the partial unique index into a P2002), so
   * the worst case is duplicated effort, never a duplicated row.
   */
  private sweepInFlight = false;

  constructor(private readonly reconcile: ReviewQueueReconcileService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledReconcile(): Promise<void> {
    // Environment kill-switch (mirrors THUMBNAIL_REPAIR_ENABLED).
    if (process.env['NOTIFICATIONS_RECONCILE_ENABLED'] === 'false') {
      return;
    }

    if (this.sweepInFlight) {
      this.logger.debug('Review-queue reconcile already in flight; skipping tick');
      return;
    }
    this.sweepInFlight = true;

    try {
      const startedAt = Date.now();
      const result = await this.reconcile.reconcileAll();

      // Quiet on a no-op tick — the steady state for a deployment with every
      // queue drained is "nothing changed", and an hourly log line saying so
      // is noise.
      if (result.upserted > 0 || result.resolved > 0 || result.reunread > 0 || result.errors > 0) {
        this.logger.log(
          `Review-queue notifications reconciled across ${result.circles} circle(s) in ` +
            `${Date.now() - startedAt}ms: ${result.upserted} upserted, ` +
            `${result.resolved} resolved, ${result.reunread} re-marked unread` +
            (result.errors > 0 ? `, ${result.errors} circle(s) failed` : ''),
        );
      }
    } catch (err) {
      this.logger.error('Review-queue notification reconcile failed', err as Error);
    } finally {
      this.sweepInFlight = false;
    }
  }
}
