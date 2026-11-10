import { Module } from '@nestjs/common';
import { LocationInferenceModule as LocationInferenceSliceModule } from '@marinoscar/memoriahub-api/location';

import { GeoLocationModule } from '../media/geo/geo-location.module';
import { ReviewRunsModule } from '../review-runs/review-runs.module';
import { LocationGroupsModule } from '../location-groups/location-groups.module';
import { LocationSuggestionController } from './location-suggestion.controller';
import { AdminLocationInferenceController } from './admin-location-inference.controller';
import { LocationSuggestionRunsController } from './runs/location-suggestion-runs.controller';
import { LocationSuggestionRunEvaluateHandler } from './runs/location-suggestion-run-evaluate.handler';
import { LocationSuggestionRunExecuteBatchHandler } from './runs/location-suggestion-run-execute-batch.handler';

/**
 * LocationInferenceModule
 *
 * The inference, the review-queue service, the sweep backfill, the `location_inference` handler and the
 * upload fan-out registration live in the location slice (`@marinoscar/memoriahub-api/location`,
 * RETRO-J10 #624); this module supplies the geo provider the suggestion service calls on accept
 * (GeoLocationModule) and keeps the controllers and the deprecated `location_suggestion_run_*` shim
 * handlers (they delegate into the review-runs engine, which has not moved yet).
 */
@Module({
  imports: [
    LocationInferenceSliceModule.forRoot({ geoProviderImports: [GeoLocationModule] }),
    ReviewRunsModule,
    LocationGroupsModule,
  ],
  controllers: [
    LocationSuggestionController,
    AdminLocationInferenceController,
    LocationSuggestionRunsController,
  ],
  providers: [LocationSuggestionRunEvaluateHandler, LocationSuggestionRunExecuteBatchHandler],
  exports: [LocationInferenceSliceModule],
})
export class LocationInferenceModule {}
