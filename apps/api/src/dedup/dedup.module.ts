import { Module } from '@nestjs/common';
import { DedupModule as DedupSliceModule } from '@marinoscar/memoriahub-api/dedup';

import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaModule } from '../media/media.module';
import { ReviewRunsModule } from '../review-runs/review-runs.module';
import { DuplicateController } from './duplicate.controller';
import { DuplicateService } from './duplicate.service';
import { AdminDuplicateController } from './admin-duplicate.controller';
import { ReviewInsightsController } from './review-insights.controller';
import { DuplicateGroupReviewStrategy } from '../review-runs/strategies/duplicate-group.strategy';

/**
 * The web app's binding of the dedup slice (RETRO-J10, #624). The detection (CLIP visual embeddings, dHash,
 * two-tier matching and grouping), the three duplicate jobs, the admin backfill, the upload fan-out
 * registration and the review insights live in `@marinoscar/memoriahub-api/dedup`; the review service, its
 * review-run strategy and the controllers stay here (the engine itself is the review-runs slice, RETRO-J9).
 */
@Module({
  imports: [
    DedupSliceModule.forRoot(),
    EnrichmentModule,
    MediaProcessingModule,
    PrismaModule,
    OwnerAccessModule,
    MediaModule,
    // The review-run engine lives in the review-runs slice (RETRO-J9); this module registers the duplicate
    // strategy with it (DuplicateService's threshold endpoints start runs, the strategy wraps its primitives).
    ReviewRunsModule,
  ],
  controllers: [DuplicateController, AdminDuplicateController, ReviewInsightsController],
  providers: [DuplicateService, DuplicateGroupReviewStrategy],
  exports: [DedupSliceModule, DuplicateService],
})
export class DedupModule {}
