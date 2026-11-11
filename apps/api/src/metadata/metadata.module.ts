import { Module } from '@nestjs/common';
import {
  AdminMetadataController,
  MEDIA_REVERSE_GEOCODER,
  MetadataBackfillService,
  MetadataController,
  MetadataExtractionHandler,
  MetadataExtractionService,
} from '@marinoscar/memoriahub-api/media';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { GeoLocationService } from '../media/geo/geo-location.service';
import { MediaModule } from '../media/media.module';

/**
 * The metadata re-run: the handler, the service, the backfill and the two controllers live in
 * `@marinoscar/memoriahub-api/media`; the app mounts them here (the OpenAPI document follows
 * module order) and binds the reverse-geocoding hook to its geo service.
 */
@Module({
  imports: [
    EnrichmentModule,
    MediaProcessingModule,
    PrismaModule,
    OwnerAccessModule,
    GeoLocationModule,
    MediaModule, // provides MediaMetadataSyncService (now exported)
  ],
  controllers: [MetadataController, AdminMetadataController],
  providers: [
    // Compute runs via the shared @marinoscar/memoriahub-compute/metadata package; geocoding runs
    // server-side in the persist half through the hook below.
    { provide: MEDIA_REVERSE_GEOCODER, useExisting: GeoLocationService },
    MetadataExtractionHandler,
    MetadataExtractionService,
    MetadataBackfillService,
  ],
})
export class MetadataModule {}
