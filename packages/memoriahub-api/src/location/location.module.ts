import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { LocationGroupRebuildHandler } from './groups/location-group-rebuild.handler.js';
import { LocationGroupRebuildService } from './groups/location-group-rebuild.service.js';
import { LocationGroupResolverService } from './groups/location-group-resolver.service.js';
import { LocationGroupsService } from './groups/location-groups.service.js';
import { DelegatingGeoLocationProvider } from './geo/delegating-geo-location.provider.js';
import { ForwardGeocodeService } from './geo/forward-geocode.service.js';
import { GEO_LOCATION_PROVIDER } from './geo/geo-location-provider.interface.js';
import { GeoGoogleCredentialResolver } from './geo/geo-google-credential.resolver.js';
import { GeoLocationService } from './geo/geo-location.service.js';
import { GeoSettingsService } from './geo/geo-settings.service.js';
import { GeocodeBackfillService } from './geo/geocode-backfill.service.js';
import { GeocodeHandler } from './geo/geocode.handler.js';
import { GeoReverseProviderDoctorCheck } from './doctor/reverse-provider.doctor-check.js';
import { GoogleGeoLocationProvider } from './geo/google-geo-location.provider.js';
import { GoogleGeocodeKeyBroker } from './geo/google-geocode-key.broker.js';
import { NominatimGeoLocationProvider } from './geo/nominatim-geo-location.provider.js';
import { OfflineGeoLocationProvider } from './geo/offline-geo-location.provider.js';

/**
 * Options of {@link LocationModule.forRoot}. None yet: the slice reads the `locationGrouping`
 * settings namespace and the `LOCATION_GROUPING_ENABLED` kill switch through the settings port.
 *
 * @stability experimental
 */
export interface LocationModuleOptions {
  /** Reserved for options the slice may bring; the geo providers read their settings through the ports. */
  readonly reserved?: never;
}

/**
 * The location slice (RETRO-J10, #624). It carries location grouping (the resolver that is the one writer of
 * canonical place names, the set-based `location_group_rebuild` job and its enqueue helper, the management
 * service behind `/api/location-groups`) and the geo half: the reverse providers (offline GeoNames,
 * Nominatim, Google) behind `GEO_LOCATION_PROVIDER`, the forward place search, the geo settings and Google
 * key administration, the `geocode` job with its per-job key broker and the geocode backfill. It reaches the
 * outside only through the host ports and imports the media slice for cover thumbnails.
 *
 * Import it ONCE in the host and re-export it from the host's own location module.
 *
 * @stability experimental
 */
@Module({})
export class LocationModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: LocationModuleOptions = {}): DynamicModule {
    LocationModule.root ??= {
      module: LocationModule,
      imports: [MediaModule.forRoot()],
      providers: [
        LocationGroupResolverService,
        LocationGroupRebuildService,
        LocationGroupRebuildHandler,
        LocationGroupsService,
        OfflineGeoLocationProvider,
        NominatimGeoLocationProvider,
        GoogleGeoLocationProvider,
        GeoGoogleCredentialResolver,
        GeoLocationService,
        DelegatingGeoLocationProvider,
        { provide: GEO_LOCATION_PROVIDER, useExisting: DelegatingGeoLocationProvider },
        ForwardGeocodeService,
        GeoSettingsService,
        GeocodeBackfillService,
        GoogleGeocodeKeyBroker,
        GeocodeHandler,
        GeoReverseProviderDoctorCheck,
      ],
      exports: [
        LocationGroupResolverService,
        LocationGroupRebuildService,
        LocationGroupsService,
        GEO_LOCATION_PROVIDER,
        GeoLocationService,
        DelegatingGeoLocationProvider,
        OfflineGeoLocationProvider,
        NominatimGeoLocationProvider,
        GoogleGeoLocationProvider,
        GeoGoogleCredentialResolver,
        ForwardGeocodeService,
        GeoSettingsService,
        GeocodeBackfillService,
      ],
    };
    return LocationModule.root;
  }
}
