import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { AiModule } from '../ai/ai.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { AutoTaggingHandler } from './auto-tagging.handler';
import { AutoTaggingService } from './auto-tagging.service';
import { TaggingEnqueueListener } from './tagging-enqueue.listener';
import { TaggingController } from './tagging.controller';
import { TagLabelsController } from './tag-labels.controller';
import { TagLabelsService } from './tag-labels.service';

@Module({
  imports: [EnrichmentModule, AiModule, StorageProvidersModule, PrismaModule, CirclesModule, SettingsModule],
  controllers: [TaggingController, TagLabelsController],
  providers: [AutoTaggingHandler, AutoTaggingService, TaggingEnqueueListener, TagLabelsService],
})
export class TaggingModule {}
