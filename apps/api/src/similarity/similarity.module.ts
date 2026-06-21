import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SimilarityController } from './similarity.controller';
import { SimilarityService } from './similarity.service';
import { SimilarityDetectionHandler } from './similarity-detection.handler';
import { SimilarityDetectionService } from './similarity-detection.service';
import { SimilarityEnqueueListener } from './similarity-enqueue.listener';

@Module({
  imports: [EnrichmentModule, StorageProvidersModule, PrismaModule, CirclesModule],
  controllers: [SimilarityController],
  providers: [
    SimilarityService,
    SimilarityDetectionHandler,
    SimilarityDetectionService,
    SimilarityEnqueueListener,
  ],
})
export class SimilarityModule {}
