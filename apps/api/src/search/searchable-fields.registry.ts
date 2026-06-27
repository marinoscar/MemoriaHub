/**
 * Searchable-field registry — single source of truth for all media filter dimensions.
 *
 * HOW TO ADD A NEW DIMENSION (e.g. people via face recognition):
 * 1. Add one `SearchableField` entry to `SEARCHABLE_FIELDS` below with the appropriate
 *    key, label, type, description, and `buildWhere` implementation.
 * 2. That's it. Both the deterministic `POST /api/search` endpoint AND the future
 *    AI agent (which reads `SEARCHABLE_FIELDS` to generate its tool schema) will
 *    automatically gain the new dimension on next deploy.
 *
 * No other files need to change.
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  whereType,
  whereFavorite,
  whereDateRange,
  whereAlbum,
  whereTag,
  whereCountry,
  whereRegion,
  whereLocality,
  wherePlace,
  whereLocation,
  whereCameraMake,
  whereCameraModel,
  whereSourceDeviceId,
  whereSourceDeviceName,
  whereMissingGeo,
  whereMissingCapturedAt,
  whereMissingCamera,
  whereNoFaces,
  whereExcludeArchived,
  wherePeople,
  whereNear,
} from './media-where.builder';

export type SearchFieldType = 'string' | 'enum' | 'date-range' | 'boolean' | 'geo' | 'person-set' | 'geo-radius';

export interface SearchableField {
  key: string;
  label: string;
  type: SearchFieldType;
  enumValues?: string[];
  /** Optional hint for the frontend to know where to fetch option values from. */
  optionsSource?: string;
  description: string;
  buildWhere(value: unknown): Prisma.MediaItemWhereInput;
}

