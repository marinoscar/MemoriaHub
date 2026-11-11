import { Injectable, Logger } from '@nestjs/common';
import { mapNominatimResponse } from '@marinoscar/memoriahub-compute/geo';
import { parseRetryAfterMs } from '@marinoscar/memoriahub-compute/rate-limit';
import { MemoriahubRateLimitError } from '../../ports/index.js';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface.js';
import { GEOCODE_THROTTLE_KEY } from './geocode-rate-limit.js';

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
 *
 * @stability experimental
 */
@Injectable()
export class NominatimGeoLocationProvider implements GeoLocationProvider {
  private readonly logger = new Logger(NominatimGeoLocationProvider.name);

  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = process.env['NOMINATIM_BASE_URL'] ?? 'https://nominatim.openstreetmap.org';
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null> {
    // Defensive guard mirroring GeoLocationService's choke point: a non-finite
    // coordinate (NaN/Infinity) must never reach the Nominatim HTTP call.
    // Duplicated here so the guard applies regardless of which wrapper calls
    // this provider directly.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      this.logger.debug(`reverseGeocode called with non-finite coordinates (${lat}, ${lng}); returning null`);
      return null;
    }

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

      // HTTP-level throttle or server error — throw before parsing so the
      // enrichment worker routes through the rate-limit deferral path.
      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after') ?? undefined);
        throw new MemoriahubRateLimitError(GEOCODE_THROTTLE_KEY, retryAfterMs, `Nominatim throttled (HTTP ${response.status})`);
      }

      if (!response.ok) {
        this.logger.warn(
          `Nominatim returned HTTP ${response.status} for (${lat}, ${lng})`,
        );
        return null;
      }

      const data = await response.json();

      // Shared with the CLI's node compute module — see
      // @marinoscar/memoriahub-compute/geo mapNominatimResponse — so a
      // distributed worker node and the server produce byte-identical
      // GeoLocationResult-shaped values from the same raw Nominatim response.
      return mapNominatimResponse(data);
    } catch (error) {
      // Re-throw RateLimitError — do not swallow it into a null return.
      if (error instanceof MemoriahubRateLimitError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Nominatim request failed for (${lat}, ${lng}): ${msg}`);
      return null;
    }
  }
}
