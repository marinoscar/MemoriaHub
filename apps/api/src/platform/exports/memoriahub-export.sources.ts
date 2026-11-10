// =============================================================================
// MemoriaHub's export sources (RETRO-H2, #596)
// =============================================================================
//
// Four sources next to the platform's `user-data` and `org-data`, each `scope: 'user'`
// and offered as JSON, CSV (formula-neutralised by the platform writer) and XLSX:
//
//   memoriahub-media     the user's media items: metadata, capture date, place, tags,
//                        people and album names. NOT the original bytes (that is Local
//                        Media Backup, `memoriahub backup`); the file name is a column.
//   memoriahub-albums    the user's albums and their membership.
//   memoriahub-memories  the memories of the circles the user belongs to, their items
//                        and the user's own seen / hidden / favourite marks.
//   memoriahub-people    the people of the user's personal circle and the ones the
//                        user added elsewhere, with face counts.
//
// Source ids use `-`, not `.`: the platform's `EXPORT_ID_PATTERN` is
// `^[a-z][a-z0-9-]{0,47}$`. They are PERMANENT once export jobs carry them.
//
// WHAT NEVER LEAVES (secret egress, biometrics): content hashes, perceptual hashes,
// storage keys (originals, thumbnails, face frames), signed URLs, the text and visual
// embeddings and every face embedding. Each dataset declares its columns and builds
// each row from them alone (`export-scope.ts`), and its `select` never reads those
// fields in the first place; `test/exports/memoriahub-export.sources.spec.ts` proves
// it against a client that returns every column whatever was selected.
//
// Scope ("my content"): `export-scope.ts`. Permission: `media:read` (every role).
// Registered by `app-registrations/exports.ts`, after `ExportsModule.forRoot`.
// =============================================================================

import { z } from 'zod';
import {
  CSV_EXPORT_WRITER,
  JSON_EXPORT_WRITER,
  XLSX_EXPORT_WRITER,
  type ExportColumn,
  type ExportContext,
  type ExportRow,
  type ExportSource,
  type ExportTable,
} from '@marinoscar/platform-api/exports';

import {
  MEMORIAHUB_EXPORT_COLUMN_TYPES,
  MEMORIAHUB_EXPORT_PERMISSION,
  bigText,
  bool,
  civilTimestamp,
  column,
  instant,
  joinNames,
  libraryName,
  num,
  OWNER_NAME_SELECT,
  ownedCircleContentWhere,
  pageById,
  text,
} from './export-scope';

/** The source ids. PERMANENT once export jobs carry them. */
export const MEMORIAHUB_MEDIA_EXPORT_SOURCE_ID = 'memoriahub-media';
export const MEMORIAHUB_ALBUMS_EXPORT_SOURCE_ID = 'memoriahub-albums';
export const MEMORIAHUB_MEMORIES_EXPORT_SOURCE_ID = 'memoriahub-memories';
export const MEMORIAHUB_PEOPLE_EXPORT_SOURCE_ID = 'memoriahub-people';

const FORMATS = [JSON_EXPORT_WRITER.id, CSV_EXPORT_WRITER.id, XLSX_EXPORT_WRITER.id] as const;
const NO_REQUEST = z.object({}).strict();

/** A dataset whose rows are a projection of a paged query. */
function projectedTable(
  ctx: ExportContext,
  spec: {
    dataset: string;
    title: string;
    columns: readonly ExportColumn[];
    delegate: string;
    where: Record<string, unknown>;
    select: Record<string, unknown>;
    project: (row: Record<string, unknown>) => ExportRow;
  },
): ExportTable {
  const keys = spec.columns.map((c) => c.key);
  return {
    dataset: spec.dataset,
    title: spec.title,
    columns: spec.columns,
    rows: (async function* () {
      for await (const row of pageById(ctx.db, spec, ctx.pageSize)) {
        const projected = spec.project(row);
        // Only the declared columns, whatever `project` returned.
        const out: Record<string, ExportRow[string]> = {};
        for (const key of keys) out[key] = projected[key] ?? null;
        yield out;
      }
    })(),
  };
}

function circleName(row: Record<string, unknown>): ExportRow[string] {
  return text(libraryName(row));
}

// ---------------------------------------------------------------------------
// memoriahub-media
// ---------------------------------------------------------------------------

