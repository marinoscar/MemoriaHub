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
// WHY IT IS NOT `MemoriesGenerationTask.handleScheduledGeneration()`
// ---------------------------------------------
// The cron's sweep exists to enforce an INTERVAL ("has this circle generated in
// the last N hours?"). A backfill is an explicit human instruction that must
// run now regardless of when the circle last generated, and it enqueues a
// sharded plan rather than one bare job. Reusing that tick would have meant
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

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { enqueueEnrichmentJob } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import { JobReason } from '../data/memories-enums.js';
import { MEMORY_GENERATION_JOB_TYPE } from '../memories-generation.task.js';
import { MEMORY_BACKFILL_SHARDS, memoryBackfillPayload } from './memory-backfill.shards.js';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Background priority: never starve upload enrichment (rerun=0, upload=10). */
const MEMORY_BACKFILL_PRIORITY = 100;

/**
 * Response body of `POST /api/admin/memories/backfill`.
 *
 * @stability experimental
 */
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

/**
 * One library the admin backfill picker lists (RETRO-I6, #588).
 *
 * @stability experimental
 */
export interface MemoryBackfillLibrary {
  /** The scope id `POST /api/admin/memories/backfill` takes as `circleId`. */
  id: string;
  /** `group`: a shared library (a platform group); `personal`: a user's own library. */
  kind: 'group' | 'personal';
  /** The group's name, or the owner's display name (email when none) for a personal library. */
  name: string;
}

/**
 * Upper bound of the picker list (the "All libraries" choice covers any deployment).
 *
 * @stability experimental
 */
export const MEMORY_BACKFILL_LIBRARIES_MAX = 1000;

/**
 * The admin library backfill: queues the sharded `memory_generation` plan per library.
 *
 * @stability experimental
 */
@Injectable()
export class MemoryBackfillService {
  private readonly logger = new Logger(MemoryBackfillService.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
  ) {}

  /**
   * The libraries an admin can target with the backfill: every shared library
   * (group) by name, then every personal library by its owner. Replaces the
   * picker's former `GET /api/circles?all=true` (RETRO-I6, #588). Read through the scope
   * directory (RETRO-K1): groups from the platform, personal libraries from the store.
   */
  async listLibraries(): Promise<MemoryBackfillLibrary[]> {
    const scopes = (await this.scopes.allScopes()).slice(0, MEMORY_BACKFILL_LIBRARIES_MAX);
    const owners = await this.scopes.userNames(scopes.map((s) => s.ownerId).filter((id): id is string => !!id));
    const groups: MemoryBackfillLibrary[] = [];
    const personal: MemoryBackfillLibrary[] = [];
    for (const scope of scopes) {
      if (scope.kind === 'personal') {
        const owner = scope.ownerId ? owners.get(scope.ownerId) : undefined;
        personal.push({ id: scope.id, kind: 'personal', name: owner?.name || owner?.email || scope.name });
      } else {
        groups.push({ id: scope.id, kind: 'group', name: scope.name });
      }
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    personal.sort((a, b) => a.name.localeCompare(b.name));
    return [...groups, ...personal];
  }

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
      const exists = await this.scopes.scopeExists(opts.circleId);
      // 404 rather than a silent no-op: an admin who mistypes a circle id must
      // not get back a cheerful `{ enqueued: 0 }` that reads like success.
      if (!exists) {
        throw new NotFoundException(`Circle ${opts.circleId} not found`);
      }
      await this.processPage([opts.circleId], result);
    } else {
      const allIds = await this.scopes.allScopeIds();
      for (let offset = 0; offset < allIds.length; offset += CIRCLE_PAGE_SIZE) {
        await this.processPage(allIds.slice(offset, offset + CIRCLE_PAGE_SIZE), result);
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
    const inFlight = await this.jobs.findActive({
      types: [MEMORY_GENERATION_JOB_TYPE],
      subjectType: 'circle',
      subjectIds: circleIds,
    });
    const busy = new Set(
      inFlight.map((job) => job.subjectId).filter((id): id is string => !!id),
    );

    for (const circleId of circleIds) {
      if (busy.has(circleId)) {
        result.skipped += 1;
        continue;
      }

      let enqueuedForCircle = 0;
      for (const shard of MEMORY_BACKFILL_SHARDS) {
        try {
          await enqueueEnrichmentJob(this.jobs, {
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
