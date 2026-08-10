// =============================================================================
// Memories — admin library backfill (epic #300, issue #315)
// =============================================================================
//
// Sweeps the EXISTING library so an admin who has just switched Memories on
// gets years of memories immediately instead of waiting for the hourly cron to
// trickle "today + tomorrow" in one day at a time.
//
// This service only ENQUEUES. Backfill semantics — every curator's widened
// horizon — live in the curators themselves (#303–#305), keyed off
// `payload.backfill`, so there is exactly one implementation of "what backfill
// means" and this endpoint cannot drift from it.
//
// WHY IT IS NOT `MemoriesGenerationTask.sweep()`
// ---------------------------------------------
// The cron's sweep exists to enforce an INTERVAL ("has this circle generated in
// the last N hours?"). A backfill is an explicit human instruction that must
// run now regardless of when the circle last generated, and it enqueues a
// sharded plan rather than one bare job. Reusing `sweep()` would have meant
// threading two mutually exclusive modes through it; the two share the circle
// paging shape and the per-circle in-flight guard, which is where the real
// logic is, and nothing else.
//
// THREE PROPERTIES THIS SWEEP HAS TO KEEP
// ---------------------------------------
//  1. It never starves upload enrichment. Every row is priority 100 — the same
//     background priority as the cron's — so face detection and auto-tagging
//     (priority 0/10) are always claimed first, even mid-backfill.
//  2. It is memory-safe on a large deployment: circles are keyset-paged 100 at
//     a time and the in-flight check is one batched query per page, so a
//     500-circle install costs a bounded number of round trips and never loads
//     every circle at once.
//  3. It is safe to re-run. A circle with a `memory_generation` job already
//     pending or running is SKIPPED, not double-queued, so a double-clicked
//     button does not enqueue 36 rows; and even if it did, every curator write
//     is an idempotent upsert.
// =============================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MEMORY_GENERATION_JOB_TYPE } from '../memories-generation.task';
import { MEMORY_BACKFILL_SHARDS, memoryBackfillPayload } from './memory-backfill.shards';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Background priority: never starve upload enrichment (rerun=0, upload=10). */
const MEMORY_BACKFILL_PRIORITY = 100;

/** Response body of `POST /api/admin/memories/backfill`. */
export interface MemoryBackfillResult {
  /**
   * Job ROWS created. One circle contributes `MEMORY_BACKFILL_SHARDS.length`
   * rows, not one — see `memory-backfill.shards.ts` for why the work is split.
   */
  enqueued: number;
  /** Circles the backfill enqueued jobs for. */
  circles: number;
  /** Circles skipped because a `memory_generation` job was already in flight. */
  skipped: number;
}

@Injectable()
export class MemoryBackfillService {
  private readonly logger = new Logger(MemoryBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  /**
   * Enqueue the sharded backfill plan for one circle, or for every circle when
   * `circleId` is omitted.
   *
   * The caller (AdminMemoriesController) has already rejected the request when
   * the feature is disabled — this method assumes the gate passed, exactly like
   * the sibling admin backfill services.
   */
  async backfillLibrary(opts: { circleId?: string } = {}): Promise<MemoryBackfillResult> {
    const result: MemoryBackfillResult = { enqueued: 0, circles: 0, skipped: 0 };

    if (opts.circleId) {
      const circle = await this.prisma.circle.findUnique({
        where: { id: opts.circleId },
        select: { id: true },
      });
      // 404 rather than a silent no-op: an admin who mistypes a circle id must
      // not get back a cheerful `{ enqueued: 0 }` that reads like success.
      if (!circle) {
        throw new NotFoundException(`Circle ${opts.circleId} not found`);
      }
      await this.processPage([circle.id], result);
    } else {
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
        await this.processPage(circleIds, result);

        if (circles.length < CIRCLE_PAGE_SIZE) break;
        cursor = circleIds[circleIds.length - 1]!;
      }
    }

    this.logger.log(
      `Memories library backfill: ${result.enqueued} job(s) enqueued across ` +
        `${result.circles} circle(s), ${result.skipped} skipped (already in flight)`,
    );
    return result;
  }

  /** Enqueue the shard plan for every non-busy circle in one keyset page. */
  private async processPage(circleIds: string[], result: MemoryBackfillResult): Promise<void> {
    // ONE batched read per page rather than one per circle. This is the same
    // guard the cron uses, and it is what makes the endpoint safe to double-
    // click: a circle already being generated is left alone.
    const inFlight = await this.prisma.enrichmentJob.findMany({
      where: {
        type: MEMORY_GENERATION_JOB_TYPE,
        circleId: { in: circleIds },
        status: { in: [JobStatus.pending, JobStatus.running] },
      },
      select: { circleId: true },
    });
    const busy = new Set(
      inFlight.map((job) => job.circleId).filter((id): id is string => !!id),
    );

    for (const circleId of circleIds) {
      if (busy.has(circleId)) {
        result.skipped += 1;
        continue;
      }

      let enqueuedForCircle = 0;
      for (const shard of MEMORY_BACKFILL_SHARDS) {
        try {
          await this.enrichmentJobService.enqueue({
            type: MEMORY_GENERATION_JOB_TYPE,
            mediaItemId: null,
            circleId,
            reason: JobReason.backfill,
            priority: MEMORY_BACKFILL_PRIORITY,
            payload: memoryBackfillPayload(shard),
            // MANDATORY, and for two reasons here. Global-job dedup keys on
            // `(type, mediaItemId IS NULL)` SYSTEM-WIDE, so without it the very
            // first shard would swallow the other 17 — and every other circle's
            // as well. The correctly-scoped replacement is the per-circle
            // in-flight check above.
            skipDedup: true,
          });
          enqueuedForCircle += 1;
        } catch (err) {
          // A per-shard failure is logged and skipped, never fatal: one bad
          // insert must not cost the rest of the deployment its backfill, and
          // the shards that did land are independently useful.
          this.logger.warn(
            `memory_generation backfill enqueue failed for circle ${circleId} ` +
              `shard "${shard.label}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (enqueuedForCircle > 0) {
        result.circles += 1;
        result.enqueued += enqueuedForCircle;
      }
    }
  }
}
