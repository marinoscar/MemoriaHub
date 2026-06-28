// =============================================================================
// Enrichment Stuck Reset Scheduled Task
// =============================================================================
//
// Every 10 minutes, reset enrichment jobs that are stuck in "running" state
// past a configurable threshold. Jobs get stuck when the process is OOM-killed
// or restarted mid-flight — they remain running=true with no worker to complete
// them. This cron auto-recovers them so they can be re-claimed on the next tick.
//
// The threshold defaults to 15 minutes (configurable via ENRICHMENT_STUCK_MINUTES).
// Only active on instances that run the enrichment worker (same disable flag).
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
    // Respect the same disable flag as the enrichment worker so non-worker
    // instances (e.g. web-only pods, read replicas) do not reset stuck jobs.
    if (process.env['ENRICHMENT_WORKER_ENABLED'] === 'false') {
      return;
    }

    const minutes = parseInt(process.env['ENRICHMENT_STUCK_MINUTES'] ?? '15', 10);

    try {
      const { reset } = await this.enrichmentAdminService.resetStuck(minutes);
      if (reset > 0) {
        this.logger.log(`Reset ${reset} stuck enrichment job(s)`);
      }
    } catch (err) {
      this.logger.error('Failed to reset stuck enrichment jobs', err as Error);
    }
  }
}
