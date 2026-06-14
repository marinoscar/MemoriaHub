import type { GeoLocationResult } from './geo-location-provider.interface';

/**
 * Maps a GeoLocationResult to the typed geo columns used in MediaItem.
 *
 * NOTE: This function OVERWRITES all geo columns (sets absent tiers to null).
 * This is intentional for manual bulk re-tagging (geoSource='manual').
 * Contrast with MediaMetadataSyncService, which uses present-only semantics
 * (never nulls out existing geo data from automatic geocoding).
 */
export function geoResultToMediaColumns(result: GeoLocationResult, source: string) {
  return {
    geoCountry: result.country ?? null,
    geoCountryCode: result.countryCode ?? null,
    geoAdmin1: result.admin1 ?? null,
    geoAdmin2: result.admin2 ?? null,
    geoLocality: result.locality ?? null,
    geoPlaceName: result.placeName ?? null,
    geoSource: source,
    geocodedAt: new Date(),
  };
}

/**
 * Columns to set when clearing location (location: null in bulk update).
 * Nulls coordinates AND all derived geo fields, forcing a full reset.
 */
export const GEO_CLEAR_COLUMNS = {
  takenLat: null,
  takenLng: null,
  takenAltitude: null,
  geoCountry: null,
  geoCountryCode: null,
  geoAdmin1: null,
  geoAdmin2: null,
  geoLocality: null,
  geoPlaceName: null,
  geoSource: null,
  geocodedAt: null,
} as const;
