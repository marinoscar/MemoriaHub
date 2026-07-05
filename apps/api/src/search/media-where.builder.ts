import { Prisma } from '@prisma/client';

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

export function whereType(value: string): Prisma.MediaItemWhereInput {
  return { type: value as any };
}

export function whereFavorite(value: boolean): Prisma.MediaItemWhereInput {
  return { favorite: value };
}

export function whereDateRange(from?: Date, to?: Date): Prisma.MediaItemWhereInput {
  if (!from && !to) return {};
  return {
    capturedAt: {
      ...(from && { gte: from }),
      ...(to && { lte: to }),
    },
  };
}

export function whereCreatedAtRange(from?: Date, to?: Date): Prisma.MediaItemWhereInput {
  if (!from && !to) return {};
  return {
    createdAt: {
      ...(from && { gte: from }),
      ...(to && { lte: to }),
    },
  };
}

export function whereAlbum(albumId: string): Prisma.MediaItemWhereInput {
  return { albumItems: { some: { albumId } } };
}

export function whereTag(tag: string): Prisma.MediaItemWhereInput {
  return { mediaTags: { some: { tag: { name: { equals: tag, mode: 'insensitive' } } } } };
}

export function whereCountry(country: string): Prisma.MediaItemWhereInput {
  return {
    OR: [
      { geoCountry: { contains: country, mode: 'insensitive' as const } },
      { geoCountryCode: { equals: country, mode: 'insensitive' as const } },
    ],
  };
}

export function whereRegion(region: string): Prisma.MediaItemWhereInput {
  return { geoAdmin1: { contains: region, mode: 'insensitive' as const } };
}

export function whereLocality(locality: string): Prisma.MediaItemWhereInput {
  return { geoLocality: { contains: locality, mode: 'insensitive' as const } };
}

export function wherePlace(place: string): Prisma.MediaItemWhereInput {
  return { geoPlaceName: { contains: place, mode: 'insensitive' as const } };
}

export function whereLocation(location: string): Prisma.MediaItemWhereInput {
  return {
    OR: [
      { geoCountry: { contains: location, mode: 'insensitive' as const } },
      { geoCountryCode: { contains: location, mode: 'insensitive' as const } },
      { geoAdmin1: { contains: location, mode: 'insensitive' as const } },
      { geoLocality: { contains: location, mode: 'insensitive' as const } },
      { geoPlaceName: { contains: location, mode: 'insensitive' as const } },
    ],
  };
}

export function whereCameraMake(value: string): Prisma.MediaItemWhereInput {
  return { cameraMake: { contains: value, mode: 'insensitive' as const } };
}

export function whereCameraModel(value: string): Prisma.MediaItemWhereInput {
  return { cameraModel: { contains: value, mode: 'insensitive' as const } };
}

export function whereSourceDeviceId(value: string): Prisma.MediaItemWhereInput {
  return { sourceDeviceId: value };
}

export function whereSourceDeviceName(value: string): Prisma.MediaItemWhereInput {
  return { sourceDeviceName: { contains: value, mode: 'insensitive' as const } };
}

export function whereMissingGeo(value: boolean): Prisma.MediaItemWhereInput {
  if (value === true) {
    return { takenLat: null, takenLng: null };
  }
  return { takenLat: { not: null }, takenLng: { not: null } };
}

export function whereMissingCapturedAt(value: boolean): Prisma.MediaItemWhereInput {
  return value === true ? { capturedAt: null } : { capturedAt: { not: null } };
}

export function whereMissingCamera(value: boolean): Prisma.MediaItemWhereInput {
  // "Missing camera info" = no make AND no model.
  // "Has camera" = at least one present.
  return value === true
    ? { cameraMake: null, cameraModel: null }
    : { OR: [{ cameraMake: { not: null } }, { cameraModel: { not: null } }] };
}

export function whereNoFaces(value: boolean): Prisma.MediaItemWhereInput {
  return value === true ? { faces: { none: {} } } : {};
}

/**
 * Exclude archived media items (archivedAt IS NULL).
 * Only applies when value is explicitly true.
 */
export function whereExcludeArchived(value: boolean): Prisma.MediaItemWhereInput {
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
 */
export function whereNear(lat: number, lng: number, radiusKm: number): Prisma.MediaItemWhereInput {
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
 */
export function wherePeople(ids: string[], mode: 'all' | 'any' = 'all'): Prisma.MediaItemWhereInput {
  const validIds = ids.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (validIds.length === 0) return {};
  if (mode === 'any') {
    return { faces: { some: { personId: { in: validIds } } } };
  }
  // 'all' mode: AND-compose one faces.some clause per person id
  return { AND: validIds.map((id) => ({ faces: { some: { personId: id } } })) };
}

export function buildMediaWhere(
  circleId: string,
  filters: MediaFilters,
): Prisma.MediaItemWhereInput {
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
  const and: Prisma.MediaItemWhereInput[] = [];

  const add = (frag: Prisma.MediaItemWhereInput) => {
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

  const where: Prisma.MediaItemWhereInput = { circleId, deletedAt: null };
  if (and.length > 0) where.AND = and;
  return where;
}
