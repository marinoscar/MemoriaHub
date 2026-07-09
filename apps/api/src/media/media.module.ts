import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { StorageModule } from '../storage/storage.module';
import { CirclesModule } from '../circles/circles.module';
import { GeoLocationModule } from './geo/geo-location.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { ForwardGeocodeService } from './geo/forward-geocode.service';
import { MediaReprocessService } from './media-reprocess.service';
import { MediaReprocessController } from './media-reprocess.controller';
import { MediaThumbnailRerunController } from './media-thumbnail-rerun.controller';
import { MediaOrientationEditController } from './media-orientation-edit.controller';
import { MediaOrientationEditService } from './media-orientation-edit.service';
import { ThumbnailProcessor } from '../storage/processing/processors/thumbnail.processor';
import { ImageDimensionsProcessor } from '../storage/processing/processors/image-dimensions.processor';
import { TrashPurgeHandler } from './trash-purge.handler';
import { TrashPurgeTask } from './trash-purge.task';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';
import { MediaEnrichmentEnqueueListener } from './enrichment/media-enrichment-enqueue.listener';
import { MediaThumbnailService } from './media-thumbnail.service';
import { ThumbnailRegenHandler } from './thumbnail-regen.handler';

/**
 * MediaModule
 *
 * Imports StorageProvidersModule so that STORAGE_PROVIDER resolves inside
 * MediaService (used to sign fresh thumbnail and download URLs at read time).
 *
 * Imports CirclesModule so that CircleMembershipService resolves inside
 * MediaService (used for circle-scoped access checks).
 *
 * Imports SettingsModule so TrashPurgeHandler can read storage.trash.retentionDays
 * and MediaEnrichmentService can call SystemSettingsService.isFeatureEnabled.
 *
 * Imports EnrichmentModule so TrashPurgeHandler can register with the handler
 * registry, TrashPurgeTask can enqueue jobs, and MediaEnrichmentService can
 * call EnrichmentJobService.enqueue.
 *
 * TrashPurgeTask @Cron decorators work via ScheduleModule.forRoot() in AppModule.
 *
 * Circular-dependency note:
 *   StorageProvidersModule only provides S3StorageProvider — it has no
 *   dependency on MediaModule — so there is no cycle.
 *   EnrichmentModule and SettingsModule do not import MediaModule.
 *
 * ThumbnailProcessor and ImageDimensionsProcessor are registered directly here
 * (not imported from ObjectProcessingModule, which does not export them) so
 * that MediaReprocessService can receive them via DI.  They are stateless and
 * safe to instantiate as a separate provider scope.
 *
 * Imports StorageModule so StorageProcessingRecoveryService resolves inside
 * MediaReprocessController (admin bulk recovery) and
 * MediaThumbnailRerunController (per-item retry). StorageModule does not
 * depend on MediaModule, so this does not introduce a cycle.
 */
@Module({
  imports: [
    PrismaModule,
    StorageProvidersModule,
    StorageModule,
    CirclesModule,
    GeoLocationModule,
    SettingsModule,
    EnrichmentModule,
  ],
  controllers: [
    MediaController,
    MediaReprocessController,
    MediaThumbnailRerunController,
    MediaOrientationEditController,
  ],
  providers: [
    MediaService,
    MediaMetadataSyncService,
    ForwardGeocodeService,
    MediaReprocessService,
    ThumbnailProcessor,
    ImageDimensionsProcessor,
    TrashPurgeHandler,
    TrashPurgeTask,
    MediaEnrichmentService,
    MediaEnrichmentEnqueueListener,
    MediaThumbnailService,
    MediaOrientationEditService,
    ThumbnailRegenHandler,
  ],
  exports: [MediaService, MediaReprocessService, MediaMetadataSyncService, MediaEnrichmentService, MediaThumbnailService],
})
export class MediaModule {}