export const MEDIA_ITEM_COLUMNS: readonly ExportColumn[] = [
  column('id', 'Media id'),
  column('circleId', 'Circle id'),
  column('circleName', 'Circle'),
  column('mediaType', 'Type'),
  column('originalFilename', 'Original file name'),
  column('mimeType', 'MIME type'),
  column('fileSize', 'File size (bytes)'),
  column('capturedAt', 'Captured (camera clock)'),
  column('width', 'Width', 'number'),
  column('height', 'Height', 'number'),
  column('durationMs', 'Duration (ms)', 'number'),
  column('cameraMake', 'Camera make'),
  column('cameraModel', 'Camera model'),
  column('takenLat', 'Latitude', 'number'),
  column('takenLng', 'Longitude', 'number'),
  column('coordSource', 'Coordinates source'),
  column('geoCountry', 'Country'),
  column('geoCountryCode', 'Country code'),
  column('geoRegion', 'Region'),
  column('geoLocality', 'Locality'),
  column('geoPlaceName', 'Place'),
  column('geoCanonicalCountry', 'Country (grouped)'),
  column('geoCanonicalRegion', 'Region (grouped)'),
  column('geoCanonicalLocality', 'Locality (grouped)'),
  column('description', 'Description'),
  column('tags', 'Tags'),
  column('people', 'People'),
  column('albums', 'Albums'),
  column('favorite', 'Favourite', 'boolean'),
  column('uploadedAt', 'Uploaded', 'datetime'),
  column('archivedAt', 'Archived', 'datetime'),
  column('deletedAt', 'In trash since', 'datetime'),
];

/** The media dataset of one user. Exposed for the spec. */
export function mediaItemTable(ctx: ExportContext): ExportTable {
  return projectedTable(ctx, {
    dataset: 'media_item',
    title: 'Media',
    columns: MEDIA_ITEM_COLUMNS,
    delegate: 'mediaItem',
    where: ownedCircleContentWhere(ctx.subjectId),
    select: {
      circleId: true,
      ...OWNER_NAME_SELECT,
      type: true,
      originalFilename: true,
      // Size and type only: never the key, the bucket or the provider.
      storageObject: { select: { size: true, mimeType: true } },
      capturedAt: true,
      width: true,
      height: true,
      durationMs: true,
      cameraMake: true,
      cameraModel: true,
      takenLat: true,
      takenLng: true,
      coordSource: true,
      geoCountry: true,
      geoCountryCode: true,
      geoAdmin1: true,
      geoLocality: true,
      geoPlaceName: true,
      geoCanonicalCountry: true,
      geoCanonicalAdmin1: true,
      geoCanonicalLocality: true,
      description: true,
      favorite: true,
      createdAt: true,
      archivedAt: true,
      deletedAt: true,
      mediaTags: { select: { tag: { select: { name: true } } } },
      faces: { where: { personId: { not: null } }, select: { person: { select: { name: true } } } },
      albumItems: { select: { album: { select: { name: true } } } },
    },
    project: (row) => {
      const object = row.storageObject as { size?: unknown; mimeType?: unknown } | null | undefined;
      const tags = ((row.mediaTags as { tag?: { name?: unknown } }[] | undefined) ?? []).map((t) => t.tag?.name);
      const people = ((row.faces as { person?: { name?: unknown } | null }[] | undefined) ?? []).map(
        (f) => f.person?.name,
      );
      const albums = ((row.albumItems as { album?: { name?: unknown } }[] | undefined) ?? []).map((a) => a.album?.name);
      return {
        id: text(row.id),
        circleId: text(row.circleId),
        circleName: circleName(row),
        mediaType: text(row.type),
        originalFilename: text(row.originalFilename),
        mimeType: text(object?.mimeType),
        fileSize: bigText(object?.size),
        capturedAt: civilTimestamp(row.capturedAt),
        width: num(row.width),
        height: num(row.height),
        durationMs: num(row.durationMs),
        cameraMake: text(row.cameraMake),
        cameraModel: text(row.cameraModel),
        takenLat: num(row.takenLat),
        takenLng: num(row.takenLng),
        coordSource: text(row.coordSource),
        geoCountry: text(row.geoCountry),
        geoCountryCode: text(row.geoCountryCode),
        geoRegion: text(row.geoAdmin1),
        geoLocality: text(row.geoLocality),
        geoPlaceName: text(row.geoPlaceName),
        geoCanonicalCountry: text(row.geoCanonicalCountry),
        geoCanonicalRegion: text(row.geoCanonicalAdmin1),
        geoCanonicalLocality: text(row.geoCanonicalLocality),
        description: text(row.description),
        tags: joinNames(tags),
        people: joinNames(people),
        albums: joinNames(albums),
        favorite: bool(row.favorite),
        uploadedAt: instant(row.createdAt),
        archivedAt: instant(row.archivedAt),
        deletedAt: instant(row.deletedAt),
      };
    },
  });
}

