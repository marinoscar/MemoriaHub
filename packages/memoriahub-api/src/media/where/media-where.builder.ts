/**
 * A `media_items` where clause, as the builders produce it. Structural on purpose: the slice imports no
 * generated client, and the host passes the clause to its own typed `findMany`.
 *
 * @stability experimental
 */
export type MediaItemWhere = Record<string, any>;

/**
 * Media filters.
 *
 * @stability experimental
 */
export interface MediaFilters {
  type?: string;
  capturedAtFrom?: Date;
  capturedAtTo?: Date;
  albumId?: string;
  favorite?: boolean;
  tag?: string;
  country?: string;
  region?: string;
  locality?: string;
  place?: string;
  location?: string;
  contentHash?: string;
  cameraMake?: string;
  cameraModel?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  missingGeo?: boolean;
  missingCapturedAt?: boolean;
  missingCamera?: boolean;
  noFaces?: boolean;
  /**
   * When true, only return items where archivedAt IS NULL (not archived).
   * When false or undefined, archived items are included.
   * Browse callers pass true; search callers omit this to include archived by default.
   */
  excludeArchived?: boolean;
}

/**
 * Where type.
 *
 * @stability experimental
 */
export function whereType(value: string): MediaItemWhere {
  return { type: value as any };
}

/**
 * Where favorite.
 *
 * @stability experimental
 */
export function whereFavorite(value: boolean): MediaItemWhere {
  return { favorite: value };
}

/**
 * Upper-bound normalisation for a date range (issue #446, epic #440).
 *
 * A caller that supplies a bare `YYYY-MM-DD` — the AI search agent, a workflow
 * `between` condition, any API consumer — means "through the end of that day",
 * but it arrives as that day's midnight and an inclusive `lte` then matches
 * only an item timestamped exactly `00:00:00.000`, silently dropping the whole
 * final day. Clients that already send an explicit end-of-day bound are
 * unaffected.
 *
 * The fix is applied here, at the single place both range builders funnel
 * through, so it also protects callers that cannot be fixed client-side.
 *
 * Returns the bound expressed as EXCLUSIVE (`lt`) when it lands exactly on
 * midnight, otherwise as INCLUSIVE (`lte`). "Exactly midnight" is a deliberate
 * heuristic: a genuine capture at precisely `00:00:00.000` is vanishingly
 * rare, and the heuristic can only ever INCLUDE such an item, never exclude
 * one.
 */
