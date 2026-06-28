// =============================================================================
// Job History Purge Enrichment Handler
// =============================================================================
//
// Global enrichment job that keeps the enrichment_jobs table from growing
// endlessly. Hard-deletes ONLY terminal rows (succeeded | failed) whose
// finishedAt is older than the configured jobs.history.retentionDays. Pending
// and running jobs are never touched.
//
// Before deleting each batch, the rows are folded into the JobStatsRollup table
// (per-type lifetime counts + total duration) in the SAME transaction as the
// delete, so all-time analytics survive the purge with no double-count or loss.
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

    // Lock-safe batched delete: select a bounded set of rows, fold them into the
    // lifetime rollup, delete them — repeat until nothing matches. Each batch's
    // rollup upserts + delete run in ONE transaction so a crash can never delete
    // a row without counting it (or count it without deleting it).
    let totalDeleted = 0;
    for (;;) {
      const batch = await this.prisma.enrichmentJob.findMany({
        where,
        select: { id: true, type: true, status: true, startedAt: true, finishedAt: true },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) break;

      const deltas = this.aggregateBatch(batch);
      const ids = batch.map((b) => b.id);

      const ops: Prisma.PrismaPromise<unknown>[] = [];
      for (const d of deltas.values()) {
        ops.push(
          this.prisma.jobStatsRollup.upsert({
            where: { type: d.type },
            create: {
              type: d.type,
              succeededCount: d.succeeded,
              failedCount: d.failed,
              sumDurationMs: d.sumDurationMs,
              durationSamples: d.durationSamples,
            },
            update: {
              succeededCount: { increment: d.succeeded },
              failedCount: { increment: d.failed },
              sumDurationMs: { increment: d.sumDurationMs },
              durationSamples: { increment: d.durationSamples },
            },
          }),
        );
      }
      ops.push(this.prisma.enrichmentJob.deleteMany({ where: { id: { in: ids } } }));

      const results = await this.prisma.$transaction(ops);
      // Last op is the deleteMany — its count is { count: number }.
      const deleteResult = results[results.length - 1] as { count: number };
      totalDeleted += deleteResult.count;

      if (batch.length < BATCH_SIZE) break;
    }

    this.logger.log(
      `job_history_purge: rolled up + deleted ${totalDeleted} terminal job rows past cutoff`,
    );
  }

  /**
   * Aggregate a batch of soon-to-be-deleted rows into per-type lifetime deltas.
   * Duration (ms) is summed only for succeeded rows that have both timestamps.
   */
  private aggregateBatch(
    rows: Array<{
      type: string;
      status: JobStatus;
      startedAt: Date | null;
      finishedAt: Date | null;
    }>,
  ): Map<string, {
    type: string;
    succeeded: number;
    failed: number;
    sumDurationMs: number;
    durationSamples: number;
  }> {
    const map = new Map<
      string,
      { type: string; succeeded: number; failed: number; sumDurationMs: number; durationSamples: number }
    >();

    for (const r of rows) {
      let d = map.get(r.type);
      if (!d) {
        d = { type: r.type, succeeded: 0, failed: 0, sumDurationMs: 0, durationSamples: 0 };
        map.set(r.type, d);
      }
      if (r.status === JobStatus.succeeded) {
        d.succeeded += 1;
        if (r.startedAt && r.finishedAt) {
          const ms = r.finishedAt.getTime() - r.startedAt.getTime();
          if (ms >= 0) {
            d.sumDurationMs += ms;
            d.durationSamples += 1;
          }
        }
      } else if (r.status === JobStatus.failed) {
        d.failed += 1;
      }
    }

    return map;
  }
}
