import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { GeoLocationService } from './geo-location.service';

/**
 * DelegatingGeoLocationProvider
 *
 * Delegates each reverse-geocoding call to the active provider resolved
 * at runtime from system settings (`geo.reverseProvider`), falling back to the
 * `GEO_PROVIDER` environment variable and finally to `'offline'`.
 *
 * This replaces the module-construction-time `useFactory` selection so that
 * admins can switch providers through the System Settings UI without
 * restarting the process.
 *
 * Supported providers:
 *   offline    — local-reverse-geocoder (GeoNames dataset, no network calls)
 *   nominatim  — OSM Nominatim HTTP API (WARNING: sends GPS off-server)
 *   google     — Google Maps Geocoding API (requires encrypted credential;
 *                delegated to GeoLocationService which handles credential
 *                lookup, decryption, and offline fallback on missing/disabled key)
 */
@Injectable()
export class DelegatingGeoLocationProvider implements GeoLocationProvider {
  private readonly logger = new Logger(DelegatingGeoLocationProvider.name);

  constructor(
    private readonly offline: OfflineGeoLocationProvider,
    private readonly nominatim: NominatimGeoLocationProvider,
    private readonly systemSettings: SystemSettingsService,
    private readonly geoLocationService: GeoLocationService,
  ) {}

  /**
   * Resolve the active provider name from system settings on every call.
   * Falls back to GEO_PROVIDER env var, then to 'offline'.
   */
  private async resolveProviderName(): Promise<string> {
    const settingValue = await this.systemSettings
      .getSettingValue<string>('geo.reverseProvider')
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to read geo.reverseProvider from system settings: ${msg}`);
        return undefined;
      });

    return settingValue ?? process.env['GEO_PROVIDER'] ?? 'offline';
  }

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
