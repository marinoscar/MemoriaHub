import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { SettingsModule } from '../settings/settings.module';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { MediaUrlSigningModule } from '../media/signing/media-url-signing.module';
import { LocationSuggestionController } from './location-suggestion.controller';
import { LocationSuggestionService } from './location-suggestion.service';
import { AdminLocationInferenceController } from './admin-location-inference.controller';
import { LocationInferenceService } from './location-inference.service';
import { LocationInferenceHandler } from './location-inference.handler';
import { LocationInferenceBackfillService } from './location-inference-backfill.service';

/**
 * LocationInferenceModule
 *
 * Imports GeoLocationModule (not MediaModule) so LocationSuggestionService can
 * call the shared applyLocation() helper via the GEO_LOCATION_PROVIDER token
 * directly, without depending on MediaModule/MediaService — avoiding any risk
 * of a circular module dependency (MediaModule never imports this module).
 */
@Module({
  imports: [EnrichmentModule, StorageProvidersModule, PrismaModule, CirclesModule, SettingsModule, GeoLocationModule, MediaUrlSigningModule],
  controllers: [LocationSuggestionController, AdminLocationInferenceController],
  providers: [
    LocationInferenceService,
    LocationInferenceHandler,
    LocationInferenceBackfillService,
    LocationSuggestionService,
  ],
})
export class LocationInferenceModule {}
