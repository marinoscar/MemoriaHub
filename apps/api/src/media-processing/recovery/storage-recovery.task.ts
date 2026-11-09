// =============================================================================
// StorageRecoveryTask: the 10-minute stuck-object recovery cron (RETRO-D1b, #567)
// =============================================================================
//
// Decides only that recovery is due and ENQUEUES it (root rule: every
// long-running activity is a queue job; `cron-enqueue-only` conformance suite).
// The scan and the per-object re-queue are `media.storage.recover_stuck`
// (`StorageRecoveryHandler`). `enqueueHousekeepingJob` skips the tick when a job
// of the type is already pending or running, queues a system job at the
// housekeeping priority, and never throws.
//
// `STORAGE_PROCESSING_STUCK_RESET_ENABLED=false` turns the cron off (the admin
// endpoint still works).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_RECOVER_STUCK_TYPE } from './storage-recovery.constants';

@Injectable()
export class StorageRecoveryTask {
  private readonly logger = new Logger(StorageRecoveryTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async enqueueRecovery(): Promise<void> {
    if (process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] === 'false') return;
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: STORAGE_RECOVER_STUCK_TYPE,
      what: 'stuck storage object recovery',
    });
  }
}
