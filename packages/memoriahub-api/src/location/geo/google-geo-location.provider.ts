import { Injectable, Logger } from '@nestjs/common';
import { mapGoogleResponse } from '@marinoscar/memoriahub-compute/geo';
import { parseRetryAfterMs } from '@marinoscar/memoriahub-compute/rate-limit';
import { MemoriahubRateLimitError } from '../../ports/index.js';
import type { GeoLocationResult } from './geo-location-provider.interface.js';
import { GEOCODE_THROTTLE_KEY } from './geocode-rate-limit.js';

/**
 * Reverse geocoding through the Google Geocoding API, with a key the caller resolved. The key goes
 * only into the request URL and is never logged or put in an error message.
 *
 * @stability experimental
 */
@Injectable()
export class GoogleGeoLocationProvider {
  private readonly logger = new Logger(GoogleGeoLocationProvider.name);

  async reverseGeocodeWithKey(lat: number, lng: number, apiKey: string): Promise<GeoLocationResult | null> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    try {
      const response = await fetch(url);

      // HTTP-level throttle or server error — throw before parsing JSON so the
      // enrichment worker routes this job through the rate-limit deferral path.
      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after') ?? undefined);
        throw new MemoriahubRateLimitError(GEOCODE_THROTTLE_KEY, retryAfterMs, `Google Geocoding API returned HTTP ${response.status}`);
      }

      const data = await response.json() as {
        status: string;
        results: Array<{
          address_components: Array<{ long_name: string; short_name: string; types: string[] }>;
          formatted_address: string;
        }>;
        error_message?: string;
      };

      if (data.status === 'ZERO_RESULTS') return null;
      if (data.status === 'REQUEST_DENIED') {
        this.logger.warn(`Google Geocoding API denied request: ${data.error_message ?? ''}`);
        return null;
      }
      // API-level quota exhaustion: treat as a rate limit so the job is deferred
      // rather than marked processed with no data (which would silence retries).
      if (data.status === 'OVER_QUERY_LIMIT' || data.status === 'RESOURCE_EXHAUSTED') {
        throw new MemoriahubRateLimitError(
          GEOCODE_THROTTLE_KEY,
          undefined,
          `Google Geocoding quota exceeded (${data.status})`,
        );
      }
      if (data.status !== 'OK') {
        this.logger.warn(`Google Geocoding API status ${data.status} for (${lat}, ${lng})`);
        return null;
      }

      // Shared with the CLI's node compute module — see
      // @marinoscar/memoriahub-compute/geo mapGoogleResponse — so a
      // distributed worker node and the server produce byte-identical
      // GeoLocationResult-shaped values from the same raw Google response.
      return mapGoogleResponse(data);
    } catch (error) {
      // Re-throw RateLimitError — do not swallow it into a null return, or the
      // geocode handler will mark the job "processed" with no data.
      if (error instanceof MemoriahubRateLimitError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Google Geocoding request failed for (${lat}, ${lng}): ${msg}`);
      return null;
    }
  }
}
