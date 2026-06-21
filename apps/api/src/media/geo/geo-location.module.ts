import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GEO_LOCATION_PROVIDER } from './geo-location-provider.interface';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { GoogleGeoLocationProvider } from './google-geo-location.provider';
import { GeoLocationService } from './geo-location.service';
import { SettingsModule } from '../../settings/settings.module';

@Module({
  imports: [SettingsModule],
  providers: [
    OfflineGeoLocationProvider,
    NominatimGeoLocationProvider,
    GoogleGeoLocationProvider,
    GeoLocationService,
    {
      provide: GEO_LOCATION_PROVIDER,
      inject: [ConfigService, OfflineGeoLocationProvider, NominatimGeoLocationProvider],
      useFactory: (
        config: ConfigService,
        offline: OfflineGeoLocationProvider,
        nominatim: NominatimGeoLocationProvider,
      ) => {
        const provider = config.get<string>('GEO_PROVIDER', 'offline');
        if (provider === 'nominatim') return nominatim;
        return offline;
      },
    },
  ],
  exports: [GEO_LOCATION_PROVIDER, GoogleGeoLocationProvider, GeoLocationService, OfflineGeoLocationProvider, NominatimGeoLocationProvider],
})
export class GeoLocationModule {}
