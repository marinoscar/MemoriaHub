// =============================================================================
// shares.expiring_sweep (epic #240, issue #247; a job since RETRO-C9, #612)
// =============================================================================
//
// Warns each share creator whose public link expires within the lead window
// (`ShareExpiringService.sweep`). The daily 9 AM `ShareExpiringTask` only
// enqueues it.
//
// A GLOBAL system job (`orgId: null`): the queue's single-flight dedup replaces
// the old in-process `sweepInFlight` guard, and the `data.notifiedFor` stamp
// keeps the sweep idempotent as before. SERVER-ONLY (no node-result pair).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';

import { SHARE_EXPIRING_SWEEP_TYPE } from './notification-cron-jobs.constants';
import { ShareExpiringService } from './share-expiring.service';

@Injectable()
export class ShareExpiringHandler implements JobHandler, OnModuleInit {
  readonly type = SHARE_EXPIRING_SWEEP_TYPE;

  readonly label = 'Expiring-share notifications';

  /** A keyset sweep over the shares expiring within a week: five minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(ShareExpiringHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly shareExpiring: ShareExpiringService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const startedAt = Date.now();
    const result = await this.shareExpiring.sweep();

    // Quiet on a no-op run: most deployments have no share expiring today.
    if (result.emitted > 0 || result.errors > 0) {
      this.logger.log(
        `Share-expiring notifications swept ${result.candidates} share(s) in ` +
          `${Date.now() - startedAt}ms: ${result.emitted} emitted, ` +
          `${result.skipped} already notified` +
          (result.errors > 0 ? `, ${result.errors} failed` : ''),
      );
    }
  }
}
