// =============================================================================
// Expiring-Share Notification Scheduled Task (epic #240, issue #247)
// =============================================================================
//
// Daily 9am cron driving ShareExpiringService.sweep(). Same shape as
// NotificationReconcileTask / TrashPurgeTask / ThumbnailRepairTask: a `@Cron`,
// an env kill-switch, an in-process overlap guard, and a handler that never
// throws.
//
// Like #246's reconcile — and unlike TrashPurgeTask — the work is done IN
// PROCESS rather than by enqueuing an `enrichment_jobs` row: the sweep is a
// bounded set of small reads and inserts, and a new job type would need a
// schema change for no benefit.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ShareExpiringService } from './share-expiring.service';

@Injectable()
export class ShareExpiringTask {
  private readonly logger = new Logger(ShareExpiringTask.name);

  /**
   * In-process overlap guard, single-process only and sufficient for the same
   * reason #246's is: the `data.notifiedFor` stamp makes the sweep idempotent,
   * so two concurrent sweeps duplicate effort, never rows.
   */
  private sweepInFlight = false;

  constructor(private readonly shareExpiring: ShareExpiringService) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async handleScheduledSweep(): Promise<void> {
    // Environment kill-switch (mirrors NOTIFICATIONS_RECONCILE_ENABLED).
    if (process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'] === 'false') {
      return;
    }

    if (this.sweepInFlight) {
      this.logger.debug('Share-expiring sweep already in flight; skipping tick');
      return;
    }
    this.sweepInFlight = true;

    try {
      const startedAt = Date.now();
      const result = await this.shareExpiring.sweep();

      // Quiet on a no-op tick — most deployments have no share expiring today,
      // and a daily log line saying so is noise.
      if (result.emitted > 0 || result.errors > 0) {
        this.logger.log(
          `Share-expiring notifications swept ${result.candidates} share(s) in ` +
            `${Date.now() - startedAt}ms: ${result.emitted} emitted, ` +
            `${result.skipped} already notified` +
            (result.errors > 0 ? `, ${result.errors} failed` : ''),
        );
      }
    } catch (err) {
      this.logger.error('Share-expiring notification sweep failed', err as Error);
    } finally {
      this.sweepInFlight = false;
    }
  }
}
