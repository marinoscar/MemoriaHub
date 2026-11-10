// =============================================================================
// Node Backup Staleness Sweep (issue #312, epic #308; enqueue-only since
// RETRO-C9, #612)
// =============================================================================
//
// Every 10 minutes, ENQUEUES `node_backup.stale_sweep` (`NodeBackupStaleHandler`),
// which releases `running` NodeBackupRun rows whose lastAckAt has fallen outside
// the backup.runStaleMinutes window. Root rule: every long-running activity is a
// queue job (`cron-enqueue-only` conformance suite). `enqueueHousekeepingJob`
// skips the tick while a sweep is pending or running and never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { NODE_BACKUP_STALE_SWEEP_TYPE } from './node-backup-stale.handler';

@Injectable()
export class NodeBackupStaleTask {
  private readonly logger = new Logger(NodeBackupStaleTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleStaleSweep(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: NODE_BACKUP_STALE_SWEEP_TYPE,
      what: 'node backup staleness sweep',
    });
  }
}
