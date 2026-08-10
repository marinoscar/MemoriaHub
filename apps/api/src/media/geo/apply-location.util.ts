import type { GeoLocationProvider } from './geo-location-provider.interface';
import { geoResultToMediaColumns } from './geo-result.mapper';
import type { LocationGroupResolverService } from '../../location-groups/location-group-resolver.service';

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
  /**
   * Canonical location-group columns (issue #373), derived from the raw geo
   * columns above by LocationGroupResolverService. Non-null whenever their raw
   * counterpart is non-null — verbatim when no group matches.
   */
  geoCanonicalCountry: string | null;
  geoCanonicalAdmin1: string | null;
  geoCanonicalLocality: string | null;
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
 *
 * `resolver` (issue #373) canonicalizes the freshly-geocoded tiers in the same
 * patch, so a manual location set, a bulk location update and a
 * location-suggestion accept all land canonical columns consistent with their
 * raw ones — this one helper covers all three call sites.
 */
export async function applyLocation(
  geoProvider: GeoLocationProvider,
  lat: number,
  lng: number,
  altitude: number | null | undefined,
  coordSource: 'manual' | 'inferred',
  resolver: LocationGroupResolverService,
): Promise<ApplyLocationPatch> {
  const result = await geoProvider.reverseGeocode(lat, lng);
  const geoColumns = geoResultToMediaColumns(result ?? {}, 'manual');

  const canonical = await resolver.resolve(
    {
      geoCountry: geoColumns.geoCountry,
      geoCountryCode: geoColumns.geoCountryCode,
      geoAdmin1: geoColumns.geoAdmin1,
      geoLocality: geoColumns.geoLocality,
    },
    { lat, lng },
  );

  return {
    takenLat: lat,
    takenLng: lng,
    takenAltitude: altitude ?? null,
    coordSource,
    ...geoColumns,
    ...canonical,
  };
}
