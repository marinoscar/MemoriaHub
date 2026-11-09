// =============================================================================
// Trash Purge Scheduled Task (enqueue-only; `enqueueHousekeepingJob` since
// RETRO-C9, #612)
// =============================================================================
//
// Hourly cron that enqueues the global `trash_purge` job (`TrashPurgeHandler`)
// when none is already pending or running. `enqueueHousekeepingJob` does that
// check, queues a system job (`orgId: null`) at the housekeeping priority (100,
// the same low priority as before) and never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TrashPurgeTask {
  private readonly logger = new Logger(TrashPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledPurge(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: 'trash_purge',
      what: 'trash purge',
    });
  }
}
