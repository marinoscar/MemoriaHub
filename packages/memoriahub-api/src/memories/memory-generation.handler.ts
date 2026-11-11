// =============================================================================
// Memory Generation Enrichment Handler (epic #300, issues #302 + #303)
// =============================================================================
//
// Runs one circle's memory curation pass. Enqueued once per circle by
// MemoriesGenerationTask (see memories-generation.task.ts).
//
// A native platform `JobHandler` (RETRO-C8, #608). The circle is the job's
// SUBJECT (`subjectType: 'circle'`, the facade's mapping of a circle-scoped
// enqueue); a job about anything else is malformed and throws, and a circle
// deleted after the job was queued settles as a no-op (`jobs.subject_id` is
// text, nothing cascades).
//
// SERVER-ONLY by design: no `nodeResultSchema` / `persistNodeResult` pair, so
// the platform's JobHandlerRegistry.serverOnlyTypes() picks it up and it stays
// in the system worker mode's claim set with no explicit pinning. Curation is a
// pure DB read + write pass over a whole circle with no per-item unit of work
// to hand a node, and (from #306) needs a server-held AI credential.
//
// DEDUP: the enqueue sites keep `skipDedup: true` (the sharded backfill queues
// up to 18 rows for ONE circle, which a per-subject dedup would collapse).
//
// PER-CURATOR ERROR ISOLATION IS A CORRECTNESS REQUIREMENT (#303), not
// politeness. The curators are independent producers of independent content: a
// circle with malformed geo data must still get its On This Day memories, and a
// single curator throwing must not cost the job its retry budget or leave the
// other six types un-generated until a human notices. Each curator therefore
// runs inside its own try/catch and the job SUCCEEDS as long as the plumbing
// worked — mirroring the best-effort philosophy of the notification producers.
// A curator that fails every run shows up in the logs, not as a red job that
// blocks the rest of the feature.
// =============================================================================

import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';

import { resolveCircleJob } from '../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  type MemoriahubAccessPort,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../ports/index.js';
import { MEMORIES_GENERATION_HOOK, type MemoriesGenerationHook } from './host/memories-options.js';
import { MemoriesSettingsService } from './memories-settings.util.js';
import { parseMemoryGenerationPayload } from './memory-generation.payload.js';
import { MemoriesNotificationService } from './notifications/memories-notification.service.js';
import { MemoryTitleService } from './titles/memory-title.service.js';
import {
  MEMORY_CURATORS,
  type MemoryCurator,
  type MemoryCuratorContext,
} from './curators/memory-curator.interface.js';

/**
 * The `memory_generation` job handler: one circle's curation pass (seven curators, AI titling).
 *
 * @stability experimental
 */
