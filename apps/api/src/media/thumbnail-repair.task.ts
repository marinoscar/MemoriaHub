// =============================================================================
// Thumbnail Repair Scheduled Task (enqueue-only; `enqueueHousekeepingJob` since
// RETRO-C9, #612)
// =============================================================================
//
// Hourly cron that enqueues the global `thumbnail_repair` job when none is
// already pending or running (`enqueueHousekeepingJob`: system job, housekeeping
// priority 100 as before, never throws). `THUMBNAIL_REPAIR_ENABLED=false` stops
// the enqueue.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ThumbnailRepairTask {
  private readonly logger = new Logger(ThumbnailRepairTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledRepair(): Promise<void> {
    // Environment kill-switch (mirrors STORAGE_PROCESSING_STUCK_RESET_ENABLED)
    if (process.env['THUMBNAIL_REPAIR_ENABLED'] === 'false') return;
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: 'thumbnail_repair',
      what: 'thumbnail repair',
    });
  }
}
