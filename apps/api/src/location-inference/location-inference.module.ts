import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { MediaModule } from '../media/media.module';
import { LocationSuggestionController } from './location-suggestion.controller';
import { LocationSuggestionService } from './location-suggestion.service';
import { AdminLocationInferenceController } from './admin-location-inference.controller';
import { LocationInferenceService } from './location-inference.service';
import { LocationInferenceHandler } from './location-inference.handler';
import { LocationInferenceBackfillService } from './location-inference-backfill.service';

/**
 * LocationInferenceModule
 *
 * Imports GeoLocationModule so LocationSuggestionService can call the shared
 * applyLocation() helper via the GEO_LOCATION_PROVIDER token directly.
 *
 * Also imports MediaModule for MediaThumbnailService (batched thumbnail
 * signing). This introduces no cycle: MediaModule never imports this module.
 */
@Module({
  imports: [EnrichmentModule, StorageProvidersModule, PrismaModule, CirclesModule, SettingsModule, GeoLocationModule, MediaModule],
  controllers: [LocationSuggestionController, AdminLocationInferenceController],
  providers: [
    LocationInferenceService,
    LocationInferenceHandler,
    LocationInferenceBackfillService,
    LocationSuggestionService,
  ],
})
export class LocationInferenceModule {}
