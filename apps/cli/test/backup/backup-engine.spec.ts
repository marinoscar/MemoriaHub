/**
 * test/backup/backup-engine.spec.ts — BackupEngine run loop (issue #316).
 *
 * Mocked ApiClient slice + a REAL per-root SQLite catalog in a temp dir.
 * Covers: the 3-page loop with cursor advance and crash-safe commit-then-ack
 * ordering, the full classification matrix (new / bytes-changed /
 * metadata-only / tombstone / archived-flip move / null-URL failure),
 * crash-before-ack replay idempotency, expired-URL page re-mint (cap 3),
 * hash-mismatch single retry then failed, download concurrency bounding,
 * dimension/manifest exports, and the 409 → RunAlreadyActiveError mapping.
 */

import { jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  ApiError,
  type BackupAckBody,
  type BackupChangeItem,
  type BackupChangesPage,
  type FinishBackupRunBody,
  type GetRawOptions,
  type GetRawResult,
} from '../../src/api.js';
import {
  BackupEngine,
  CHECKPOINT_CURSOR_KEY,
  RunAlreadyActiveError,
  type BackupApi,
  type BackupEngineOpts,
} from '../../src/backup/backup-engine.js';
import { BACKUP_EV, type ItemDonePayload } from '../../src/backup/events.js';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import { absPathFor } from '../../src/backup/layout.js';

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;

/** Build a change-feed item; `updatedAt` auto-increments for cursor ordering. */
function feedItem(over: Partial<BackupChangeItem> & { id: string }): BackupChangeItem {
  seq++;
  const updatedAt = `2024-01-05T00:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`;
  return {
    circleId: 'circle-1',
    updatedAt,
    createdAt: '2024-01-01T00:00:00.000Z',
    capturedAt: '2024-01-05T10:00:00.000Z',
    capturedAtOffset: 0,
    type: 'photo',
    deletedAt: null,
    archivedAt: null,
    contentHash: null,
    originalFilename: `${over.id}.jpg`,
    storage: { objectId: `obj-${over.id}`, size: '0', mimeType: 'image/jpeg', status: 'ready' },
    downloadUrl: `https://s3.test/${over.id}`,
    downloadUrlExpiresAt: null,
    sidecar: {
      schemaVersion: 1,
      mediaItemId: over.id,
      tags: [],
      albums: [],
      people: [],
    },
    ...over,
  };
}

/** Attach content bytes to an item: hash + size + registered URL body. */
function withContent(
  item: BackupChangeItem,
  contents: Map<string, Buffer>,
  content: Buffer,
): BackupChangeItem {
  contents.set(item.downloadUrl as string, content);
  return {
    ...item,
    contentHash: sha256(content),
    storage: { ...(item.storage as NonNullable<BackupChangeItem['storage']>), size: String(content.length) },
  };
}

/** Chain pages into a cursor-keyed map ('start' for the null cursor). */
function chainPages(pageItems: BackupChangeItem[][]): Map<string, BackupChangesPage> {
  const map = new Map<string, BackupChangesPage>();
  let key = 'start';
  for (let i = 0; i < pageItems.length; i++) {
    const items = pageItems[i] as BackupChangeItem[];
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    map.set(key, {
      items,
      nextCursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
      hasMore: i < pageItems.length - 1,
      safetyHorizon: '2024-01-05T01:00:00.000Z',
    });
    if (last) key = last.id;
  }
  return map;
}

const EMPTY_PAGE: BackupChangesPage = {
  items: [],
  nextCursor: null,
  hasMore: false,
  safetyHorizon: '2024-01-05T01:00:00.000Z',
};

interface FakeApiState {
  api: BackupApi;
  changesCalls: string[];
  acks: BackupAckBody[];
  finishes: Array<{ runId: string; body: FinishBackupRunBody }>;
  getRawCalls: Map<string, number>;
}

