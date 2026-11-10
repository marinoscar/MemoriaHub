import { Injectable, Logger } from '@nestjs/common';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { GoogleGeoLocationProvider } from './google-geo-location.provider';
import { GeoLocationResult } from '@marinoscar/memoriahub-api/location';
import { GeoGoogleCredentialResolver } from './geo-google-credential.resolver';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';

@Injectable()
export class GeoLocationService {
  private readonly logger = new Logger(GeoLocationService.name);

  constructor(
    private readonly systemSettings: AppSystemSettingsService,
    private readonly offlineProvider: OfflineGeoLocationProvider,
    private readonly nominatimProvider: NominatimGeoLocationProvider,
    private readonly googleProvider: GoogleGeoLocationProvider,
    private readonly googleCredential: GeoGoogleCredentialResolver,
  ) {}

  async reverseGeocode(lat: number, lng: number): Promise<{ result: GeoLocationResult | null; source: string }> {
    // Defensive choke point for every provider (offline/nominatim/google) and every
    // caller: a non-finite coordinate (NaN/Infinity) must never reach a provider.
    // The offline kd-tree geocoder has no "no location" concept and returns a bogus
    // nearest city (Talnakh, RU) for a NaN input; short-circuit to an empty result.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      this.logger.debug(`reverseGeocode called with non-finite coordinates (${lat}, ${lng}); returning null`);
      return { result: null, source: 'none' };
    }

    const settings = await this.systemSettings.getSettings();
    const activeProvider = (settings as any).geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';

    if (activeProvider === 'google') {
      const apiKey = await this.googleCredential.resolveApiKey();
      if (!apiKey) {
        this.logger.warn('Google geo provider configured but credential not found or disabled; falling back to offline');
        const result = await this.offlineProvider.reverseGeocode(lat, lng);
        return { result, source: 'geonames-offline' };
      }
      const result = await this.googleProvider.reverseGeocodeWithKey(lat, lng, apiKey);
      return { result, source: 'google' };
    }

    if (activeProvider === 'nominatim') {
      const result = await this.nominatimProvider.reverseGeocode(lat, lng);
      return { result, source: 'nominatim' };
    }

    // default: offline
    const result = await this.offlineProvider.reverseGeocode(lat, lng);
    return { result, source: 'geonames-offline' };
  }
}
