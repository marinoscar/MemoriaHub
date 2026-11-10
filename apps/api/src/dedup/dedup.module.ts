import { Module, forwardRef } from '@nestjs/common';
import { DedupModule as DedupSliceModule } from '@marinoscar/memoriahub-api/dedup';

import { ReviewRunsModule } from '../review-runs/review-runs.module';
import { DuplicateController } from './duplicate.controller';
import { DuplicateService } from './duplicate.service';
import { AdminDuplicateController } from './admin-duplicate.controller';
import { ReviewInsightsController } from './review-insights.controller';

/**
 * The web app's binding of the dedup slice (RETRO-J10, #624). The detection (CLIP visual embeddings, dHash,
 * two-tier matching and grouping), the three duplicate jobs, the admin backfill, the upload fan-out
 * registration and the review insights live in `@marinoscar/memoriahub-api/dedup`; the review service and
 * the controllers stay here (the review service starts review runs, which have not moved yet).
 */
@Module({
  imports: [
    DedupSliceModule.forRoot(),
    // Mutual: the duplicate review-run strategy wraps DuplicateService's
    // primitives while DuplicateService's threshold endpoints start review runs
    // (issue #190).
    forwardRef(() => ReviewRunsModule),
  ],
  controllers: [DuplicateController, AdminDuplicateController, ReviewInsightsController],
  providers: [DuplicateService],
  exports: [DedupSliceModule, DuplicateService],
})
export class DedupModule {}
