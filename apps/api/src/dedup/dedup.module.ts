import { Global, Module } from '@nestjs/common';
import {
  AdminDuplicateController,
  DUPLICATE_OBSERVER,
  DedupModule as DedupSliceModule,
  DuplicateController,
  ReviewInsightsController,
} from '@marinoscar/memoriahub-api/dedup';

import { ReviewRunsModule } from '../review-runs/review-runs.module';
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
 * registration, the review insights, the review service, its review-run strategy and the three
 * controllers live in `@marinoscar/memoriahub-api/dedup`; this module mounts the controllers. The strategy registers
 * itself with the review-runs slice's registry (RETRO-J9), so no module here imports the other way.
 */
@Module({
  // The review-runs module (the run engine and its controller) is imported before the slice, as every review
  // queue module did before the strategies moved: the OpenAPI path order follows the module order.
  imports: [ReviewRunsModule, DedupSliceModule.forRoot(), DuplicateObserverModule],
  controllers: [DuplicateController, AdminDuplicateController, ReviewInsightsController],
  exports: [DedupSliceModule],
})
export class DedupModule {}
