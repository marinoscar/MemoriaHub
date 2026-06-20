import { Prisma } from '@prisma/client';

export interface MediaFilters {
  type?: string;
  capturedAtFrom?: Date;
  capturedAtTo?: Date;
  classification?: string;
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
  noFaces?: boolean;
}

export function whereType(value: string): Prisma.MediaItemWhereInput {
  return { type: value as any };
}

export function whereClassification(value: string): Prisma.MediaItemWhereInput {
  return { classification: value as any };
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

export function whereNoFaces(value: boolean): Prisma.MediaItemWhereInput {
  return value === true ? { faces: { none: {} } } : {};
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
    classification,
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
    noFaces,
  } = filters;

  const where: Prisma.MediaItemWhereInput = {
    circleId,
    deletedAt: null,
    ...(type && whereType(type)),
    ...(classification && whereClassification(classification)),
    ...(favorite !== undefined && whereFavorite(favorite)),
    ...(contentHash && { contentHash }),
    ...(capturedAtFrom || capturedAtTo ? whereDateRange(capturedAtFrom, capturedAtTo) : {}),
    ...(albumId ? whereAlbum(albumId) : {}),
    ...(tag ? whereTag(tag) : {}),
    ...(country ? whereCountry(country) : {}),
    ...(region ? whereRegion(region) : {}),
    ...(locality ? whereLocality(locality) : {}),
    ...(place ? wherePlace(place) : {}),
    ...(location ? whereLocation(location) : {}),
    ...(cameraMake ? whereCameraMake(cameraMake) : {}),
    ...(cameraModel ? whereCameraModel(cameraModel) : {}),
    ...(sourceDeviceName ? whereSourceDeviceName(sourceDeviceName) : {}),
    ...(sourceDeviceId ? whereSourceDeviceId(sourceDeviceId) : {}),
    ...(missingGeo !== undefined ? whereMissingGeo(missingGeo) : {}),
    ...(noFaces !== undefined ? whereNoFaces(noFaces) : {}),
  };

  return where;
}
