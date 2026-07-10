// =============================================================================
// Enrichment Admin Service
// =============================================================================
//
// Admin-only service for inspecting and managing the enrichment job queue.
// Provides stats, paginated listing, retry/reset operations, and deletion.
// =============================================================================

import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, JobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { defaultStuckThresholdMinutes } from '../common/types/settings.types';
import { ENRICHMENT_MAX_ATTEMPTS } from './enrichment-job.worker';

/** Default rolling window (days) for the duration-history aggregate. */
export const INSIGHTS_WINDOW_DAYS = 7;

/** Fallback per-job duration (ms) used for ETA when no history exists at all. */
const ETA_FALLBACK_MS = 5000;

// ---------------------------------------------------------------------------
// Return shape interfaces
// ---------------------------------------------------------------------------

export interface JobStatsByType {
  type: string;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
}

export interface JobStats {
  total: number;
  byStatus: {
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  byType: JobStatsByType[];
  stuckRunning: number;
  /** Effective stuck threshold (minutes) used for the stuckRunning count. */
  stuckThresholdMinutes: number;
  /** Number of pending jobs currently deferred (scheduledFor > now). */
  scheduled: number;
}

export interface JobListItem {
  id: string;
  type: string;
  status: JobStatus;
  reason: string;
  priority: number;
  mediaItemId: string | null;
  circleId: string | null;
  attempts: number;
  lastError: string | null;
  providerKey: string | null;
  modelVersion: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  scheduledFor: Date | null;
  rateLimitedAt: Date | null;
  rateLimitHits: number;
}

export interface JobListResult {
  items: JobListItem[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

// ---------------------------------------------------------------------------
// Job Insights / ETA shapes
// ---------------------------------------------------------------------------

export interface JobDurationStats {
  type: string;
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  throughputPerMin: number;
}

export interface JobInsights {
  computedAt: string;
  windowDays: number;
  concurrency: number;
  live: {
    total: number;
    byStatus: { pending: number; running: number; succeeded: number; failed: number };
    pending: number;
    running: number;
    failed: number;
    scheduled: number;
    rateLimited: number;
    retried: number;
    byType: JobStatsByType[];
  };
  history: {
    overall: Omit<JobDurationStats, 'type'>;
    byType: JobDurationStats[];
  };
  eta: {
    totalRemaining: number;
    etaMs: number | null;
    basis: 'live' | 'partial' | 'none';
    perType: Array<{
      type: string;
      remaining: number;
      avgMs: number | null;
      etcMs: number | null;
    }>;
  };
  // All-time totals that survive history purging (live rows + rollup of purged
  // rows). Counts and average duration only — no percentiles.
  lifetime: {
    overall: JobLifetimeStats;
    byType: Array<JobLifetimeStats & { type: string }>;
  };
}

export interface JobLifetimeStats {
  succeeded: number;
  failed: number;
  total: number;
  avgMs: number;
  samples: number;
}

export type ProcessedWithinWindow = '4h' | '24h' | '7d' | '30d' | 'all';

export interface ListJobsFilter {
  status?: JobStatus;
  type?: string;
  page: number;
  pageSize: number;
  /** When true, restrict to pending jobs with scheduledFor > now (backoff/deferred). */
  scheduled?: boolean;
  /**
   * Filter by activity time: COALESCE(finishedAt, createdAt) >= cutoff.
   * When omitted or 'all', no time filter is applied.
   */
  processedWithin?: ProcessedWithinWindow;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class EnrichmentAdminService {
  private readonly logger = new Logger(EnrichmentAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SystemSettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // Stuck-threshold helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective stuck threshold (minutes) shared by getStats and
   * resetStuck: system setting jobs.stuckThresholdMinutes, falling back to the
   * legacy ENRICHMENT_STUCK_MINUTES env var, else 3. getSettings() is cached
   * in-process (5 s TTL) so this adds no per-call DB round-trip.
   */
  private async getStuckThresholdMinutes(): Promise<number> {
    const settings = await this.settingsService.getSettings();
    const configured = settings.jobs?.stuckThresholdMinutes;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return defaultStuckThresholdMinutes();
  }

  /**
   * Where-clause matching running jobs stuck past the given threshold.
   * Includes zombie rows with startedAt=null (claimed but never stamped — e.g.
   * the process died between claim and stamp, or the terminal-status write was
   * lost), aged by createdAt instead, so they are counted and recoverable.
   */
  private stuckRunningWhere(threshold: Date): Prisma.EnrichmentJobWhereInput {
    return {
      status: JobStatus.running,
      OR: [
        { startedAt: { lt: threshold } },
        { startedAt: null, createdAt: { lt: threshold } },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  async getStats(): Promise<JobStats> {
    const stuckThresholdMinutes = await this.getStuckThresholdMinutes();
    const stuckThreshold = new Date(Date.now() - stuckThresholdMinutes * 60 * 1000);

    const now = new Date();

    const [statusGroups, typeStatusGroups, stuckCount, scheduledCount] = await Promise.all([
      // Count per status
      this.prisma.enrichmentJob.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      // Count per (type, status)
      this.prisma.enrichmentJob.groupBy({
        by: ['type', 'status'],
        _count: { id: true },
      }),
      // Count stuck running jobs (incl. startedAt=null zombies)
      this.prisma.enrichmentJob.count({
        where: this.stuckRunningWhere(stuckThreshold),
      }),
      // Count pending jobs that are backed off (scheduledFor in the future)
      this.prisma.enrichmentJob.count({
        where: {
          status: JobStatus.pending,
          scheduledFor: { gt: now },
        },
      }),
    ]);

    // Build byStatus map
    const byStatus = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    let total = 0;

    for (const row of statusGroups) {
      const count = row._count.id;
      total += count;
      if (row.status === JobStatus.pending) byStatus.pending = count;
      else if (row.status === JobStatus.running) byStatus.running = count;
      else if (row.status === JobStatus.succeeded) byStatus.succeeded = count;
      else if (row.status === JobStatus.failed) byStatus.failed = count;
    }

    // Build byType array — collect all types first
    const typeMap = new Map<string, JobStatsByType>();
    for (const row of typeStatusGroups) {
      const { type, status } = row;
      const count = row._count.id;

      if (!typeMap.has(type)) {
        typeMap.set(type, { type, pending: 0, running: 0, succeeded: 0, failed: 0, total: 0 });
      }

      const entry = typeMap.get(type)!;
      entry.total += count;
      if (status === JobStatus.pending) entry.pending = count;
      else if (status === JobStatus.running) entry.running = count;
      else if (status === JobStatus.succeeded) entry.succeeded = count;
      else if (status === JobStatus.failed) entry.failed = count;
    }

    const byType = Array.from(typeMap.values()).sort((a, b) => a.type.localeCompare(b.type));

    return {
      total,
      byStatus,
      byType,
      stuckRunning: stuckCount,
      stuckThresholdMinutes,
      scheduled: scheduledCount,
    };
  }

  // -------------------------------------------------------------------------
  // getInsights — live counts + duration history + ETA (read-only, lock-safe)
  // -------------------------------------------------------------------------
  //
  // All queries here are pure SELECTs (incl. PERCENTILE_CONT ordered-set
  // aggregates), which take only a Postgres ACCESS SHARE lock — compatible with
  // the worker's ROW EXCLUSIVE / FOR UPDATE row claims, so they never block the
  // worker. The duration scan is bounded to `windowDays` so it never grows with
  // the unbounded retained history. Computed on demand only (no polling).
  // -------------------------------------------------------------------------

  async getInsights(windowDays: number = INSIGHTS_WINDOW_DAYS): Promise<JobInsights> {
    const concurrency = Math.max(
      1,
      parseInt(
        process.env['ENRICHMENT_WORKER_CONCURRENCY'] ??
          process.env['FACE_WORKER_CONCURRENCY'] ??
          '1',
        10,
      ) || 1,
    );

    const throughputSince = new Date(Date.now() - 60 * 60 * 1000);

    const [stats, rateLimited, retried, durByType, durOverall, tpByType, rollups, lifeDurByType] =
      await Promise.all([
        this.getStats(),
        this.prisma.enrichmentJob.count({
          where: {
            rateLimitHits: { gt: 0 },
            status: { in: [JobStatus.pending, JobStatus.running] },
          },
        }),
        this.prisma.enrichmentJob.count({ where: { attempts: { gt: 1 } } }),
        this.prisma.$queryRaw<
          Array<{ type: string; samples: number; avg_sec: number; p50_sec: number; p95_sec: number }>
        >(Prisma.sql`
          SELECT type,
            COUNT(*)::int AS samples,
            COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS avg_sec,
            COALESCE(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS p50_sec,
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS p95_sec
          FROM enrichment_jobs
          WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
            AND finished_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
          GROUP BY type
        `),
        this.prisma.$queryRaw<
          Array<{ samples: number; avg_sec: number; p50_sec: number; p95_sec: number }>
        >(Prisma.sql`
          SELECT
            COUNT(*)::int AS samples,
            COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS avg_sec,
            COALESCE(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS p50_sec,
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS p95_sec
          FROM enrichment_jobs
          WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
            AND finished_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
        `),
        this.prisma.enrichmentJob.groupBy({
          by: ['type'],
          where: { status: JobStatus.succeeded, finishedAt: { gte: throughputSince } },
          _count: { id: true },
        }),
        // Lifetime rollup of already-purged rows
        this.prisma.jobStatsRollup.findMany(),
        // All-time (un-windowed) duration sum + sample count over LIVE rows, so
        // lifetime avg = (rollup + live) sum / (rollup + live) samples
        this.prisma.$queryRaw<
          Array<{ type: string; samples: number; sum_sec: number }>
        >(Prisma.sql`
          SELECT type,
            COUNT(*)::int AS samples,
            COALESCE(SUM(EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::float8 AS sum_sec
          FROM enrichment_jobs
          WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
          GROUP BY type
        `),
      ]);

    const secToMs = (s: number): number => Math.round(s * 1000);

    // Throughput per type over the last hour (jobs / minute)
    const tpMap = new Map<string, number>();
    for (const row of tpByType) tpMap.set(row.type, row._count.id / 60);

    // Per-type duration history
    const historyByType: JobDurationStats[] = durByType
      .map((r) => ({
        type: r.type,
        samples: r.samples,
        avgMs: secToMs(r.avg_sec),
        p50Ms: secToMs(r.p50_sec),
        p95Ms: secToMs(r.p95_sec),
        throughputPerMin: tpMap.get(r.type) ?? 0,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));

    const histMap = new Map<string, JobDurationStats>();
    for (const h of historyByType) histMap.set(h.type, h);

    const o = durOverall[0] ?? { samples: 0, avg_sec: 0, p50_sec: 0, p95_sec: 0 };
    const overallThroughput =
      tpByType.reduce((sum, r) => sum + r._count.id, 0) / 60;
    const overall = {
      samples: o.samples,
      avgMs: secToMs(o.avg_sec),
      p50Ms: secToMs(o.p50_sec),
      p95Ms: secToMs(o.p95_sec),
      throughputPerMin: overallThroughput,
    };

    // -------- ETA --------
    let totalRemaining = 0;
    let usedFallback = false;
    let sumWorkMs = 0;
    const hasAnyHistory = overall.samples > 0;

    const perType = stats.byType.map((bt) => {
      const remaining = bt.pending + bt.running;
      totalRemaining += remaining;

      const typeHist = histMap.get(bt.type);
      const typeAvg = typeHist && typeHist.samples > 0 ? typeHist.avgMs : null;

      if (!hasAnyHistory) {
        return { type: bt.type, remaining, avgMs: null, etcMs: null };
      }

      // Effective per-job avg: type history → overall avg → hard fallback
      let effectiveAvg = typeAvg;
      if (effectiveAvg === null) {
        effectiveAvg = overall.avgMs > 0 ? overall.avgMs : ETA_FALLBACK_MS;
        if (remaining > 0) usedFallback = true;
      }

      const etcMs = remaining > 0 ? Math.round((remaining * effectiveAvg) / concurrency) : 0;
      if (remaining > 0) sumWorkMs += remaining * effectiveAvg;

      return { type: bt.type, remaining, avgMs: typeAvg, etcMs };
    });

    let etaMs: number | null;
    let basis: 'live' | 'partial' | 'none';
    if (totalRemaining === 0) {
      etaMs = 0;
      basis = 'live';
    } else if (!hasAnyHistory) {
      etaMs = null;
      basis = 'none';
    } else {
      etaMs = Math.round(sumWorkMs / concurrency);
      basis = usedFallback ? 'partial' : 'live';
    }

    // -------- Lifetime totals (live all-time + purged rollup) --------
    // Merge by type across: live status counts (stats.byType, all-time), live
    // duration sum/samples (lifeDurByType, all-time), and the purged rollup.
    const lifeMap = new Map<
      string,
      { type: string; succeeded: number; failed: number; sumMs: number; samples: number }
    >();
    const ensureLife = (type: string) => {
      let e = lifeMap.get(type);
      if (!e) {
        e = { type, succeeded: 0, failed: 0, sumMs: 0, samples: 0 };
        lifeMap.set(type, e);
      }
      return e;
    };
    for (const bt of stats.byType) {
      const e = ensureLife(bt.type);
      e.succeeded += bt.succeeded;
      e.failed += bt.failed;
    }
    for (const r of lifeDurByType) {
      const e = ensureLife(r.type);
      e.sumMs += r.sum_sec * 1000;
      e.samples += r.samples;
    }
    for (const r of rollups) {
      const e = ensureLife(r.type);
      e.succeeded += r.succeededCount;
      e.failed += r.failedCount;
      e.sumMs += r.sumDurationMs;
      e.samples += r.durationSamples;
    }

    const lifetimeByType = Array.from(lifeMap.values())
      .map((e) => ({
        type: e.type,
        succeeded: e.succeeded,
        failed: e.failed,
        total: e.succeeded + e.failed,
        avgMs: e.samples > 0 ? Math.round(e.sumMs / e.samples) : 0,
        samples: e.samples,
      }))
      .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));

    const lifeAgg = lifetimeByType.reduce(
      (acc, e) => {
        acc.succeeded += e.succeeded;
        acc.failed += e.failed;
        acc.sumMs += e.avgMs * e.samples;
        acc.samples += e.samples;
        return acc;
      },
      { succeeded: 0, failed: 0, sumMs: 0, samples: 0 },
    );
    const lifetimeOverall = {
      succeeded: lifeAgg.succeeded,
      failed: lifeAgg.failed,
      total: lifeAgg.succeeded + lifeAgg.failed,
      avgMs: lifeAgg.samples > 0 ? Math.round(lifeAgg.sumMs / lifeAgg.samples) : 0,
      samples: lifeAgg.samples,
    };

    return {
      computedAt: new Date().toISOString(),
      windowDays,
      concurrency,
      live: {
        total: stats.total,
        byStatus: stats.byStatus,
        pending: stats.byStatus.pending,
        running: stats.byStatus.running,
        failed: stats.byStatus.failed,
        scheduled: stats.scheduled,
        rateLimited,
        retried,
        byType: stats.byType,
      },
      history: { overall, byType: historyByType },
      eta: { totalRemaining, etaMs, basis, perType },
      lifetime: { overall: lifetimeOverall, byType: lifetimeByType },
    };
  }

  // -------------------------------------------------------------------------
  // resetHistory — clear the lifetime rollup (analytics reset)
  // -------------------------------------------------------------------------

  async resetHistory(): Promise<{ reset: number }> {
    const result = await this.prisma.jobStatsRollup.deleteMany({});
    this.logger.log(`Admin reset job history rollup (${result.count} type rows cleared)`);
    return { reset: result.count };
  }

  // -------------------------------------------------------------------------
  // Activity-time window helper
  // -------------------------------------------------------------------------

  /**
   * Maps a processedWithin window string to the cutoff Date for the query.
   * Returns null when no filter should be applied ('all' or undefined).
   */
  private windowCutoff(window: ProcessedWithinWindow | undefined): Date | null {
    if (!window || window === 'all') return null;
    const msMap: Record<Exclude<ProcessedWithinWindow, 'all'>, number> = {
      '4h':  4  * 3_600_000,
      '24h': 24 * 3_600_000,
      '7d':  7  * 86_400_000,
      '30d': 30 * 86_400_000,
    };
    return new Date(Date.now() - msMap[window]);
  }

  // -------------------------------------------------------------------------
  // listJobs
  // -------------------------------------------------------------------------

  async listJobs(filter: ListJobsFilter): Promise<JobListResult> {
    const { status, type, page, pageSize, scheduled, processedWithin } = filter;
    const skip = (page - 1) * pageSize;

    const cutoff = this.windowCutoff(processedWithin);

    // Build the optional time-window OR clause:
    // COALESCE(finishedAt, createdAt) >= cutoff
    const timeFilter: Prisma.EnrichmentJobWhereInput | undefined = cutoff
      ? {
          OR: [
            { finishedAt: { gte: cutoff } },
            { finishedAt: null, createdAt: { gte: cutoff } },
          ],
        }
      : undefined;

    // When scheduled=true, force status=pending and require scheduledFor > now.
    // Otherwise compose status/type filters as-is.
    // In both branches, spread timeFilter to AND with the base where clause.
    const where: Prisma.EnrichmentJobWhereInput = scheduled === true
      ? {
          status: JobStatus.pending,
          scheduledFor: { gt: new Date() },
          ...(type !== undefined ? { type } : {}),
          ...timeFilter,
        }
      : {
          ...(status !== undefined ? { status } : {}),
          ...(type !== undefined ? { type } : {}),
          ...timeFilter,
        };

    const [items, totalItems] = await Promise.all([
      this.prisma.enrichmentJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          reason: true,
          priority: true,
          mediaItemId: true,
          circleId: true,
          attempts: true,
          lastError: true,
          providerKey: true,
          modelVersion: true,
          payload: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          scheduledFor: true,
          rateLimitedAt: true,
          rateLimitHits: true,
        },
      }),
      this.prisma.enrichmentJob.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // -------------------------------------------------------------------------
  // retryJob
  // -------------------------------------------------------------------------

  async retryJob(id: string): Promise<JobListItem> {
    const job = await this.prisma.enrichmentJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException(`EnrichmentJob ${id} not found`);
    }

    if (job.status === JobStatus.running) {
      throw new BadRequestException(
        `EnrichmentJob ${id} is currently running and cannot be retried`,
      );
    }

    const updated = await this.prisma.enrichmentJob.update({
      where: { id },
      data: {
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
      },
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        priority: true,
        mediaItemId: true,
        circleId: true,
        attempts: true,
        lastError: true,
        providerKey: true,
        modelVersion: true,
        payload: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        scheduledFor: true,
        rateLimitedAt: true,
        rateLimitHits: true,
      },
    });

    this.logger.log(`EnrichmentJob ${id} reset to pending by admin`);
    return updated;
  }

  // -------------------------------------------------------------------------
  // retryAllFailed
  // -------------------------------------------------------------------------

  async retryAllFailed(type?: string): Promise<{ retried: number }> {
    const where = {
      status: JobStatus.failed,
      ...(type !== undefined ? { type } : {}),
    };

    const result = await this.prisma.enrichmentJob.updateMany({
      where,
      data: {
        status: JobStatus.pending,
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        rateLimitHits: 0,
      },
    });

    this.logger.log(
      `Admin bulk-retried ${result.count} failed enrichment jobs${type ? ` of type="${type}"` : ''}`,
    );

    return { retried: result.count };
  }

  // -------------------------------------------------------------------------
  // resetStuck
  // -------------------------------------------------------------------------

  async resetStuck(olderThanMinutes?: number): Promise<{ reset: number; failed: number }> {
    const minutes = olderThanMinutes ?? (await this.getStuckThresholdMinutes());
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    const stuckWhere = this.stuckRunningWhere(threshold);

    // Attempts are charged at CLAIM time (see EnrichmentJobWorker.claimNextJob),
    // so a job that repeatedly kills the process (e.g. OOM SIGKILL) still
    // carries its charge when it lands here as stuck. Once the budget is
    // exhausted, mark it failed instead of requeueing — this is what bounds a
    // poison-pill job to ENRICHMENT_MAX_ATTEMPTS crashes instead of an
    // infinite crash loop. Per-row updates (guarded on status=running) so the
    // lastError message can carry the per-job attempt count.
    const exhausted = await this.prisma.enrichmentJob.findMany({
      where: { ...stuckWhere, attempts: { gte: ENRICHMENT_MAX_ATTEMPTS } },
      select: { id: true, type: true, attempts: true },
    });

    let failed = 0;
    for (const job of exhausted) {
      const result = await this.prisma.enrichmentJob.updateMany({
        where: { id: job.id, status: JobStatus.running },
        data: {
          status: JobStatus.failed,
          lastError: `process terminated during execution (attempt ${job.attempts}/${ENRICHMENT_MAX_ATTEMPTS})`,
          finishedAt: new Date(),
          scheduledFor: null,
        },
      });
      if (result.count > 0) {
        failed += result.count;
        this.logger.warn(
          `EnrichmentJob ${job.id} (type="${job.type}") stuck with attempts budget exhausted ` +
            `(${job.attempts}/${ENRICHMENT_MAX_ATTEMPTS}) — marked failed instead of requeued`,
        );
      }
    }

    const result = await this.prisma.enrichmentJob.updateMany({
      where: { ...stuckWhere, attempts: { lt: ENRICHMENT_MAX_ATTEMPTS } },
      data: {
        status: JobStatus.pending,
        startedAt: null,
        scheduledFor: null,
      },
    });

    this.logger.log(
      `Admin reset ${result.count} stuck enrichment jobs (older than ${minutes} minutes)` +
        (failed > 0 ? `; failed ${failed} with exhausted attempts` : ''),
    );

    return { reset: result.count, failed };
  }

  // -------------------------------------------------------------------------
  // deleteJob
  // -------------------------------------------------------------------------

  async deleteJob(id: string): Promise<{ deleted: true }> {
    const job = await this.prisma.enrichmentJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException(`EnrichmentJob ${id} not found`);
    }

    if (job.status === JobStatus.running) {
      throw new BadRequestException(
        `EnrichmentJob ${id} is currently running and cannot be deleted`,
      );
    }

    await this.prisma.enrichmentJob.delete({ where: { id } });

    this.logger.log(`EnrichmentJob ${id} deleted by admin`);
    return { deleted: true };
  }
}
