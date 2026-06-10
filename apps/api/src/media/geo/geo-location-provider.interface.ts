/**
 * Dependency injection token for the geo location provider.
 */
export const GEO_LOCATION_PROVIDER = Symbol('GEO_LOCATION_PROVIDER');

/**
 * Result of a reverse geocoding lookup.
 * All fields are optional — providers may not resolve every tier.
 */
export interface GeoLocationResult {
  /** Human-readable country name, e.g. "Costa Rica" */
  country?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "CR" */
  countryCode?: string;
  /** State / province / region, e.g. "Alajuela" */
  admin1?: string;
  /** County / canton (optional second tier), e.g. "San Carlos" */
  admin2?: string;
  /** City / town, e.g. "La Fortuna" */
  locality?: string;
  /** POI / landmark / display label */
  placeName?: string;
}

/**
 * Pluggable interface for reverse-geocoding GPS coordinates.
 * Mirrors the StorageProvider pattern; implementation is selected at runtime
 * via the GEO_LOCATION_PROVIDER injection token.
 */
export interface GeoLocationProvider {
  /**
   * Reverse-geocode a GPS coordinate pair.
   *
   * @param lat - Latitude in decimal degrees
   * @param lng - Longitude in decimal degrees
   * @returns Geo result, or null if the lookup fails / returns no result
   */
  reverseGeocode(lat: number, lng: number): Promise<GeoLocationResult | null>;
}
