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
import { ReviewRunsModule } from '../review-runs/review-runs.module';
import { LocationSuggestionRunsController } from './runs/location-suggestion-runs.controller';
import { LocationSuggestionRunEvaluateHandler } from './runs/location-suggestion-run-evaluate.handler';
import { LocationSuggestionRunExecuteBatchHandler } from './runs/location-suggestion-run-execute-batch.handler';

/**
 * LocationInferenceModule
 *
 * Imports GeoLocationModule so LocationSuggestionService can call the shared
 * applyLocation() helper via the GEO_LOCATION_PROVIDER token directly.
 *
 * Also imports MediaModule for MediaThumbnailService (batched thumbnail
 * signing). This introduces no cycle: MediaModule never imports this module.
 *
 * Since issue #190 the bulk accept/reject run lifecycle lives in
 * ReviewRunsModule (shared with the burst and duplicate review queues); the two
 * handler classes kept here are deprecated shims that drain jobs queued under
 * the old `location_suggestion_run_*` types. ReviewRunsModule does not import
 * this module, so the plain import below is cycle-free.
 */
@Module({
  imports: [
    EnrichmentModule,
    StorageProvidersModule,
    PrismaModule,
    CirclesModule,
    SettingsModule,
    GeoLocationModule,
    MediaModule,
    ReviewRunsModule,
  ],
  controllers: [
    LocationSuggestionController,
    AdminLocationInferenceController,
    LocationSuggestionRunsController,
  ],
  providers: [
    LocationInferenceService,
    LocationInferenceHandler,
    LocationInferenceBackfillService,
    LocationSuggestionService,
    LocationSuggestionRunEvaluateHandler,
    LocationSuggestionRunExecuteBatchHandler,
  ],
  exports: [LocationSuggestionService],
})
export class LocationInferenceModule {}
