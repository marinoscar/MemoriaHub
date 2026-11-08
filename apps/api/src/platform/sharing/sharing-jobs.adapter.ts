import { Injectable } from '@nestjs/common';
import {
  enqueueHousekeepingJob,
  JobHandlerRegistry,
  JobsService,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import type { SharingJobHandler, SharingJobsPort } from '@marinoscar/platform-api/sharing';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// SHARING_JOBS -> the platform queue (RETRO-I1, #562)
// =============================================================================
//
// The slice has one job type, `sharing.grants.prune` (revoked, expired and
// dangling grants past the retention window; type string permanent, pinned by
// `test/jobs/job-type-snapshot.spec.ts`). It is SERVER-ONLY: it declares no
// node pair, because it reads every resource type's `loadOwners`
// mid-computation. Its daily cron (`GrantsPruneTask`, 03:00) only enqueues,
// through the platform's `enqueueHousekeepingJob` (global row, `orgId: null`,
// priority 100, skipped while one is pending or running): root rule 1.
// =============================================================================

@Injectable()
export class SharingJobsAdapter implements SharingJobsPort {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  registerHandler(handler: SharingJobHandler): void {
    this.registry.register(handler as unknown as JobHandler);
  }

  async enqueueHousekeepingJob(options: {
    type: string;
    what: string;
    logger: { log(message: string): void; warn(message: string): void };
  }): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: options.logger as never,
      type: options.type,
      what: options.what,
    });
  }
}
