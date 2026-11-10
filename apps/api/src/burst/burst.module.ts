import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { DedupModule } from '../dedup/dedup.module';
import { MediaModule } from '../media/media.module';
import { BurstController } from './burst.controller';
import { BurstService } from './burst.service';
import { BurstDetectionHandler } from './burst-detection.handler';
import { BurstDetectionService } from './burst-detection.service';
import { AdminBurstController } from './admin-burst.controller';
import { ReviewRunsModule } from '../review-runs/review-runs.module';
import { BurstUploadEnrichment } from './burst-upload-enrichment';
import { BurstGroupReviewStrategy } from '../review-runs/strategies/burst-group.strategy';

@Module({
  imports: [
    EnrichmentModule,
    MediaProcessingModule,
    PrismaModule,
    OwnerAccessModule,
    
    DedupModule,
    MediaModule,
    // The review-run engine lives in the review-runs slice (RETRO-J9); this module registers the burst
    // strategy with it (BurstService's threshold endpoints start runs, the strategy wraps its primitives).
    ReviewRunsModule,
  ],
  controllers: [BurstController, AdminBurstController],
  providers: [
    // Registers this slice's upload fan-out with the media slice (RETRO-J5).
    BurstUploadEnrichment,
    BurstService,
    BurstDetectionHandler,
    BurstDetectionService,
    BurstGroupReviewStrategy,
  ],
  exports: [BurstService],
})
export class BurstModule {}
