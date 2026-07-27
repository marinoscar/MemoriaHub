import { Module, forwardRef } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaModule } from '../media/media.module';
import { DuplicateController } from './duplicate.controller';
import { DuplicateService } from './duplicate.service';
import { AdminDuplicateController } from './admin-duplicate.controller';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { DuplicateDetectionHandler } from './duplicate-detection.handler';
import { DuplicateDetectionBatchHandler } from './duplicate-detection-batch.handler';
import { DuplicateBackfillService } from './duplicate-backfill.service';
import { DuplicateConfidenceBackfillHandler } from './duplicate-confidence-backfill.handler';
import { VisualEmbeddingService } from './visual-embedding.service';
import { ReviewInsightsController } from './review-insights.controller';
import { ReviewInsightsService } from './review-insights.service';
import { ReviewRunsModule } from '../review-runs/review-runs.module';

@Module({
  imports: [
    EnrichmentModule,
    StorageProvidersModule,
    PrismaModule,
    CirclesModule,
    SettingsModule,
    MediaModule,
    // Mutual: the duplicate review-run strategy wraps DuplicateService's
    // primitives while DuplicateService's threshold endpoints start review runs
    // (issue #190).
    forwardRef(() => ReviewRunsModule),
  ],
  controllers: [DuplicateController, AdminDuplicateController, ReviewInsightsController],
  providers: [
    DuplicateService,
    DuplicateDetectionService,
    DuplicateDetectionHandler,
    DuplicateDetectionBatchHandler,
    DuplicateBackfillService,
    DuplicateConfidenceBackfillHandler,
    VisualEmbeddingService,
    ReviewInsightsService,
  ],
  exports: [VisualEmbeddingService, DuplicateDetectionService, DuplicateService],
})
export class DedupModule {}