export const MEMORIAHUB_MEDIA_EXPORT_SOURCE: ExportSource<Record<string, never>> = {
  id: MEMORIAHUB_MEDIA_EXPORT_SOURCE_ID,
  scope: 'user',
  label: 'Your photos and videos (details)',
  description:
    'One row per photo or video in your personal circle or that you added to a shared circle: file name, capture date, size, camera, place, description, tags, people and albums. The files themselves are not included; use Local Media Backup for the originals.',
  permission: MEMORIAHUB_EXPORT_PERMISSION,
  requestSchema: NO_REQUEST,
  formats: FORMATS,
  columnTypes: MEMORIAHUB_EXPORT_COLUMN_TYPES,
  acceptsAttachedWriters: false,
  async *collect(ctx) {
    yield mediaItemTable(ctx);
  },
};

// ---------------------------------------------------------------------------
// memoriahub-albums
// ---------------------------------------------------------------------------

export const ALBUM_COLUMNS: readonly ExportColumn[] = [
  column('id', 'Album id'),
  column('circleId', 'Circle id'),
  column('circleName', 'Circle'),
  column('name', 'Name'),
  column('description', 'Description'),
  column('itemCount', 'Items', 'number'),
  column('dateRangeStart', 'Earliest capture (camera clock)'),
  column('dateRangeEnd', 'Latest capture (camera clock)'),
  column('coverMediaItemId', 'Cover media id'),
  column('createdAt', 'Created', 'datetime'),
  column('updatedAt', 'Updated', 'datetime'),
];

export const ALBUM_ITEM_COLUMNS: readonly ExportColumn[] = [
  column('id', 'Row id'),
  column('albumId', 'Album id'),
  column('mediaItemId', 'Media id'),
  column('addedAt', 'Added', 'datetime'),
];

/** The albums of one user: personal circle, or added by the user elsewhere. */
export function albumWhere(userId: string): Record<string, unknown> {
  return ownedCircleContentWhere(userId);
}

/** The albums dataset. The date range is one aggregate per album, over live members (as the album list shows it). */
export function albumTable(ctx: ExportContext): ExportTable {
  const base = projectedTable(ctx, {
    dataset: 'album',
    title: 'Albums',
    columns: ALBUM_COLUMNS,
    delegate: 'album',
    where: albumWhere(ctx.subjectId),
    select: {
      circleId: true,
      ...OWNER_NAME_SELECT,
      name: true,
      description: true,
      coverMediaItemId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { items: true } },
    },
    project: (row) => ({
      id: text(row.id),
      circleId: text(row.circleId),
      circleName: circleName(row),
      name: text(row.name),
      description: text(row.description),
      itemCount: num((row._count as { items?: unknown } | undefined)?.items),
      coverMediaItemId: text(row.coverMediaItemId),
      createdAt: instant(row.createdAt),
      updatedAt: instant(row.updatedAt),
    }),
  });
  return {
    ...base,
    rows: (async function* () {
      for await (const row of base.rows) {
        const range = (await ctx.db.mediaItem?.aggregate?.({
          where: { albumItems: { some: { albumId: row.id } }, deletedAt: null, archivedAt: null },
          _min: { capturedAt: true },
          _max: { capturedAt: true },
        })) as { _min?: { capturedAt?: unknown }; _max?: { capturedAt?: unknown } } | undefined;
        yield {
          ...row,
          dateRangeStart: civilTimestamp(range?._min?.capturedAt),
          dateRangeEnd: civilTimestamp(range?._max?.capturedAt),
        };
      }
    })(),
  };
}

