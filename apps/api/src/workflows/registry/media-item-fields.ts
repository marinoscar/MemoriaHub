import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WorkflowActionDescriptor,
  WorkflowFieldDescriptor,
  WorkflowOperator,
} from './field-descriptor.interface';
import {
  whereType,
  whereFavorite,
  whereDateRange,
  whereCreatedAtRange,
  whereAlbum,
  whereCountry,
  whereRegion,
  whereLocality,
  whereNear,
  whereMissingCapturedAt,
  whereMissingCamera,
  whereNoFaces,
  whereMissingGeo,
  wherePeople,
} from '../../search/media-where.builder';

// ---------------------------------------------------------------------------
// Small local helpers (case-insensitive string, relative dates, string lists)
// ---------------------------------------------------------------------------

const ci = (s: unknown) => ({ equals: String(s), mode: 'insensitive' as const });

function relativeDate(days: unknown, dir: 'older' | 'within'): Prisma.MediaItemWhereInput['capturedAt'] {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException('Relative-day value must be a positive number');
  }
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  // older_than_days: captured strictly before the cutoff.
  // within_last_days: captured at or after the cutoff.
  return dir === 'older' ? { lt: cutoff } : { gte: cutoff };
}

function asDate(v: unknown): Date {
  const d = new Date(String(v));
  if (isNaN(d.getTime())) throw new BadRequestException('Expected an ISO 8601 date value');
  return d;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new BadRequestException('Expected an array of strings');
  const list = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (list.length === 0) throw new BadRequestException('Expected a non-empty array of strings');
  return list;
}

function tagNameMatch(name: string): Prisma.MediaItemWhereInput {
  return { mediaTags: { some: { tag: { name: ci(name) } } } };
}

// ---------------------------------------------------------------------------
// Date-family builder shared by capturedAt (captured_at) and uploadedAt (created_at)
// ---------------------------------------------------------------------------

function buildDateWhere(
  column: 'capturedAt' | 'createdAt',
  op: WorkflowOperator,
  value: unknown,
): Prisma.MediaItemWhereInput {
  switch (op) {
    case 'between': {
      const range = (value ?? {}) as { from?: string; to?: string };
      if (!range.from && !range.to) {
        throw new BadRequestException('between requires { from, to } (at least one)');
      }
      const from = range.from ? asDate(range.from) : undefined;
      const to = range.to ? asDate(range.to) : undefined;
      return column === 'capturedAt' ? whereDateRange(from, to) : whereCreatedAtRange(from, to);
    }
    case 'before':
      return { [column]: { lt: asDate(value) } };
    case 'after':
      return { [column]: { gt: asDate(value) } };
    case 'older_than_days':
      return { [column]: relativeDate(value, 'older') };
    case 'within_last_days':
      return { [column]: relativeDate(value, 'within') };
    default:
      throw new BadRequestException(`Unsupported operator "${op}" for date field`);
  }
}

const DATE_OPERATORS: WorkflowOperator[] = [
  'between',
  'before',
  'after',
  'older_than_days',
  'within_last_days',
];

// ---------------------------------------------------------------------------
// Media Item field catalog
// ---------------------------------------------------------------------------

