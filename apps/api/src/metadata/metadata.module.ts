import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { MediaModule } from '../media/media.module';
import { OBJECT_PROCESSOR } from '../storage/processing/object-processor.interface';
import { ExifProcessor } from '../storage/processing/processors/exif.processor';
import { ImageDimensionsProcessor } from '../storage/processing/processors/image-dimensions.processor';
import { ReverseGeocodeProcessor } from '../storage/processing/processors/reverse-geocode.processor';
import { VideoProbeProcessor } from '../storage/processing/processors/video-probe.processor';
import { MetadataExtractionHandler } from './metadata.handler';
import { MetadataExtractionService } from './metadata.service';
import { MetadataController } from './metadata.controller';

@Module({
  imports: [
    EnrichmentModule,
    StorageProvidersModule,
    PrismaModule,
    CirclesModule,
    GeoLocationModule,
    MediaModule, // provides MediaMetadataSyncService (now exported)
  ],
  controllers: [MetadataController],
  providers: [
    // Individual processor classes (same pattern as MediaModule re-registering processors)
    ExifProcessor,
    ImageDimensionsProcessor,
    VideoProbeProcessor,
    ReverseGeocodeProcessor,

    // Aggregate OBJECT_PROCESSOR token for MetadataExtractionService
    {
      provide: OBJECT_PROCESSOR,
      inject: [ExifProcessor, ImageDimensionsProcessor, VideoProbeProcessor, ReverseGeocodeProcessor],
      useFactory: (
        exif: ExifProcessor,
        dimensions: ImageDimensionsProcessor,
        videoProbe: VideoProbeProcessor,
        geocode: ReverseGeocodeProcessor,
      ) => [exif, dimensions, videoProbe, geocode],
    },

    MetadataExtractionHandler,
    MetadataExtractionService,
  ],
})
export class MetadataModule {}
