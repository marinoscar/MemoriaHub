import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mapNominatimResponse } from '@memoriahub/enrichment-compute/geo';
import type { GeoLocationProvider, GeoLocationResult } from './geo-location-provider.interface';
import { RateLimitError, parseRetryAfterMs } from '../../enrichment/rate-limit.error';

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

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>(
      'NOMINATIM_BASE_URL',
      'https://nominatim.openstreetmap.org',
    );
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
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get('retry-after') ?? undefined) ?? undefined;
        throw new RateLimitError(
          `Nominatim throttled (HTTP ${response.status})`,
          retryAfterMs,
          'nominatim',
        );
      }

      if (!response.ok) {
        this.logger.warn(
          `Nominatim returned HTTP ${response.status} for (${lat}, ${lng})`,
        );
        return null;
      }

      const data = await response.json();

      // Shared with the CLI's node compute module — see
      // @memoriahub/enrichment-compute/geo mapNominatimResponse — so a
      // distributed worker node and the server produce byte-identical
      // GeoLocationResult-shaped values from the same raw Nominatim response.
      return mapNominatimResponse(data);
    } catch (error) {
      // Re-throw RateLimitError — do not swallow it into a null return.
      if (error instanceof RateLimitError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Nominatim request failed for (${lat}, ${lng}): ${msg}`);
      return null;
    }
  }
}
