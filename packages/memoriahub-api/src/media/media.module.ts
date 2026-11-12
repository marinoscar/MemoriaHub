import { Module, type DynamicModule } from '@nestjs/common';

import { UploadEnrichmentRegistry } from './enrichment-fanout/upload-enrichment.registry.js';
import { UploadEnrichmentService } from './enrichment-fanout/upload-enrichment.service.js';
import { AndroidMediaSyncDoctorCheck } from './doctor/android-media-sync.doctor-check.js';
import { AndroidUploadPathDoctorCheck } from './doctor/android-upload-path.doctor-check.js';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service.js';
import { MEDIA_ENRICHMENT } from './hooks/media-host-hooks.js';
import { MediaSyncService } from './media-sync/media-sync.service.js';
import { TrashEmptyRunService } from './trash-empty/trash-empty-run.service.js';
import { MediaThumbnailService } from './thumbnails/media-thumbnail.service.js';
import { ReviewQueueCounterRegistry } from './producers/review-queue-counter.registry.js';
import { UploadNotificationService } from './producers/upload-notification.service.js';
import { MediaTouchModule } from './touch/media-touch.module.js';

/**
 * Options of {@link MediaModule.forRoot}. None yet: the slice's behaviour is
 * configured through the ports and through the registries it exposes
 * ({@link UploadEnrichmentRegistry}).
 *
 * @stability experimental
 */
export interface MediaModuleOptions {
  /** Reserved for the options the rest of the slice brings (thumbnail TTL, feature toggles). */
  readonly reserved?: never;
}

/**
 * The media slice (RETRO-J5, #613). It reaches the outside only through the ports of
 * `@marinoscar/memoriahub-api/ports` (the host binds them once with
 * `MemoriahubPortsModule.forRoot`) and exports what the host and the other slices inject:
 * the upload fan-out registry and service, the sidecar touch service, the `upload_completed`
 * producer, the enrichment service (the `MEDIA_ENRICHMENT` hook the gallery calls and the video
 * post-detection fan-out) and the Media Sync device service.
 *
 * The slice's controllers (`MediaSyncController`, `TrashEmptyRunsController`) are exported classes, not
 * mounted by `forRoot()`: the host lists them in the `controllers` of the module where its routes belong,
 * so the order of its OpenAPI document (which follows module order) stays the host's decision. The same
 * goes for the job handlers that need the host's `MEDIA_ITEM_PURGER` (`TrashPurgeHandler`,
 * `TrashEmptyExecuteBatchHandler`) and `TrashEmptyEvaluateHandler`: the host lists them as providers.
 *
 * Import it ONCE in the host (the registry is a singleton) and re-export it from the
 * host's own media module.
 *
 * @stability experimental
 */
@Module({})
export class MediaModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module. The result is cached, so every `forRoot()` call in a host's module graph
   * names the same module instance and the registry stays a singleton.
   *
   * @param _options - reserved.
   */
  static forRoot(_options: MediaModuleOptions = {}): DynamicModule {
    MediaModule.root ??= {
      module: MediaModule,
      imports: [MediaTouchModule],
      providers: [
        UploadEnrichmentRegistry,
        ReviewQueueCounterRegistry,
        UploadEnrichmentService,
        UploadNotificationService,
        AndroidMediaSyncDoctorCheck,
        AndroidUploadPathDoctorCheck,
        MediaEnrichmentService,
        { provide: MEDIA_ENRICHMENT, useExisting: MediaEnrichmentService },
        MediaSyncService,
        MediaThumbnailService,
        TrashEmptyRunService,
      ],
      exports: [
        MediaTouchModule,
        UploadEnrichmentRegistry,
        ReviewQueueCounterRegistry,
        UploadEnrichmentService,
        UploadNotificationService,
        MediaEnrichmentService,
        MEDIA_ENRICHMENT,
        MediaSyncService,
        MediaThumbnailService,
        TrashEmptyRunService,
      ],
    };
    return MediaModule.root;
  }
}