function upperBound(to: Date): { lt: Date } | { lte: Date } {
  const isMidnightUtc =
    to.getUTCHours() === 0 &&
    to.getUTCMinutes() === 0 &&
    to.getUTCSeconds() === 0 &&
    to.getUTCMilliseconds() === 0;

  if (!isMidnightUtc) return { lte: to };
  return { lt: new Date(to.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * Where date range.
 *
 * @stability experimental
 */
export function whereDateRange(from?: Date, to?: Date): MediaItemWhere {
  if (!from && !to) return {};
  return {
    capturedAt: {
      ...(from && { gte: from }),
      ...(to && upperBound(to)),
    },
  };
}

/**
 * Where created at range.
 *
 * @stability experimental
 */
export function whereCreatedAtRange(from?: Date, to?: Date): MediaItemWhere {
  if (!from && !to) return {};
  return {
    createdAt: {
      ...(from && { gte: from }),
      ...(to && upperBound(to)),
    },
  };
}

/**
 * Where album.
 *
 * @stability experimental
 */
export function whereAlbum(albumId: string): MediaItemWhere {
  return { albumItems: { some: { albumId } } };
}

/**
 * Where tag.
 *
 * @stability experimental
 */
export function whereTag(tag: string): MediaItemWhere {
  return { mediaTags: { some: { tag: { name: { equals: tag, mode: 'insensitive' } } } } };
}

// -----------------------------------------------------------------------------
// Geo filters — canonical OR raw (Location Grouping, issue #374)
// -----------------------------------------------------------------------------
//
// Each geo filter matches BOTH the canonical column and its raw counterpart.
// Canonical alone would be tempting (§3.4's invariant guarantees it is
// populated whenever the raw column is), but it would silently break every
// pre-existing deep link, bookmark, saved workflow condition and Android/CLI
// client that passes a raw name: once "Heredia Province" has been folded into
// the group "Heredia", a canonical-only filter for "Heredia Province" matches
// nothing at all. Matching either side keeps the old name working as a synonym.
//
// Emitting a top-level `OR` from a builder is safe here because
// `buildMediaWhere` (below) composes every fragment into a shared `AND: []`
// array precisely so two fragments that each emit an `OR` cannot clobber each
// other. `wherePlace` is unchanged — `geo_place_name` deliberately does not
// participate in grouping (see the Location Grouping spec's non-goals).

/**
 * Where country.
 *
 * @stability experimental
 */
export function whereCountry(country: string): MediaItemWhere {
  return {
    OR: [
      { geoCanonicalCountry: { contains: country, mode: 'insensitive' as const } },
      { geoCountry: { contains: country, mode: 'insensitive' as const } },
      { geoCountryCode: { equals: country, mode: 'insensitive' as const } },
    ],
  };
}

/**
 * Where region.
 *
 * @stability experimental
 */
export function whereRegion(region: string): MediaItemWhere {
  return {
    OR: [
      { geoCanonicalAdmin1: { contains: region, mode: 'insensitive' as const } },
      { geoAdmin1: { contains: region, mode: 'insensitive' as const } },
    ],
  };
}

/**
 * Where locality.
 *
 * @stability experimental
 */
export function whereLocality(locality: string): MediaItemWhere {
  return {
    OR: [
      { geoCanonicalLocality: { contains: locality, mode: 'insensitive' as const } },
      { geoLocality: { contains: locality, mode: 'insensitive' as const } },
    ],
  };
}

/**
 * Where place.
 *
 * @stability experimental
 */
export function wherePlace(place: string): MediaItemWhere {
  return { geoPlaceName: { contains: place, mode: 'insensitive' as const } };
}

/**
 * Where location.
 *
 * @stability experimental
 */
export function whereLocation(location: string): MediaItemWhere {
  return {
    OR: [
      { geoCanonicalCountry: { contains: location, mode: 'insensitive' as const } },
      { geoCountry: { contains: location, mode: 'insensitive' as const } },
      { geoCountryCode: { contains: location, mode: 'insensitive' as const } },
      { geoCanonicalAdmin1: { contains: location, mode: 'insensitive' as const } },
      { geoAdmin1: { contains: location, mode: 'insensitive' as const } },
      { geoCanonicalLocality: { contains: location, mode: 'insensitive' as const } },
      { geoLocality: { contains: location, mode: 'insensitive' as const } },
      { geoPlaceName: { contains: location, mode: 'insensitive' as const } },
    ],
  };
}

/**
 * Where camera make.
 *
 * @stability experimental
 */
export function whereCameraMake(value: string): MediaItemWhere {
  return { cameraMake: { contains: value, mode: 'insensitive' as const } };
}

/**
 * Where camera model.
 *
 * @stability experimental
 */
export function whereCameraModel(value: string): MediaItemWhere {
  return { cameraModel: { contains: value, mode: 'insensitive' as const } };
}

/**
 * Where source device id.
 *
 * @stability experimental
 */
export function whereSourceDeviceId(value: string): MediaItemWhere {
  return { sourceDeviceId: value };
}

/**
 * Where source device name.
 *
 * @stability experimental
 */
export function whereSourceDeviceName(value: string): MediaItemWhere {
  return { sourceDeviceName: { contains: value, mode: 'insensitive' as const } };
}

/**
 * Where missing geo.
 *
 * @stability experimental
 */
export function whereMissingGeo(value: boolean): MediaItemWhere {
  if (value === true) {
    return { takenLat: null, takenLng: null };
  }
  return { takenLat: { not: null }, takenLng: { not: null } };
}

/**
 * Where missing captured at.
 *
 * @stability experimental
 */
export function whereMissingCapturedAt(value: boolean): MediaItemWhere {
  return value === true ? { capturedAt: null } : { capturedAt: { not: null } };
}

/**
 * Where missing camera.
 *
 * @stability experimental
 */
export function whereMissingCamera(value: boolean): MediaItemWhere {
  // "Missing camera info" = no make AND no model.
  // "Has camera" = at least one present.
  return value === true
    ? { cameraMake: null, cameraModel: null }
    : { OR: [{ cameraMake: { not: null } }, { cameraModel: { not: null } }] };
}

/**
 * Where no faces.
 *
 * @stability experimental
 */
export function whereNoFaces(value: boolean): MediaItemWhere {
  return value === true ? { faces: { none: {} } } : {};
}

/**
 * Exclude archived media items (archivedAt IS NULL).
 * Only applies when value is explicitly true.
 *
 * @stability experimental
 */
export function whereExcludeArchived(value: boolean): MediaItemWhere {
  return value === true ? { archivedAt: null } : {};
}

/**
 * Bounding-box geographic radius filter.
 *
 * Approximates a circle using a lat/lng bounding box:
 *   latDelta  = radiusKm / 111.32
 *   lngDelta  = radiusKm / (111.32 * cos(lat))   — clamped to 180 near poles
 *
 * This is an intentional v1 approximation: accurate enough for typical radii and
 * well within the margin of error for photo GPS coordinates.
 *
 * @stability experimental
 */
export function whereNear(lat: number, lng: number, radiusKm: number): MediaItemWhere {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Guard against division-by-zero / extreme values near poles
  const lngDelta = cosLat > 0.0001 ? Math.min(radiusKm / (111.32 * cosLat), 180) : 180;

  return {
    takenLat: { gte: lat - latDelta, lte: lat + latDelta },
    takenLng: { gte: lng - lngDelta, lte: lng + lngDelta },
  };
}

/**
 * Filter media items by people who appear in them (via face recognition).
 *
 * @param ids    Array of Person UUIDs to filter by.
 * @param mode   'all' = every person must appear in the same photo (AND);
 *               'any' = at least one person appears (OR).
 *
 * @stability experimental
 */
export function wherePeople(ids: string[], mode: 'all' | 'any' = 'all'): MediaItemWhere {
  const validIds = ids.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (validIds.length === 0) return {};
  if (mode === 'any') {
    return { faces: { some: { personId: { in: validIds } } } };
  }
  // 'all' mode: AND-compose one faces.some clause per person id
  return { AND: validIds.map((id) => ({ faces: { some: { personId: id } } })) };
}

/**
 * AND-compose extra fragments onto an already-built `where` (issue #431).
 *
 * `buildMediaWhere` collects every filter into a shared `AND` array precisely
 * so that two fragments each emitting a top-level key (`OR`, `AND`) cannot
 * clobber one another. `wherePeople(ids, 'all')` also returns a top-level
 * `AND`, so composing the two with an object spread —
 * `{ ...buildMediaWhere(...), ...wherePeople(...) }` — overwrote the builder's
 * whole `AND` array and silently dropped every other filter, WIDENING the
 * match set. That is a wrong-results bug on a read path (the gallery) and a
 * wrong-writes bug on `POST /albums/:id/items/by-filter`, which adds the
 * widened set to the album.
 *
 * Pushing each fragment into the array instead is safe for any fragment shape,
 * including one that carries its own nested `AND`.
 *
 * @stability experimental
 */
export function andWhere(
  base: MediaItemWhere,
  ...fragments: Array<MediaItemWhere | undefined>
): MediaItemWhere {
  const extras = fragments.filter(
    (f): f is MediaItemWhere => !!f && Object.keys(f).length > 0,
  );
  if (extras.length === 0) return base;

  const existing =
    base.AND === undefined ? [] : Array.isArray(base.AND) ? base.AND : [base.AND];

  return { ...base, AND: [...existing, ...extras] };
}

/**
 * Build media where.
 *
 * @stability experimental
 */
export function buildMediaWhere(
  circleId: string,
  filters: MediaFilters,
): MediaItemWhere {
  const {
    type,
    capturedAtFrom,
    capturedAtTo,
    albumId,
    favorite,
    tag,
    country,
    region,
    locality,
    place,
    location,
    contentHash,
    cameraMake,
    cameraModel,
    sourceDeviceId,
    sourceDeviceName,
    missingGeo,
    missingCapturedAt,
    missingCamera,
    noFaces,
    excludeArchived,
  } = filters;

  // Collect non-empty filter fragments into an AND array so that two fragments
  // that both emit a top-level `OR` key (e.g. whereCountry + whereLocation)
  // never overwrite each other.
  const and: MediaItemWhere[] = [];

  const add = (frag: MediaItemWhere) => {
    if (frag && Object.keys(frag).length > 0) and.push(frag);
  };

  if (type) add(whereType(type));
  if (favorite !== undefined) add(whereFavorite(favorite));
  if (contentHash) add({ contentHash });
  if (capturedAtFrom || capturedAtTo) add(whereDateRange(capturedAtFrom, capturedAtTo));
  if (albumId) add(whereAlbum(albumId));
  if (tag) add(whereTag(tag));
  if (country) add(whereCountry(country));
  if (region) add(whereRegion(region));
  if (locality) add(whereLocality(locality));
  if (place) add(wherePlace(place));
  if (location) add(whereLocation(location));
  if (cameraMake) add(whereCameraMake(cameraMake));
  if (cameraModel) add(whereCameraModel(cameraModel));
  if (sourceDeviceName) add(whereSourceDeviceName(sourceDeviceName));
  if (sourceDeviceId) add(whereSourceDeviceId(sourceDeviceId));
  if (missingGeo !== undefined) add(whereMissingGeo(missingGeo));
  if (missingCapturedAt !== undefined) add(whereMissingCapturedAt(missingCapturedAt));
  if (missingCamera !== undefined) add(whereMissingCamera(missingCamera));
  if (noFaces !== undefined) add(whereNoFaces(noFaces));
  // Only add archivedAt: null when caller explicitly opts in (browse surfaces).
  // Omitting this keeps archived items visible in search by default.
  if (excludeArchived === true) add(whereExcludeArchived(true));

  const where: MediaItemWhere = { circleId, deletedAt: null };
  if (and.length > 0) where.AND = and;
  return where;
}
