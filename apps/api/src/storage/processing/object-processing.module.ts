import { Module } from '@nestjs/common';
import { ObjectProcessingService } from './object-processing.service';
import { StorageProvidersModule } from '../providers/storage-providers.module';
import { GeoLocationModule } from '../../media/geo/geo-location.module';
import { OBJECT_PROCESSOR } from './object-processor.interface';
import { ContentHashProcessor } from './processors/content-hash.processor';
import { ExifProcessor } from './processors/exif.processor';
import { ImageDimensionsProcessor } from './processors/image-dimensions.processor';
import { VideoProbeProcessor } from './processors/video-probe.processor';
import { ReverseGeocodeProcessor } from './processors/reverse-geocode.processor';
import { ThumbnailProcessor } from './processors/thumbnail.processor';

/**
 * ObjectProcessingModule
 *
 * Multi-processor injection strategy:
 * All five processor classes are registered as individual providers so NestJS
 * can construct and inject their own dependencies (e.g. ReverseGeocodeProcessor
 * needs GEO_LOCATION_PROVIDER).  A factory provider bound to OBJECT_PROCESSOR
 * then collects them all into an array, which ObjectProcessingService receives
 * via @Inject(OBJECT_PROCESSOR) — its normalizeProcessors() handles both
 * scalar and array forms, so this is fully backward-compatible.
 */
@Module({
  imports: [StorageProvidersModule, GeoLocationModule],
  providers: [
    // Individual processor providers — each class gets its own DI scope so
    // constructor injection (e.g. GEO_LOCATION_PROVIDER) resolves correctly.
    ContentHashProcessor,
    ExifProcessor,
    ImageDimensionsProcessor,
    VideoProbeProcessor,
    ReverseGeocodeProcessor,
    ThumbnailProcessor,

    // Aggregate all processors under the OBJECT_PROCESSOR token as an array.
    // ObjectProcessingService.normalizeProcessors() handles the array form.
    {
      provide: OBJECT_PROCESSOR,
      inject: [
        ContentHashProcessor,
        ExifProcessor,
        ImageDimensionsProcessor,
        VideoProbeProcessor,
        ReverseGeocodeProcessor,
        ThumbnailProcessor,
      ],
      useFactory: (
        contentHash: ContentHashProcessor,
        exif: ExifProcessor,
        dimensions: ImageDimensionsProcessor,
        videoProbe: VideoProbeProcessor,
        geocode: ReverseGeocodeProcessor,
        thumbnail: ThumbnailProcessor,
      ) => [contentHash, exif, dimensions, videoProbe, geocode, thumbnail],
    },

    ObjectProcessingService,
  ],
  exports: [ObjectProcessingService],
})
export class ObjectProcessingModule {}
