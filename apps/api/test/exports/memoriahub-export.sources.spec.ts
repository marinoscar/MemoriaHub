/**
 * MemoriaHub's export sources (RETRO-H2, #596): scope, columns, civil dates and secret egress.
 *
 * The fake client is the worst case: it IGNORES `select` and hands back every column a
 * row has, including the ones that must never leave the server (content and perceptual
 * hashes, storage and thumbnail keys, signed URLs, face embeddings), each holding a
 * sentinel. Every source is then written through every writer it offers (JSON, CSV,
 * XLSX; the zips decompressed) and no sentinel may appear in any byte. That proves the
 * redaction is the sources' column projection, not the query's `select`.
 */

/** The platform's `EXPORT_ID_PATTERN` (`@marinoscar/platform-contract/exports`). */
const EXPORT_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
import {
  CSV_EXPORT_WRITER,
  JSON_EXPORT_WRITER,
  XLSX_EXPORT_WRITER,
  exportSourceRegistry,
  writersFor,
  type ExportContext,
  type ExportDb,
} from '@marinoscar/platform-api/exports';
import { collectExportOutput, exportFileText } from '@marinoscar/platform-api/exports/testing';

import '../../src/platform/exports/exports.config';
import { ownedCircleContentWhere, pageById } from '../../src/platform/exports/export-scope';
import {
  MEMORIAHUB_ALBUMS_EXPORT_SOURCE_ID,
  MEMORIAHUB_EXPORT_SOURCES,
  MEMORIAHUB_MEDIA_EXPORT_SOURCE,
  MEMORIAHUB_MEDIA_EXPORT_SOURCE_ID,
  MEMORIAHUB_MEMORIES_EXPORT_SOURCE,
  MEMORIAHUB_MEMORIES_EXPORT_SOURCE_ID,
  MEMORIAHUB_PEOPLE_EXPORT_SOURCE,
  MEMORIAHUB_PEOPLE_EXPORT_SOURCE_ID,
  memoryWhere,
} from '../../src/platform/exports/memoriahub-export.sources';

const USER = '00000000-0000-4000-8000-0000000000aa';

/** A value that must never appear in an export. */
const secret = (name: string) => `S3CR3T-${name}-Z`;
const FORBIDDEN = [
  'contentHash',
  'perceptualHash',
  'storageKey',
  'thumbnailKey',
  'bucket',
  'signedUrl',
  'embedding',
  'frameThumbnailKey',
  'sourcePath',
  'sharpness',
  'profileCrop',
  'otherUserState',
].map(secret);

const CAPTURED = new Date('2026-06-20T23:30:07.000Z');

/** Full rows, as a client ignoring `select` would return them. */
const ROWS: Record<string, Record<string, unknown>[]> = {
  mediaItem: [
    {
      id: '10000000-0000-4000-8000-000000000001',
      circleId: 'c1',
      circle: { name: 'Circle Alpha', ownerId: USER },
      type: 'photo',
      originalFilename: 'IMG_0001.HEIC',
      contentHash: secret('contentHash'),
      perceptualHash: secret('perceptualHash'),
      sharpnessScore: secret('sharpness'),
      sourcePath: secret('sourcePath'),
      storageObjectId: 's1',
      storageObject: {
        size: BigInt('9007199254740993'),
        mimeType: 'image/heic',
        storageKey: secret('storageKey'),
        bucket: secret('bucket'),
        metadata: { thumbnailStorageKey: secret('thumbnailKey') },
      },
      thumbnailUrl: secret('signedUrl'),
      capturedAt: CAPTURED,
      width: 4032,
      height: 3024,
      takenLat: 9.93,
      takenLng: -84.08,
      coordSource: 'exif',
      geoCountry: 'Country Alpha',
      geoAdmin1: 'Region Alpha',
      geoCanonicalAdmin1: 'Region A',
      description: 'A placeholder description',
      favorite: true,
      createdAt: new Date('2026-06-21T10:00:00.000Z'),
      archivedAt: null,
      deletedAt: null,
      embedding: { embedding: secret('embedding') },
      mediaTags: [{ tag: { name: 'beach' } }, { tag: { name: 'sunset' } }, { tag: { name: 'beach' } }],
      faces: [
        { person: { name: 'Person A' }, embedding: [secret('embedding')], frameThumbnailKey: secret('frameThumbnailKey') },
        { person: { name: 'Person B' } },
      ],
      albumItems: [{ album: { name: 'Album X' } }],
    },
  ],
  album: [
    {
      id: '20000000-0000-4000-8000-000000000001',
      circleId: 'c1',
      circle: { name: 'Circle Alpha' },
      name: 'Album X',
      description: null,
      coverMediaItemId: '10000000-0000-4000-8000-000000000001',
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      updatedAt: new Date('2026-06-22T00:00:00.000Z'),
      _count: { items: 1 },
    },
  ],
  albumItem: [
    {
      id: '30000000-0000-4000-8000-000000000001',
      albumId: '20000000-0000-4000-8000-000000000001',
      mediaItemId: '10000000-0000-4000-8000-000000000001',
      addedAt: new Date('2026-06-22T00:00:00.000Z'),
    },
  ],
  memory: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      circleId: 'c1',
      circle: { name: 'Circle Alpha' },
      type: 'trip',
      periodKey: '2026-06-20',
      title: 'A trip',
      subtitle: null,
      narrative: 'Placeholder narrative',
      titleSource: 'ai',
      titleModel: 'model-x',
      periodStart: CAPTURED,
      periodEnd: CAPTURED,
      itemCount: 1,
      coverMediaItemId: null,
      generatedAt: new Date('2026-06-23T00:00:00.000Z'),
      meta: { secret: secret('otherUserState') },
      userStates: [{ seenAt: new Date('2026-06-24T00:00:00.000Z'), hiddenAt: null, favoritedAt: null }],
    },
  ],
  memoryItem: [
    {
      id: '50000000-0000-4000-8000-000000000001',
      memoryId: '40000000-0000-4000-8000-000000000001',
      mediaItemId: '10000000-0000-4000-8000-000000000001',
      position: 0,
      score: 0.9,
    },
  ],
  person: [
    {
      id: '60000000-0000-4000-8000-000000000001',
      circleId: 'c1',
      circle: { name: 'Circle Alpha' },
      name: 'Person A',
      coverFaceId: '70000000-0000-4000-8000-000000000001',
      favorite: false,
      hiddenAt: null,
      mergedIntoId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
      profileCrop: { x: secret('profileCrop') },
      _count: { faces: 12 },
      faces: [{ embedding: [secret('embedding')] }],
    },
  ],
};

