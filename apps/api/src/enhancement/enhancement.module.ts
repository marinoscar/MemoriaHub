import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { StorageModule } from '../storage/storage.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { AiModule } from '../ai/ai.module';
import { MediaModule } from '../media/media.module';
import { MediaEnhancementController } from './media-enhancement.controller';
import { AdminEnhancementController } from './admin-enhancement.controller';
import { MediaEnhancementService } from './media-enhancement.service';
import { PictureEnhancementHandler } from './picture-enhancement.handler';
import { PictureEnhancementPurgeHandler } from './picture-enhancement-purge.handler';
import { PictureEnhancementPurgeTask } from './picture-enhancement-purge.task';

/**
 * EnhancementModule — the AI Picture Enhancer (spec docs/specs/picture-enhancer.md).
 *
 * Imports:
 *   - EnrichmentModule: handler registration + EnrichmentJobService.enqueue.
 *   - StorageProvidersModule: StorageProviderResolver (per-object + active provider).
 *   - StorageModule: StorageProcessingRecoveryService.reprocessObjectNow.
 *   - CirclesModule: CircleMembershipService.assertCircleAccess.
 *   - SettingsModule: SystemSettingsService.
 *   - AiModule: AiSettingsService + AiProviderRegistry (enhanceImage provider).
 *   - MediaModule: MediaMetadataSyncService + MediaEnrichmentService (keep_both path).
 *
 * The purge cron @Cron works via ScheduleModule.forRoot() in AppModule.
 */
@Module({
  imports: [
    PrismaModule,
    EnrichmentModule,
    StorageProvidersModule,
    StorageModule,
    CirclesModule,
    SettingsModule,
    AiModule,
    MediaModule,
  ],
  controllers: [MediaEnhancementController, AdminEnhancementController],
  providers: [
    MediaEnhancementService,
    PictureEnhancementHandler,
    PictureEnhancementPurgeHandler,
    PictureEnhancementPurgeTask,
  ],
})
export class EnhancementModule {}
