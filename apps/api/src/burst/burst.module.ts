import { Module, forwardRef } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { DedupModule } from '../dedup/dedup.module';
import { MediaModule } from '../media/media.module';
import { BurstController } from './burst.controller';
import { BurstService } from './burst.service';
import { BurstDetectionHandler } from './burst-detection.handler';
import { BurstDetectionService } from './burst-detection.service';
import { AdminBurstController } from './admin-burst.controller';
import { ReviewRunsModule } from '../review-runs/review-runs.module';

@Module({
  imports: [
    EnrichmentModule,
    MediaProcessingModule,
    PrismaModule,
    CirclesModule,
    
    DedupModule,
    MediaModule,
    // Mutual: the burst review-run strategy wraps BurstService's primitives
    // while BurstService's threshold endpoints start review runs (issue #190).
    forwardRef(() => ReviewRunsModule),
  ],
  controllers: [BurstController, AdminBurstController],
  providers: [BurstService, BurstDetectionHandler, BurstDetectionService],
  exports: [BurstService],
})
export class BurstModule {}
