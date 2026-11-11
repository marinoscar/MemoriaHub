import { Inject, Injectable, Logger } from '@nestjs/common';

import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../../ports/index.js';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface.js';
import { GeoLocationService } from './geo-location.service.js';
import type { GeoSettingsDocument } from './geo-settings-shape.js';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider.js';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider.js';

/**
 * DelegatingGeoLocationProvider
 *
 * Delegates each reverse-geocoding call to the active provider resolved
 * at runtime from system settings (`geo.reverseProvider`), falling back to the
 * `GEO_PROVIDER` environment variable and finally to `'offline'`. It is what the
 * `GEO_LOCATION_PROVIDER` token resolves to, so an administrator can switch providers
 * in the settings UI without restarting the process.
 *
 * Supported providers:
 *   offline    — local-reverse-geocoder (GeoNames dataset, no network calls)
 *   nominatim  — OSM Nominatim HTTP API (WARNING: sends GPS off-server)
 *   google     — Google Maps Geocoding API (requires a stored credential; delegated to
 *                GeoLocationService, which handles the key lookup and the offline fallback
 *                on a missing or disabled key)
 *
 * @stability experimental
 */
@Injectable()
export class DelegatingGeoLocationProvider implements GeoLocationProvider {
  private readonly logger = new Logger(DelegatingGeoLocationProvider.name);

  constructor(
    private readonly offline: OfflineGeoLocationProvider,
    private readonly nominatim: NominatimGeoLocationProvider,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly geoLocationService: GeoLocationService,
  ) {}

  /**
   * Resolve the active provider name from system settings on every call.
   * Falls back to GEO_PROVIDER env var, then to 'offline'.
   */
  private async resolveProviderName(): Promise<string> {
    const settingValue = await this.settings
      .readSystem<GeoSettingsDocument | undefined>('geo')
      .then(({ value }) => value?.reverseProvider)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to read geo.reverseProvider from system settings: ${msg}`);
        return undefined;
      });

    return settingValue ?? process.env['GEO_PROVIDER'] ?? 'offline';
  }

  /**
   * Reverse-geocodes through the active provider.
   *
   * @param lat - latitude in decimal degrees.
   * @param lng - longitude in decimal degrees.
   */
  async reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null> {
    const providerName = await this.resolveProviderName();

    if (providerName === 'google') {
      // Delegate to GeoLocationService which handles credential lookup,
      // decryption, and transparent fallback to offline on missing/disabled key.
      const { result } = await this.geoLocationService.reverseGeocode(lat, lng);
      return result;
    }

    if (providerName === 'nominatim') {
      return this.nominatim.reverseGeocode(lat, lng);
    }

    return this.offline.reverseGeocode(lat, lng);
  }
}
