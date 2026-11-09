import { Module } from '@nestjs/common';
import { ObjectProcessingModule, StorageProvidersModule } from '@marinoscar/platform-api/storage';

import { GeoLocationModule } from '../media/geo/geo-location.module';
import { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';
import { MediaObjectProcessingService } from './media-object-processing.service';
import { MediaProcessorsRegistrar } from './media-processors.registrar';
import { ContentHashProcessor } from './processors/content-hash.processor';
import { ExifProcessor } from './processors/exif.processor';
import { ImageDimensionsProcessor } from './processors/image-dimensions.processor';
import { ReverseGeocodeProcessor } from './processors/reverse-geocode.processor';
import { ThumbnailProcessor } from './processors/thumbnail.processor';
import { VideoProbeProcessor } from './processors/video-probe.processor';
import { VisualHashProcessor } from './processors/visual-hash.processor';
import { StorageProcessingRecoveryService } from './recovery/storage-processing-recovery.service';
import { StorageProcessingRecoveryTask } from './recovery/storage-processing-recovery.task';
import { ThumbnailPruneService } from './thumbnail-prune.service';

// =============================================================================
// MediaProcessingModule: MemoriaHub's media pipeline on the platform storage slice (RETRO-D1, #563)
// =============================================================================
//
// What MemoriaHub adds to the platform's object storage:
//
//   * the seven post-upload processors, registered on the platform's
//     `ObjectProcessorRegistry` (they run in the `storage.object.process` job);
//   * `MediaObjectProcessingService`: the `storage.object.processed` app event
//     and the inline re-run the destructive edits use;
//   * `StorageProviderResolver`: the active and the per-row provider, over the
//     platform's `STORAGE_PROVIDER` and `StorageProviderRouter`, for every
//     feature that moves bytes;
//   * `ThumbnailPruneService` (content-addressed thumbnails, #434) and the
//     stuck-object recovery (RETRO-D1b moves it onto the platform's own).
//
// `ObjectProcessingModule` and `StorageProvidersModule` are the platform's static
// modules, so the registry and the provider here are the same instances the
// storage slice's job and objects API use.
// =============================================================================

@Module({
  imports: [StorageProvidersModule, ObjectProcessingModule, GeoLocationModule],
  providers: [
    StorageProviderResolver,
    ContentHashProcessor,
    ExifProcessor,
    ImageDimensionsProcessor,
    VideoProbeProcessor,
    ReverseGeocodeProcessor,
    ThumbnailProcessor,
    VisualHashProcessor,
    MediaProcessorsRegistrar,
    MediaObjectProcessingService,
    ThumbnailPruneService,
    StorageProcessingRecoveryService,
    StorageProcessingRecoveryTask,
  ],
  exports: [
    StorageProvidersModule,
    StorageProviderResolver,
    MediaObjectProcessingService,
    ThumbnailPruneService,
    StorageProcessingRecoveryService,
    ThumbnailProcessor,
  ],
})
export class MediaProcessingModule {}
