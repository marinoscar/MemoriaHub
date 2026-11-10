import { Module } from '@nestjs/common';
import { CredentialsModule } from '../platform/credentials/credentials.config';
import { GeoSettingsController } from './geo-settings.controller';
import { GeoSettingsService } from './geo-settings.service';
import { GeocodeAdminController } from './geocode-admin.controller';
import { GeocodeMediaController } from './geocode-media.controller';
import { GeocodeBackfillService } from './geocode-backfill.service';
import { GeocodeHandler } from './geocode.handler';
import { GoogleGeocodeKeyBroker } from './google-geocode-key.broker';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { LocationGroupsModule } from '../location-groups/location-groups.module';

@Module({
  imports: [CredentialsModule, GeoLocationModule, EnrichmentModule, OwnerAccessModule, LocationGroupsModule],
  controllers: [GeoSettingsController, GeocodeAdminController, GeocodeMediaController],
  providers: [GeoSettingsService, GeocodeBackfillService, GoogleGeocodeKeyBroker, GeocodeHandler],
  exports: [GeocodeBackfillService, GeoSettingsService],
})
export class GeoModule {}
