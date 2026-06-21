import { Module } from '@nestjs/common';
import { GeoSettingsController } from './geo-settings.controller';
import { GeoSettingsService } from './geo-settings.service';
import { GeocodeAdminController } from './geocode-admin.controller';
import { GeocodeMediaController } from './geocode-media.controller';
import { GeocodeBackfillService } from './geocode-backfill.service';
import { GeocodeHandler } from './geocode.handler';
import { GeoLocationModule } from '../media/geo/geo-location.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { CirclesModule } from '../circles/circles.module';

@Module({
  imports: [GeoLocationModule, SettingsModule, EnrichmentModule, CirclesModule],
  controllers: [GeoSettingsController, GeocodeAdminController, GeocodeMediaController],
  providers: [GeoSettingsService, GeocodeBackfillService, GeocodeHandler],
  exports: [GeocodeBackfillService],
})
export class GeoModule {}
