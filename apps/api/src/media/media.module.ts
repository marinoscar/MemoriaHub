import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { GeoLocationModule } from './geo/geo-location.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import {
  MEDIA_ITEM_PURGER,
  MediaModule as MediaCoreModule,
  TrashPurgeHandler,
  TrashPurgeTask,
} from '@marinoscar/memoriahub-api/media';
import { LocationGroupsModule } from '../location-groups/location-groups.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { ForwardGeocodeService } from './geo/forward-geocode.service';
import { MediaReprocessController } from './media-reprocess.controller';
import { MediaThumbnailRerunController } from './media-thumbnail-rerun.controller';
import { MediaOrientationEditController } from './media-orientation-edit.controller';
import { MediaOrientationEditService } from './media-orientation-edit.service';
import { ThumbnailProcessor } from '../media-processing/processors/thumbnail.processor';
import { ImageDimensionsProcessor } from '../media-processing/processors/image-dimensions.processor';
import { ThumbnailRepairHandler } from './thumbnail-repair.handler';
import { ThumbnailRepairTask } from './thumbnail-repair.task';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';
import { MediaEnrichmentEnqueueListener } from './enrichment/media-enrichment-enqueue.listener';
import { ThumbnailRegenHandler } from './thumbnail-regen.handler';
import { ThumbnailNodePersistService } from './thumbnail-node-persist.service';
import { TrashEmptyRunService } from './trash-empty/trash-empty-run.service';
import { TrashEmptyRunsController } from './trash-empty/trash-empty-runs.controller';
import { TrashEmptyEvaluateHandler } from './trash-empty/trash-empty-evaluate.handler';
import { TrashEmptyExecuteBatchHandler } from './trash-empty/trash-empty-execute-batch.handler';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * MediaModule
 *
 * Imports MediaProcessingModule so that STORAGE_PROVIDER resolves inside
 * MediaService (used to sign fresh thumbnail and download URLs at read time).
 *
 * Imports OwnerAccessModule so that OwnerAccessService resolves inside
 * MediaService (used for circle-scoped access checks).
 *
 * Imports SettingsModule so TrashPurgeHandler can read storage.trash.retentionDays
 * and MediaEnrichmentService can call AppSystemSettingsService.isFeatureEnabled.
 *
 * Imports EnrichmentModule so TrashPurgeHandler can register with the handler
 * registry, TrashPurgeTask can enqueue jobs, and MediaEnrichmentService can
 * call EnrichmentJobService.enqueue.
 *
 * TrashPurgeTask and ThumbnailRepairTask @Cron decorators work via
 * ScheduleModule.forRoot() in AppModule. ThumbnailRepairHandler additionally
 * uses ObjectReprocessService (exported by MediaProcessingModule) and
 * MediaMetadataSyncService for its reprocess/resync repair paths.
 *
 * Circular-dependency note:
 *   MediaProcessingModule (the storage resolver, the processors and the
 *   recovery service, RETRO-D1) has no dependency on MediaModule, so there is no cycle.
 *   EnrichmentModule and SettingsModule do not import MediaModule.
 *
 * ThumbnailProcessor and ImageDimensionsProcessor are registered directly here
 * (a separate, stateless provider scope) for the services of this module that
 * inject them. (MediaReprocessService, their first consumer, is gone since
 * RETRO-D1b: the admin bulk reprocess is the `media.storage.reprocess` job.)
 *
 * Imports MediaProcessingModule so ObjectReprocessService resolves inside
 * MediaThumbnailRerunController (per-item retry) and the orientation edit.
 * MediaReprocessController (admin bulk recovery) only enqueues jobs. MediaProcessingModule does not
 * depend on MediaModule, so this does not introduce a cycle.
 *
 * Imports the packaged media slice (`MediaCoreModule.forRoot()`, RETRO-J5) so
 * UploadNotificationService (the `media.upload_completed` producer, epic #240 /
 * issue #247; through MEMORIAHUB_NOTIFY), MediaTouchService, the upload
 * enrichment registry and MediaSyncService resolve. It imports nothing of the
 * media graph, so this edge cannot close a cycle — which is why the review-queue
 * reconcile, which needs MediaService, lives in NotificationReconcileModule:
 *   NotificationReconcileModule -> MediaModule -> MediaCoreModule
 */
@Module({
  imports: [
    PrismaModule,
    MediaProcessingModule,
    OwnerAccessModule,
    GeoLocationModule,
    
    EnrichmentModule,
    // The packaged media slice (RETRO-J5): upload fan-out registry, touch service, the
    // `upload_completed` producer and the Media Sync device service.
    MediaCoreModule.forRoot(),
    // Location Grouping (issue #373) — MediaService.bulkUpdateMedia and
    // MediaMetadataSyncService both need the canonical-name resolver.
    LocationGroupsModule,
  ],
  controllers: [
    MediaController,
    MediaReprocessController,
    MediaThumbnailRerunController,
    MediaOrientationEditController,
    TrashEmptyRunsController,
  ],
  providers: [
    MediaService,
    MediaMetadataSyncService,
    ForwardGeocodeService,
    ThumbnailProcessor,
    ImageDimensionsProcessor,
    // The trash purge job and its hourly cron are the media slice's; the batched hard delete they
    // call is this module's MediaService until the gallery service moves into the package.
    TrashPurgeHandler,
    TrashPurgeTask,
    { provide: MEDIA_ITEM_PURGER, useExisting: MediaService },
    ThumbnailRepairHandler,
    ThumbnailRepairTask,
    MediaEnrichmentService,
    MediaEnrichmentEnqueueListener,
    MediaOrientationEditService,
    ThumbnailRegenHandler,
    ThumbnailNodePersistService,
    TrashEmptyRunService,
    TrashEmptyEvaluateHandler,
    TrashEmptyExecuteBatchHandler,
  ],
  exports: [MediaService, MediaMetadataSyncService, MediaEnrichmentService, TrashEmptyRunService, MediaCoreModule.forRoot()],
})
export class MediaModule {}
