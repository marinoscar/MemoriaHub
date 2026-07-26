import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaModule } from '../media/media.module';
import { BurstModule } from '../burst/burst.module';
import { DedupModule } from '../dedup/dedup.module';
import { ReviewRunsController } from './review-runs.controller';
import { ReviewRunService } from './review-run.service';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import { ReviewRunEvaluateHandler } from './review-run-evaluate.handler';
import { ReviewRunExecuteBatchHandler } from './review-run-execute-batch.handler';
import { BurstGroupReviewStrategy } from './strategies/burst-group.strategy';
import { DuplicateGroupReviewStrategy } from './strategies/duplicate-group.strategy';
import { LocationSuggestionReviewStrategy } from './strategies/location-suggestion.strategy';

/**
 * ReviewRunsModule — the shared async run engine behind every bulk review-queue
 * action (issue #190).
 *
 * BurstModule and DedupModule are imported through `forwardRef` because the
 * dependency is genuinely mutual: the strategies here wrap `BurstService` /
 * `DuplicateService` primitives, while those services' threshold endpoints call
 * `ReviewRunService.createRun`. MediaModule (MediaThumbnailService) and the rest
 * are plain imports — none of them import this module.
 *
 * The location-suggestion strategy deliberately does NOT depend on
 * LocationInferenceModule: it owns the accept/reject transaction outright
 * (ported from the old run execute-batch handler), so that module can import
 * this one without a cycle.
 */
@Module({
  imports: [
    PrismaModule,
    CirclesModule,
    EnrichmentModule,
    MediaModule,
    forwardRef(() => BurstModule),
    forwardRef(() => DedupModule),
  ],
  controllers: [ReviewRunsController],
  providers: [
    ReviewRunService,
    ReviewRunSubjectRegistry,
    BurstGroupReviewStrategy,
    DuplicateGroupReviewStrategy,
    LocationSuggestionReviewStrategy,
    ReviewRunEvaluateHandler,
    ReviewRunExecuteBatchHandler,
  ],
  exports: [ReviewRunService, ReviewRunEvaluateHandler, ReviewRunExecuteBatchHandler],
})
export class ReviewRunsModule {}
