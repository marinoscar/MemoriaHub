import { Module } from '@nestjs/common';
import { ReviewRunsController, ReviewRunsModule as ReviewRunsSliceModule } from '@marinoscar/memoriahub-api/review-runs';

import { PrismaModule } from '../prisma/prisma.module';
import { ReviewRunsRetentionHandler } from './review-runs-retention.handler';

/**
 * The web app's binding of the review-runs slice (RETRO-J9, #622). The shared async run engine behind every
 * bulk review-queue action (issue #190: the run service, the `review_run_evaluate` and
 * `review_run_execute_batch` handlers, the deprecated `location_suggestion_run_*` shims, the strategy
 * registry) lives in `@marinoscar/memoriahub-api/review-runs`; this module mounts its controller and keeps
 * the nightly `review_run_history_purge`, which is bound to the platform's retention policy.
 *
 * The slice knows no review queue: the burst and duplicate strategies are registered by `BurstModule` and
 * `DedupModule` (their review services stay in the app), the location strategy by the location slice. None
 * of them imports this module back, so there is no cycle.
 */
@Module({
  imports: [ReviewRunsSliceModule.forRoot(), PrismaModule],
  controllers: [ReviewRunsController],
  providers: [ReviewRunsRetentionHandler],
  exports: [ReviewRunsSliceModule, ReviewRunsRetentionHandler],
})
export class ReviewRunsModule {}