interface FakeApiOverrides {
  /** URLs that answer 403/AccessDenied (mutable — tests may clear it). */
  badUrls?: Set<string>;
  /** Transform a page per fetch: (page, cursorKey, nthCallForKey). */
  onChanges?: (page: BackupChangesPage, key: string, call: number) => BackupChangesPage;
  /** Per-download delay + concurrency tracker. */
  onDownloadStart?: () => Promise<void> | void;
  onDownloadEnd?: () => void;
  startRun?: () => Promise<{ run: { id: string; kind: string; startedAt: string; cursorStart: { updatedAt: string | null; id: string | null } } }>;
}

function makeApi(
  pages: Map<string, BackupChangesPage>,
  contents: Map<string, Buffer>,
  over: FakeApiOverrides = {},
): FakeApiState {
  const changesCalls: string[] = [];
  const acks: BackupAckBody[] = [];
  const finishes: Array<{ runId: string; body: FinishBackupRunBody }> = [];
  const getRawCalls = new Map<string, number>();
  const perKeyCalls = new Map<string, number>();
  let runCounter = 0;

  const api: BackupApi = {
    startNodeBackupRun: (over.startRun ??
      (async () => ({
        run: {
          id: `run-${++runCounter}`,
          kind: 'incremental',
          startedAt: '2024-01-05T00:00:00.000Z',
          cursorStart: { updatedAt: null, id: null },
        },
      }))) as BackupApi['startNodeBackupRun'],

    getNodeBackupChanges: (async (_nodeId: string, q: { cursor?: { id: string } | null }) => {
      const key = q.cursor?.id ?? 'start';
      changesCalls.push(key);
      const call = perKeyCalls.get(key) ?? 0;
      perKeyCalls.set(key, call + 1);
      const page = pages.get(key) ?? EMPTY_PAGE;
      return over.onChanges ? over.onChanges(page, key, call) : page;
    }) as BackupApi['getNodeBackupChanges'],

    ackNodeBackup: (async (_nodeId: string, body: BackupAckBody) => {
      acks.push(body);
      return { ok: true as const, checkpoint: body.cursor };
    }) as BackupApi['ackNodeBackup'],

    finishNodeBackupRun: (async (_nodeId: string, runId: string, body: FinishBackupRunBody) => {
      finishes.push({ runId, body });
      return { ok: true as const };
    }) as BackupApi['finishNodeBackupRun'],

    getNodeBackupDimensions: (async () => ({
      albums: [{ id: 'al-1', name: 'Trip', description: null, itemCount: 2, itemIds: ['a', 'b'] }],
      people: [{ id: 'p-1', name: 'Ada', favorite: false, faceCount: 3 }],
      tags: [{ name: 'beach', itemCount: 2 }],
      generatedAt: '2024-01-05T02:00:00.000Z',
    })) as BackupApi['getNodeBackupDimensions'],

    getRaw: (async (url: string, destPath: string, opts?: GetRawOptions): Promise<GetRawResult> => {
      getRawCalls.set(url, (getRawCalls.get(url) ?? 0) + 1);
      await over.onDownloadStart?.();
      try {
        const cfg = (await opts?.attempt?.()) ?? {};
        if (over.badUrls?.has(url)) {
          throw new ApiError(403, 'AccessDenied: Request has expired');
        }
        const content = contents.get(url);
        if (!content) throw new Error(`no content registered for ${url}`);
        const rangeStart = cfg.rangeStart ?? 0;
        const resumed = rangeStart > 0;
        await cfg.onResponse?.({ status: resumed ? 206 : 200, resumed });
        const body = resumed ? content.subarray(rangeStart) : content;
        await cfg.onChunk?.(Buffer.from(body));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        if (resumed) fs.appendFileSync(destPath, body);
        else fs.writeFileSync(destPath, body);
        return { status: resumed ? 206 : 200, bytesWritten: body.length };
      } finally {
        over.onDownloadEnd?.();
      }
    }) as BackupApi['getRaw'],
  };

  return { api, changesCalls, acks, finishes, getRawCalls };
}

