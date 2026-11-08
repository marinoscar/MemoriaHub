import { Module } from '@nestjs/common';

import {
  LegacyEnrichmentHandlerAdapter,
} from '../platform/jobs/legacy-handlers.adapter';
import { EnrichmentJobService, LegacyJobSettledBridge } from '../platform/jobs/enrichment-job.facade';
import { RetiredJobTypeHandler } from '../platform/jobs/retired-job-types';
import { PrismaModule } from '../prisma/prisma.module';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';

/**
 * The legacy face of the queue (RETRO-C1, #575): what the feature modules import
 * to enqueue (`EnrichmentJobService`) and to register a handler
 * (`EnrichmentHandlerRegistry`). The queue itself is the platform's
 * `JobsModule` (global, mounted in `platform/jobs/jobs.config.ts`): the worker,
 * the claim, the terminal state machine, the reaper, the janitor, the history
 * purge, the provider throttle and `/api/admin/jobs/*` are no longer here.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-C3..C8, C11): shrinks as handler groups are
 * converted to native `JobHandler`s, and goes with C11.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    LegacyEnrichmentHandlerAdapter,
    EnrichmentHandlerRegistry,
    EnrichmentJobService,
    LegacyJobSettledBridge,
    RetiredJobTypeHandler,
  ],
  exports: [EnrichmentJobService, EnrichmentHandlerRegistry],
})
export class EnrichmentModule {}
