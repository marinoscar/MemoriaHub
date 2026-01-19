import type { GeocodingResult } from '@memoriahub/shared';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * Simple in-memory cache for geocoding results
 */
interface CacheEntry {
  result: GeocodingResult;
  timestamp: number;
}

/**
 * Geocoding service
 * Reverse geocodes GPS coordinates to country, state, city using OpenStreetMap Nominatim API
 *
 * Note: This uses the free Nominatim API which has rate limits.
 * For production use, consider:
 * - Caching results aggressively
 * - Using a paid geocoding service (Google, Mapbox, etc.)
 * - Running your own Nominatim instance
 */
export class GeocodingService {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheTtlMs = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxCacheSize = 10000;

  // Nominatim API configuration
  private readonly nominatimUrl = 'https://nominatim.openstreetmap.org/reverse';
  private readonly userAgent = 'MemoriaHub/1.0 (https://github.com/memoriahub)';

  // Rate limiting: Nominatim requires max 1 request per second
  private lastRequestTime = 0;
  private readonly minRequestIntervalMs = 1100; // 1.1 seconds to be safe

  /**
   * Reverse geocode coordinates to location information
   * @param latitude GPS latitude
   * @param longitude GPS longitude
   * @returns Location information or null values if lookup fails
   */
  async reverseGeocode(latitude: number, longitude: number): Promise<GeocodingResult> {
    const traceId = getTraceId();
    const startTime = Date.now();

    // Validate coordinates
    if (!this.isValidCoordinate(latitude, longitude)) {
      logger.warn({
        eventType: 'geocoding.invalid_coordinates',
        latitude,
        longitude,
        traceId,
      }, 'Invalid coordinates for geocoding');
      return this.emptyResult();
    }

    // Round coordinates for cache key (approx 11m precision)
    const cacheKey = this.getCacheKey(latitude, longitude);

    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      logger.debug({
        eventType: 'geocoding.cache_hit',
        latitude,
        longitude,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Geocoding result from cache');
      return cached;
    }

    // Rate limit check
    await this.waitForRateLimit();

    try {
      const result = await this.fetchFromNominatim(latitude, longitude);

      // Cache the result
      this.addToCache(cacheKey, result);

      logger.debug({
        eventType: 'geocoding.success',
        latitude,
        longitude,
        country: result.country,
        state: result.state,
        city: result.city,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Geocoding completed');

      return result;
    } catch (error) {
      logger.warn({
        eventType: 'geocoding.error',
        latitude,
        longitude,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Geocoding failed');

      return this.emptyResult();
    }
  }

  /**
   * Fetch location from Nominatim API
   */
  private async fetchFromNominatim(latitude: number, longitude: number): Promise<GeocodingResult> {
    const url = new URL(this.nominatimUrl);
    url.searchParams.set('lat', latitude.toString());
    url.searchParams.set('lon', longitude.toString());
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('zoom', '10'); // City level detail

    this.lastRequestTime = Date.now();

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as NominatimResponse;

    return this.parseNominatimResponse(data);
  }

  /**
   * Parse Nominatim response into our format
   */
  private parseNominatimResponse(data: NominatimResponse): GeocodingResult {
    if (!data.address) {
      return this.emptyResult();
    }

    const address = data.address;

    // Extract country
    const country = address.country || null;

    // Extract state (try multiple fields)
    const state =
      address.state ||
      address.province ||
      address.region ||
      address.state_district ||
      null;

    // Extract city (try multiple fields in order of preference)
    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.hamlet ||
      address.locality ||
      null;

    // Build location name from display_name or construct it
    const locationName = this.buildLocationName(data.display_name, city, state, country);

    return {
      country,
      state,
      city,
      locationName,
    };
  }

  /**
   * Build a readable location name
   */
  private buildLocationName(
    displayName: string | undefined,
    city: string | null,
    state: string | null,
    country: string | null
  ): string | null {
    // If we have a display name, use first few parts
    if (displayName) {
      const parts = displayName.split(', ').slice(0, 4);
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }

    // Otherwise construct from parts
    const parts = [city, state, country].filter(Boolean);
    if (parts.length > 0) {
      return parts.join(', ');
    }

    return null;
  }

  /**
   * Validate coordinates are within valid ranges
   */
  private isValidCoordinate(latitude: number, longitude: number): boolean {
    return (
      typeof latitude === 'number' &&
      typeof longitude === 'number' &&
      !isNaN(latitude) &&
      !isNaN(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  /**
   * Generate cache key from coordinates (rounded to ~11m precision)
   */
  private getCacheKey(latitude: number, longitude: number): string {
    // Round to 4 decimal places (approx 11m precision)
    const lat = latitude.toFixed(4);
    const lon = longitude.toFixed(4);
    return `${lat},${lon}`;
  }

  /**
   * Get result from cache if valid
   */
  private getFromCache(key: string): GeocodingResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if cache entry is still valid
    if (Date.now() - entry.timestamp > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Add result to cache
   */
  private addToCache(key: string, result: GeocodingResult): void {
    // Evict old entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest entries (first 10%)
      const toRemove = Math.floor(this.maxCacheSize * 0.1);
      const keys = Array.from(this.cache.keys()).slice(0, toRemove);
      for (const k of keys) {
        this.cache.delete(k);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Wait for rate limit if needed
   */
  private async waitForRateLimit(): Promise<void> {
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestIntervalMs) {
      const waitTime = this.minRequestIntervalMs - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Return empty result
   */
  private emptyResult(): GeocodingResult {
    return {
      country: null,
      state: null,
      city: null,
      locationName: null,
    };
  }

  /**
   * Clear the geocoding cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
    };
  }
}

/**
 * Nominatim API response type
 */
interface NominatimResponse {
  place_id?: number;
  licence?: string;
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: NominatimAddress;
  boundingbox?: string[];
}

interface NominatimAddress {
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  hamlet?: string;
  village?: string;
  town?: string;
  city?: string;
  municipality?: string;
  locality?: string;
  county?: string;
  state_district?: string;
  state?: string;
  province?: string;
  region?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

// Export singleton instance
export const geocodingService = new GeocodingService();
