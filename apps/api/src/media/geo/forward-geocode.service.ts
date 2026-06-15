import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GeoSearchResult {
  lat: number;
  lng: number;
  label: string;
}

/**
 * ForwardGeocodeService
 *
 * Provides place-name → coordinates search using either Nominatim or Google
 * Geocoding API, selected via GEO_FORWARD_PROVIDER (default: 'nominatim').
 * This service is separate from GeoLocationProvider (which handles reverse geocoding)
 * because forward geocoding is always online (HTTP), regardless of the
 * reverse geocoding provider setting.
 *
 * SECURITY NOTE: Only the typed query string leaves the server — photo GPS coordinates
 * are never sent from this service. This is the safe forward-search path.
 * Gate it with GEO_FORWARD_SEARCH_ENABLED to give operators explicit opt-in control.
 */
@Injectable()
export class ForwardGeocodeService {
  private readonly logger = new Logger(ForwardGeocodeService.name);
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly provider: string;
  private readonly googleApiKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>(
      'NOMINATIM_BASE_URL',
      'https://nominatim.openstreetmap.org',
    );
    this.enabled = this.config.get<string>('GEO_FORWARD_SEARCH_ENABLED', 'false') === 'true';
    this.provider = this.config.get<string>('GEO_FORWARD_PROVIDER', 'nominatim');
    this.googleApiKey = this.config.get<string>('GOOGLE_MAPS_API_KEY', '');
  }

  async searchPlaces(q: string, limit: number): Promise<GeoSearchResult[]> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Place search is disabled');
    }

    if (this.provider === 'google') {
      return this.searchGoogle(q, limit);
    }

    return this.searchNominatim(q, limit);
  }

  private async searchNominatim(q: string, limit: number): Promise<GeoSearchResult[]> {
    const url =
      `${this.baseUrl}/search?format=jsonv2&addressdetails=1&q=${encodeURIComponent(q)}&limit=${limit}`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'MemoriaHub/1.0 (https://github.com/memoriaHub)',
          'Accept-Language': 'en',
        },
      });

      if (!response.ok) {
        this.logger.warn(`Nominatim search returned HTTP ${response.status} for "${q}"`);
        return [];
      }

      const data = (await response.json()) as Array<{
        lat?: string;
        lon?: string;
        display_name?: string;
      }>;

      return data
        .filter((r) => r.lat && r.lon && r.display_name)
        .map((r) => ({
          lat: parseFloat(r.lat!),
          lng: parseFloat(r.lon!),
          label: r.display_name!,
        }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Nominatim search failed for "${q}": ${msg}`);
      return [];
    }
  }

  private async searchGoogle(q: string, limit: number): Promise<GeoSearchResult[]> {
    if (!this.googleApiKey) {
      this.logger.warn(
        'GEO_FORWARD_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set; falling back to Nominatim',
      );
      return this.searchNominatim(q, limit);
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${this.googleApiKey}`;

    try {
      const response = await fetch(url);

      const data = (await response.json()) as {
        status: string;
        results: Array<{
          formatted_address: string;
          geometry: { location: { lat: number; lng: number } };
        }>;
        error_message?: string;
      };

      if (data.status === 'OK') {
        return data.results
          .map((r) => ({
            lat: r.geometry.location.lat,
            lng: r.geometry.location.lng,
            label: r.formatted_address,
          }))
          .slice(0, limit);
      }

      if (data.status === 'ZERO_RESULTS') {
        return [];
      }

      this.logger.warn(
        `Google Geocoding API returned status ${data.status}${data.error_message ? ': ' + data.error_message : ''} for "${q}"`,
      );
      return [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Google Geocoding request failed for "${q}": ${msg}`);
      return [];
    }
  }
}
