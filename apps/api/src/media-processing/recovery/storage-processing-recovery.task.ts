// =============================================================================
// Storage Processing Recovery Scheduled Task
// =============================================================================
//
// Every 10 minutes, reprocess StorageObjects stuck at status='processing' past
// a configurable threshold. Objects get stuck there when the API process is
// OOM-killed, crashed, or restarted mid-pipeline (content-hash/exif/dimensions/
// video-probe/geocode/thumbnail/visual-hash) — the row is left with no worker
// to ever finish it. This cron auto-recovers them by re-running the full
// pipeline, capped at STORAGE_PROCESSING_MAX_RETRIES attempts per object.
//
// The threshold defaults to 10 minutes (configurable via
// STORAGE_PROCESSING_STUCK_MINUTES). Mirrors EnrichmentStuckResetTask's shape.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StorageProcessingRecoveryService } from './storage-processing-recovery.service';

@Injectable()
export class StorageProcessingRecoveryTask {
  private readonly logger = new Logger(StorageProcessingRecoveryTask.name);

  constructor(private readonly recoveryService: StorageProcessingRecoveryService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleStuckRecovery(): Promise<void> {
    if (process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] === 'false') {
      return;
    }

    try {
      const { claimed, reprocessed, exhausted, errors } = await this.recoveryService.recoverStuckObjects();
      if (claimed > 0) {
        this.logger.log(
          `Recovered ${reprocessed}/${claimed} stuck storage object(s) (${exhausted} exhausted, ${errors} errors)`,
        );
      }
    } catch (err) {
      this.logger.error('Failed to recover stuck storage objects', err as Error);
    }
  }
}
