import { Injectable, Logger } from '@nestjs/common';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface';

/**
 * IMPORTANT — PRIVACY NOTICE:
 * This provider sends GPS coordinates to an external OSM Nominatim server.
 * Do NOT use this provider if photo GPS data should never leave the server.
 * Enable only when `GEO_PROVIDER=nominatim` is set and the privacy tradeoff
 * is accepted.  The default provider is `offline`, which keeps coordinates
 * fully on-server.
 *
 * This implementation uses the public OSM Nominatim instance at
 * https://nominatim.openstreetmap.org.  For production use, host a private
 * Nominatim instance or replace the endpoint with a paid provider (Mapbox,
 * Google, etc.) to comply with OSM's usage policy.
 */
@Injectable()
export class NominatimGeoLocationProvider implements GeoLocationProvider {
  private readonly logger = new Logger(NominatimGeoLocationProvider.name);

  private readonly baseUrl: string;

  constructor(baseUrl = 'https://nominatim.openstreetmap.org') {
    this.baseUrl = baseUrl;
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null> {
    const url =
      `${this.baseUrl}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;

    try {
      const response = await fetch(url, {
        headers: {
          // OSM policy requires a valid User-Agent identifying the application
          'User-Agent': 'MemoriaHub/1.0 (https://github.com/memoriaHub)',
          'Accept-Language': 'en',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Nominatim returned HTTP ${response.status} for (${lat}, ${lng})`,
        );
        return null;
      }

      const data = (await response.json()) as {
        address?: {
          country?: string;
          country_code?: string;
          state?: string;
          county?: string;
          city?: string;
          town?: string;
          village?: string;
          neighbourhood?: string;
          suburb?: string;
        };
        display_name?: string;
      };

      if (!data?.address) return null;

      const addr = data.address;

      const locality =
        addr.city ?? addr.town ?? addr.village ?? addr.neighbourhood ?? addr.suburb;

      return {
        country: addr.country,
        countryCode: addr.country_code?.toUpperCase(),
        admin1: addr.state,
        admin2: addr.county,
        locality,
        placeName: data.display_name,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Nominatim request failed for (${lat}, ${lng}): ${msg}`);
      return null;
    }
  }
}
