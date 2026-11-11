import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../../media/index.js';
import { ReviewRunsModule } from '../../review-runs/index.js';
import { LocationModule } from '../location.module.js';
import { LocationSuggestionReviewStrategy } from '../review/location-suggestion.strategy.js';
import { LocationInferenceBackfillService } from './location-inference-backfill.service.js';
import { LocationInferenceUploadEnrichment } from './location-inference-upload-enrichment.js';
import { LocationInferenceHandler } from './location-inference.handler.js';
import { LocationInferenceService } from './location-inference.service.js';
import { LocationSuggestionService } from './location-suggestion.service.js';

/**
 * Options of {@link LocationInferenceModule.forRoot}. None yet: the geo providers the suggestion service calls
 * on accept come from {@link LocationModule}.
 *
 * @stability experimental
 */
export interface LocationInferenceModuleOptions {
  /** Reserved. */
  readonly reserved?: never;
}

/**
 * Location inference (RETRO-J10, #624): the per-item and sweep inference of coordinates for photos
 * without GPS, the `location_inference` job, the review-queue service behind
 * `/api/media/location-suggestions` and the upload fan-out registration. Reaches the outside only
 * through the host ports and the `GEO_LOCATION_PROVIDER` token of the location slice.
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
   * @param _options - reserved.
   */
  static forRoot(_options: LocationInferenceModuleOptions = {}): DynamicModule {
    LocationInferenceModule.root ??= {
      module: LocationInferenceModule,
      imports: [LocationModule.forRoot(), MediaModule.forRoot(), ReviewRunsModule.forRoot()],
      providers: [
        LocationInferenceService,
        LocationInferenceHandler,
        LocationInferenceBackfillService,
        LocationSuggestionService,
        LocationInferenceUploadEnrichment,
        LocationSuggestionReviewStrategy,
      ],
      exports: [LocationInferenceService, LocationInferenceBackfillService, LocationSuggestionService],
    };
    return LocationInferenceModule.root;
  }
}
