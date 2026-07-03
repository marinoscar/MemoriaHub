import type { GeoLocationProvider } from './geo-location-provider.interface';
import { geoResultToMediaColumns } from './geo-result.mapper';

/**
 * Data patch produced by applyLocation — write coords + coordSource
 * provenance + freshly reverse-geocoded geo columns onto a MediaItem.
 */
export interface ApplyLocationPatch {
  takenLat: number;
  takenLng: number;
  takenAltitude: number | null;
  coordSource: string;
  geoCountry: string | null;
  geoCountryCode: string | null;
  geoAdmin1: string | null;
  geoAdmin2: string | null;
  geoLocality: string | null;
  geoPlaceName: string | null;
  geoSource: string;
  geocodedAt: Date;
}

/**
 * applyLocation
 *
 * Shared helper extracted from MediaService.bulkUpdateMedia's inline
 * location-write block. Writes takenLat/takenLng/takenAltitude, performs a
 * synchronous reverse-geocode via the injected GeoLocationProvider, and
 * returns the full data patch (geo columns + coordSource provenance) ready
 * to spread into a Prisma `update`/`updateMany` data object.
 *
 * `coordSource` records WHY these coordinates exist: 'manual' for a
 * human-entered/adjusted location (bulkUpdateMedia, adjusted location
 * suggestion accept), 'inferred' for an unmodified location-inference
 * suggestion accept. This is distinct from `geoSource`, which always
 * records 'manual' here because the reverse-geocode call itself was
 * triggered by an explicit write path (not an automatic geocode job) —
 * geoSource tracks the geocode *provider/trigger*, coordSource tracks the
 * coordinate *provenance*. A later automatic `geocode` job re-running for
 * this item is expected to overwrite geoSource; it must never touch
 * coordSource.
 */
export async function applyLocation(
  geoProvider: GeoLocationProvider,
  lat: number,
  lng: number,
  altitude: number | null | undefined,
  coordSource: 'manual' | 'inferred',
): Promise<ApplyLocationPatch> {
  const result = await geoProvider.reverseGeocode(lat, lng);
  return {
    takenLat: lat,
    takenLng: lng,
    takenAltitude: altitude ?? null,
    coordSource,
    ...geoResultToMediaColumns(result ?? {}, 'manual'),
  };
}
