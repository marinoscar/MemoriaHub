/**
 * The secrets-port purpose the Google reverse-geocoding key is stored under (`geo_provider`). A purpose is
 * also its encryption domain: never rename it.
 *
 * @stability experimental
 */
export const GEO_PROVIDER_PURPOSE = 'geo_provider';

/**
 * The `geo` system settings namespace as the geo code reads it.
 *
 * @stability experimental
 */
export interface GeoSettingsDocument {
  /** The active reverse provider (`offline`, `nominatim` or `google`). */
  reverseProvider?: 'offline' | 'nominatim' | 'google';
  /** Whether the place-name search is on. */
  forwardSearchEnabled?: boolean;
  /** The non-secret half of the Google provider. */
  google?: { enabled?: boolean; baseUrl?: string | null };
}
