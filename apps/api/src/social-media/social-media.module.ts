import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { SettingsModule } from '../settings/settings.module';
import { FaceModule } from '../face/face.module';
import { MediaModule } from '../media/media.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { SocialMediaDetectorService } from './social-media-detector.service';
import { SocialMediaOcrService } from './social-media-ocr.service';
import { SocialMediaDetectionHandler } from './social-media-detection.handler';

/**
 * SocialMediaModule
 *
 * Social-media video detection: a Tier-1 (metadata/filename) rule engine plus a
 * Tier-2 OCR fallback, wired into the enrichment queue as the
 * `social_media_detection` handler.
 *
 * Imports:
 *   - EnrichmentModule       → EnrichmentHandlerRegistry / EnrichmentJobService
 *   - SettingsModule         → SystemSettingsService (feature flags + socialMedia.*)
 *   - FaceModule             → VideoFrameExtractionService (now exported)
 *   - MediaModule            → MediaEnrichmentService (clean-path fan-out)
 *   - StorageProvidersModule → StorageProviderResolver (legacy re-probe + OCR download)
 *
 * No circular import: FaceModule already imports MediaModule; nothing imports
 * SocialMediaModule except AppModule.
 */
@Module({
  imports: [
    EnrichmentModule,
    SettingsModule,
    FaceModule,
    MediaModule,
    StorageProvidersModule,
  ],
  providers: [
    SocialMediaDetectorService,
    SocialMediaOcrService,
    SocialMediaDetectionHandler,
  ],
  exports: [SocialMediaOcrService, SocialMediaDetectorService],
})
export class SocialMediaModule {}
