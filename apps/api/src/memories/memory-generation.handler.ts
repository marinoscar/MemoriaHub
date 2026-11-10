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

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { resolveCircleJob } from '../platform/jobs/media-item-job';
import { OwnerScopeSweepService } from '../platform/sharing/owner-scope-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoriaHubWebhooks } from '../platform/webhooks/memoriahub-webhooks.service';
import { isMemoriesEnabled } from '../settings/feature-gates';
import { resolveMemoriesSettings } from './memories-settings.util';
import { parseMemoryGenerationPayload } from './memory-generation.payload';
import { MemoriesNotificationService } from './notifications/memories-notification.service';
import { MemoryTitleService } from './titles/memory-title.service';
import {
  MEMORY_CURATORS,
  MemoryCurator,
  MemoryCuratorContext,
} from './curators/memory-curator.interface';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

@Injectable()
export class MemoryGenerationHandler implements JobHandler, OnModuleInit {
  readonly type = 'memory_generation';

  readonly label = 'Memory generation';

  /** One circle's seven curators plus AI titling: 20 minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 1_200_000, maxAttempts: 3 };

  private readonly logger = new Logger(MemoryGenerationHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly scopes: OwnerScopeSweepService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly titles: MemoryTitleService,
    private readonly memoriesNotifications: MemoriesNotificationService,
    @Inject(MEMORY_CURATORS) private readonly curators: MemoryCurator[],
    // Webhooks (RETRO-H4, #603). Optional so unit tests that build the handler by hand need no stub.
    @Optional() private readonly webhookEvents?: MemoriaHubWebhooks,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    // Re-check the gate here as well as in the cron. A job can sit pending
    // across a settings change, be retried by hand from /admin/settings/jobs,
    // or be enqueued by the future admin backfill (#315) — none of which go
    // through the cron's gate. Succeeding as a no-op (rather than throwing) is
    // deliberate: a disabled feature is not a failure, and failing would burn
    // retry attempts and light up the job dashboard for no reason.
    const settings = await this.systemSettings.getSettings();
    if (!isMemoriesEnabled(settings)) {
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
    const memoriesSettings = resolveMemoriesSettings(settings.memories);
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
      await this.webhookEvents?.memoriesCreated(ctx.circleId, ctx.now);
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
