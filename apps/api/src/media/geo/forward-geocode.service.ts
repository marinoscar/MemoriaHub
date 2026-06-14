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
 * Provides place-name → coordinates search using Nominatim's /search endpoint.
 * This service is separate from GeoLocationProvider (which handles reverse geocoding)
 * because forward geocoding is always online (Nominatim HTTP), regardless of the
 * reverse geocoding provider setting.
 *
 * SECURITY NOTE: Only the typed query string leaves the server — photo GPS coordinates
 * are never sent to Nominatim from this service. This is the safe forward-search path.
 * Gate it with GEO_FORWARD_SEARCH_ENABLED to give operators explicit opt-in control.
 */
@Injectable()
export class ForwardGeocodeService {
  private readonly logger = new Logger(ForwardGeocodeService.name);
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>(
      'NOMINATIM_BASE_URL',
      'https://nominatim.openstreetmap.org',
    );
    this.enabled = this.config.get<string>('GEO_FORWARD_SEARCH_ENABLED', 'false') === 'true';
  }

  async searchPlaces(q: string, limit: number): Promise<GeoSearchResult[]> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Place search is disabled');
    }

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
}
