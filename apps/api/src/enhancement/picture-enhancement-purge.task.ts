// =============================================================================
// Picture Enhancement Purge Scheduled Task (enqueue-only;
// `enqueueHousekeepingJob` since RETRO-C9, #612)
// =============================================================================
//
// Hourly cron that enqueues the global `picture_enhancement_purge` job when none
// is already pending or running (`enqueueHousekeepingJob`: system job,
// housekeeping priority 100 as before, never throws). Gated on the worker mode
// so only worker instances schedule the sweep.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { configuredWorkerMode } from '../platform/jobs/legacy-env';

@Injectable()
export class PictureEnhancementPurgeTask {
  private readonly logger = new Logger(PictureEnhancementPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledPurge(): Promise<void> {
    // Only worker instances create/sweep staging objects.
    if (configuredWorkerMode() === 'off') return;
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: 'picture_enhancement_purge',
      what: 'picture enhancement purge',
    });
  }
}
