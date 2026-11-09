import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { FaceModule } from '../face/face.module';
import { MediaModule } from '../media/media.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { SocialMediaDetectorService } from './social-media-detector.service';
import { SocialMediaOcrService } from './social-media-ocr.service';
import { SocialMediaDetectionHandler } from './social-media-detection.handler';
import { SocialMediaBackfillService } from './social-media-backfill.service';
import { SocialMediaMediaController } from './social-media-media.controller';
import { AdminSocialMediaController } from './admin-social-media.controller';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * SocialMediaModule
 *
 * Social-media video detection: a Tier-1 (metadata/filename) rule engine plus a
 * Tier-2 OCR fallback, wired into the enrichment queue as the
 * `social_media_detection` handler.
 *
 * Imports:
 *   - EnrichmentModule       → EnrichmentHandlerRegistry / EnrichmentJobService
 *   - SettingsModule         → AppSystemSettingsService (feature flags + socialMedia.*)
 *   - FaceModule             → VideoFrameExtractionService (now exported)
 *   - MediaModule            → MediaEnrichmentService (clean-path fan-out)
 *   - MediaProcessingModule → StorageProviderResolver (legacy re-probe + OCR download)
 *
 * No circular import: FaceModule already imports MediaModule; nothing imports
 * SocialMediaModule except AppModule.
 */
@Module({
  imports: [
    EnrichmentModule,
    
    FaceModule,
    MediaModule,
    OwnerAccessModule,
    MediaProcessingModule,
  ],
  controllers: [SocialMediaMediaController, AdminSocialMediaController],
  providers: [
    SocialMediaDetectorService,
    SocialMediaOcrService,
    SocialMediaDetectionHandler,
    SocialMediaBackfillService,
  ],
  exports: [SocialMediaOcrService, SocialMediaDetectorService],
})
export class SocialMediaModule {}
