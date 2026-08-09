/**
 * test/backup/restore-engine.spec.ts — `memoriahub backup restore` (issue #321).
 *
 * Covers the contract that makes a restore trustworthy:
 *   - --dry-run produces a COMPLETE plan (circle mapping + per-circle totals)
 *     and writes nothing at all;
 *   - a fresh restore uploads originals, registers MediaItems, and reapplies
 *     tags / albums / people / archive state from the sidecars;
 *   - a second invocation is a no-op (restored_media_item_id + server dedup);
 *   - a dedup response counts as skipped-existing, not an error;
 *   - circle-mapping precedence (--map-circle > --into-circle > by name), and
 *     an unknown --map-circle target hard-erroring BEFORE any write;
 *   - --include trashed restores trashed rows as ACTIVE; quarantined never;
 *   - a run killed mid-way resumes and only finishes the remaining items;
 *   - a `nod_` node credential is refused up front.
 *
 * Everything runs against a real on-disk backup root (files + sidecars + a
 * real SQLite catalog) and a fully mocked ApiClient surface.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo, type CatalogItemStatus } from '../../src/backup/catalog-repo.js';
import { absPathFor, sidecarRelPathFor } from '../../src/backup/layout.js';
import { ApiError, type Circle } from '../../src/api.js';
import {
  NodeCredentialNotAllowedError,
  RestoreEmitter,
  RestoreMappingError,
  assertRestoreCredential,
  parseMapCircle,
  resolveRestoreExitCode,
  runRestore,
  type RestoreApi,
  type RestorePlan,
  type RestoreSummary,
  type RestoreUploadFn,
} from '../../src/backup/restore-engine.js';

// ---------------------------------------------------------------------------
// Fixture: a real backup root on disk
// ---------------------------------------------------------------------------

interface SeedItem {
  id: string;
  circleId: string;
  circleName: string;
  fileName: string;
  status?: CatalogItemStatus;
  archivedAt?: string | null;
  capturedAt?: string | null;
  favorite?: boolean;
  description?: string;
  tags?: string[];
  albums?: Array<{ id: string; name: string }>;
  people?: Array<{ personId: string; name: string }>;
  geo?: { takenLat: number; takenLng: number; coordSource: string };
  /** Skip writing the original bytes (simulates a damaged root). */
  omitFile?: boolean;
}

let tmpRoot: string;
let db: BetterSqlite3.Database;
let repo: CatalogRepo;

function seed(item: SeedItem): void {
  const archived = typeof item.archivedAt === 'string';
  const relPath = `${archived ? 'archived' : 'media'}/2024/03/${item.fileName}`;
  const abs = absPathFor(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!item.omitFile) fs.writeFileSync(abs, `bytes-of-${item.id}`);

  const sidecar = {
    schemaVersion: 1,
    mediaItemId: item.id,
    circleId: item.circleId,
    circleName: item.circleName,
    type: 'photo',
    originalFilename: item.fileName,
    capturedAt: item.capturedAt ?? '2024-03-10T12:00:00.000Z',
    capturedAtOffset: -360,
    mimeType: 'image/jpeg',
    description: item.description ?? null,
    favorite: item.favorite ?? false,
    archivedAt: item.archivedAt ?? null,
    deletedAt: item.status === 'trashed' ? '2024-04-01T00:00:00.000Z' : null,
    geo: item.geo ?? { takenLat: null, takenLng: null, coordSource: null },
    tags: (item.tags ?? []).map((name) => ({ name, source: 'ai' })),
    albums: item.albums ?? [],
    people: item.people ?? [],
    faces: [],
  };
  fs.mkdirSync(path.dirname(absPathFor(tmpRoot, sidecarRelPathFor(relPath))), {
    recursive: true,
  });
  fs.writeFileSync(
    absPathFor(tmpRoot, sidecarRelPathFor(relPath)),
    JSON.stringify(sidecar, null, 2),
  );

  repo.upsertItemWithDims(
    {
      mediaItemId: item.id,
      circleId: item.circleId,
      relPath,
      sidecarRelPath: sidecarRelPathFor(relPath),
      capturedAt: item.capturedAt ?? '2024-03-10T12:00:00.000Z',
      contentHash: `hash-${item.id}`,
      size: 1024,
      mimeType: 'image/jpeg',
      serverUpdatedAt: '2024-03-11T00:00:00.000Z',
      status: item.status ?? 'present',
      archived,
      downloadedAt: '2024-03-11T00:00:00.000Z',
      verifiedAt: null,
      lastError: null,
    },
    {
      tags: (item.tags ?? []).map((name) => ({ name, source: 'ai' })),
      albums: item.albums ?? [],
      people: item.people ?? [],
    },
  );
}