// ---------------------------------------------------------------------------
// Engine harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let root: string;
const openDbs: BetterSqlite3.Database[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-engine-'));
  root = path.join(tmpDir, 'backup-root');
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngine(
  api: BackupApi,
  over: Partial<BackupEngineOpts> = {},
): { engine: BackupEngine; db: BetterSqlite3.Database; itemDone: ItemDonePayload[] } {
  const db = openCatalogDb(root);
  openDbs.push(db);
  const engine = new BackupEngine(
    {
      root,
      nodeId: 'node-1',
      nodeName: 'test-node',
      serverUrl: 'https://api.test',
      trigger: 'manual',
      cliVersion: '1.2.21',
      concurrency: 2,
      maxMbps: 0,
      pageSize: 2,
      pacingMs: 0,
      ...over,
    },
    { api, db, sleep: async () => {} },
  );
  const itemDone: ItemDonePayload[] = [];
  engine.on(BACKUP_EV.ITEM_DONE, (p) => itemDone.push(p));
  engine.on(BACKUP_EV.ERROR, () => {});
  return { engine, db, itemDone };
}

/** Recursively list files under root, excluding the .memoriahub state dir. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.memoriahub') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackupEngine.runBackup', () => {
  it('walks a 3-page feed with cursor advance, commit-then-ack per page', async () => {
    const contents = new Map<string, Buffer>();
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      withContent(feedItem({ id }), contents, Buffer.from(`bytes of ${id}`)),
    );
    const pages = chainPages([items.slice(0, 2), items.slice(2, 4), items.slice(4, 6)]);
    const { api, changesCalls, acks, finishes } = makeApi(pages, contents);

    const { engine, db } = makeEngine(api);
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('completed');
    expect(outcome.stats).toMatchObject({
      itemsDownloaded: 6,
      itemsSkipped: 0,
      sidecarsWritten: 6,
      errors: 0,
    });

    // Cursor advance: start → last of page1 → last of page2.
    expect(changesCalls).toEqual(['start', 'b', 'd']);
    expect(acks.map((a) => a.cursor.id)).toEqual(['b', 'd', 'f']);
    expect(acks[0]?.stats).toMatchObject({ itemsDownloaded: 2, errors: 0 });

    // Local mirrored checkpoint = final cursor.
    const repo = new CatalogRepo(db);
    expect(JSON.parse(repo.getCheckpoint(CHECKPOINT_CURSOR_KEY) as string).id).toBe('f');

    // Files + sidecars in final place; catalog rows present.
    for (const item of items) {
      const row = repo.getById(item.id);
      expect(row?.status).toBe('present');
      expect(fs.readFileSync(absPathFor(root, row?.relPath as string))).toEqual(
        contents.get(item.downloadUrl as string),
      );
      expect(fs.existsSync(absPathFor(root, row?.sidecarRelPath as string))).toBe(true);
    }

    // Server run finished as completed with final stats.
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.body.status).toBe('completed');
    expect(finishes[0]?.body.finalStats?.itemsDownloaded).toBe(6);

    // Dimension catalogs + manifest written.
    for (const f of ['albums.json', 'people.json', 'tags.json', 'manifest.json']) {
      expect(fs.existsSync(path.join(root, 'catalog', f))).toBe(true);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      serverUrl: 'https://api.test',
      nodeId: 'node-1',
      nodeName: 'test-node',
      catalogSchemaVersion: 1,
    });
    expect(manifest.checkpoint.id).toBe('f');
    expect(manifest.counts.totalItems).toBe(6);
    expect(manifest.lastRun.status).toBe('completed');
  });

  it('classifies new / bytes-changed / metadata-only / tombstone / archived-flip / null-URL', async () => {
    const contents = new Map<string, Buffer>();

    // --- Run 1: seed four items into the catalog + on disk. -----------------
    const a1 = withContent(feedItem({ id: 'a' }), contents, Buffer.from('a v1'));
    const b1 = withContent(feedItem({ id: 'b' }), contents, Buffer.from('b v1'));
    const c1 = withContent(feedItem({ id: 'c' }), contents, Buffer.from('c v1'));
    const d1 = withContent(feedItem({ id: 'd' }), contents, Buffer.from('d v1'));
    {
      const pages = chainPages([[a1, b1, c1, d1]]);
      const { api } = makeApi(pages, contents);
      const { engine } = makeEngine(api, { pageSize: 10 });
      const res = await engine.runBackup();
      expect(res.status).toBe('completed');
      expect(res.stats.itemsDownloaded).toBe(4);
    }

    // --- Run 2: one page exercising every classification branch. -----------
    const a2 = { ...a1, ...feedItem({ id: 'a' }), contentHash: a1.contentHash, storage: a1.storage };
    const b2 = withContent(feedItem({ id: 'b', downloadUrl: 'https://s3.test/b-v2' }), contents, Buffer.from('b v2 changed'));
    const c2 = { ...c1, ...feedItem({ id: 'c' }), contentHash: c1.contentHash, storage: c1.storage, deletedAt: '2024-01-06T00:00:00.000Z', downloadUrl: null };
    const d2 = { ...d1, ...feedItem({ id: 'd' }), contentHash: d1.contentHash, storage: d1.storage, archivedAt: '2024-01-06T00:00:00.000Z' };
    const e2 = withContent(feedItem({ id: 'e' }), contents, Buffer.from('e new'));
    const f2 = feedItem({ id: 'f', downloadUrl: null, contentHash: 'deadbeef' });

    const db0 = openCatalogDb(root);
    const repo0 = new CatalogRepo(db0);
    const page2Key = JSON.parse(repo0.getCheckpoint(CHECKPOINT_CURSOR_KEY) as string).id as string;
    db0.close();

    const pages = new Map<string, BackupChangesPage>();
    const page: BackupChangesPage = {
      items: [a2, b2, c2, d2, e2, f2],
      nextCursor: { updatedAt: f2.updatedAt, id: f2.id },
      hasMore: false,
      safetyHorizon: 'x',
    };
    pages.set(page2Key, page);

    const { api } = makeApi(pages, contents);
    const { engine, db, itemDone } = makeEngine(api, { pageSize: 10 });
    const outcome = await engine.runBackup();

    const outcomes = Object.fromEntries(itemDone.map((p) => [p.id, p.outcome]));
    expect(outcomes).toEqual({
      a: 'sidecar-only',
      b: 'downloaded',
      c: 'tombstone',
      d: 'moved',
      e: 'downloaded',
      f: 'failed',
    });
    expect(outcome.stats).toMatchObject({
      itemsDownloaded: 2,
      itemsSkipped: 3,
      errors: 1,
      sidecarsWritten: 5,
    });

    const repo = new CatalogRepo(db);

    // a: metadata-only — file untouched, still v1 bytes.
    const rowA = repo.getById('a');
    expect(rowA?.status).toBe('present');
    expect(fs.readFileSync(absPathFor(root, rowA?.relPath as string), 'utf8')).toBe('a v1');

    // b: bytes-changed — re-downloaded in place.
    const rowB = repo.getById('b');
    expect(rowB?.status).toBe('present');
    expect(rowB?.contentHash).toBe(b2.contentHash);
    expect(fs.readFileSync(absPathFor(root, rowB?.relPath as string), 'utf8')).toBe('b v2 changed');

    // c: tombstone — status trashed, file stays in place, sidecar rewritten.
    const rowC = repo.getById('c');
    expect(rowC?.status).toBe('trashed');
    expect(fs.existsSync(absPathFor(root, rowC?.relPath as string))).toBe(true);

    // d: archived flip — moved media/ → archived/, catalog rel_path updated.
    const rowD = repo.getById('d');
    expect(rowD?.status).toBe('present');
    expect(rowD?.archived).toBe(true);
    expect(rowD?.relPath.startsWith('archived/')).toBe(true);
    expect(fs.readFileSync(absPathFor(root, rowD?.relPath as string), 'utf8')).toBe('d v1');
    expect(fs.existsSync(absPathFor(root, (rowD?.relPath as string).replace(/^archived\//, 'media/')))).toBe(false);

    // e: new — downloaded.
    expect(repo.getById('e')?.status).toBe('present');

    // f: null URL — failed with a recorded error, run NOT blocked.
    const rowF = repo.getById('f');
    expect(rowF?.status).toBe('failed');
    expect(rowF?.lastError).toMatch(/no download URL/);
    expect(outcome.status).toBe('completed');
  });

  it('replays a page idempotently after a crash-before-ack (no duplicate files)', async () => {
    const contents = new Map<string, Buffer>();
    const items = ['a', 'b', 'c', 'd'].map((id) =>
      withContent(feedItem({ id }), contents, Buffer.from(`bytes ${id}`)),
    );
    const pages = chainPages([items.slice(0, 2), items.slice(2, 4)]);

    // Full first run.
    {
      const { api } = makeApi(pages, contents);
      const { engine } = makeEngine(api);
      expect((await engine.runBackup()).status).toBe('completed');
    }
    const filesAfterRun1 = listFiles(root).sort();
    const rowCount = (): number => {
      const db = openCatalogDb(root);
      const n = new CatalogRepo(db).stats().totalItems;
      db.close();
      return n;
    };
    expect(rowCount()).toBe(4);

    // Simulate a crash BEFORE page 2's local commit + ack: rewind the local
    // checkpoint to page 1's cursor. Page 2 must be re-fetched and
    // re-processed — idempotently.
    {
      const db = openCatalogDb(root);
      new CatalogRepo(db).setCheckpoint(
        CHECKPOINT_CURSOR_KEY,
        JSON.stringify({ updatedAt: (items[1] as BackupChangeItem).updatedAt, id: 'b' }),
      );
      db.close();
    }

    const { api, changesCalls, acks } = makeApi(pages, contents);
    const { engine, itemDone } = makeEngine(api);
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('completed');
    // Page 2 was re-fetched from the rewound cursor…
    expect(changesCalls[0]).toBe('b');
    // …and re-processed as up-to-date (bytes already on disk, hashes equal).
    expect(itemDone.map((p) => p.outcome)).toEqual(['sidecar-only', 'sidecar-only']);
    expect(outcome.stats).toMatchObject({ itemsDownloaded: 0, itemsSkipped: 2, errors: 0 });
    // The ack re-advanced the server cursor to the same place.
    expect(acks.map((a) => a.cursor.id)).toEqual(['d']);
    // No duplicate files, no duplicate rows.
    expect(listFiles(root).sort()).toEqual(filesAfterRun1);
    expect(rowCount()).toBe(4);
  });

  it('re-fetches the SAME page to re-mint expired presigned URLs', async () => {
    const contents = new Map<string, Buffer>();
    const good = withContent(feedItem({ id: 'ok' }), contents, Buffer.from('fine'));
    const expiring = withContent(feedItem({ id: 'exp' }), contents, Buffer.from('slow one'));
    const badUrls = new Set<string>([expiring.downloadUrl as string]);

    const pages = chainPages([[good, expiring]]);
    const freshUrl = 'https://s3.test/exp-reminted';
    contents.set(freshUrl, Buffer.from('slow one'));

    const { api, changesCalls } = makeApi(pages, contents, {
      badUrls,
      onChanges: (page, key, call) => {
        if (key !== 'start' || call === 0) return page;
        // The re-fetch re-mints: same items, fresh URL for the expired one.
        return {
          ...page,
          items: page.items.map((i) => (i.id === 'exp' ? { ...i, downloadUrl: freshUrl } : i)),
        };
      },
    });

    const { engine, itemDone } = makeEngine(api, { pageSize: 10 });
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('completed');
    expect(changesCalls).toEqual(['start', 'start']); // one re-mint fetch
    const byId = Object.fromEntries(itemDone.map((p) => [p.id, p.outcome]));
    expect(byId).toEqual({ ok: 'downloaded', exp: 'downloaded' });
    expect(outcome.stats).toMatchObject({ itemsDownloaded: 2, errors: 0 });
  });

  it('caps page re-mints at 3, then fails the remaining items without blocking', async () => {
    const contents = new Map<string, Buffer>();
    const good = withContent(feedItem({ id: 'ok' }), contents, Buffer.from('fine'));
    const doomed = withContent(feedItem({ id: 'doom' }), contents, Buffer.from('never'));
    const badUrls = new Set<string>([doomed.downloadUrl as string]);

    const pages = chainPages([[good, doomed]]);
    const { api, changesCalls } = makeApi(pages, contents, { badUrls });

    const { engine, itemDone } = makeEngine(api, { pageSize: 10 });
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('completed');
    // 1 initial fetch + 3 re-mint fetches.
    expect(changesCalls).toEqual(['start', 'start', 'start', 'start']);
    const doomDone = itemDone.find((p) => p.id === 'doom');
    expect(doomDone?.outcome).toBe('failed');
    expect(doomDone?.error).toMatch(/re-mint cap/);
    expect(outcome.stats).toMatchObject({ itemsDownloaded: 1, errors: 1 });

    const db = openCatalogDb(root);
    const row = new CatalogRepo(db).getById('doom');
    db.close();
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/expired/);
  });

  it('retries a hash mismatch exactly once, then marks the item failed', async () => {
    const contents = new Map<string, Buffer>();
    const item = withContent(feedItem({ id: 'bad' }), contents, Buffer.from('expected bytes'));
    // Serve DIFFERENT bytes than the advertised hash, every time.
    contents.set(item.downloadUrl as string, Buffer.from('corrupt bytes'));

    const pages = chainPages([[item]]);
    const { api, getRawCalls } = makeApi(pages, contents);
    const { engine, itemDone } = makeEngine(api, { pageSize: 10 });
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('completed');
    expect(getRawCalls.get(item.downloadUrl as string)).toBe(2); // initial + ONE retry
    expect(itemDone[0]?.outcome).toBe('failed');
    expect(itemDone[0]?.error).toMatch(/sha256/);

    const db = openCatalogDb(root);
    const row = new CatalogRepo(db).getById('bad');
    db.close();
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/sha256/);
  });

  it('bounds concurrent downloads to the configured pool size', async () => {
    const contents = new Map<string, Buffer>();
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      withContent(feedItem({ id }), contents, Buffer.from(`bytes ${id}`)),
    );
    let active = 0;
    let maxActive = 0;
    const pages = chainPages([items]);
    const { api } = makeApi(pages, contents, {
      onDownloadStart: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
      },
      onDownloadEnd: () => {
        active--;
      },
    });

    const { engine } = makeEngine(api, { pageSize: 10, concurrency: 2 });
    const outcome = await engine.runBackup();

    expect(outcome.stats.itemsDownloaded).toBe(6);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // the pool did actually parallelize
  });

  it('maps a 409 on run start to RunAlreadyActiveError with the active run id', async () => {
    const { api } = makeApi(new Map(), new Map(), {
      startRun: async () => {
        throw new ApiError(409, 'a backup run is already active for this node', null, false, {
          message: 'a backup run is already active for this node',
          activeRunId: 'run-elsewhere',
        });
      },
    });

    const { engine } = makeEngine(api);
    const err = await engine.runBackup().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAlreadyActiveError);
    expect((err as RunAlreadyActiveError).activeRunId).toBe('run-elsewhere');
  });

  it('finishes the run failed (best-effort) when the feed itself breaks', async () => {
    const { api, finishes } = makeApi(new Map(), new Map());
    (api as { getNodeBackupChanges: unknown }).getNodeBackupChanges = jest.fn(async () => {
      throw new ApiError(500, 'boom');
    });

    const { engine } = makeEngine(api);
    const outcome = await engine.runBackup();

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/boom/);
    expect(finishes[0]?.body.status).toBe('failed');
    expect(finishes[0]?.body.error).toMatch(/boom/);
  });
});
