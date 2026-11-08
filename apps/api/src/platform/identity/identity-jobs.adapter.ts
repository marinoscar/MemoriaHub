import { Injectable, type Logger } from '@nestjs/common';
import { JobReason, MhLegacyJobStatus } from '@prisma/client';
import type { EnrichmentJob } from '@prisma/client';
import type { IdentityJobHandler, IdentityJobsPort } from '@marinoscar/platform-api/identity';

import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// IDENTITY_JOBS -> MemoriaHub's `enrichment_jobs` queue (RETRO-B2, issue #611)
// =============================================================================
//
// Identity's two housekeeping job types (`auth.token.cleanup`,
// `auth.device-code.cleanup`) are queue jobs: the slice's enqueue-only crons call
// `enqueueHousekeepingJob`, and its two handlers register through
// `registerHandler`. This replaces the app's two inline `@Cron` bodies
// (`auth/tasks/token-cleanup.task.ts`, `device-auth/tasks/device-code-cleanup.task.ts`).
//
// The housekeeping row is global (`mediaItemId: null`, `circleId: null`), low
// priority, and skipped when one is already pending or running, the same rule as
// `JobHistoryPurgeTask`. Both types are server-only (no node pair).
//
// PLATFORM-ADOPTION-SHIM(RETRO-C1): re-pointed at the platform `JobsService`
// (`enqueueHousekeepingJob` of `@marinoscar/platform-api/jobs`) when the jobs
// slice replaces `enrichment_jobs`.
// =============================================================================

@Injectable()
export class IdentityJobsAdapter implements IdentityJobsPort {
  constructor(
    private readonly jobs: EnrichmentJobService,
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  async enqueueHousekeepingJob(options: { type: string; what: string; logger: Logger }): Promise<void> {
    const { type, what, logger } = options;
    try {
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: { type, status: { in: [MhLegacyJobStatus.pending, MhLegacyJobStatus.running] } },
        select: { id: true },
      });
      if (existing) {
        logger.debug(`${type} job already queued; skipping ${what}`);
        return;
      }
      await this.jobs.enqueue({
        type,
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100, // background housekeeping
      });
      logger.log(`${type} job enqueued (${what})`);
    } catch (err) {
      logger.error(`${what} could not be enqueued: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  registerHandler(handler: IdentityJobHandler): void {
    const appHandler: EnrichmentHandler = {
      type: handler.type,
      process: (job: EnrichmentJob) => handler.process({ id: job.id }),
    };
    this.registry.register(appHandler);
  }
}
