import { Module } from '@nestjs/common';
import { LocationInferenceModule as LocationInferenceSliceModule } from '@marinoscar/memoriahub-api/location';

import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaModule } from '../media/media.module';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { ReviewRunsModule } from '../review-runs/review-runs.module';
import { LocationGroupsModule } from '../location-groups/location-groups.module';
import { LocationSuggestionController } from './location-suggestion.controller';
import { AdminLocationInferenceController } from './admin-location-inference.controller';
import { LocationSuggestionRunsController } from './runs/location-suggestion-runs.controller';

/**
 * LocationInferenceModule
 *
 * The inference, the review-queue service, the sweep backfill, the `location_inference` handler and the
 * upload fan-out registration live in the location slice (`@marinoscar/memoriahub-api/location`,
 * RETRO-J10 #624); this module supplies the geo provider the suggestion service calls on accept
 * (GeoLocationModule) and keeps the controllers (the deprecated `location_suggestion_run_*` shim handlers and
 * the location review-run strategy live in the review-runs and location slices, RETRO-J9 #622).
 */
@Module({
  imports: [
    LocationInferenceSliceModule.forRoot({ geoProviderImports: [GeoLocationModule] }),
    EnrichmentModule,
    MediaProcessingModule,
    PrismaModule,
    OwnerAccessModule,
    MediaModule,
    ReviewRunsModule,
    LocationGroupsModule,
  ],
  controllers: [
    LocationSuggestionController,
    AdminLocationInferenceController,
    LocationSuggestionRunsController,
  ],
  exports: [LocationInferenceSliceModule],
})
export class LocationInferenceModule {}