export const SEARCHABLE_FIELDS: SearchableField[] = [
  {
    key: 'type',
    label: 'Media type',
    type: 'enum',
    enumValues: ['photo', 'video'],
    description: 'Filter by media type. Accepts "photo" or "video".',
    buildWhere: (v) => whereType(String(v)),
  },
  {
    key: 'favorite',
    label: 'Favorites only',
    type: 'boolean',
    description: 'When true, returns only items marked as favorites.',
    buildWhere: (v) => whereFavorite(Boolean(v)),
  },
  {
    key: 'capturedAt',
    label: 'Capture date range',
    type: 'date-range',
    description:
      'Filter by capture date. Pass an object { from?: ISO8601, to?: ISO8601 } to match items captured in that window.',
    buildWhere: (v) => {
      const range = v as { from?: string; to?: string } | undefined;
      return whereDateRange(
        range?.from ? new Date(range.from) : undefined,
        range?.to ? new Date(range.to) : undefined,
      );
    },
  },
  {
    key: 'albumId',
    label: 'Album',
    type: 'string',
    description: 'Filter to items belonging to a specific album. Pass the album UUID.',
    buildWhere: (v) => whereAlbum(String(v)),
  },
  {
    key: 'tag',
    label: 'Tag',
    type: 'string',
    description:
      'Filter by exact tag name (case-insensitive). A media item matches if any of its tags equals this value.',
    buildWhere: (v) => whereTag(String(v)),
  },
  {
    key: 'country',
    label: 'Country',
    type: 'geo',
    description:
      'Filter by country name (partial, case-insensitive) or ISO country code (exact, case-insensitive). E.g. "Costa Rica" or "CR".',
    buildWhere: (v) => whereCountry(String(v)),
  },
  {
    key: 'region',
    label: 'Region / State',
    type: 'geo',
    description:
      'Filter by administrative region or state (partial match, case-insensitive). E.g. "California".',
    buildWhere: (v) => whereRegion(String(v)),
  },
  {
    key: 'locality',
    label: 'Locality / City',
    type: 'geo',
    description:
      'Filter by city or locality name (partial match, case-insensitive). E.g. "San José".',
    buildWhere: (v) => whereLocality(String(v)),
  },
  {
    key: 'place',
    label: 'Place name',
    type: 'geo',
    description:
      'Filter by specific place name (partial match, case-insensitive). E.g. "Arenal Volcano".',
    buildWhere: (v) => wherePlace(String(v)),
  },
  {
    key: 'location',
    label: 'Location (free text)',
    type: 'geo',
    description:
      'Free-text search across all geographic tiers: country, country code, region, locality, and place name. Useful when the exact tier is unknown.',
    buildWhere: (v) => whereLocation(String(v)),
  },
  {
    key: 'cameraMake',
    label: 'Camera make',
    type: 'string',
    description:
      'Filter by camera manufacturer (partial match, case-insensitive). E.g. "Apple", "Canon".',
    buildWhere: (v) => whereCameraMake(String(v)),
  },
  {
    key: 'cameraModel',
    label: 'Camera model',
    type: 'string',
    description:
      'Filter by camera model name (partial match, case-insensitive). E.g. "iPhone 15 Pro".',
    buildWhere: (v) => whereCameraModel(String(v)),
  },
  {
    key: 'sourceDeviceId',
    label: 'Source device ID',
    type: 'string',
    description:
      'Filter by exact source device identifier. Used by sync clients to find their own uploads.',
    buildWhere: (v) => whereSourceDeviceId(String(v)),
  },
  {
    key: 'sourceDeviceName',
    label: 'Source device name',
    type: 'string',
    description:
      "Filter by source device name (partial match, case-insensitive). E.g. \"Oscar's iPhone\".",
    buildWhere: (v) => whereSourceDeviceName(String(v)),
  },
  {
    key: 'missingGeo',
    label: 'Missing GPS',
    type: 'boolean',
    description:
      'When true, returns only items without GPS coordinates. When false, returns only items that have GPS coordinates.',
    buildWhere: (v) => whereMissingGeo(Boolean(v)),
  },
  {
    key: 'missingCapturedAt',
    label: 'Missing capture date',
    type: 'boolean',
    description:
      'When true, returns only items with no capture date (missing EXIF DateTimeOriginal) — useful for finding photos whose date was not extracted. When false, returns only items that have a capture date.',
    buildWhere: (v) => whereMissingCapturedAt(v === true),
  },
  {
    key: 'missingCamera',
    label: 'Missing camera info',
    type: 'boolean',
    description:
      'When true, returns only items with no camera make or model (missing EXIF camera identification). When false, returns only items that have camera make or model.',
    buildWhere: (v) => whereMissingCamera(v === true),
  },
  {
    key: 'noFaces',
    label: 'No faces detected',
    type: 'boolean',
    description:
      'When true, returns only items that have no faces at all (neither detected nor manually added) — useful for finding photos that still need people tagged.',
    buildWhere: (v) => whereNoFaces(v === true),
  },
  {
    key: 'excludeArchived',
    label: 'Exclude archived',
    type: 'boolean',
    description:
      'When true, excludes archived items from search results (only returns non-archived items). When false or omitted, archived items are included in search results by default.',
    buildWhere: (v) => whereExcludeArchived(v === true),
  },
  {
    key: 'people',
    label: 'People',
    type: 'person-set',
    optionsSource: 'people',
    description:
      'Filter by people who appear in the photo. Provide person IDs and a match mode.',
    buildWhere: (value) => {
      const v = value as { ids?: unknown; mode?: unknown } | undefined;
      if (!v || !Array.isArray(v.ids) || v.ids.length === 0) return {};
      const ids = (v.ids as unknown[]).filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      );
      const mode = v.mode === 'any' ? 'any' : 'all';
      return wherePeople(ids, mode);
    },
  },
  {
    key: 'near',
    label: 'Near location (map radius)',
    type: 'geo-radius',
    description:
      'Filter to items taken within a radius of a GPS point. Pass { lat, lng, radiusKm }. ' +
      'Uses a bounding-box approximation suitable for photo search. ' +
      'lat: -90 to 90, lng: -180 to 180, radiusKm: >0 up to 20000.',
    buildWhere: (value) => {
      const v = value as { lat?: unknown; lng?: unknown; radiusKm?: unknown } | undefined;
      if (
        !v ||
        typeof v.lat !== 'number' ||
        typeof v.lng !== 'number' ||
        typeof v.radiusKm !== 'number' ||
        v.radiusKm <= 0
      ) {
        return {};
      }
      return whereNear(v.lat, v.lng, v.radiusKm);
    },
  },
];

/** Map for O(1) key lookup */
const FIELD_MAP = new Map<string, SearchableField>(
  SEARCHABLE_FIELDS.map((f) => [f.key, f]),
);

/**
 * Compose a Prisma where clause from a map of filter key → value.
 * Unknown keys cause a BadRequestException (fail-safe: reject rather than silently ignore).
 * The circleId and deletedAt:null baseline are always applied.
 *
 * @throws BadRequestException for unknown filter keys
 */
export function buildWhereFromFields(
  circleId: string,
  filters: Record<string, unknown>,
): Prisma.MediaItemWhereInput {
  const unknownKeys = Object.keys(filters).filter((k) => !FIELD_MAP.has(k));
  if (unknownKeys.length > 0) {
    throw new BadRequestException(
      `Unknown filter key(s): ${unknownKeys.join(', ')}. ` +
        `Valid keys: ${SEARCHABLE_FIELDS.map((f) => f.key).join(', ')}`,
    );
  }

  // Start with the mandatory baseline
  const where: Prisma.MediaItemWhereInput = {
    circleId,
    deletedAt: null,
  };

  // AND-compose each field's contribution so that two fragments that both emit
  // a top-level `OR` key (e.g. whereCountry + whereLocation) never overwrite
  // each other.  Skip empty contributions ({}) so the AND array stays clean.
  const and: Prisma.MediaItemWhereInput[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    const field = FIELD_MAP.get(key)!;
    const contribution = field.buildWhere(value);
    if (contribution && Object.keys(contribution).length > 0) {
      and.push(contribution);
    }
  }
  if (and.length > 0) where.AND = and;

  return where;
}