/** The membership rows of the user's albums. */
export function albumItemTable(ctx: ExportContext): ExportTable {
  return projectedTable(ctx, {
    dataset: 'album_item',
    title: 'Album items',
    columns: ALBUM_ITEM_COLUMNS,
    delegate: 'albumItem',
    where: { album: albumWhere(ctx.subjectId) },
    select: { albumId: true, mediaItemId: true, addedAt: true },
    project: (row) => ({
      id: text(row.id),
      albumId: text(row.albumId),
      mediaItemId: text(row.mediaItemId),
      addedAt: instant(row.addedAt),
    }),
  });
}

export const MEMORIAHUB_ALBUMS_EXPORT_SOURCE: ExportSource<Record<string, never>> = {
  id: MEMORIAHUB_ALBUMS_EXPORT_SOURCE_ID,
  scope: 'user',
  label: 'Your albums',
  description:
    'The albums of your personal circle and the ones you created in shared circles: name, description, item count, date range and cover, plus which photos each album holds.',
  permission: MEMORIAHUB_EXPORT_PERMISSION,
  requestSchema: NO_REQUEST,
  formats: FORMATS,
  columnTypes: MEMORIAHUB_EXPORT_COLUMN_TYPES,
  acceptsAttachedWriters: false,
  async *collect(ctx) {
    yield albumTable(ctx);
    yield albumItemTable(ctx);
  },
};

// ---------------------------------------------------------------------------
// memoriahub-memories
// ---------------------------------------------------------------------------

export const MEMORY_COLUMNS: readonly ExportColumn[] = [
  column('id', 'Memory id'),
  column('circleId', 'Circle id'),
  column('circleName', 'Circle'),
  column('type', 'Type'),
  column('title', 'Title'),
  column('subtitle', 'Subtitle'),
  column('narrative', 'Narrative'),
  column('titleSource', 'Title source'),
  column('titleModel', 'Title model'),
  column('periodStart', 'Period start (camera clock)'),
  column('periodEnd', 'Period end (camera clock)'),
  column('itemCount', 'Items', 'number'),
  column('coverMediaItemId', 'Cover media id'),
  column('generatedAt', 'Generated', 'datetime'),
  column('seenAt', 'Seen', 'datetime'),
  column('hiddenAt', 'Hidden by you', 'datetime'),
  column('favoritedAt', 'Favourited', 'datetime'),
];

export const MEMORY_ITEM_COLUMNS: readonly ExportColumn[] = [
  column('id', 'Row id'),
  column('memoryId', 'Memory id'),
  column('mediaItemId', 'Media id'),
  column('position', 'Position', 'number'),
];

/** Live (not tombstoned) memories of the circles the user is a member of. */
export function memoryWhere(userId: string): Record<string, unknown> {
  return { deletedAt: null, OR: [{ ownerUserId: userId }, { ownerGroup: { members: { some: { userId } } } }] };
}

