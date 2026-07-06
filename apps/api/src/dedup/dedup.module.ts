import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaUrlSigningModule } from '../media/signing/media-url-signing.module';
import { DuplicateController } from './duplicate.controller';
import { DuplicateService } from './duplicate.service';
import { AdminDuplicateController } from './admin-duplicate.controller';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { DuplicateDetectionHandler } from './duplicate-detection.handler';
import { DuplicateDetectionBatchHandler } from './duplicate-detection-batch.handler';
import { DuplicateBackfillService } from './duplicate-backfill.service';
import { VisualEmbeddingService } from './visual-embedding.service';

@Module({
  imports: [EnrichmentModule, StorageProvidersModule, PrismaModule, CirclesModule, SettingsModule, MediaUrlSigningModule],
  controllers: [DuplicateController, AdminDuplicateController],
  providers: [
    DuplicateService,
    DuplicateDetectionService,
    DuplicateDetectionHandler,
    DuplicateDetectionBatchHandler,
    DuplicateBackfillService,
    VisualEmbeddingService,
  ],
  exports: [VisualEmbeddingService],
})
export class DedupModule {}
