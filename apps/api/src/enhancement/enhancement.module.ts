import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { CirclesModule } from '../circles/circles.module';
import { LegacyAiModule } from '../ai-port/legacy-ai.module';
import { MediaModule } from '../media/media.module';
import { MediaEnhancementController } from './media-enhancement.controller';
import { EnhancementBatchesController } from './enhancement-batches.controller';
import { AdminEnhancementController } from './admin-enhancement.controller';
import { MediaEnhancementService } from './media-enhancement.service';
import { ExifCarryoverService } from './exif-carryover.service';
import { PictureEnhancementHandler } from './picture-enhancement.handler';
import { PictureEnhancementPurgeHandler } from './picture-enhancement-purge.handler';
import { PictureEnhancementPurgeTask } from './picture-enhancement-purge.task';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * EnhancementModule — the AI Picture Enhancer (spec docs/specs/picture-enhancer.md).
 *
 * Imports:
 *   - EnrichmentModule: handler registration + EnrichmentJobService.enqueue.
 *   - MediaProcessingModule: StorageProviderResolver (per-object + active provider) and
 *     ObjectReprocessService.reprocessNow.
 *   - CirclesModule: CircleMembershipService.assertCircleAccess.
 *   - SettingsModule: AppSystemSettingsService.
 *   - LegacyAiModule: AiSettingsService + AiProviderRegistry (enhanceImage provider).
 *   - MediaModule: MediaMetadataSyncService + MediaEnrichmentService (keep_both path).
 *
 * The purge cron @Cron works via ScheduleModule.forRoot() in AppModule.
 */
@Module({
  imports: [
    PrismaModule,
    EnrichmentModule,
    MediaProcessingModule,
    CirclesModule,
    
    LegacyAiModule,
    MediaModule,
  ],
  controllers: [
    MediaEnhancementController,
    EnhancementBatchesController,
    AdminEnhancementController,
  ],
  providers: [
    MediaEnhancementService,
    ExifCarryoverService,
    PictureEnhancementHandler,
    PictureEnhancementPurgeHandler,
    PictureEnhancementPurgeTask,
  ],
})
export class EnhancementModule {}
