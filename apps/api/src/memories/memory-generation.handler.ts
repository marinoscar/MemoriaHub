// =============================================================================
// Memory Generation Enrichment Handler (epic #300, issue #302)
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
// v1 SCOPE (this issue): the handler is a deliberate NO-OP. Shipping the
// scheduling, dedup, gating and observability plumbing before any curation
// logic exists is what lets #303–#305 add curators to a queue path that is
// already proven end to end. Curators arrive in #303 (On This Day),
// #304 (Trips) and #305 (People / Theme / Seasonal / Year in Review).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { isMemoriesEnabled } from '../common/types/settings.types';

@Injectable()
export class MemoryGenerationHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'memory_generation';

  private readonly logger = new Logger(MemoryGenerationHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly systemSettings: SystemSettingsService,
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

    // v1: no curators registered yet (#303–#305). The log line is the
    // observability hook that proves the scheduling path works end to end.
    this.logger.log(
      `memory_generation ran for circle ${job.circleId} (job ${job.id}): ` +
        'no curators registered yet',
    );
  }
}
