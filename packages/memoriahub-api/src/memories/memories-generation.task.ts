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
//
// ENQUEUE-ONLY (RETRO-C9, #612): the tick reads (circles, the queue) and
// enqueues; it never generates. `MemoryGenerationHandler` does the work.
// Moved into @marinoscar/memoriahub-api/memories (RETRO-J8, #619): it reads settings, the library
// directory and the queue through the host ports.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { JobReason } from './data/memories-enums.js';
import type { MemoriesDb } from './data/memories-db.js';
import { MemoriesSettingsService } from './memories-settings.util.js';

/**
 * The job type this task schedules. Permanent: a queued row names its handler by this string.
 *
 * @stability experimental
 */
export const MEMORY_GENERATION_JOB_TYPE = 'memory_generation';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Background priority: never starve upload enrichment (rerun=0, upload=10). */
const MEMORY_GENERATION_PRIORITY = 100;

/** Fallback when `memories.generation.intervalHours` is absent (pre-#302 rows). */
const DEFAULT_INTERVAL_HOURS = 24;

/**
 * Outcome tally for one sweep — logged, and returned for tests.
 *
 * @stability experimental
 */
export interface MemoriesGenerationSweepResult {
  circles: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

/**
 * The hourly, interval-gated, enqueue-only scheduler of `memory_generation` jobs.
 *
 * @stability experimental
 */
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
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MemoriesDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly memories: MemoriesSettingsService,
  ) {}

  /**
   * The hourly tick: decides which circles are due and enqueues one
   * `memory_generation` job per due circle (RETRO-C9, #612: a `@Cron` only
   * decides and enqueues; the generation itself is `MemoryGenerationHandler`'s).
   * Reads only, plus the per-circle enqueues. Returns the tally for tests and
   * NEVER throws: a throw out of a `@Cron` is an unhandled rejection.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledGeneration(): Promise<MemoriesGenerationSweepResult> {
    const result: MemoriesGenerationSweepResult = {
      circles: 0,
      enqueued: 0,
      skipped: 0,
      errors: 0,
    };

    // Gate 1 — env kill-switch. Checked before anything else so a CI/test
    // deployment pays not even a cached settings read.
    if (process.env['MEMORIES_ENABLED'] === 'false') {
      return result;
    }

    if (this.sweepInFlight) {
      this.logger.debug('Memories generation sweep already in flight; skipping tick');
      return result;
    }
    this.sweepInFlight = true;

    try {
      // Gate 2 — feature flag, read ONCE for the whole sweep through the cached
      // settings port, so a 500-circle deployment costs one settings read.
      if (!(await this.memories.enabled())) {
        return result;
      }

      const intervalHours =
        (await this.memories.resolve()).generation?.intervalHours ?? DEFAULT_INTERVAL_HOURS;
      const cutoff = new Date(Date.now() - intervalHours * 3_600_000);

      // Every library (groups through the platform, personal libraries from the store),
      // walked in pages of CIRCLE_PAGE_SIZE ids (RETRO-K1).
      const allScopeIds = await this.scopes.allScopeIds();
      for (let offset = 0; offset < allScopeIds.length; offset += CIRCLE_PAGE_SIZE) {
        const circleIds = allScopeIds.slice(offset, offset + CIRCLE_PAGE_SIZE);

        // Two batched reads per page instead of two per circle.
        const [inFlight, lastSucceeded] = await Promise.all([
          this.jobs.findActive({
            types: [MEMORY_GENERATION_JOB_TYPE],
            subjectType: 'circle',
            subjectIds: circleIds,
          }),
          this.prisma.job.groupBy({
            by: ['subjectId'],
            where: {
              type: MEMORY_GENERATION_JOB_TYPE,
              subjectType: 'circle',
              subjectId: { in: circleIds },
              status: 'succeeded',
            },
            _max: { finishedAt: true },
          }),
        ]);

        const busy = new Set(inFlight.map((j) => j.subjectId).filter((id): id is string => !!id));
        const lastSuccessAt = new Map<string, Date | null>();
        for (const row of lastSucceeded as Array<{ subjectId: string | null; _max: { finishedAt: Date | null } }>) {
          if (row.subjectId) lastSuccessAt.set(row.subjectId, row._max.finishedAt);
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
            await this.jobs.enqueue({
              type: MEMORY_GENERATION_JOB_TYPE,
              subjectType: 'circle',
              subjectId: circleId,
              payload: {},
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
      }

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
    return result;
  }
}
