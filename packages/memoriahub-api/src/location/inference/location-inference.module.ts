import { Module, type DynamicModule, type Type } from '@nestjs/common';

import { MediaModule } from '../../media/index.js';
import { LocationModule } from '../location.module.js';
import { LocationInferenceBackfillService } from './location-inference-backfill.service.js';
import { LocationInferenceUploadEnrichment } from './location-inference-upload-enrichment.js';
import { LocationInferenceHandler } from './location-inference.handler.js';
import { LocationInferenceService } from './location-inference.service.js';
import { LocationSuggestionService } from './location-suggestion.service.js';

/**
 * Options of {@link LocationInferenceModule.forRoot}.
 *
 * @stability experimental
 */
export interface LocationInferenceModuleOptions {
  /**
   * Modules that provide and export the `GEO_LOCATION_PROVIDER` token (the reverse geocoder the
   * suggestion service calls when a suggestion is accepted). The providers themselves (offline
   * GeoNames, Nominatim, Google) stay in the host until the geo part of the slice moves.
   */
  readonly geoProviderImports?: ReadonlyArray<Type<unknown> | DynamicModule>;
}

/**
 * Location inference (RETRO-J10, #624): the per-item and sweep inference of coordinates for photos
 * without GPS, the `location_inference` job, the review-queue service behind
 * `/api/media/location-suggestions` and the upload fan-out registration. Reaches the outside only
 * through the host ports and the `GEO_LOCATION_PROVIDER` token the host provides.
 *
 * Import it ONCE in the host (the handler and the registration are singletons); the first
 * `forRoot()` call wins.
 *
 * @stability experimental
 */
@Module({})
export class LocationInferenceModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param options - the geo provider imports.
   */
  static forRoot(options: LocationInferenceModuleOptions = {}): DynamicModule {
    LocationInferenceModule.root ??= {
      module: LocationInferenceModule,
      imports: [LocationModule.forRoot(), MediaModule.forRoot(), ...(options.geoProviderImports ?? [])],
      providers: [
        LocationInferenceService,
        LocationInferenceHandler,
        LocationInferenceBackfillService,
        LocationSuggestionService,
        LocationInferenceUploadEnrichment,
      ],
      exports: [LocationInferenceService, LocationInferenceBackfillService, LocationSuggestionService],
    };
    return LocationInferenceModule.root;
  }
}