export const MEDIA_ITEM_FIELDS: WorkflowFieldDescriptor[] = [
  // ------------------------------- File -----------------------------------
  {
    key: 'filename',
    label: 'Filename',
    group: 'File',
    type: 'string',
    operators: ['contains', 'starts_with', 'ends_with', 'equals'],
    valueType: 'string',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const v = String(value ?? '');
      if (!v) throw new BadRequestException('filename value must be a non-empty string');
      // Case-insensitive ILIKE via Prisma mode:'insensitive' — never a raw regex.
      switch (op) {
        case 'contains':
          return { originalFilename: { contains: v, mode: 'insensitive' } };
        case 'starts_with':
          return { originalFilename: { startsWith: v, mode: 'insensitive' } };
        case 'ends_with':
          return { originalFilename: { endsWith: v, mode: 'insensitive' } };
        case 'equals':
          return { originalFilename: { equals: v, mode: 'insensitive' } };
        default:
          throw new BadRequestException(`Unsupported operator "${op}" for filename`);
      }
    },
  },
  {
    key: 'mimeType',
    label: 'MIME type',
    group: 'File',
    type: 'string',
    operators: ['equals'],
    valueType: 'string',
    dependency: 'metadata',
    // mimeType lives on the required StorageObject relation.
    buildWhere: (_op, value) => ({ storageObject: { mimeType: String(value ?? '') } }),
  },
  {
    key: 'fileSize',
    label: 'File size (bytes)',
    group: 'File',
    type: 'number',
    operators: ['gt', 'lt'],
    valueType: 'number',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException('fileSize value must be a non-negative number of bytes');
      }
      // StorageObject.size is a BigInt column.
      const bytes = BigInt(Math.trunc(n));
      return { storageObject: { size: op === 'gt' ? { gt: bytes } : { lt: bytes } } };
    },
  },

  // ------------------------------- Media ----------------------------------
  {
    key: 'mediaType',
    label: 'Media type',
    group: 'Media',
    type: 'enum',
    operators: ['equals'],
    valueType: 'enum',
    enumValues: ['photo', 'video'],
    dependency: 'metadata',
    buildWhere: (_op, value) => whereType(String(value)),
  },
  {
    key: 'width',
    label: 'Width (px)',
    group: 'Media',
    type: 'number',
    operators: ['gt', 'lt'],
    valueType: 'number',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new BadRequestException('width value must be a number');
      return { width: op === 'gt' ? { gt: Math.trunc(n) } : { lt: Math.trunc(n) } };
    },
  },
  {
    key: 'height',
    label: 'Height (px)',
    group: 'Media',
    type: 'number',
    operators: ['gt', 'lt'],
    valueType: 'number',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new BadRequestException('height value must be a number');
      return { height: op === 'gt' ? { gt: Math.trunc(n) } : { lt: Math.trunc(n) } };
    },
  },
  {
    key: 'megapixels',
    label: 'Megapixels',
    group: 'Media',
    type: 'number',
    operators: ['gt', 'lt'],
    valueType: 'number',
    dependency: 'metadata',
    // Megapixels = width*height/1e6. Prisma's typed `where` cannot express a
    // column-arithmetic comparison, so this is a read-time-refined field: the
    // bounding predicate only requires both dimensions to be present; the exact
    // comparison runs in `refinementPredicate`.
    readTimeRefinement: true,
    refinementSelect: { width: true, height: true },
    refinementPredicate: (op, value) => {
      const threshold = Number(value);
      return (row: { width: number | null; height: number | null }) => {
        if (row.width == null || row.height == null) return false;
        const mp = (row.width * row.height) / 1_000_000;
        return op === 'gt' ? mp > threshold : mp < threshold;
      };
    },
    buildWhere: () => ({ width: { not: null }, height: { not: null } }),
  },
  {
    key: 'orientationShape',
    label: 'Orientation shape',
    group: 'Media',
    type: 'enum',
    operators: ['equals'],
    valueType: 'enum',
    enumValues: ['portrait', 'landscape', 'square'],
    dependency: 'metadata',
    // Shape derives from a width-vs-height comparison, which Prisma's typed
    // `where` cannot express (no column-to-column comparison), so it is
    // read-time refined: bound to rows that have both dimensions, then compare.
    readTimeRefinement: true,
    refinementSelect: { width: true, height: true },
    refinementPredicate: (_op, value) => {
      const shape = String(value);
      return (row: { width: number | null; height: number | null }) => {
        if (row.width == null || row.height == null) return false;
        if (shape === 'portrait') return row.height > row.width;
        if (shape === 'landscape') return row.width > row.height;
        return row.width === row.height; // square
      };
    },
    buildWhere: () => ({ width: { not: null }, height: { not: null } }),
  },
  {
    key: 'socialMediaSource',
    label: 'Social-media source',
    group: 'Media',
    type: 'enum',
    operators: ['is_set', 'equals'],
    valueType: 'enum',
    enumValues: ['tiktok', 'instagram', 'facebook', 'other'],
    dependency: 'metadata',
    buildWhere: (op, value) => {
      if (op === 'is_set') return { socialMediaSource: { not: null } };
      return { socialMediaSource: String(value) };
    },
  },

  // ------------------------------- Dates ----------------------------------
  {
    key: 'capturedAt',
    label: 'Capture date',
    group: 'Dates',
    type: 'date',
    operators: DATE_OPERATORS,
    valueType: 'date-range',
    dependency: 'metadata',
    buildWhere: (op, value) => buildDateWhere('capturedAt', op, value),
  },
  {
    key: 'missingCapturedAt',
    label: 'Missing capture date',
    group: 'Dates',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereMissingCapturedAt(value === true),
  },
  {
    key: 'uploadedAt',
    label: 'Upload date',
    group: 'Dates',
    type: 'date',
    operators: DATE_OPERATORS,
    valueType: 'date-range',
    dependency: 'metadata',
    buildWhere: (op, value) => buildDateWhere('createdAt', op, value),
  },

  // ----------------------------- Location ---------------------------------
  {
    key: 'hasGps',
    label: 'Has GPS coordinates',
    group: 'Location',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'metadata',
    // is:true → coords present; is:false → coords absent.
    buildWhere: (_op, value) => whereMissingGeo(value !== true),
  },
  {
    key: 'noGps',
    label: 'No GPS coordinates',
    group: 'Location',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereMissingGeo(value === true),
  },
  {
    key: 'country',
    label: 'Country',
    group: 'Location',
    type: 'string',
    operators: ['equals'],
    valueType: 'string',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereCountry(String(value)),
  },
  {
    key: 'region',
    label: 'Region / State',
    group: 'Location',
    type: 'string',
    operators: ['equals'],
    valueType: 'string',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereRegion(String(value)),
  },
  {
    key: 'locality',
    label: 'Locality / City',
    group: 'Location',
    type: 'string',
    operators: ['equals'],
    valueType: 'string',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereLocality(String(value)),
  },
  {
    key: 'near',
    label: 'Near location (map radius)',
    group: 'Location',
    type: 'geo-radius',
    operators: ['near'],
    valueType: 'geo-radius',
    dependency: 'metadata',
    buildWhere: (_op, value) => {
      const v = (value ?? {}) as { lat?: unknown; lng?: unknown; radiusKm?: unknown };
      if (
        typeof v.lat !== 'number' ||
        typeof v.lng !== 'number' ||
        typeof v.radiusKm !== 'number' ||
        v.radiusKm <= 0
      ) {
        throw new BadRequestException('near requires { lat, lng, radiusKm } numbers with radiusKm > 0');
      }
      return whereNear(v.lat, v.lng, v.radiusKm);
    },
  },
  {
    key: 'coordSource',
    label: 'Coordinate source',
    group: 'Location',
    type: 'enum',
    operators: ['is'],
    valueType: 'enum',
    enumValues: ['exif', 'manual', 'inferred'],
    dependency: 'metadata',
    buildWhere: (_op, value) => ({ coordSource: String(value) }),
  },

  // --------------------------- Organization -------------------------------
  {
    key: 'cameraMake',
    label: 'Camera make',
    group: 'Organization',
    type: 'string',
    operators: ['equals', 'contains'],
    valueType: 'string',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const v = String(value ?? '');
      return {
        cameraMake:
          op === 'equals' ? { equals: v, mode: 'insensitive' } : { contains: v, mode: 'insensitive' },
      };
    },
  },
  {
    key: 'cameraModel',
    label: 'Camera model',
    group: 'Organization',
    type: 'string',
    operators: ['equals', 'contains'],
    valueType: 'string',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const v = String(value ?? '');
      return {
        cameraModel:
          op === 'equals' ? { equals: v, mode: 'insensitive' } : { contains: v, mode: 'insensitive' },
      };
    },
  },
  {
    key: 'missingCamera',
    label: 'Missing camera info',
    group: 'Organization',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereMissingCamera(value === true),
  },
  {
    key: 'favorite',
    label: 'Favorite',
    group: 'Organization',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'metadata',
    buildWhere: (_op, value) => whereFavorite(value === true),
  },
  {
    key: 'archived',
    label: 'Archived',
    group: 'Organization',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'metadata',
    buildWhere: (_op, value) =>
      value === true ? { archivedAt: { not: null } } : { archivedAt: null },
  },
  {
    key: 'album',
    label: 'Album membership',
    group: 'Organization',
    type: 'uuid',
    operators: ['in_album', 'not_in_album'],
    valueType: 'uuid',
    dependency: 'metadata',
    buildWhere: (op, value) => {
      const albumId = String(value ?? '');
      if (!albumId) throw new BadRequestException('album value must be an album UUID');
      return op === 'in_album'
        ? whereAlbum(albumId)
        : { NOT: { albumItems: { some: { albumId } } } };
    },
  },

  // ------------------------------- Tags -----------------------------------
  {
    key: 'tags',
    label: 'Tags',
    group: 'Tags',
    type: 'tag-set',
    operators: ['has_any', 'has_all', 'has_none'],
    valueType: 'string-list',
    dependency: 'tags',
    buildWhere: (op, value) => {
      const names = asStringList(value);
      if (op === 'has_any') return { OR: names.map(tagNameMatch) };
      if (op === 'has_all') return { AND: names.map(tagNameMatch) };
      // has_none
      return { AND: names.map((n) => ({ NOT: tagNameMatch(n) })) };
    },
  },
  {
    key: 'untagged',
    label: 'Untagged',
    group: 'Tags',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'tags',
    buildWhere: (_op, value) =>
      value === true ? { mediaTags: { none: {} } } : { mediaTags: { some: {} } },
  },

  // ------------------------------ People ----------------------------------
  {
    key: 'people',
    label: 'People',
    group: 'People',
    type: 'person-set',
    operators: ['has_person', 'not_has_person'],
    valueType: 'person-set',
    dependency: 'faces',
    buildWhere: (op, value) => {
      const v = (value ?? {}) as { ids?: unknown; mode?: unknown };
      const ids = Array.isArray(v.ids)
        ? (v.ids as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];
      if (ids.length === 0) throw new BadRequestException('people requires { ids: string[] }');
      if (op === 'not_has_person') {
        return { NOT: { faces: { some: { personId: { in: ids } } } } };
      }
      const mode = v.mode === 'all' ? 'all' : 'any';
      return wherePeople(ids, mode);
    },
  },
  {
    key: 'noFaces',
    label: 'No faces detected',
    group: 'People',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'faces',
    buildWhere: (_op, value) => whereNoFaces(value === true),
  },
  {
    key: 'hasUnassignedFaces',
    label: 'Has unassigned faces',
    group: 'People',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'faces',
    buildWhere: (_op, value) =>
      value === true
        ? { faces: { some: { personId: null } } }
        : { faces: { none: { personId: null } } },
  },

  // ------------------------------ Review ----------------------------------
  // Workflow-only descriptors targeting the burst/duplicate/location review
  // queues so a Media-Item workflow can drive their resolve/dismiss/accept
  // actions in Phase 2.
  {
    key: 'inPendingBurstGroup',
    label: 'In a pending burst group',
    group: 'Review',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'bursts',
    buildWhere: (_op, value) =>
      value === true
        ? { burstGroup: { is: { status: 'pending' } } }
        : { burstGroup: { isNot: { status: 'pending' } } },
  },
  {
    key: 'burstGroupConfidence',
    label: 'Burst-group confidence ≥',
    group: 'Review',
    type: 'number',
    operators: ['gte'],
    valueType: 'number',
    dependency: 'bursts',
    // Burst confidence IS persisted on burst_groups, so this is a pure indexed
    // relation predicate (unlike duplicateGroupConfidence below).
    buildWhere: (_op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new BadRequestException('burstGroupConfidence value must be a number');
      return { burstGroup: { is: { status: 'pending', confidence: { gte: n } } } };
    },
  },
  {
    key: 'inPendingDuplicateGroup',
    label: 'In a pending duplicate group',
    group: 'Review',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'duplicates',
    buildWhere: (_op, value) =>
      value === true
        ? { duplicateGroup: { is: { status: 'pending' } } }
        : { duplicateGroup: { isNot: { status: 'pending' } } },
  },
  {
    key: 'duplicateGroupConfidence',
    label: 'Duplicate-group confidence ≥',
    group: 'Review',
    type: 'number',
    operators: ['gte'],
    valueType: 'number',
    dependency: 'duplicates',
    // IMPORTANT: duplicate-group confidence (tightest-pair CLIP cosine
    // similarity) is computed at READ time, NOT persisted (see CLAUDE.md), so
    // this CANNOT be a pure index predicate the way burstGroupConfidence is.
    // The bounding predicate restricts to items already in a pending duplicate
    // group (a small set); the exact confidence comparison is a bounded
    // per-candidate compute pass. In Phase 1 the compute pass is deferred to the
    // Phase-2 executor (no `refinementPredicate` here), so preview counts items
    // in a pending duplicate group without applying the threshold — documented
    // behavior. Marked readTimeRefinement so the compiler surfaces it.
    readTimeRefinement: true,
    buildWhere: (_op, _value) => ({ duplicateGroup: { is: { status: 'pending' } } }),
  },
  {
    key: 'hasPendingLocationSuggestion',
    label: 'Has a pending location suggestion',
    group: 'Review',
    type: 'boolean',
    operators: ['is'],
    valueType: 'boolean',
    dependency: 'locationSuggestions',
    buildWhere: (_op, value) =>
      value === true
        ? { locationSuggestion: { is: { status: 'pending' } } }
        : { locationSuggestion: { isNot: { status: 'pending' } } },
  },
  {
    key: 'locationSuggestionConfidence',
    label: 'Location-suggestion confidence ≥',
    group: 'Review',
    type: 'number',
    operators: ['gte'],
    valueType: 'number',
    dependency: 'locationSuggestions',
    buildWhere: (_op, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestException('locationSuggestionConfidence value must be a number');
      }
      return { locationSuggestion: { is: { status: 'pending', confidence: { gte: n } } } };
    },
  },
  {
    key: 'locationSuggestionMethod',
    label: 'Location-suggestion method',
    group: 'Review',
    type: 'enum',
    operators: ['equals'],
    valueType: 'enum',
    enumValues: ['interpolated', 'nearest'],
    dependency: 'locationSuggestions',
    buildWhere: (_op, value) => ({
      locationSuggestion: { is: { status: 'pending', method: String(value) } },
    }),
  },
];

