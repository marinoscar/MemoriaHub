// =============================================================================
// Memories Generation Scheduled Task (epic #300, issue #302)
// =============================================================================
//
// Hourly, interval-gated cron that enqueues ONE `memory_generation` enrichment
// job per circle whose last successful generation is older than
// `memories.generation.intervalHours`. Mirrors InsightsRefreshTask's
// interval-gate shape (hourly tick, configurable interval, skip while a job is
// already pending/running) and TrashPurgeTask/ThumbnailRepairTask's cron
// contract (env kill-switch, try/catch that never throws).
//
// ZERO COST WHEN OFF. With `features.memories` absent/false — the default — the
// tick costs exactly one CACHED settings read and returns: no circle paging, no
// job rows, nothing for the worker to claim. `MEMORIES_ENABLED=false` short-
// circuits even that.
//
// WHY `skipDedup: true` IS MANDATORY. EnrichmentJobService's default dedup finds
// an existing pending/running job with the same `(type, mediaItemId)` — and for
// a global job `mediaItemId` is NULL for every circle, so the FIRST circle's job
// would swallow the enqueue for all the others, system-wide. The per-circle
// pending/running check below is this task's own, correctly-scoped replacement
// for that dedup. Precedent: `face_auto_archive_sweep` (FaceBackfillService).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { isMemoriesEnabled } from '../common/types/settings.types';

/** The enrichment job type this task schedules. */
export const MEMORY_GENERATION_JOB_TYPE = 'memory_generation';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Background priority: never starve upload enrichment (rerun=0, upload=10). */
const MEMORY_GENERATION_PRIORITY = 100;

/** Fallback when `memories.generation.intervalHours` is absent (pre-#302 rows). */
const DEFAULT_INTERVAL_HOURS = 24;

/** Outcome tally for one sweep — logged, and returned for tests. */
export interface MemoriesGenerationSweepResult {
  circles: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

@Injectable()
export class MemoriesGenerationTask {
  private readonly logger = new Logger(MemoriesGenerationTask.name);

  /**
   * In-process overlap guard. A sweep over a large deployment can outlive its
   * hourly slot and two concurrent sweeps would do identical work twice.
   * Single-process only, and sufficient: the per-circle pending/running check
   * makes a duplicated sweep idempotent, so the worst case across replicas is
   * wasted effort, never a duplicated job row for the same circle.
   */
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledGeneration(): Promise<void> {
    // Gate 1 — env kill-switch. Checked before anything else so a CI/test
    // deployment pays not even a cached settings read.
    if (process.env['MEMORIES_ENABLED'] === 'false') {
      return;
    }

    if (this.sweepInFlight) {
      this.logger.debug('Memories generation sweep already in flight; skipping tick');
      return;
    }
    this.sweepInFlight = true;

    try {
      const result = await this.sweep();
      if (result.enqueued > 0 || result.errors > 0) {
        this.logger.log(
          `Memories generation: ${result.enqueued} job(s) enqueued across ` +
            `${result.circles} circle(s), ${result.skipped} skipped` +
            (result.errors > 0 ? `, ${result.errors} circle(s) failed` : ''),
        );
      }
    } catch (err) {
      this.logger.error('Memories generation schedule check failed', err as Error);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * Enqueue a `memory_generation` job for every eligible circle.
   *
   * Exposed (rather than inlined into the cron body) so the admin backfill in
   * #315 and this task's tests can drive the same code path.
   */
  async sweep(): Promise<MemoriesGenerationSweepResult> {
    const result: MemoriesGenerationSweepResult = {
      circles: 0,
      enqueued: 0,
      skipped: 0,
      errors: 0,
    };

    // Gate 2 — feature flag, read ONCE for the whole sweep through the cached
    // getSettings(), so a 500-circle deployment costs one settings read.
    const settings = await this.systemSettings.getSettings();
    if (!isMemoriesEnabled(settings)) {
      return result;
    }

    const intervalHours =
      settings.memories?.generation?.intervalHours ?? DEFAULT_INTERVAL_HOURS;
    const cutoff = new Date(Date.now() - intervalHours * 3_600_000);

    let cursor: string | undefined;
    for (;;) {
      const circles = await this.prisma.circle.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: CIRCLE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (circles.length === 0) break;

      const circleIds = circles.map((c) => c.id);

      // Two batched reads per page instead of two per circle.
      const [inFlight, lastSucceeded] = await Promise.all([
        this.prisma.enrichmentJob.findMany({
          where: {
            type: MEMORY_GENERATION_JOB_TYPE,
            circleId: { in: circleIds },
            status: { in: [JobStatus.pending, JobStatus.running] },
          },
          select: { circleId: true },
        }),
        this.prisma.enrichmentJob.groupBy({
          by: ['circleId'],
          where: {
            type: MEMORY_GENERATION_JOB_TYPE,
            circleId: { in: circleIds },
            status: JobStatus.succeeded,
          },
          _max: { finishedAt: true },
        }),
      ]);

      const busy = new Set(inFlight.map((j) => j.circleId).filter((id): id is string => !!id));
      const lastSuccessAt = new Map<string, Date | null>();
      for (const row of lastSucceeded) {
        if (row.circleId) lastSuccessAt.set(row.circleId, row._max.finishedAt);
      }

      for (const circleId of circleIds) {
        result.circles += 1;

        // Gate 3a — a job for this circle is already queued or running.
        if (busy.has(circleId)) {
          result.skipped += 1;
          continue;
        }

        // Gate 3b — interval gate. A circle that has never generated (no
        // succeeded row) has no `last` and is always eligible.
        const last = lastSuccessAt.get(circleId);
        if (last && last > cutoff) {
          result.skipped += 1;
          continue;
        }

        // A per-circle failure is logged and counted, never fatal — one bad
        // circle must not stop the rest of the deployment from generating.
        try {
          await this.enrichmentJobService.enqueue({
            type: MEMORY_GENERATION_JOB_TYPE,
            mediaItemId: null,
            circleId,
            reason: JobReason.backfill,
            priority: MEMORY_GENERATION_PRIORITY,
            // MANDATORY — see the header. Without it, one circle's job would
            // suppress every other circle's, since global-job dedup keys on
            // (type, mediaItemId IS NULL) system-wide.
            skipDedup: true,
          });
          result.enqueued += 1;
        } catch (err) {
          result.errors += 1;
          this.logger.warn(
            `memory_generation enqueue failed for circle ${circleId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      if (circles.length < CIRCLE_PAGE_SIZE) break;
      cursor = circleIds[circleIds.length - 1]!;
    }

    return result;
  }
}
