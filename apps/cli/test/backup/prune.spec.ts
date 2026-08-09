/**
 * test/backup/prune.spec.ts — quarantine listing + prune (issue #320).
 *
 * REAL catalog + REAL files in a temp dir. The load-bearing property here is
 * the ASYMMETRY between the two functions: listQuarantined never touches the
 * filesystem (it is the dry run), and pruneQuarantine is the ONLY code path in
 * the whole backup feature that unlinks quarantined bytes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openCatalogDb } from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';
import { absPathFor } from '../../src/backup/layout.js';
import { listQuarantined, pruneQuarantine } from '../../src/backup/reconcile.js';

let tmpDir: string;
let root: string;
let db: BetterSqlite3.Database;
let repo: CatalogRepo;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-prune-'));
  root = path.join(tmpDir, 'backup-root');
  db = openCatalogDb(root);
  repo = new CatalogRepo(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Seed a quarantined row + its files. `updatedAt` (the quarantine timestamp
 * --older-than filters on) is back-dated with a direct UPDATE, since the repo
 * always stamps now().
 */
function seedQuarantined(id: string, content: Buffer, quarantinedAt?: string): string {
  const relPath = `_quarantine/media/2024/02/${id}.jpg`;
  const abs = absPathFor(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.writeFileSync(`${abs}.json`, JSON.stringify({ schemaVersion: 1, mediaItemId: id }));

  repo.upsertItemWithDims(
    {
      mediaItemId: id,
      circleId: 'circle-1',
      relPath,
      sidecarRelPath: `${relPath}.json`,
      capturedAt: null,
      contentHash: null,
      size: content.length,
      mimeType: 'image/jpeg',
      serverUpdatedAt: '2024-02-01T00:00:00.000Z',
      status: 'quarantined',
      archived: false,
      downloadedAt: '2024-02-01T00:00:00.000Z',
      verifiedAt: null,
      lastError: 'quarantined by reconcile run run-1: absent from server manifest',
    },
    { tags: [{ name: 'beach' }] },
  );

  if (quarantinedAt) {
    db.prepare('UPDATE items SET updated_at = ? WHERE media_item_id = ?').run(quarantinedAt, id);
  }
  return relPath;
}

/** Seed a normal, live item that prune must never touch. */
function seedPresent(id: string, content: Buffer): string {
  const relPath = `media/2024/02/${id}.jpg`;
  const abs = absPathFor(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  repo.upsertItemWithDims(
    {
      mediaItemId: id,
      circleId: 'circle-1',
      relPath,
      sidecarRelPath: `${relPath}.json`,
      capturedAt: null,
      contentHash: null,
      size: content.length,
      mimeType: 'image/jpeg',
      serverUpdatedAt: '2024-02-01T00:00:00.000Z',
      status: 'present',
      archived: false,
      downloadedAt: '2024-02-01T00:00:00.000Z',
      verifiedAt: null,
      lastError: null,
    },
    {},
  );
  return relPath;
}

// ---------------------------------------------------------------------------
// listQuarantined (the dry run)
// ---------------------------------------------------------------------------

describe('listQuarantined', () => {
  it('lists quarantined rows with sizes and touches nothing on disk', () => {
    const relA = seedQuarantined('q-a', Buffer.from('aaaa'));
    const relB = seedQuarantined('q-b', Buffer.from('bbbbbb'));
    seedPresent('live-1', Buffer.from('live'));

    const entries = listQuarantined(db);
    expect(entries.map((e) => e.mediaItemId).sort()).toEqual(['q-a', 'q-b']);
    expect(entries.reduce((sum, e) => sum + (e.size ?? 0), 0)).toBe(10);
    expect(entries[0]!.lastError).toMatch(/absent from server manifest/);

    // Dry run: every file is still there.
    expect(fs.existsSync(absPathFor(root, relA))).toBe(true);
    expect(fs.existsSync(absPathFor(root, relB))).toBe(true);
    expect(fs.existsSync(`${absPathFor(root, relA)}.json`)).toBe(true);
  });

  it('excludes live items entirely', () => {
    seedPresent('live-only', Buffer.from('x'));
    expect(listQuarantined(db)).toEqual([]);
  });

  it('--older-than filters on the quarantine timestamp', () => {
    const now = new Date('2024-03-15T00:00:00.000Z');
    seedQuarantined('old-1', Buffer.from('old'), '2024-02-01T00:00:00.000Z'); // 43 days
    seedQuarantined('recent-1', Buffer.from('new'), '2024-03-14T00:00:00.000Z'); // 1 day

    expect(listQuarantined(db, undefined, now).map((e) => e.mediaItemId).sort()).toEqual([
      'old-1',
      'recent-1',
    ]);
    expect(listQuarantined(db, 30, now).map((e) => e.mediaItemId)).toEqual(['old-1']);
    expect(listQuarantined(db, 60, now)).toEqual([]);
    expect(listQuarantined(db, 0, now).map((e) => e.mediaItemId).sort()).toEqual([
      'old-1',
      'recent-1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// pruneQuarantine (the only deleting path)
// ---------------------------------------------------------------------------

describe('pruneQuarantine', () => {
  it('deletes files, sidecars, and catalog rows, and reports bytes freed', () => {
    const relA = seedQuarantined('p-a', Buffer.from('aaaa'));
    const relB = seedQuarantined('p-b', Buffer.from('bbbbbb'));
    const liveRel = seedPresent('live-2', Buffer.from('untouched'));

    const result = pruneQuarantine(root, db, listQuarantined(db));

    expect(result.deleted.map((e) => e.mediaItemId).sort()).toEqual(['p-a', 'p-b']);
    expect(result.bytesFreed).toBe(10);

    expect(fs.existsSync(absPathFor(root, relA))).toBe(false);
    expect(fs.existsSync(`${absPathFor(root, relA)}.json`)).toBe(false);
    expect(fs.existsSync(absPathFor(root, relB))).toBe(false);

    expect(repo.getById('p-a')).toBeNull();
    expect(repo.getById('p-b')).toBeNull();

    // Dimension rows go with the item.
    const tagRows = db
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM item_tags WHERE media_item_id = ?',
      )
      .get('p-a');
    expect(tagRows!.c).toBe(0);

    // The live item is completely untouched.
    expect(fs.existsSync(absPathFor(root, liveRel))).toBe(true);
    expect(repo.getById('live-2')!.status).toBe('present');
  });

  it('prunes only the entries it is handed (--older-than composes)', () => {
    const now = new Date('2024-03-15T00:00:00.000Z');
    const oldRel = seedQuarantined('o-1', Buffer.from('old'), '2024-01-01T00:00:00.000Z');
    const newRel = seedQuarantined('n-1', Buffer.from('new'), '2024-03-14T00:00:00.000Z');

    const result = pruneQuarantine(root, db, listQuarantined(db, 30, now));

    expect(result.deleted.map((e) => e.mediaItemId)).toEqual(['o-1']);
    expect(fs.existsSync(absPathFor(root, oldRel))).toBe(false);
    expect(fs.existsSync(absPathFor(root, newRel))).toBe(true);
    expect(repo.getById('n-1')!.status).toBe('quarantined');
  });

  it('is a no-op for an empty selection', () => {
    const relA = seedQuarantined('keep-1', Buffer.from('bytes'));
    const result = pruneQuarantine(root, db, []);
    expect(result).toEqual({ deleted: [], bytesFreed: 0 });
    expect(fs.existsSync(absPathFor(root, relA))).toBe(true);
    expect(repo.getById('keep-1')).not.toBeNull();
  });

  it('still removes the catalog row when the file is already gone', () => {
    const relPath = seedQuarantined('half-gone', Buffer.from('bytes'));
    fs.rmSync(absPathFor(root, relPath));

    const result = pruneQuarantine(root, db, listQuarantined(db));
    expect(result.deleted).toHaveLength(1);
    expect(repo.getById('half-gone')).toBeNull();
  });
});
