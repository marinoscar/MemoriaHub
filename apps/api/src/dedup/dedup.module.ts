import { Global, Module } from '@nestjs/common';
import { DUPLICATE_OBSERVER, DedupModule as DedupSliceModule } from '@marinoscar/memoriahub-api/dedup';

import { EnrichmentModule } from '../enrichment/enrichment.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DuplicateController } from './duplicate.controller';
import { AdminDuplicateController } from './admin-duplicate.controller';
import { ReviewInsightsController } from './review-insights.controller';
import { AppDuplicateObserver } from './duplicate-observer.adapter';

/**
 * Binds the slice's optional `DUPLICATE_OBSERVER` (the `media.item.trashed` webhook). Global because Nest
 * resolves a token only in the module that provides it or in a global module, and the slice's own module is
 * the consumer.
 */
@Global()
@Module({
  providers: [AppDuplicateObserver, { provide: DUPLICATE_OBSERVER, useExisting: AppDuplicateObserver }],
  exports: [DUPLICATE_OBSERVER],
})
export class DuplicateObserverModule {}

/**
 * The web app's binding of the dedup slice (RETRO-J10, #624). The detection (CLIP visual embeddings, dHash,
 * two-tier matching and grouping), the three duplicate jobs, the admin backfill, the upload fan-out
 * registration, the review insights, the review service and its review-run strategy live in
 * `@marinoscar/memoriahub-api/dedup`; the controllers stay here until they move too. The strategy registers
 * itself with the review-runs slice's registry (RETRO-J9), so no module here imports the other way.
 */
@Module({
  imports: [DedupSliceModule.forRoot(), DuplicateObserverModule, EnrichmentModule, PrismaModule],
  controllers: [DuplicateController, AdminDuplicateController, ReviewInsightsController],
  exports: [DedupSliceModule],
})
export class DedupModule {}
