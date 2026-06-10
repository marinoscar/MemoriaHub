import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GEO_LOCATION_PROVIDER } from './geo-location-provider.interface';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';

/**
 * GeoLocationModule — selects the active reverse-geocoding provider based on
 * the `GEO_PROVIDER` environment variable (default: `offline`).
 *
 * Supported values:
 *   offline    — local-reverse-geocoder (GeoNames dataset, no network calls)
 *   nominatim  — OSM Nominatim HTTP API (WARNING: sends GPS off-server)
 *
 * Mirror of StorageProvidersModule pattern.
 */
@Module({
  providers: [
    OfflineGeoLocationProvider,
    NominatimGeoLocationProvider,
    {
      provide: GEO_LOCATION_PROVIDER,
      inject: [ConfigService, OfflineGeoLocationProvider, NominatimGeoLocationProvider],
      useFactory: (
        config: ConfigService,
        offline: OfflineGeoLocationProvider,
        nominatim: NominatimGeoLocationProvider,
      ) => {
        const provider = config.get<string>('GEO_PROVIDER', 'offline');
        if (provider === 'nominatim') {
          return nominatim;
        }
        return offline;
      },
    },
  ],
  exports: [GEO_LOCATION_PROVIDER],
})
export class GeoLocationModule {}
