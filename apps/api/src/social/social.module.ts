import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { VideoProbeProcessor } from '../storage/processing/processors/video-probe.processor';
import { SocialDetectionHandler } from './social-detection.handler';
import { SocialDetectionService } from './social-detection.service';
import { SocialOcrService } from './social-ocr.service';
import { SocialController } from './social.controller';
import { SocialBackfillService } from './social-backfill.service';
import { AdminSocialController } from './admin-social.controller';

/**
 * SocialModule
 *
 * Provides social media video detection as an enrichment job handler.
 *
 * Imports:
 *   - EnrichmentModule: provides EnrichmentHandlerRegistry + EnrichmentJobService
 *   - StorageProvidersModule: provides StorageProviderResolver for video download
 *   - PrismaModule: database access
 *   - CirclesModule: provides CircleMembershipService for access checks in controller
 *   - SettingsModule: provides SystemSettingsService for feature flag + OCR config
 *
 * VideoProbeProcessor is registered directly here (not via MetadataModule) so it
 * can be used as a legacy fallback re-prober without pulling in the full metadata
 * pipeline. It is stateless and safe to instantiate as a separate provider scope.
 */
@Module({
  imports: [
    EnrichmentModule,
    StorageProvidersModule,
    PrismaModule,
    CirclesModule,
    SettingsModule,
  ],
  controllers: [SocialController, AdminSocialController],
  providers: [
    // VideoProbeProcessor registered directly for legacy re-probe fallback
    VideoProbeProcessor,

    SocialOcrService,
    SocialDetectionService,
    SocialDetectionHandler,
    SocialBackfillService,
  ],
})
export class SocialModule {}
