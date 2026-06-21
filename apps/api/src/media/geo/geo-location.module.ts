import { Module } from '@nestjs/common';
import { GEO_LOCATION_PROVIDER } from './geo-location-provider.interface';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { GoogleGeoLocationProvider } from './google-geo-location.provider';
import { GeoLocationService } from './geo-location.service';
import { DelegatingGeoLocationProvider } from './delegating-geo-location.provider';
import { SettingsModule } from '../../settings/settings.module';

/**
 * GeoLocationModule — provides the active reverse-geocoding provider via the
 * GEO_LOCATION_PROVIDER injection token.
 *
 * The active provider is resolved at runtime on every call by
 * DelegatingGeoLocationProvider, which reads `geo.reverseProvider` from system
 * settings (falling back to the `GEO_PROVIDER` env var, then `'offline'`).
 * This allows admins to switch providers through the System Settings UI
 * without restarting the process.
 *
 * Supported values:
 *   offline    — local-reverse-geocoder (GeoNames dataset, no network calls)
 *   nominatim  — OSM Nominatim HTTP API (WARNING: sends GPS off-server)
 *   google     — Google Maps Geocoding API (requires encrypted credential in geo_provider_credentials)
 */
@Module({
  imports: [SettingsModule],
  providers: [
    OfflineGeoLocationProvider,
    NominatimGeoLocationProvider,
    GoogleGeoLocationProvider,
    GeoLocationService,
    DelegatingGeoLocationProvider,
    {
      provide: GEO_LOCATION_PROVIDER,
      useClass: DelegatingGeoLocationProvider,
    },
  ],
  exports: [GEO_LOCATION_PROVIDER, GeoLocationService, GoogleGeoLocationProvider, OfflineGeoLocationProvider, NominatimGeoLocationProvider],
})
export class GeoLocationModule {}
