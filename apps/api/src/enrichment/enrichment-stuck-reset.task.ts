// =============================================================================
// Enrichment Stuck Reset Scheduled Task
// =============================================================================
//
// Every 10 minutes, reset enrichment jobs that are stuck in "running" state
// past a configurable threshold. Jobs get stuck when the process is OOM-killed
// or restarted mid-flight — they remain running=true with no worker to complete
// them. This cron auto-recovers them so they can be re-claimed on the next tick.
//
// The threshold is resolved by EnrichmentAdminService.resetStuck() from the
// jobs.stuckThresholdMinutes system setting (default 3 minutes; the legacy
// ENRICHMENT_STUCK_MINUTES env var acts as fallback when the setting is unset),
// so stats, the admin endpoint, and this cron all share one threshold.
//
// resetStuck() is also the ONLY lease-expiry reaper: it requeues (or, budget
// exhausted, fails) running jobs whose lease_expires_at has passed — including
// jobs claimed by DISTRIBUTED WORKER NODES that died without renewing. That
// makes this a CONTROL-PLANE duty, not a worker duty, so it deliberately does
// NOT follow the enrichment worker's mode/enable switches: an API tier running
// as a pure control plane (ENRICHMENT_WORKER_MODE=off/system with an external
// node fleet) still depends on this cron. The only opt-out is the dedicated
// ENRICHMENT_REAPER_ENABLED=false flag, for instances that must never touch
// the queue (e.g. read replicas) when some other instance runs the reaper.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EnrichmentAdminService } from './enrichment-admin.service';

@Injectable()
export class EnrichmentStuckResetTask {
  private readonly logger = new Logger(EnrichmentStuckResetTask.name);

  constructor(private readonly enrichmentAdminService: EnrichmentAdminService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleStuckReset(): Promise<void> {
    // Deliberately NOT gated on the enrichment worker's mode/enable switches:
    // this is the lease-expiry reaper external node fleets depend on, so it
    // must run even on a control-plane instance whose in-process worker is off
    // (see the header comment). Dedicated opt-out only.
    if (process.env['ENRICHMENT_REAPER_ENABLED'] === 'false') {
      return;
    }

    try {
      // No argument: the service resolves the settings-driven threshold.
      const { reset, failed } = await this.enrichmentAdminService.resetStuck();
      if (reset > 0 || failed > 0) {
        this.logger.log(
          `Reset ${reset} stuck enrichment job(s)` +
            (failed > 0 ? `; failed ${failed} with exhausted attempts` : ''),
        );
      }
    } catch (err) {
      this.logger.error('Failed to reset stuck enrichment jobs', err as Error);
    }
  }
}
