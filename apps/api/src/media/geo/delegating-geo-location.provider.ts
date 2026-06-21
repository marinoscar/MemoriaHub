import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';

/**
 * DelegatingGeoLocationProvider
 *
 * Delegates each reverse-geocoding call to the active provider resolved
 * at runtime from system settings (`geo.provider`), falling back to the
 * `GEO_PROVIDER` environment variable and finally to `'offline'`.
 *
 * This replaces the module-construction-time `useFactory` selection so that
 * admins can switch providers through the System Settings UI without
 * restarting the process.
 */
@Injectable()
export class DelegatingGeoLocationProvider implements GeoLocationProvider {
  private readonly logger = new Logger(DelegatingGeoLocationProvider.name);

  constructor(
    private readonly offline: OfflineGeoLocationProvider,
    private readonly nominatim: NominatimGeoLocationProvider,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /**
   * Resolve the active provider from system settings on every call.
   * Falls back to GEO_PROVIDER env var, then to 'offline'.
   */
  private async resolveProvider(): Promise<GeoLocationProvider> {
    const settingValue = await this.systemSettings
      .getSettingValue<string>('geo.provider')
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to read geo.provider from system settings: ${msg}`);
        return undefined;
      });

    const provider =
      settingValue ?? process.env['GEO_PROVIDER'] ?? 'offline';

    if (provider === 'nominatim') {
      return this.nominatim;
    }
    return this.offline;
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null> {
    const provider = await this.resolveProvider();
    return provider.reverseGeocode(lat, lng);
  }
}
