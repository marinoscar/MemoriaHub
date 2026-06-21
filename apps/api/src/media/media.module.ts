import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { CirclesModule } from '../circles/circles.module';
import { GeoLocationModule } from './geo/geo-location.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { ForwardGeocodeService } from './geo/forward-geocode.service';
import { MediaReprocessService } from './media-reprocess.service';
import { MediaReprocessController } from './media-reprocess.controller';
import { ThumbnailProcessor } from '../storage/processing/processors/thumbnail.processor';
import { ImageDimensionsProcessor } from '../storage/processing/processors/image-dimensions.processor';

/**
 * MediaModule
 *
 * Imports StorageProvidersModule so that STORAGE_PROVIDER resolves inside
 * MediaService (used to sign fresh thumbnail and download URLs at read time).
 *
 * Imports CirclesModule so that CircleMembershipService resolves inside
 * MediaService (used for circle-scoped access checks).
 *
 * Circular-dependency note:
 *   StorageProvidersModule only provides S3StorageProvider — it has no
 *   dependency on MediaModule — so there is no cycle.
 *
 * ThumbnailProcessor and ImageDimensionsProcessor are registered directly here
 * (not imported from ObjectProcessingModule, which does not export them) so
 * that MediaReprocessService can receive them via DI.  They are stateless and
 * safe to instantiate as a separate provider scope.
 */
@Module({
  imports: [PrismaModule, StorageProvidersModule, CirclesModule, GeoLocationModule, SettingsModule],
  controllers: [MediaController, MediaReprocessController],
  providers: [
    MediaService,
    MediaMetadataSyncService,
    ForwardGeocodeService,
    MediaReprocessService,
    ThumbnailProcessor,
    ImageDimensionsProcessor,
  ],
  exports: [MediaService, MediaReprocessService, MediaMetadataSyncService],
})
export class MediaModule {}
