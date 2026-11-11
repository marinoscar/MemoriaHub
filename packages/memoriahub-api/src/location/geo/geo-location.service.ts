import { Inject, Injectable, Logger } from '@nestjs/common';

import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../../ports/index.js';
import { GeoGoogleCredentialResolver } from './geo-google-credential.resolver.js';
import type { GeoLocationResult } from './geo-location-provider.interface.js';
import type { GeoSettingsDocument } from './geo-settings-shape.js';
import { GoogleGeoLocationProvider } from './google-geo-location.provider.js';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider.js';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider.js';

/**
 * Reverse geocoding through the ACTIVE provider (`geo.reverseProvider`, else `GEO_PROVIDER`, else offline),
 * reporting which provider answered. The Google provider needs a stored, enabled key; without one the
 * service falls back to the offline provider.
 *
 * @stability experimental
 */
@Injectable()
export class GeoLocationService {
  private readonly logger = new Logger(GeoLocationService.name);

  constructor(
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly offlineProvider: OfflineGeoLocationProvider,
    private readonly nominatimProvider: NominatimGeoLocationProvider,
    private readonly googleProvider: GoogleGeoLocationProvider,
    private readonly googleCredential: GeoGoogleCredentialResolver,
  ) {}

  /**
   * Reverse-geocodes a coordinate pair.
   *
   * @param lat - latitude in decimal degrees.
   * @param lng - longitude in decimal degrees.
   * @returns the result (or `null`) and the provider source that produced it.
   */
  async reverseGeocode(lat: number, lng: number): Promise<{ result: GeoLocationResult | null; source: string }> {
    // Defensive choke point for every provider (offline/nominatim/google) and every
    // caller: a non-finite coordinate (NaN/Infinity) must never reach a provider.
    // The offline kd-tree geocoder has no "no location" concept and returns a bogus
    // nearest city (Talnakh, RU) for a NaN input; short-circuit to an empty result.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      this.logger.debug(`reverseGeocode called with non-finite coordinates (${lat}, ${lng}); returning null`);
      return { result: null, source: 'none' };
    }

    const { value: geo } = await this.settings.readSystem<GeoSettingsDocument | undefined>('geo');
    const activeProvider = geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';

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