/** A client that ignores `select` and records every query. */
function leakyDb(queries: { delegate: string; args: Record<string, unknown> }[] = []): ExportDb {
  const db: Record<string, unknown> = {};
  for (const [delegate, rows] of Object.entries(ROWS)) {
    let served = false;
    db[delegate] = {
      findMany: async (args: Record<string, unknown>) => {
        queries.push({ delegate, args });
        if (served) return [];
        served = true;
        return rows;
      },
      aggregate: async () => ({ _min: { capturedAt: CAPTURED }, _max: { capturedAt: CAPTURED } }),
    };
  }
  return db as ExportDb;
}

function ctxOf(db: ExportDb): ExportContext {
  return {
    exportId: 'export-1',
    scope: 'user',
    subjectId: USER,
    requestedById: USER,
    db,
    datamodel: { models: [] },
    pageSize: 500,
    now: new Date('2026-07-01T00:00:00.000Z'),
    timeZone: 'UTC',
  };
}

describe('MemoriaHub export sources', () => {
  it('registers the four sources after the platform ones, with valid permanent ids and JSON/CSV/XLSX', () => {
    const ids = exportSourceRegistry.list().map((source) => source.id);
    expect(ids.slice(0, 2)).toEqual(['user-data', 'org-data']);
    for (const source of MEMORIAHUB_EXPORT_SOURCES) {
      expect(ids).toContain(source.id);
      expect(source.id).toMatch(EXPORT_ID_PATTERN);
      expect(source.scope).toBe('user');
      expect(source.permission).toBe('media:read');
      expect(writersFor(source).map((writer) => writer.id)).toEqual(['json', 'csv', 'xlsx']);
    }
    expect(MEMORIAHUB_EXPORT_SOURCES.map((source) => source.id)).toEqual([
      MEMORIAHUB_MEDIA_EXPORT_SOURCE_ID,
      MEMORIAHUB_ALBUMS_EXPORT_SOURCE_ID,
      MEMORIAHUB_MEMORIES_EXPORT_SOURCE_ID,
      MEMORIAHUB_PEOPLE_EXPORT_SOURCE_ID,
    ]);
  });

  describe.each(MEMORIAHUB_EXPORT_SOURCES.map((source) => [source.id, source] as const))('%s', (_id, source) => {
    it.each([JSON_EXPORT_WRITER, CSV_EXPORT_WRITER, XLSX_EXPORT_WRITER].map((w) => [w.id, w] as const))(
      'writes no hash, key, URL, embedding or other user state as %s',
      async (_format, writer) => {
        const { bytes, result } = await collectExportOutput(writer, source.collect(ctxOf(leakyDb()), {}), source.id);
        const output = exportFileText(bytes);
        for (const sentinel of FORBIDDEN) expect(output).not.toContain(sentinel);
        expect(Object.values(result.rowCounts).every((count) => count === 1)).toBe(true);
      },
    );
  });

  it('writes a media row with the civil capture time, size as text and joined names', async () => {
    const { bytes } = await collectExportOutput(
      JSON_EXPORT_WRITER,
      MEMORIAHUB_MEDIA_EXPORT_SOURCE.collect(ctxOf(leakyDb()), {}),
    );
    const file = JSON.parse(bytes.toString('utf8')) as {
      datasets: Record<string, { rows: Record<string, unknown>[] }>;
    };
    const row = file.datasets.media_item!.rows[0]!;
    // The stored UTC wall clock with no zone: the same day and time the gallery shows.
    expect(row.capturedAt).toBe('2026-06-20T23:30:07');
    expect(row.fileSize).toBe('9007199254740993');
    expect(row.mimeType).toBe('image/heic');
    expect(row.tags).toBe('beach; sunset');
    expect(row.people).toBe('Person A; Person B');
    expect(row.albums).toBe('Album X');
    expect(row.geoRegion).toBe('Region Alpha');
    expect(row.geoCanonicalRegion).toBe('Region A');
    expect(row.uploadedAt).toBe('2026-06-21T10:00:00.000Z');
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['contentHash', 'perceptualHash', 'storageKey']));
  });

  it('keeps the civil capture time whatever the process time zone', async () => {
    const original = process.env.TZ;
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = tz;
      const { bytes } = await collectExportOutput(
        JSON_EXPORT_WRITER,
        MEMORIAHUB_MEDIA_EXPORT_SOURCE.collect(ctxOf(leakyDb()), {}),
      );
      expect(bytes.toString('utf8')).toContain('"2026-06-20T23:30:07"');
    }
    process.env.TZ = original;
  });

  it('reads media of the personal circle and what the user added outside someone else’s personal circle', async () => {
    const queries: { delegate: string; args: Record<string, unknown> }[] = [];
    for await (const table of MEMORIAHUB_MEDIA_EXPORT_SOURCE.collect(ctxOf(leakyDb(queries)), {})) {
      for await (const _row of table.rows) void _row;
    }
    expect(queries[0]!.args.where).toEqual(ownedCircleContentWhere(USER));
    expect(ownedCircleContentWhere(USER)).toEqual({
      OR: [
        { circle: { isPersonal: true, ownerId: USER } },
        { addedById: USER, circle: { OR: [{ isPersonal: false }, { ownerId: USER }] } },
      ],
    });
    // The storage object is read for its size and type only.
    const select = queries[0]!.args.select as { storageObject: unknown };
    expect(select.storageObject).toEqual({ select: { size: true, mimeType: true } });
  });

  it('reads live memories of the user’s circles and only the user’s own marks', async () => {
    const queries: { delegate: string; args: Record<string, unknown> }[] = [];
    for await (const table of MEMORIAHUB_MEMORIES_EXPORT_SOURCE.collect(ctxOf(leakyDb(queries)), {})) {
      for await (const _row of table.rows) void _row;
    }
    const memory = queries.find((q) => q.delegate === 'memory')!;
    expect(memory.args.where).toEqual(memoryWhere(USER));
    expect(memoryWhere(USER)).toEqual({ deletedAt: null, circle: { members: { some: { userId: USER } } } });
    const select = memory.args.select as { userStates: { where: unknown } };
    expect(select.userStates.where).toEqual({ userId: USER });
    expect(queries.find((q) => q.delegate === 'memoryItem')!.args.where).toEqual({ memory: memoryWhere(USER) });
  });

  it('counts a person’s faces and never selects a face row', async () => {
    const queries: { delegate: string; args: Record<string, unknown> }[] = [];
    for await (const table of MEMORIAHUB_PEOPLE_EXPORT_SOURCE.collect(ctxOf(leakyDb(queries)), {})) {
      for await (const _row of table.rows) void _row;
    }
    const select = queries[0]!.args.select as Record<string, unknown>;
    expect(select._count).toEqual({ select: { faces: true } });
    expect(select).not.toHaveProperty('faces');
  });
});

describe('pageById', () => {
  it('pages by id with a keyset cursor until a short page', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const calls: Record<string, unknown>[] = [];
    const db = {
      thing: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          const where = args.where as { AND?: [unknown, { id: { gt: string } }] };
          const after = where.AND?.[1].id.gt;
          const start = after ? ids.indexOf(after) + 1 : 0;
          return ids.slice(start, start + (args.take as number)).map((id) => ({ id }));
        },
      },
    } as ExportDb;
    const seen: string[] = [];
    for await (const row of pageById(db, { delegate: 'thing', where: { owner: 'u' }, select: {} }, 2)) {
      seen.push(row.id as string);
    }
    expect(seen).toEqual(ids);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ where: { owner: 'u' }, orderBy: { id: 'asc' }, take: 2 });
    expect(calls[1]).toMatchObject({ where: { AND: [{ owner: 'u' }, { id: { gt: 'b' } }] } });
  });
});
