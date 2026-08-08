/**
 * test/backup/catalog-repo.spec.ts — Typed catalog repository.
 *
 * The load-bearing case is upsertItemWithDims' transactionality: the item row
 * and its three dimension row-sets are replaced atomically, and a failure
 * mid-transaction (a bad dim row hitting a NOT NULL constraint) rolls the
 * WHOLE write back, leaving the previous item + dimension state intact.
 */

import { openCatalogDbFile } from '../../src/backup/catalog-db.js';
import {
  CatalogRepo,
  type CatalogItem,
  type SidecarDims,
} from '../../src/backup/catalog-repo.js';
import type BetterSqlite3 from 'better-sqlite3';

let db: BetterSqlite3.Database;
let repo: CatalogRepo;

beforeEach(() => {
  db = openCatalogDbFile(':memory:');
  repo = new CatalogRepo(db);
});

afterEach(() => {
  db.close();
});

function makeItem(overrides: Partial<Omit<CatalogItem, 'updatedAt'>> = {}): Omit<CatalogItem, 'updatedAt'> {
  return {
    mediaItemId: 'item-1',
    circleId: 'circle-1',
    relPath: 'media/2024/03/IMG_0001.jpg',
    sidecarRelPath: 'media/2024/03/IMG_0001.jpg.json',
    capturedAt: '2024-03-10T12:00:00.000Z',
    contentHash: 'abc123',
    size: 1234,
    mimeType: 'image/jpeg',
    serverUpdatedAt: '2024-03-11T00:00:00.000Z',
    status: 'present',
    archived: false,
    downloadedAt: null,
    verifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

const dims: SidecarDims = {
  tags: [
    { name: 'beach', source: 'ai' },
    { name: 'family', source: 'manual' },
  ],
  albums: [{ id: 'album-1', name: 'Summer' }],
  people: [{ personId: 'person-1', name: 'Ana' }],
};

function countDim(table: string, id: string): number {
  const row = db
    .prepare<[string], { c: number }>(`SELECT count(*) AS c FROM ${table} WHERE media_item_id = ?`)
    .get(id);
  return row?.c ?? 0;
}

describe('upsertItemWithDims', () => {
  it('inserts the item row and all three dimension row-sets', () => {
    repo.upsertItemWithDims(makeItem(), dims);

    const item = repo.getById('item-1');
    expect(item).not.toBeNull();
    expect(item?.relPath).toBe('media/2024/03/IMG_0001.jpg');
    expect(item?.archived).toBe(false);
    expect(item?.updatedAt).toEqual(expect.any(String));
    expect(countDim('item_tags', 'item-1')).toBe(2);
    expect(countDim('item_albums', 'item-1')).toBe(1);
    expect(countDim('item_people', 'item-1')).toBe(1);
  });

  it('replaces the dimension row-sets wholesale on re-upsert', () => {
    repo.upsertItemWithDims(makeItem(), dims);
    repo.upsertItemWithDims(makeItem({ contentHash: 'def456' }), {
      tags: [{ name: 'mountains' }],
      albums: [],
      people: [],
    });

    expect(repo.getById('item-1')?.contentHash).toBe('def456');
    expect(countDim('item_tags', 'item-1')).toBe(1);
    const tag = db
      .prepare<[string], { tag: string; source: string | null }>(
        'SELECT tag, source FROM item_tags WHERE media_item_id = ?',
      )
      .get('item-1');
    expect(tag).toEqual({ tag: 'mountains', source: null });
    expect(countDim('item_albums', 'item-1')).toBe(0);
    expect(countDim('item_people', 'item-1')).toBe(0);
  });

  it('a failure mid-transaction leaves the OLD item + dims intact', () => {
    repo.upsertItemWithDims(makeItem(), dims);

    // The people insert runs LAST inside the transaction; a null personId
    // violates the PRIMARY KEY's implicit NOT NULL and throws after the item
    // row and the tag/album rows were already written inside the tx.
    const badDims = {
      tags: [{ name: 'new-tag' }],
      albums: [{ id: 'album-2', name: 'New' }],
      people: [{ personId: null as unknown as string, name: 'broken' }],
    };

    expect(() =>
      repo.upsertItemWithDims(makeItem({ contentHash: 'SHOULD-NOT-PERSIST' }), badDims),
    ).toThrow();

    // Everything rolled back to the previous state.
    expect(repo.getById('item-1')?.contentHash).toBe('abc123');
    expect(countDim('item_tags', 'item-1')).toBe(2);
    const tags = db
      .prepare<[string], { tag: string }>(
        'SELECT tag FROM item_tags WHERE media_item_id = ? ORDER BY tag',
      )
      .all('item-1')
      .map((r) => r.tag);
    expect(tags).toEqual(['beach', 'family']);
    expect(countDim('item_albums', 'item-1')).toBe(1);
    expect(countDim('item_people', 'item-1')).toBe(1);
  });
});

describe('lookups and status', () => {
  beforeEach(() => {
    repo.upsertItemWithDims(makeItem(), dims);
    repo.upsertItemWithDims(
      makeItem({
        mediaItemId: 'item-2',
        relPath: 'media/2024/04/IMG_0002.jpg',
        sidecarRelPath: 'media/2024/04/IMG_0002.jpg.json',
        size: 5000,
        status: 'failed',
        lastError: 'boom',
      }),
      {},
    );
  });

  it('getByPath / ownerOfPath resolve the claiming item', () => {
    expect(repo.getByPath('media/2024/03/IMG_0001.jpg')?.mediaItemId).toBe('item-1');
    expect(repo.getByPath('media/none.jpg')).toBeNull();
    expect(repo.ownerOfPath('media/2024/04/IMG_0002.jpg')).toBe('item-2');
    expect(repo.ownerOfPath('media/none.jpg')).toBeNull();
  });

  it('listByStatus filters and honors the limit', () => {
    expect(repo.listByStatus('present').map((i) => i.mediaItemId)).toEqual(['item-1']);
    expect(repo.listByStatus('failed')[0]?.lastError).toBe('boom');
    repo.upsertItemWithDims(
      makeItem({ mediaItemId: 'item-3', relPath: 'media/x.jpg', sidecarRelPath: 'media/x.jpg.json' }),
      {},
    );
    expect(repo.listByStatus('present', 1)).toHaveLength(1);
  });

  it('allIds iterates every id', () => {
    expect([...repo.allIds()]).toEqual(['item-1', 'item-2']);
  });

  it('setStatus updates status + lastError', () => {
    repo.setStatus('item-1', 'quarantined', 'hash mismatch');
    const item = repo.getById('item-1');
    expect(item?.status).toBe('quarantined');
    expect(item?.lastError).toBe('hash mismatch');
  });

  it('setRelPath records an archive move', () => {
    repo.setRelPath('item-1', 'archived/2024/03/IMG_0001.jpg', 'archived/2024/03/IMG_0001.jpg.json');
    const item = repo.getById('item-1');
    expect(item?.relPath).toBe('archived/2024/03/IMG_0001.jpg');
    expect(item?.sidecarRelPath).toBe('archived/2024/03/IMG_0001.jpg.json');
  });

  it('stats aggregates counts + bytes by status', () => {
    const stats = repo.stats();
    expect(stats.totalItems).toBe(2);
    expect(stats.totalBytes).toBe(6234);
    expect(stats.byStatus.present).toEqual({ count: 1, bytes: 1234 });
    expect(stats.byStatus.failed).toEqual({ count: 1, bytes: 5000 });
    expect(stats.byStatus.trashed).toEqual({ count: 0, bytes: 0 });
    expect(stats.archivedCount).toBe(0);
  });
});

describe('meta, runs, checkpoint', () => {
  it('meta set/get + setMetaIfAbsent', () => {
    repo.setMeta('server_url', 'https://a.example');
    repo.setMeta('server_url', 'https://b.example');
    expect(repo.getMeta('server_url')).toBe('https://b.example');

    repo.setMetaIfAbsent('created_at', 'first');
    repo.setMetaIfAbsent('created_at', 'second');
    expect(repo.getMeta('created_at')).toBe('first');
    expect(repo.getMeta('missing')).toBeNull();
  });

  it('recordRun upserts a run row', () => {
    repo.recordRun({
      id: 'run-1',
      kind: 'incremental',
      status: 'running',
      startedAt: '2024-03-11T00:00:00.000Z',
    });
    repo.recordRun({
      id: 'run-1',
      kind: 'incremental',
      status: 'completed',
      startedAt: '2024-03-11T00:00:00.000Z',
      finishedAt: '2024-03-11T00:05:00.000Z',
      itemsDownloaded: 10,
      itemsSkipped: 2,
      bytesDownloaded: 999,
      errorCount: 1,
      lastError: 'one failed',
    });

    const row = db
      .prepare<[], { status: string; items_downloaded: number; last_error: string }>(
        "SELECT status, items_downloaded, last_error FROM runs WHERE id = 'run-1'",
      )
      .get();
    expect(row).toEqual({ status: 'completed', items_downloaded: 10, last_error: 'one failed' });
    expect(db.prepare<[], { c: number }>('SELECT count(*) AS c FROM runs').get()?.c).toBe(1);
  });

  it('checkpoint get/set round-trips (mirrored server cursor)', () => {
    expect(repo.getCheckpoint('cursor')).toBeNull();
    repo.setCheckpoint('cursor', JSON.stringify({ updatedAt: 'x', id: 'y' }));
    expect(repo.getCheckpoint('cursor')).toBe('{"updatedAt":"x","id":"y"}');
    repo.setCheckpoint('cursor', 'v2');
    expect(repo.getCheckpoint('cursor')).toBe('v2');
  });
});