@Injectable()
export class MemoryGenerationHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'memory_generation';

  readonly label = 'Memory generation';

  /** One circle's seven curators plus AI titling: 20 minutes, three attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 1_200_000, maxAttempts: 3 };

  private readonly logger = new Logger(MemoryGenerationHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
    private readonly memories: MemoriesSettingsService,
    private readonly titles: MemoryTitleService,
    private readonly memoriesNotifications: MemoriesNotificationService,
    @Inject(MEMORY_CURATORS) private readonly curators: MemoryCurator[],
    @Optional() @Inject(MEMORIES_GENERATION_HOOK) private readonly generationHook?: MemoriesGenerationHook,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Runs the curators of one circle.
   *
   * @param job - the queue's job; its subject is the circle.
   */
  async process(job: MemoriahubJob): Promise<void> {
    // Re-check the gate here as well as in the cron. A job can sit pending
    // across a settings change, be retried by hand from /admin/settings/jobs,
    // or be enqueued by the future admin backfill (#315) — none of which go
    // through the cron's gate. Succeeding as a no-op (rather than throwing) is
    // deliberate: a disabled feature is not a failure, and failing would burn
    // retry attempts and light up the job dashboard for no reason.
    if (!(await this.memories.enabled())) {
      this.logger.debug(
        `Memories disabled; memory_generation job ${job.id} is a no-op`,
      );
      return;
    }

    // Every memory is circle-scoped: the job's subject is the circle. A job
    // about anything else throws (a malformed row); a circle deleted since the
    // job was queued is a no-op.
    const circleId = await resolveCircleJob(this.scopes, job, this.logger);
    if (!circleId) return;

    const payload = parseMemoryGenerationPayload(job.payload);
    const memoriesSettings = await this.memories.resolve();
    // ONE titling budget for the whole job (#306), shared by every curator: a
    // provider rate limit must stop titling for the rest of the run, and a
    // backfill's call cap is job-wide, not per curator. It is created here
    // rather than held on MemoryTitleService because that service is a
    // singleton and several `memory_generation` jobs can run concurrently.
    //
    // `payload.aiTitleCap` is #315's shard slice of that cap: a backfill split
    // across N jobs would otherwise multiply the per-job ceiling by N.
    const titling = this.titles.beginRun({
      backfill: payload.backfill === true,
      aiTitlesEnabled: memoriesSettings.aiTitles.enabled,
      ...(payload.aiTitleCap !== undefined ? { maxAiCalls: payload.aiTitleCap } : {}),
    });
    const ctx: MemoryCuratorContext = {
      circleId,
      settings: memoriesSettings,
      titling,
      // ONE wall clock for the whole run: a pass that straddles midnight must
      // not have curator A anchoring on today and curator B on tomorrow.
      now: new Date(),
      backfill: payload.backfill === true,
      ...(payload.anchorMonths ? { anchorMonths: payload.anchorMonths } : {}),
    };

    // #315 sharding: a backfill is split into bounded jobs, each naming the
    // curators it owns. An absent/empty list means "every enabled curator",
    // which is what every scheduled run does. An unknown name matches nothing
    // and is logged rather than thrown — a payload written by another release
    // must never poison the queue.
    const selected = payload.curators
      ? this.curators.filter((curator) => payload.curators!.includes(curator.name))
      : this.curators;
    if (payload.curators && selected.length === 0) {
      this.logger.warn(
        `memory_generation job ${job.id} names no known curator ` +
          `(${payload.curators.join(', ')}); nothing to run`,
      );
      return;
    }

    let created = 0;
    let refreshed = 0;
    let tombstoned = 0;
    let purged = 0;
    let failed = 0;

    for (const curator of selected) {
      if (!curator.isEnabled(ctx.settings)) continue;

      try {
        const result = await curator.run(ctx);
        // Each create/refresh is counted where it is written: MemoryCurationService.upsertMemory (`app.memories.generated`).
        created += result.created;
        refreshed += result.refreshed;
        tombstoned += result.tombstoned;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `Memory curator "${curator.name}" failed for circle ${ctx.circleId} ` +
            `(job ${job.id}): ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }

      // The retention tail runs even when run() threw: expired rows are stale
      // regardless of whether this pass managed to produce new ones, and a
      // curator whose generation is broken is exactly the one whose old rows
      // would otherwise accumulate.
      if (curator.purge) {
        try {
          purged += await curator.purge(ctx);
        } catch (err) {
          failed += 1;
          this.logger.error(
            `Memory curator "${curator.name}" purge failed for circle ${ctx.circleId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    // Notification Center (#311) — fire-and-forget, never awaited, and only
    // when the run genuinely CREATED something. A refresh-only pass resurfaces
    // nothing new, and a bell row that says so every day is how a user learns
    // to ignore the bell. `ctx.now` is the run's start, so the producer's
    // "newest memory of this run" lookup sees exactly this pass's rows.
    //
    // Wrapped defensively even though the producer's entry point is documented
    // as never throwing: the job's real work is already committed by this
    // point, so nothing about a bell row is worth turning a green job red and
    // burning a retry attempt on a re-run that would duplicate the whole pass.
    if (created > 0) {
      try {
        this.memoriesNotifications.recordGeneratedAsync({
          circleId: ctx.circleId,
          createdCount: created,
          since: ctx.now,
        });
      } catch (err) {
        this.logger.warn(
          `memories_ready notification hook failed for circle ${ctx.circleId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      // Webhook `memories.memory.created` (RETRO-H4, #603): the curators' writes are committed;
      // the service re-reads this pass's new rows (`generatedAt >= ctx.now`), emits in batches of
      // up to 100 ids and never throws, so the job's outcome does not depend on it.
      await this.generationHook?.memoriesCreated(ctx.circleId, ctx.now);
    }

    this.logger.log({
      event: 'memory_generation.completed',
      jobId: job.id,
      circleId: ctx.circleId,
      backfill: ctx.backfill,
      // #315: which shard of a sharded backfill this row was. Absent on a
      // scheduled run, which always runs the whole registry.
      curators: payload.curators ?? null,
      anchorMonths: payload.anchorMonths ?? null,
      created,
      refreshed,
      tombstoned,
      purged,
      failedCurators: failed,
      // #306 audit: how much titling this run actually paid for, and whether it
      // gave up early. `aiTitleStopReason` is the one-line explanation for a run
      // whose memories are mostly template-titled despite a configured provider.
      aiTitleCalls: titling.aiCalls,
      aiTitleStopReason: titling.stopReason,
    });
  }
}
