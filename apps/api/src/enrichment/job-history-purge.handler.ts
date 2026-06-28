// =============================================================================
// Job History Purge Enrichment Handler
// =============================================================================
//
// Global enrichment job that keeps the enrichment_jobs table from growing
// endlessly. Hard-deletes ONLY terminal rows (succeeded | failed) whose
// finishedAt is older than the configured jobs.history.retentionDays. Pending
// and running jobs are never touched.
//
// Deletes in bounded batches so each DELETE statement stays short and never
// holds locks long enough to stall the worker's row claims. Runs via the shared
// enrichment worker queue (retries, visibility in /admin/jobs, and the dedup
// guarantee of (type, mediaItemId IS NULL)).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, JobStatus, Prisma } from '@prisma/client';
import { EnrichmentHandler } from './enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

const DEFAULT_RETENTION_DAYS = 30;
const BATCH_SIZE = 5000;

@Injectable()
export class JobHistoryPurgeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'job_history_purge';

  private readonly logger = new Logger(JobHistoryPurgeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    const enabled =
      (await this.systemSettings.getSettingValue<boolean>('jobs.history.purgeEnabled')) ?? true;

    if (!enabled) {
      this.logger.log('job_history_purge: disabled via jobs.history.purgeEnabled; skipping');
      return;
    }

    const retentionDays =
      (await this.systemSettings.getSettingValue<number>('jobs.history.retentionDays')) ??
      DEFAULT_RETENTION_DAYS;

    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    this.logger.log(
      `job_history_purge: starting — retentionDays=${retentionDays}, cutoff=${cutoff.toISOString()}`,
    );

    const where: Prisma.EnrichmentJobWhereInput = {
      status: { in: [JobStatus.succeeded, JobStatus.failed] },
      finishedAt: { not: null, lt: cutoff },
    };

    // Lock-safe batched delete: select a bounded set of ids, delete them, repeat
    // until nothing matches. Keeps each statement short so it never stalls the
    // worker's claim transaction.
    let totalDeleted = 0;
    for (;;) {
      const batch = await this.prisma.enrichmentJob.findMany({
        where,
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) break;

      const ids = batch.map((b) => b.id);
      const result = await this.prisma.enrichmentJob.deleteMany({
        where: { id: { in: ids } },
      });
      totalDeleted += result.count;

      if (batch.length < BATCH_SIZE) break;
    }

    this.logger.log(`job_history_purge: deleted ${totalDeleted} terminal job rows past cutoff`);
  }
}
