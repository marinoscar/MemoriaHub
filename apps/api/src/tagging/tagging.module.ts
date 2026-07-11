import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { AiModule } from '../ai/ai.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { AutoTaggingHandler } from './auto-tagging.handler';
import { AutoTaggingService } from './auto-tagging.service';
import { TaggingController } from './tagging.controller';
import { TagLabelsController } from './tag-labels.controller';
import { TagLabelsService } from './tag-labels.service';
import { TaggingBackfillService } from './tagging-backfill.service';
import { AdminTaggingController } from './admin-tagging.controller';

@Module({
  imports: [EnrichmentModule, AiModule, StorageProvidersModule, PrismaModule, CirclesModule, SettingsModule],
  controllers: [TaggingController, TagLabelsController, AdminTaggingController],
  providers: [AutoTaggingHandler, AutoTaggingService, TagLabelsService, TaggingBackfillService],
  exports: [AutoTaggingService],
})
export class TaggingModule {}
