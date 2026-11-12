import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { Module } from '@nestjs/common';

import { EnrichmentJobService, LegacyJobSettledBridge } from '../platform/jobs/enrichment-job.facade';
import { RetiredJobTypeHandler, RetiredStorageMigrationHandler } from '../platform/jobs/retired-job-types';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * The legacy face of the queue (RETRO-C1, #575): what the feature modules import
 * to enqueue (`EnrichmentJobService`). Every handler is a native `JobHandler`
 * that registers itself with the platform's `JobHandlerRegistry`; the
 * `EnrichmentHandler` adapter and registry are gone. The queue itself is the platform's
 * `JobsModule` (global, mounted in `platform/jobs/jobs.config.ts`): the worker,
 * the claim, the terminal state machine, the reaper, the janitor, the history
 * purge, the provider throttle and `/api/admin/jobs/*` are no longer here.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-C11): what is left is the enqueue facade, the
 * settled-event bridge and the two retired job types; see
 * docs/platform-adoption/legacy-removal.md for what removes each.
 */
@Module({
  imports: [PrismaModule, OwnerAccessModule],
  providers: [
    EnrichmentJobService,
    LegacyJobSettledBridge,
    RetiredJobTypeHandler,
    RetiredStorageMigrationHandler,
  ],
  exports: [EnrichmentJobService],
})
export class EnrichmentModule {}
