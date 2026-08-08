// =============================================================================
// Node Backup Staleness Sweep (issue #312, epic #308)
// =============================================================================
//
// Every 10 minutes, marks `running` NodeBackupRun rows whose lastAckAt has
// fallen outside the backup.runStaleMinutes window as `stale` (+ finishedAt),
// releasing the single-active-run guard a crashed node would otherwise hold
// forever. Mirrors the never-throws task pattern of trash-purge.task.ts.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NodeBackupService } from './node-backup.service';

@Injectable()
export class NodeBackupStaleTask {
  private readonly logger = new Logger(NodeBackupStaleTask.name);

  constructor(private readonly backupService: NodeBackupService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleStaleSweep(): Promise<void> {
    try {
      const released = await this.backupService.markStaleRuns();
      if (released > 0) {
        this.logger.log(`Marked ${released} stale node backup run(s)`);
      }
    } catch (err) {
      this.logger.error('node backup staleness sweep failed', err as Error);
    }
  }
}
