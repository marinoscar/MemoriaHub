import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { AiModule } from '../ai/ai.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaTouchModule } from '../media/media-touch.module';
import { VideoInputResolver } from '../media/enrichment/video-input.service';
import { AutoTaggingHandler } from './auto-tagging.handler';
import { AutoTaggingService } from './auto-tagging.service';
import { VideoAutoTaggingHandler } from './video-auto-tagging.handler';
import { VideoAutoTaggingService } from './video-auto-tagging.service';
import { TaggingController } from './tagging.controller';
import { TagLabelsController } from './tag-labels.controller';
import { TagLabelsService } from './tag-labels.service';
import { TaggingBackfillService } from './tagging-backfill.service';
import { AdminTaggingController } from './admin-tagging.controller';

@Module({
  imports: [EnrichmentModule, AiModule, MediaProcessingModule, PrismaModule, OwnerAccessModule, MediaTouchModule],
  controllers: [TaggingController, TagLabelsController, AdminTaggingController],
  providers: [
    AutoTaggingHandler,
    AutoTaggingService,
    VideoAutoTaggingHandler,
    VideoAutoTaggingService,
    VideoInputResolver,
    TagLabelsService,
    TaggingBackfillService,
  ],
  exports: [AutoTaggingService, VideoAutoTaggingService],
})
export class TaggingModule {}
