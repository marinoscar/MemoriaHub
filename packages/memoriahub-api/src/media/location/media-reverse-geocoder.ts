/**
 * Injection token of {@link MediaReverseGeocoder}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_REVERSE_GEOCODER = Symbol.for('@marinoscar/memoriahub/MEDIA_REVERSE_GEOCODER');

/** The tiers of a reverse-geocoding answer; a provider may not resolve every one. @stability experimental */
export interface MediaGeocodeResult {
  country?: string;
  countryCode?: string;
  admin1?: string;
  admin2?: string;
  locality?: string;
  placeName?: string;
}

/**
 * Reverse-geocodes GPS coordinates through the deployment's configured provider (offline dataset,
 * Nominatim or Google, with its credential). The metadata extraction job calls it from its
 * server-only persist half, so a node result never carries a geocode. The host binds the token to
 * its geo service, whose `reverseGeocode` has this shape.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaReverseGeocoder {
  /**
   * Reverse-geocodes a coordinate pair.
   *
   * @param lat - latitude in decimal degrees.
   * @param lng - longitude in decimal degrees.
   * @returns the result (or null when the lookup found nothing) and the provider that answered.
   */
  reverseGeocode(lat: number, lng: number): Promise<{ result: MediaGeocodeResult | null; source: string }>;
}
