// =============================================================================
// Memory Generation Enrichment Handler (epic #300, issues #302 + #303)
// =============================================================================
//
// Runs one circle's memory curation pass. Enqueued once per circle by
// MemoriesGenerationTask (see memories-generation.task.ts).
//
// SERVER-ONLY by design: no `nodeResultSchema` / `persistNodeResult` pair, so
// EnrichmentHandlerRegistry.serverOnlyTypes() picks it up automatically and it
// becomes eligible for the ENRICHMENT_WORKER_MODE=system claim set with no
// explicit pinning — the same no-node-pair inference that covers
// `face_auto_archive_sweep` and the `location_inference` sweep. Curation is a
// pure DB read + write pass over a whole circle with no per-item unit of work
// to hand a node, and (from #306) needs a server-held AI credential.
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

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { isMemoriesEnabled } from '../common/types/settings.types';
import { resolveMemoriesSettings } from './memories-settings.util';
import {
  MEMORY_CURATORS,
  MemoryCurator,
  MemoryCuratorContext,
} from './curators/memory-curator.interface';

/** Payload shape for a `memory_generation` job. */
interface MemoryGenerationPayload {
  /** Admin library backfill (#315): widen curators past "what matters today". */
  backfill?: boolean;
}

@Injectable()
export class MemoryGenerationHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'memory_generation';

  private readonly logger = new Logger(MemoryGenerationHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly systemSettings: SystemSettingsService,
    @Inject(MEMORY_CURATORS) private readonly curators: MemoryCurator[],
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
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

    if (!job.circleId) {
      // Every memory is circle-scoped, so a circle-less job has nothing to
      // curate. Not an error — just nothing to do.
      this.logger.warn(
        `memory_generation job ${job.id} has no circleId; nothing to generate`,
      );
      return;
    }

    const payload = (job.payload as unknown as MemoryGenerationPayload | null) ?? {};
    const ctx: MemoryCuratorContext = {
      circleId: job.circleId,
      settings: resolveMemoriesSettings(settings.memories),
      // ONE wall clock for the whole run: a pass that straddles midnight must
      // not have curator A anchoring on today and curator B on tomorrow.
      now: new Date(),
      backfill: payload.backfill === true,
    };

    let created = 0;
    let refreshed = 0;
    let tombstoned = 0;
    let purged = 0;
    let failed = 0;

    for (const curator of this.curators) {
      if (!curator.isEnabled(ctx.settings)) continue;

      try {
        const result = await curator.run(ctx);
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

    this.logger.log({
      event: 'memory_generation.completed',
      jobId: job.id,
      circleId: ctx.circleId,
      backfill: ctx.backfill,
      created,
      refreshed,
      tombstoned,
      purged,
      failedCurators: failed,
    });
  }
}
