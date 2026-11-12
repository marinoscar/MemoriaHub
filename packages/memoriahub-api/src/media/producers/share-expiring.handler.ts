// =============================================================================
// shares.expiring_sweep (epic #240, issue #247; a job since RETRO-C9, #612; RETRO-J10 #624)
// =============================================================================
//
// Warns each link creator whose public link expires within the lead window (`ShareExpiringService.sweep`).
// The daily 9 AM `ShareExpiringTask` only enqueues it.
//
// A GLOBAL system job (`orgId: null`): the queue's single-flight dedup replaces the old in-process
// `sweepInFlight` guard, and the `data.notifiedFor` stamp keeps the sweep idempotent as before.
// SERVER-ONLY (no node-result pair).
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { MEMORIAHUB_JOBS, type MemoriahubJobHandler, type MemoriahubJobProfile, type MemoriahubJobsPort } from '../../ports/index.js';
import { SHARE_EXPIRING_SWEEP_TYPE } from './share-expiring.constants.js';
import { ShareExpiringService } from './share-expiring.service.js';

/** The `shares.expiring_sweep` job (server-only, a system job). @stability experimental */
@Injectable()
export class ShareExpiringHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = SHARE_EXPIRING_SWEEP_TYPE;

  readonly label = 'Expiring-share notifications';

  /** A keyset sweep over the links expiring within a week: five minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(ShareExpiringHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly shareExpiring: ShareExpiringService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs the sweep. */
  async process(): Promise<void> {
    const startedAt = Date.now();
    const result = await this.shareExpiring.sweep();

    // Quiet on a no-op run: most deployments have no link expiring today.
    if (result.emitted > 0 || result.errors > 0) {
      this.logger.log(
        `Share-expiring notifications swept ${result.candidates} link(s) in ` +
          `${Date.now() - startedAt}ms: ${result.emitted} emitted, ` +
          `${result.skipped} already notified` +
          (result.errors > 0 ? `, ${result.errors} failed` : ''),
      );
    }
  }
}