export function memoryTable(ctx: ExportContext): ExportTable {
  return projectedTable(ctx, {
    dataset: 'memory',
    title: 'Memories',
    columns: MEMORY_COLUMNS,
    delegate: 'memory',
    where: memoryWhere(ctx.subjectId),
    select: {
      circleId: true,
      ...OWNER_NAME_SELECT,
      type: true,
      title: true,
      subtitle: true,
      narrative: true,
      titleSource: true,
      titleModel: true,
      periodStart: true,
      periodEnd: true,
      itemCount: true,
      coverMediaItemId: true,
      generatedAt: true,
      // The caller's own marks only; another member's are theirs.
      userStates: {
        where: { userId: ctx.subjectId },
        select: { seenAt: true, hiddenAt: true, favoritedAt: true },
      },
    },
    project: (row) => {
      const state = ((row.userStates as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
      return {
        id: text(row.id),
        circleId: text(row.circleId),
        circleName: circleName(row),
        type: text(row.type),
        title: text(row.title),
        subtitle: text(row.subtitle),
        narrative: text(row.narrative),
        titleSource: text(row.titleSource),
        titleModel: text(row.titleModel),
        periodStart: civilTimestamp(row.periodStart),
        periodEnd: civilTimestamp(row.periodEnd),
        itemCount: num(row.itemCount),
        coverMediaItemId: text(row.coverMediaItemId),
        generatedAt: instant(row.generatedAt),
        seenAt: instant(state.seenAt),
        hiddenAt: instant(state.hiddenAt),
        favoritedAt: instant(state.favoritedAt),
      };
    },
  });
}

export function memoryItemTable(ctx: ExportContext): ExportTable {
  return projectedTable(ctx, {
    dataset: 'memory_item',
    title: 'Memory items',
    columns: MEMORY_ITEM_COLUMNS,
    delegate: 'memoryItem',
    where: { memory: memoryWhere(ctx.subjectId) },
    select: { memoryId: true, mediaItemId: true, position: true },
    project: (row) => ({
      id: text(row.id),
      memoryId: text(row.memoryId),
      mediaItemId: text(row.mediaItemId),
      position: num(row.position),
    }),
  });
}

export const MEMORIAHUB_MEMORIES_EXPORT_SOURCE: ExportSource<Record<string, never>> = {
  id: MEMORIAHUB_MEMORIES_EXPORT_SOURCE_ID,
  scope: 'user',
  label: 'Your memories',
  description:
    'The memories of the circles you belong to (deleted ones are left out): title, narrative, period and items, with whether you have seen, hidden or favourited each one.',
  permission: MEMORIAHUB_EXPORT_PERMISSION,
  requestSchema: NO_REQUEST,
  formats: FORMATS,
  columnTypes: MEMORIAHUB_EXPORT_COLUMN_TYPES,
  acceptsAttachedWriters: false,
  async *collect(ctx) {
    yield memoryTable(ctx);
    yield memoryItemTable(ctx);
  },
};

// ---------------------------------------------------------------------------
// memoriahub-people
// ---------------------------------------------------------------------------

export const PERSON_COLUMNS: readonly ExportColumn[] = [
  column('id', 'Person id'),
  column('circleId', 'Circle id'),
  column('circleName', 'Circle'),
  column('name', 'Name'),
  column('faceCount', 'Faces', 'number'),
  column('coverFaceId', 'Cover face id'),
  column('favorite', 'Favourite', 'boolean'),
  column('hiddenAt', 'Hidden', 'datetime'),
  column('mergedIntoId', 'Merged into'),
  column('deletedAt', 'Deleted', 'datetime'),
  column('createdAt', 'Created', 'datetime'),
];

export function personTable(ctx: ExportContext): ExportTable {
  return projectedTable(ctx, {
    dataset: 'person',
    title: 'People',
    columns: PERSON_COLUMNS,
    delegate: 'person',
    where: ownedCircleContentWhere(ctx.subjectId),
    select: {
      circleId: true,
      ...OWNER_NAME_SELECT,
      name: true,
      coverFaceId: true,
      favorite: true,
      hiddenAt: true,
      mergedIntoId: true,
      deletedAt: true,
      createdAt: true,
      // A count, never a face row: embeddings are biometric and never exported.
      _count: { select: { faces: true } },
    },
    project: (row) => ({
      id: text(row.id),
      circleId: text(row.circleId),
      circleName: circleName(row),
      name: text(row.name),
      faceCount: num((row._count as { faces?: unknown } | undefined)?.faces),
      coverFaceId: text(row.coverFaceId),
      favorite: bool(row.favorite),
      hiddenAt: instant(row.hiddenAt),
      mergedIntoId: text(row.mergedIntoId),
      deletedAt: instant(row.deletedAt),
      createdAt: instant(row.createdAt),
    }),
  });
}

export const MEMORIAHUB_PEOPLE_EXPORT_SOURCE: ExportSource<Record<string, never>> = {
  id: MEMORIAHUB_PEOPLE_EXPORT_SOURCE_ID,
  scope: 'user',
  label: 'Your people',
  description:
    'The people recognised in your personal circle and the ones you added in shared circles: name, number of faces, cover face and whether they are hidden or merged. Face data itself (the biometric embedding) never leaves the server.',
  permission: MEMORIAHUB_EXPORT_PERMISSION,
  requestSchema: NO_REQUEST,
  formats: FORMATS,
  columnTypes: MEMORIAHUB_EXPORT_COLUMN_TYPES,
  acceptsAttachedWriters: false,
  async *collect(ctx) {
    yield personTable(ctx);
  },
};

/** The four sources, in dialog order. */
export const MEMORIAHUB_EXPORT_SOURCES: readonly ExportSource<Record<string, never>>[] = [
  MEMORIAHUB_MEDIA_EXPORT_SOURCE,
  MEMORIAHUB_ALBUMS_EXPORT_SOURCE,
  MEMORIAHUB_MEMORIES_EXPORT_SOURCE,
  MEMORIAHUB_PEOPLE_EXPORT_SOURCE,
];
