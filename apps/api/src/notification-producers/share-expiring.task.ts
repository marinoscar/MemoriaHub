// =============================================================================
// Expiring-Share Notification Scheduled Task (epic #240, issue #247;
// enqueue-only since RETRO-C9, #612)
// =============================================================================
//
// Daily 9 AM cron that ENQUEUES `shares.expiring_sweep`
// (`ShareExpiringHandler`, which runs `ShareExpiringService.sweep()`). Root
// rule: every long-running activity is a queue job (`cron-enqueue-only`
// conformance suite).
//
// `NOTIFICATIONS_SHARE_EXPIRING_ENABLED=false` stops the enqueue. The old
// in-process overlap guard is gone: `enqueueHousekeepingJob` skips the tick
// while a sweep is pending or running. Never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { SHARE_EXPIRING_SWEEP_TYPE } from './notification-cron-jobs.constants';

@Injectable()
export class ShareExpiringTask {
  private readonly logger = new Logger(ShareExpiringTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async handleScheduledSweep(): Promise<void> {
    // Environment kill-switch (mirrors NOTIFICATIONS_RECONCILE_ENABLED).
    if (process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'] === 'false') return;
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: SHARE_EXPIRING_SWEEP_TYPE,
      what: 'expiring-share notification sweep',
    });
  }
}