/**
 * Phase-1 action catalog stub for the Media Item Subject. Only the registered
 * TYPE set matters this phase — per-action parameter schemas and execution are
 * Phase 2 (#140). Types mirror the epic's Media-Item action list.
 */
export const MEDIA_ITEM_ACTIONS: WorkflowActionDescriptor[] = [
  { type: 'move_to_trash', label: 'Move to Trash' },
  { type: 'hard_delete', label: 'Delete permanently', destructive: true },
  { type: 'archive', label: 'Archive' },
  { type: 'unarchive', label: 'Unarchive' },
  { type: 'add_to_album', label: 'Add to album' },
  { type: 'remove_from_album', label: 'Remove from album' },
  { type: 'add_tags', label: 'Add tags' },
  { type: 'remove_tags', label: 'Remove tags' },
  { type: 'set_favorite', label: 'Set favorite' },
  { type: 'set_capture_date', label: 'Set capture date' },
  { type: 'shift_capture_date', label: 'Shift capture date' },
  { type: 'move_to_circle', label: 'Move to circle' },
  { type: 'assign_person', label: 'Assign person' },
  { type: 'remove_person', label: 'Remove person' },
  { type: 'set_location', label: 'Set location' },
  { type: 'clear_location', label: 'Clear location' },
  { type: 'resolve_burst_group', label: 'Resolve burst group' },
  { type: 'dismiss_burst_group', label: 'Dismiss burst group' },
  { type: 'resolve_duplicate_group', label: 'Resolve duplicate group' },
  { type: 'dismiss_duplicate_group', label: 'Dismiss duplicate group' },
  { type: 'accept_location_suggestion', label: 'Accept location suggestion' },
  { type: 'reject_location_suggestion', label: 'Reject location suggestion' },
  { type: 'rerun_enrichment', label: 'Re-run enrichment' },
];
