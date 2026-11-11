/**
 * Injection token of {@link MediaLocationResolver}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_LOCATION_RESOLVER = Symbol.for('@marinoscar/memoriahub/MEDIA_LOCATION_RESOLVER');

/** The raw geocoder tiers of a media item. @stability experimental */
export interface MediaRawGeoTiers {
  geoCountry: string | null;
  geoCountryCode: string | null;
  geoAdmin1: string | null;
  geoLocality: string | null;
}

/** The canonical tiers a resolver answers. @stability experimental */
export interface MediaCanonicalGeoTiers {
  geoCanonicalCountry: string | null;
  geoCanonicalAdmin1: string | null;
  geoCanonicalLocality: string | null;
}

/**
 * Resolves the raw geocoder tiers of an item to their canonical place names (Location Grouping).
 * The `location` slice depends on `media`, so `media` cannot import it: the host binds this token
 * to the location slice's `LocationGroupResolverService`, whose `resolve` has this shape.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaLocationResolver {
  /**
   * Resolves the tiers.
   *
   * @param raw - the raw tiers.
   * @param coords - the item's capture coordinates, or null when it has none.
   */
  resolve(raw: MediaRawGeoTiers, coords: { lat: number; lng: number } | null): Promise<MediaCanonicalGeoTiers>;
}
