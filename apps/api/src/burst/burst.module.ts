import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { BurstController } from './burst.controller';
import { BurstService } from './burst.service';
import { BurstDetectionHandler } from './burst-detection.handler';
import { BurstDetectionService } from './burst-detection.service';
import { BurstEnqueueListener } from './burst-enqueue.listener';

@Module({
  imports: [EnrichmentModule, StorageProvidersModule, PrismaModule, CirclesModule],
  controllers: [BurstController],
  providers: [BurstService, BurstDetectionHandler, BurstDetectionService, BurstEnqueueListener],
})
export class BurstModule {}
