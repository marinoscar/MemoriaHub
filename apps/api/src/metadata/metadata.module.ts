import { Module } from '@nestjs/common';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { MediaModule } from '../media/media.module';
import { MetadataExtractionHandler } from './metadata.handler';
import { MetadataExtractionService } from './metadata.service';
import { MetadataController } from './metadata.controller';
import { MetadataBackfillService } from './metadata-backfill.service';
import { AdminMetadataController } from './admin-metadata.controller';

@Module({
  imports: [
    EnrichmentModule,
    StorageProvidersModule,
    PrismaModule,
    CirclesModule,
    GeoLocationModule,
    MediaModule, // provides MediaMetadataSyncService (now exported)
  ],
  controllers: [MetadataController, AdminMetadataController],
  providers: [
    // Compute now runs via the shared @memoriahub/enrichment-compute/metadata
    // package (compute/persist split — see metadata.service.ts). The
    // ObjectProcessor classes are no longer instantiated here; geocoding runs
    // server-side in the persist half via GeoLocationService.
    MetadataExtractionHandler,
    MetadataExtractionService,
    MetadataBackfillService,
  ],
})
export class MetadataModule {}
