import { Injectable, type Logger } from '@nestjs/common';
import type { IdentityJobHandler, IdentityJobsPort } from '@marinoscar/platform-api/identity';
import { enqueueHousekeepingJob, JobHandlerRegistry, JobsService } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// IDENTITY_JOBS -> the platform queue (RETRO-B2, #611; re-pointed by RETRO-C1, #575)
// =============================================================================
//
// Identity's two housekeeping job types (`auth.token.cleanup`,
// `auth.device-code.cleanup`) are queue jobs: the slice's enqueue-only crons call
// `enqueueHousekeepingJob`, and its two handlers register through
// `registerHandler`. Both are server-only (no node pair): they delete credential
// rows, a privilege a worker node must never hold.
//
// The housekeeping row is global (no subject, `orgId: null`), priority 100, and
// skipped when one is already pending or running: that is the platform's
// `enqueueHousekeepingJob`, so the app keeps no copy of the rule.
// =============================================================================

@Injectable()
export class IdentityJobsAdapter implements IdentityJobsPort {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  async enqueueHousekeepingJob(options: { type: string; what: string; logger: Logger }): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: options.logger,
      type: options.type,
      what: options.what,
    });
  }

  registerHandler(handler: IdentityJobHandler): void {
    this.registry.register(handler);
  }
}