/** Write catalog/albums.json (the dimension file restore reads descriptions from). */
function seedAlbumCatalog(entries: Array<{ id: string; name: string; description?: string }>): void {
  const dir = absPathFor(tmpRoot, 'catalog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'albums.json'), JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// Fixture: a recording fake ApiClient
// ---------------------------------------------------------------------------

interface FakeApiOptions {
  circles?: Circle[];
  /** Ids the server still knows about (drives getMediaItem 200 vs 404). */
  knownMediaIds?: Set<string>;
  /** Content hashes the server ALREADY holds → createMediaItem dedups. */
  dedupHashes?: Set<string>;
}

interface FakeApi {
  api: RestoreApi;
  calls: {
    circlesCreated: Array<{ name: string }>;
    mediaCreated: Array<Record<string, unknown>>;
    mediaGets: string[];
    bulkUpdates: Array<{ circleId: string; ids: string[]; set: Record<string, unknown> }>;
    bulkTags: Array<{ circleId: string; ids: string[]; add?: string[] }>;
    albumsCreated: Array<{ circleId: string; name: string; description?: string }>;
    albumItems: Array<{ albumId: string; mediaItemIds: string[] }>;
    archives: Array<{ circleId: string; ids: string[] }>;
    people: Array<{ mediaItemId: string; name?: string }>;
  };
}

function makeApi(opts: FakeApiOptions = {}): FakeApi {
  const circles: Circle[] = opts.circles ?? [];
  const known = opts.knownMediaIds ?? new Set<string>();
  const dedupHashes = opts.dedupHashes ?? new Set<string>();
  let mediaSeq = 0;
  let circleSeq = 0;
  let albumSeq = 0;
  const albumsByCircle = new Map<string, Array<{ id: string; name: string }>>();

  const calls: FakeApi['calls'] = {
    circlesCreated: [],
    mediaCreated: [],
    mediaGets: [],
    bulkUpdates: [],
    bulkTags: [],
    albumsCreated: [],
    albumItems: [],
    archives: [],
    people: [],
  };

  const api = {
    listCircles: async () => circles.slice(),
    createCircle: async (body: { name: string; description?: string }) => {
      calls.circlesCreated.push({ name: body.name });
      const created: Circle = {
        id: `new-circle-${++circleSeq}`,
        name: body.name,
        isPersonal: false,
      };
      circles.push(created);
      return created;
    },
    getMediaItem: async (id: string) => {
      calls.mediaGets.push(id);
      if (!known.has(id)) throw new ApiError(404, 'Media item not found');
      return { id };
    },
    createMediaItem: async (body: Record<string, unknown>) => {
      calls.mediaCreated.push(body);
      const hash = body['contentHash'] as string | undefined;
      if (hash && dedupHashes.has(hash)) {
        const id = `dedup-${hash}`;
        known.add(id);
        return { id, deduplicated: true };
      }
      const id = `srv-${++mediaSeq}`;
      known.add(id);
      return {
        id,
        capturedAt: (body['capturedAt'] as string | undefined) ?? null,
        favorite: body['favorite'] === true,
      };
    },
    bulkUpdateMedia: async (body: {
      circleId: string;
      ids: string[];
      set: Record<string, unknown>;
    }) => {
      calls.bulkUpdates.push({ circleId: body.circleId, ids: [...body.ids], set: body.set });
      return {};
    },
    bulkTags: async (body: { circleId: string; ids: string[]; add?: string[] }) => {
      calls.bulkTags.push({
        circleId: body.circleId,
        ids: [...body.ids],
        ...(body.add ? { add: [...body.add] } : {}),
      });
      return {};
    },
    bulkArchiveMedia: async (body: { circleId: string; ids: string[] }) => {
      calls.archives.push({ circleId: body.circleId, ids: [...body.ids] });
      return {};
    },
    listAlbums: async (circleId: string) => (albumsByCircle.get(circleId) ?? []).slice(),
    createAlbum: async (body: { circleId: string; name: string; description?: string }) => {
      calls.albumsCreated.push({
        circleId: body.circleId,
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
      });
      const album = { id: `album-${++albumSeq}`, name: body.name };
      const list = albumsByCircle.get(body.circleId) ?? [];
      list.push(album);
      albumsByCircle.set(body.circleId, list);
      return album;
    },
    addAlbumItems: async (albumId: string, mediaItemIds: string[]) => {
      calls.albumItems.push({ albumId, mediaItemIds: [...mediaItemIds] });
      return {};
    },
    addPersonToMedia: async (mediaItemId: string, body: { personId?: string; name?: string }) => {
      calls.people.push({
        mediaItemId,
        ...(body.name !== undefined ? { name: body.name } : {}),
      });
      return { personId: `person-${body.name ?? body.personId}`, personName: body.name ?? null, faceId: 'face-1' };
    },
  } as unknown as RestoreApi;

  return { api, calls };
}

/** Recording upload stub; `failFor` makes specific rel paths blow up. */
function makeUpload(failFor: (filePath: string) => boolean = () => false): {
  upload: RestoreUploadFn;
  uploaded: string[];
} {
  const uploaded: string[] = [];
  let seq = 0;
  const upload: RestoreUploadFn = async (filePath) => {
    if (failFor(filePath)) throw new Error('simulated upload kill');
    uploaded.push(path.basename(filePath));
    return { objectId: `obj-${++seq}` };
  };
  return { upload, uploaded };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-restore-'));
  db = openCatalogDb(tmpRoot);
  repo = new CatalogRepo(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Credential guard
// ---------------------------------------------------------------------------

describe('restore credential guard', () => {
  it('rejects a `nod_` node credential up front', () => {
    expect(() => assertRestoreCredential('nod_abcdef')).toThrow(NodeCredentialNotAllowedError);
    expect(() => assertRestoreCredential('nod_abcdef')).toThrow(/node credential/i);
    // The message must point at the fix, not just the symptom.
    expect(() => assertRestoreCredential('nod_abcdef')).toThrow(/memoriahub login/);
  });

  it('accepts a normal PAT / session token', () => {
    expect(() => assertRestoreCredential('mhp_live_token')).not.toThrow();
    expect(() => assertRestoreCredential('eyJhbGciOi.jwt.token')).not.toThrow();
  });
});

describe('parseMapCircle', () => {
  it('parses repeated src=dst pairs', () => {
    const map = parseMapCircle(['a=b', ' c = d ']);
    expect(map.get('a')).toBe('b');
    expect(map.get('c')).toBe('d');
  });

  it('rejects a malformed pair instead of silently dropping the mapping', () => {
    expect(() => parseMapCircle(['no-equals'])).toThrow(RestoreMappingError);
    expect(() => parseMapCircle(['=missing-source'])).toThrow(RestoreMappingError);
    expect(() => parseMapCircle(['missing-target='])).toThrow(RestoreMappingError);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('restore --dry-run', () => {
  it('produces a complete, write-free plan including the circle mapping', async () => {
    seed({
      id: 'i1',
      circleId: 'src-circle',
      circleName: 'Family',
      fileName: 'A.jpg',
      tags: ['beach', 'sunset'],
      albums: [{ id: 'alb-1', name: 'Summer' }],
      people: [{ personId: 'p1', name: 'Ana' }],
    });
    seed({
      id: 'i2',
      circleId: 'src-circle',
      circleName: 'Family',
      fileName: 'B.jpg',
      archivedAt: '2024-05-01T00:00:00.000Z',
      tags: ['beach'],
    });
    seed({ id: 'i3', circleId: 'other-circle', circleName: 'Work', fileName: 'C.jpg' });

    const { api, calls } = makeApi({
      circles: [{ id: 'existing-1', name: 'Family', isPersonal: false }],
    });
    const { upload, uploaded } = makeUpload();

    const emitter = new RestoreEmitter();
    const plans: RestorePlan[] = [];
    emitter.on('restore-plan', (p: RestorePlan) => plans.push(p));

    const summary = await runRestore(
      { root: tmpRoot, dryRun: true },
      { db, api, upload },
      emitter,
    );

    // Nothing was written: no uploads, no circles, no media, no metadata.
    expect(uploaded).toEqual([]);
    expect(calls.circlesCreated).toEqual([]);
    expect(calls.mediaCreated).toEqual([]);
    expect(calls.bulkTags).toEqual([]);
    expect(calls.albumItems).toEqual([]);
    expect(calls.archives).toEqual([]);
    expect(summary.uploaded).toBe(0);

    // The plan is complete.
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.dryRun).toBe(true);
    expect(plan.totalItems).toBe(3);
    expect(plan.totalBytes).toBe(3 * 1024);

    const family = plan.circles.find((c) => c.sourceCircleId === 'src-circle')!;
    expect(family.sourceCircleName).toBe('Family');
    expect(family.resolution).toBe('matched-by-name');
    expect(family.targetCircleId).toBe('existing-1');
    expect(family.items).toBe(2);
    expect(family.bytes).toBe(2048);
    expect(family.albums).toBe(1);
    expect(family.people).toBe(1);
    expect(family.tags).toBe(2);

    // A circle with no name match is planned as a CREATE, with no target id
    // (nothing is created during a dry run).
    const work = plan.circles.find((c) => c.sourceCircleId === 'other-circle')!;
    expect(work.resolution).toBe('create');
    expect(work.targetCircleId).toBeNull();
    expect(work.targetCircleName).toBe('Work');

    expect(resolveRestoreExitCode(summary)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end restore
// ---------------------------------------------------------------------------

describe('restore end-to-end', () => {
  it('uploads originals, creates albums/tags/people, and re-archives archived items', async () => {
    seedAlbumCatalog([{ id: 'alb-1', name: 'Summer', description: 'Beach trip' }]);
    seed({
      id: 'i1',
      circleId: 'src',
      circleName: 'Family',
      fileName: 'A.jpg',
      favorite: true,
      description: 'A sunny day',
      tags: ['beach', 'sunset'],
      albums: [{ id: 'alb-1', name: 'Summer' }],
      people: [{ personId: 'p1', name: 'Ana' }, { personId: 'p2', name: 'Bruno' }],
      geo: { takenLat: 9.9, takenLng: -84.1, coordSource: 'manual' },
    });
    seed({
      id: 'i2',
      circleId: 'src',
      circleName: 'Family',
      fileName: 'B.jpg',
      archivedAt: '2024-05-01T00:00:00.000Z',
      tags: ['beach', 'sunset'],
    });

    const { api, calls } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
    });
    const { upload, uploaded } = makeUpload();

    const summary = await runRestore(
      { root: tmpRoot, concurrency: 1 },
      { db, api, upload },
    );

    // Originals uploaded and registered into the name-matched circle.
    expect(uploaded.sort()).toEqual(['A.jpg', 'B.jpg']);
    expect(summary.uploaded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(calls.mediaCreated).toHaveLength(2);
    for (const body of calls.mediaCreated) {
      expect(body['circleId']).toBe('circle-family');
      expect(body['source']).toBe('cli');
      expect(body['type']).toBe('photo');
      expect(String(body['contentHash'])).toMatch(/^hash-i/);
    }
    // description has no bulk endpoint, so it rides along on creation.
    expect(calls.mediaCreated.find((b) => b['originalFilename'] === 'A.jpg')?.['description']).toBe(
      'A sunny day',
    );

    // Tags: both items share one tag SET, so they collapse into ONE bulk call.
    expect(calls.bulkTags).toHaveLength(1);
    expect(calls.bulkTags[0]!.add).toEqual(['beach', 'sunset']);
    expect(calls.bulkTags[0]!.ids).toHaveLength(2);

    // Album: found-or-created by name (with the catalog description) + members.
    expect(calls.albumsCreated).toEqual([
      { circleId: 'circle-family', name: 'Summer', description: 'Beach trip' },
    ]);
    expect(calls.albumItems).toHaveLength(1);
    expect(calls.albumItems[0]!.mediaItemIds).toHaveLength(1);
    expect(summary.albumsCreated).toBe(1);

    // People restored by NAME (faces themselves are re-detected by enrichment).
    expect(calls.people.map((p) => p.name).sort()).toEqual(['Ana', 'Bruno']);
    expect(summary.peopleLinks).toBe(2);

    // Manual location came back through the bulk update path.
    const withLocation = calls.bulkUpdates.find((u) => u.set['location'] !== undefined);
    expect(withLocation?.set['location']).toEqual({ lat: 9.9, lng: -84.1 });

    // The archived item was restored, then re-archived at the very end.
    expect(calls.archives).toHaveLength(1);
    expect(calls.archives[0]!.ids).toHaveLength(1);
    expect(summary.archived).toBe(1);

    // Both restored ids are recorded in the catalog.
    expect(repo.getById('i1')?.restoredMediaItemId).toMatch(/^srv-/);
    expect(repo.getById('i2')?.restoredMediaItemId).toMatch(/^srv-/);
    expect(resolveRestoreExitCode(summary)).toBe(0);
  });

  it('is a no-op on a second invocation (restored ids verified, nothing re-uploaded)', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg', tags: ['beach'] });
    seed({ id: 'i2', circleId: 'src', circleName: 'Family', fileName: 'B.jpg' });

    const known = new Set<string>();
    const first = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
      knownMediaIds: known,
    });
    const firstUpload = makeUpload();
    await runRestore({ root: tmpRoot }, { db, api: first.api, upload: firstUpload.upload });
    expect(firstUpload.uploaded).toHaveLength(2);

    // Second run: the same server still knows both items.
    const second = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
      knownMediaIds: known,
    });
    const secondUpload = makeUpload();
    const summary = await runRestore(
      { root: tmpRoot },
      { db, api: second.api, upload: secondUpload.upload },
    );

    expect(secondUpload.uploaded).toEqual([]);
    expect(second.calls.mediaCreated).toEqual([]);
    expect(second.calls.bulkTags).toEqual([]);
    expect(second.calls.people).toEqual([]);
    expect(summary.uploaded).toBe(0);
    expect(summary.skippedExisting).toBe(2);
    expect(summary.failed).toBe(0);
    // Each skip was a real server verification, not a blind trust of the catalog.
    expect(second.calls.mediaGets).toHaveLength(2);
  });

  it('records a dedup response as skipped-existing (not an error) and captures its id', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });

    const { api, calls } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
      dedupHashes: new Set(['hash-i1']),
    });
    const { upload, uploaded } = makeUpload();

    const summary = await runRestore({ root: tmpRoot }, { db, api, upload });

    // The upload still happened (the server decides dedup), but the outcome is
    // a skip and the EXISTING id is what lands in the catalog.
    expect(uploaded).toEqual(['A.jpg']);
    expect(calls.mediaCreated).toHaveLength(1);
    expect(summary.uploaded).toBe(0);
    expect(summary.skippedExisting).toBe(1);
    expect(summary.failed).toBe(0);
    expect(repo.getById('i1')?.restoredMediaItemId).toBe('dedup-hash-i1');
    expect(resolveRestoreExitCode(summary)).toBe(0);
  });

  it('reports a missing local file as a failure without aborting the run', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg', omitFile: true });
    seed({ id: 'i2', circleId: 'src', circleName: 'Family', fileName: 'B.jpg' });

    const { api } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
    });
    const { upload, uploaded } = makeUpload();

    const summary = await runRestore({ root: tmpRoot }, { db, api, upload });

    expect(uploaded).toEqual(['B.jpg']);
    expect(summary.uploaded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]!.error).toMatch(/missing/);
    expect(resolveRestoreExitCode(summary)).toBe(1);
  });

  it('--skip-metadata uploads originals only', async () => {
    seed({
      id: 'i1',
      circleId: 'src',
      circleName: 'Family',
      fileName: 'A.jpg',
      tags: ['beach'],
      albums: [{ id: 'alb-1', name: 'Summer' }],
      people: [{ personId: 'p1', name: 'Ana' }],
      archivedAt: '2024-05-01T00:00:00.000Z',
    });

    const { api, calls } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
    });
    const { upload, uploaded } = makeUpload();

    const summary = await runRestore(
      { root: tmpRoot, skipMetadata: true },
      { db, api, upload },
    );

    expect(uploaded).toEqual(['A.jpg']);
    expect(calls.bulkTags).toEqual([]);
    expect(calls.albumItems).toEqual([]);
    expect(calls.people).toEqual([]);
    expect(calls.archives).toEqual([]);
    expect(calls.mediaCreated[0]!['description']).toBeUndefined();
    expect(summary.metadataApplied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Circle mapping
// ---------------------------------------------------------------------------

describe('restore circle mapping', () => {
  it('honours precedence: --map-circle > --into-circle > name match', async () => {
    seed({ id: 'i1', circleId: 'src-a', circleName: 'Family', fileName: 'A.jpg' });
    seed({ id: 'i2', circleId: 'src-b', circleName: 'Work', fileName: 'B.jpg' });

    const { api, calls } = makeApi({
      circles: [
        { id: 'circle-family', name: 'Family', isPersonal: false },
        { id: 'circle-dump', name: 'Dump', isPersonal: false },
        { id: 'circle-explicit', name: 'Explicit', isPersonal: false },
      ],
    });
    const { upload } = makeUpload();

    // src-a is explicitly mapped (beats both --into-circle and its name match);
    // src-b falls through to --into-circle (beats its own name match).
    await runRestore(
      {
        root: tmpRoot,
        intoCircle: 'circle-dump',
        mapCircle: new Map([['src-a', 'circle-explicit']]),
      },
      { db, api, upload },
    );

    const byFile = new Map(
      calls.mediaCreated.map((b) => [b['originalFilename'] as string, b['circleId']]),
    );
    expect(byFile.get('A.jpg')).toBe('circle-explicit');
    expect(byFile.get('B.jpg')).toBe('circle-dump');
    // Name matching never ran — nothing was created.
    expect(calls.circlesCreated).toEqual([]);
  });

  it('creates a circle by sidecar name when nothing matches', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Brand New', fileName: 'A.jpg' });

    const { api, calls } = makeApi({ circles: [] });
    const { upload } = makeUpload();

    const summary = await runRestore({ root: tmpRoot }, { db, api, upload });

    expect(calls.circlesCreated).toEqual([{ name: 'Brand New' }]);
    expect(summary.circlesCreated).toBe(1);
    expect(calls.mediaCreated[0]!['circleId']).toBe('new-circle-1');
  });

  it('hard-errors on an unknown --map-circle target BEFORE any write', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });

    const { api, calls } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
    });
    const { upload, uploaded } = makeUpload();

    await expect(
      runRestore(
        { root: tmpRoot, mapCircle: new Map([['src', 'circle-that-does-not-exist']]) },
        { db, api, upload },
      ),
    ).rejects.toThrow(RestoreMappingError);

    // Absolutely nothing was written.
    expect(uploaded).toEqual([]);
    expect(calls.mediaCreated).toEqual([]);
    expect(calls.circlesCreated).toEqual([]);
    expect(repo.getById('i1')?.restoredMediaItemId).toBeNull();
  });

  it('hard-errors on an unknown --into-circle target', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });
    const { api } = makeApi({ circles: [] });
    const { upload, uploaded } = makeUpload();

    await expect(
      runRestore({ root: tmpRoot, intoCircle: 'nope' }, { db, api, upload }),
    ).rejects.toThrow(/--into-circle target nope/);
    expect(uploaded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('restore scope', () => {
  it('never restores quarantined items, and restores trashed ones only with --include trashed', async () => {
    seed({ id: 'present-1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });
    seed({
      id: 'trashed-1',
      circleId: 'src',
      circleName: 'Family',
      fileName: 'T.jpg',
      status: 'trashed',
    });
    seed({
      id: 'quarantined-1',
      circleId: 'src',
      circleName: 'Family',
      fileName: 'Q.jpg',
      status: 'quarantined',
    });
    seed({
      id: 'failed-1',
      circleId: 'src',
      circleName: 'Family',
      fileName: 'F.jpg',
      status: 'failed',
    });

    // Default scope: present only. The same server (shared knownMediaIds)
    // serves both runs, so the second one skips what the first restored.
    const known = new Set<string>();
    const first = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
      knownMediaIds: known,
    });
    const firstUpload = makeUpload();
    const defaultSummary = await runRestore(
      { root: tmpRoot },
      { db, api: first.api, upload: firstUpload.upload },
    );
    expect(firstUpload.uploaded).toEqual(['A.jpg']);
    expect(defaultSummary.plan.totalItems).toBe(1);

    // --include trashed: the trashed row is restored too, as an ACTIVE item —
    // it must NOT be archived or otherwise hidden, since no public API can put
    // an item back into the server's Trash.
    const second = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
      knownMediaIds: known,
    });
    const secondUpload = makeUpload();
    const summary = await runRestore(
      { root: tmpRoot, includeTrashed: true },
      { db, api: second.api, upload: secondUpload.upload },
    );

    expect(secondUpload.uploaded).toEqual(['T.jpg']);
    expect(summary.plan.includeTrashed).toBe(true);
    expect(summary.plan.totalItems).toBe(2);
    expect(second.calls.archives).toEqual([]);
    expect(repo.getById('trashed-1')?.restoredMediaItemId).toMatch(/^srv-/);

    // Quarantined and failed rows were never touched, in either run.
    expect(repo.getById('quarantined-1')?.restoredMediaItemId).toBeNull();
    expect(repo.getById('failed-1')?.restoredMediaItemId).toBeNull();
    expect([...firstUpload.uploaded, ...secondUpload.uploaded]).not.toContain('Q.jpg');
    expect([...firstUpload.uploaded, ...secondUpload.uploaded]).not.toContain('F.jpg');
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe('restore resume after a partial run', () => {
  it('re-runs only the items that did not finish', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });
    seed({ id: 'i2', circleId: 'src', circleName: 'Family', fileName: 'B.jpg' });
    seed({ id: 'i3', circleId: 'src', circleName: 'Family', fileName: 'C.jpg' });

    const known = new Set<string>();
    const circles: Circle[] = [{ id: 'circle-family', name: 'Family', isPersonal: false }];

    // First run dies on everything except A.jpg (concurrency 1 keeps it ordered).
    const first = makeApi({ circles: circles.slice(), knownMediaIds: known });
    const firstUpload = makeUpload((filePath) => !filePath.endsWith('A.jpg'));
    const killed = await runRestore(
      { root: tmpRoot, concurrency: 1 },
      { db, api: first.api, upload: firstUpload.upload },
    );

    expect(firstUpload.uploaded).toEqual(['A.jpg']);
    expect(killed.uploaded).toBe(1);
    expect(killed.failed).toBe(2);
    expect(resolveRestoreExitCode(killed)).toBe(1);
    expect(repo.getById('i1')?.restoredMediaItemId).toMatch(/^srv-/);
    expect(repo.getById('i2')?.restoredMediaItemId).toBeNull();
    expect(repo.getById('i3')?.restoredMediaItemId).toBeNull();

    // Second run: only the two unfinished items upload; A.jpg is verified+skipped.
    const second = makeApi({ circles: circles.slice(), knownMediaIds: known });
    const secondUpload = makeUpload();
    const resumed = await runRestore(
      { root: tmpRoot, concurrency: 1 },
      { db, api: second.api, upload: secondUpload.upload },
    );

    expect(secondUpload.uploaded.sort()).toEqual(['B.jpg', 'C.jpg']);
    expect(resumed.uploaded).toBe(2);
    expect(resumed.skippedExisting).toBe(1);
    expect(resumed.failed).toBe(0);
    expect(resolveRestoreExitCode(resumed)).toBe(0);
    for (const id of ['i1', 'i2', 'i3']) {
      expect(repo.getById(id)?.restoredMediaItemId).toMatch(/^srv-/);
    }
  });

  it('re-uploads when the recorded MediaItem no longer exists server-side', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });
    repo.setRestoredMediaItemId('i1', 'stale-id');

    // The server 404s the stale id (nothing is in knownMediaIds).
    const { api, calls } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
    });
    const { upload, uploaded } = makeUpload();

    const summary = await runRestore({ root: tmpRoot }, { db, api, upload });

    expect(calls.mediaGets).toEqual(['stale-id']);
    expect(uploaded).toEqual(['A.jpg']);
    expect(summary.uploaded).toBe(1);
    expect(repo.getById('i1')?.restoredMediaItemId).toBe('srv-1');
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('restore events', () => {
  it('emits a plan, one item-done per item, and a finished summary', async () => {
    seed({ id: 'i1', circleId: 'src', circleName: 'Family', fileName: 'A.jpg' });
    seed({ id: 'i2', circleId: 'src', circleName: 'Family', fileName: 'B.jpg' });

    const { api } = makeApi({
      circles: [{ id: 'circle-family', name: 'Family', isPersonal: false }],
    });
    const { upload } = makeUpload();

    const emitter = new RestoreEmitter();
    const events: string[] = [];
    let finished: RestoreSummary | null = null;
    emitter.on('restore-plan', () => events.push('plan'));
    emitter.on('restore-item-started', () => events.push('started'));
    emitter.on('restore-item-done', () => events.push('done'));
    emitter.on('restore-finished', (p: { summary: RestoreSummary }) => {
      events.push('finished');
      finished = p.summary;
    });

    await runRestore({ root: tmpRoot, concurrency: 1 }, { db, api, upload }, emitter);

    expect(events[0]).toBe('plan');
    expect(events.at(-1)).toBe('finished');
    expect(events.filter((e) => e === 'done')).toHaveLength(2);
    expect(events.filter((e) => e === 'started')).toHaveLength(2);
    expect(finished).not.toBeNull();
    expect((finished as unknown as RestoreSummary).uploaded).toBe(2);
  });
});
