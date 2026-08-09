// =============================================================================
// Memory Digest Scheduled Task (epic #300, issue #311)
// =============================================================================
//
// Hourly cron that enqueues ONE `memory_digest` enrichment job per DUE circle.
// Same contract as MemoriesGenerationTask / TrashPurgeTask / ShareExpiringTask:
// an env kill-switch, an in-process overlap guard, and a handler that never
// throws.
//
// It ticks HOURLY rather than daily because `memories.digest.sendHourUtc` is a
// per-deployment setting: a daily 09:00 cron could not honour a deployment that
// asks for 14:00. The hourly tick with a send-hour gate is what makes the
// setting mean anything.
//
// ZERO COST WHEN OFF. With `features.memories` absent/false — the default — the
// tick costs exactly one CACHED settings read and returns: no circle paging, no
// job rows, no mail. The same is true when the admin has turned the digest off,
// set `frequency: 'off'`, or simply never configured email. `MEMORIES_ENABLED=
// false` short-circuits even the settings read.
//
// WHY `skipDedup: true` IS MANDATORY, exactly as for `memory_generation`:
// EnrichmentJobService's default dedup keys on `(type, mediaItemId)`, and for a
// global job `mediaItemId` is NULL for EVERY circle — so the first circle's
// pending job would swallow the enqueue for the whole deployment. The
// per-circle pending/running check below is this task's own, correctly-scoped
// replacement. Precedent: `face_auto_archive_sweep`, `memory_generation`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';

import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  MEMORY_DIGEST_JOB_TYPE,
  MEMORY_DIGEST_PRIORITY,
  MemoryDigestService,
} from './memory-digest.service';

/** Circles fetched per keyset page — the sweep never loads them all at once. */
const CIRCLE_PAGE_SIZE = 100;

/** Outcome tally for one sweep — logged, and returned for tests. */
export interface MemoryDigestSweepResult {
  circles: number;
  enqueued: number;
  skipped: number;
  errors: number;
  /** Set when a deployment-wide gate closed before any circle was examined. */
  gate?: string;
}

@Injectable()
export class MemoryDigestTask {
  private readonly logger = new Logger(MemoryDigestTask.name);

  /**
   * In-process overlap guard. Single-process only, and sufficient: the
   * per-circle pending/running check makes a duplicated sweep idempotent, so
   * the worst case across replicas is wasted effort, never a duplicated job row
   * — and therefore never a duplicated email.
   */
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
    private readonly digest: MemoryDigestService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledDigest(): Promise<void> {
    // Gate 1 — env kill-switch, shared with generation. Checked before anything
    // else so a CI/test deployment pays not even a cached settings read.
    if (process.env['MEMORIES_ENABLED'] === 'false') {
      return;
    }

    if (this.sweepInFlight) {
      this.logger.debug('Memory digest sweep already in flight; skipping tick');
      return;
    }
    this.sweepInFlight = true;

    try {
      const result = await this.sweep();
      if (result.enqueued > 0 || result.errors > 0) {
        this.logger.log(
          `Memory digest: ${result.enqueued} job(s) enqueued across ` +
            `${result.circles} circle(s), ${result.skipped} skipped` +
            (result.errors > 0 ? `, ${result.errors} circle(s) failed` : ''),
        );
      }
    } catch (err) {
      this.logger.error('Memory digest schedule check failed', err as Error);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * Enqueue a `memory_digest` job for every due circle.
   *
   * Exposed (rather than inlined into the cron body) so tests — and any future
   * admin "send now" affordance — drive the same code path the cron does.
   */
  async sweep(now: Date = new Date()): Promise<MemoryDigestSweepResult> {
    const result: MemoryDigestSweepResult = {
      circles: 0,
      enqueued: 0,
      skipped: 0,
      errors: 0,
    };

    // Gates 2–5, read ONCE for the whole sweep through the cached getSettings()
    // and evaluated by the same helper the handler uses, so the cron and the
    // send can never disagree about whether the digest is live.
    const settings = await this.systemSettings.getSettings();
    const gate = this.digest.evaluateGlobalGate(settings);
    if (!gate.ok) {
      result.gate = gate.reason;
      return result;
    }

    // Gate 6 — send hour. `frequency` is narrowed by the gate above, which
    // already rejected 'off'.
    const frequency = gate.settings.digest.frequency as 'daily' | 'weekly' | 'monthly';
    if (now.getUTCHours() < gate.settings.digest.sendHourUtc) {
      result.gate = 'before_send_hour';
      return result;
    }

    const cutoff = new Date(now.getTime() - this.digest.windowMs(frequency));

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
            type: MEMORY_DIGEST_JOB_TYPE,
            circleId: { in: circleIds },
            status: { in: [JobStatus.pending, JobStatus.running] },
          },
          select: { circleId: true },
        }),
        this.prisma.enrichmentJob.groupBy({
          by: ['circleId'],
          where: {
            type: MEMORY_DIGEST_JOB_TYPE,
            circleId: { in: circleIds },
            status: JobStatus.succeeded,
          },
          _max: { finishedAt: true },
        }),
      ]);

      const busy = new Set(
        inFlight.map((j) => j.circleId).filter((id): id is string => !!id),
      );
      const lastSuccessAt = new Map<string, Date | null>();
      for (const row of lastSucceeded) {
        if (row.circleId) lastSuccessAt.set(row.circleId, row._max.finishedAt);
      }

      for (const circleId of circleIds) {
        result.circles += 1;

        // A job for this circle is already queued or running.
        if (busy.has(circleId)) {
          result.skipped += 1;
          continue;
        }

        // Gate 7 — frequency window. A circle that has never had a digest has
        // no watermark and is always past the window.
        const last = lastSuccessAt.get(circleId) ?? null;
        if (last && last > cutoff) {
          result.skipped += 1;
          continue;
        }

        try {
          // Gate 8 — NEW CONTENT, the epic's hard requirement. Checked BEFORE
          // enqueueing rather than only inside the handler, so a quiet circle
          // costs one bounded SELECT per period instead of a job row, a worker
          // slot, and a red-herring entry in the job dashboard. The handler
          // re-checks it anyway (a memory can be tombstoned in between).
          const candidates = await this.digest.loadCandidates(circleId, last);
          if (candidates.length === 0) {
            result.skipped += 1;
            continue;
          }

          await this.enrichmentJobService.enqueue({
            type: MEMORY_DIGEST_JOB_TYPE,
            mediaItemId: null,
            circleId,
            // The queue has no 'scheduled' reason; `backfill` is what every
            // other cron-enqueued global job uses (trash_purge, thumbnail_repair,
            // memory_generation).
            reason: JobReason.backfill,
            priority: MEMORY_DIGEST_PRIORITY,
            // MANDATORY — see the header.
            skipDedup: true,
          });
          result.enqueued += 1;
        } catch (err) {
          result.errors += 1;
          this.logger.warn(
            `memory_digest enqueue failed for circle ${circleId}: ` +
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
