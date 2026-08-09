/**
 * test/backup/catalog-db.spec.ts — Per-root catalog migration runner.
 *
 * Covers: fresh create reaches the current user_version with the full schema; a
 * reopen applies nothing; a catalog stamped with a NEWER user_version errors
 * cleanly; a non-SQLite file errors cleanly; and a seeded catalog answers
 * plain SQL (SELECT count(*) FROM items) via better-sqlite3 directly.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  CATALOG_SCHEMA_VERSION,
  CatalogOpenError,
  openCatalogDb,
  openCatalogDbFile,
  runCatalogMigrations,
} from '../../src/backup/catalog-db.js';
import { CatalogRepo } from '../../src/backup/catalog-repo.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RawDatabase = require('better-sqlite3') as typeof BetterSqlite3;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-catalog-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('catalog migrations', () => {
  it('fresh create reaches the current user_version with the full schema', () => {
    const db = openCatalogDb(tmpRoot);
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(2);
    expect(CATALOG_SCHEMA_VERSION).toBe(2);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    for (const t of ['meta', 'items', 'item_tags', 'item_albums', 'item_people', 'runs', 'checkpoint']) {
      expect(tables).toContain(t);
    }
    // WAL + foreign keys are set.
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('reopen applies nothing (idempotent, existing data preserved)', () => {
    const db1 = openCatalogDb(tmpRoot);
    db1.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('probe', 'kept');
    db1.close();

    const db2 = openCatalogDb(tmpRoot);
    expect(db2.pragma('user_version', { simple: true })).toBe(2);
    const row = db2
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get('probe');
    expect(row?.value).toBe('kept');
    db2.close();
  });

  it('errors cleanly on a catalog written by a newer CLI', () => {
    const db = openCatalogDb(tmpRoot);
    db.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => openCatalogDb(tmpRoot)).toThrow(CatalogOpenError);
    expect(() => openCatalogDb(tmpRoot)).toThrow(/schema version 3/);
    expect(() => openCatalogDb(tmpRoot)).toThrow(/Upgrade the CLI/);
  });

  it('newer-version guard also fires on a bare runCatalogMigrations call', () => {
    const raw = new RawDatabase(':memory:') as BetterSqlite3.Database;
    raw.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION + 5}`);
    expect(() => runCatalogMigrations(raw)).toThrow(CatalogOpenError);
    raw.close();
  });

  it('upgrades an existing v1 catalog to v2 in place (column added, data intact)', () => {
    // Hand-build a genuine v1 catalog: the exact v1 DDL, user_version = 1, and
    // a seeded item + dimension rows — the state a root backed up by a
    // pre-#321 CLI is in on disk.
    const filePath = path.join(tmpRoot, '.memoriahub', 'backup.db');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const v1 = new RawDatabase(filePath) as BetterSqlite3.Database;
    v1.exec(`
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE items(
  media_item_id TEXT PRIMARY KEY, circle_id TEXT NOT NULL,
  rel_path TEXT NOT NULL UNIQUE, sidecar_rel_path TEXT NOT NULL,
  captured_at TEXT, content_hash TEXT, size INTEGER, mime_type TEXT,
  server_updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','trashed','quarantined','failed')),
  archived INTEGER NOT NULL DEFAULT 0,
  downloaded_at TEXT, verified_at TEXT, last_error TEXT,
  updated_at TEXT NOT NULL);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_hash ON items(content_hash);
CREATE INDEX idx_items_captured ON items(captured_at);
CREATE TABLE item_tags(media_item_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT,
  PRIMARY KEY(media_item_id, tag));
CREATE TABLE item_albums(media_item_id TEXT NOT NULL, album_id TEXT NOT NULL, album_name TEXT,
  PRIMARY KEY(media_item_id, album_id));
CREATE TABLE item_people(media_item_id TEXT NOT NULL, person_id TEXT NOT NULL, person_name TEXT,
  PRIMARY KEY(media_item_id, person_id));
CREATE TABLE runs(id TEXT PRIMARY KEY, kind TEXT, status TEXT, started_at TEXT, finished_at TEXT,
  items_downloaded INTEGER DEFAULT 0, items_skipped INTEGER DEFAULT 0,
  bytes_downloaded INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0, last_error TEXT);
CREATE TABLE checkpoint(key TEXT PRIMARY KEY, value TEXT);
PRAGMA user_version = 1;
    `);
    v1.prepare(
      `INSERT INTO items (media_item_id, circle_id, rel_path, sidecar_rel_path,
         captured_at, content_hash, size, mime_type, server_updated_at, status,
         archived, downloaded_at, verified_at, last_error, updated_at)
       VALUES ('legacy-1','circle-1','media/2023/01/OLD.jpg','media/2023/01/OLD.jpg.json',
         '2023-01-02T03:04:05.000Z','oldhash',4242,'image/jpeg','2023-01-03T00:00:00.000Z',
         'present',0,NULL,NULL,NULL,'2023-01-03T00:00:00.000Z')`,
    ).run();
    v1.prepare("INSERT INTO item_tags VALUES ('legacy-1','beach','ai')").run();
    v1.prepare("INSERT INTO meta (key, value) VALUES ('created_at','2023-01-01T00:00:00.000Z')").run();
    expect(v1.pragma('user_version', { simple: true })).toBe(1);
    v1.close();

    // Opening it with this build applies v2 only.
    const upgraded = openCatalogDbFile(filePath);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(2);

    const columns = upgraded
      .prepare<[], { name: string }>('PRAGMA table_info(items)')
      .all()
      .map((c) => c.name);
    expect(columns).toContain('restored_media_item_id');

    const repo = new CatalogRepo(upgraded);
    const item = repo.getById('legacy-1');
    expect(item).not.toBeNull();
    expect(item?.contentHash).toBe('oldhash');
    expect(item?.size).toBe(4242);
    expect(item?.relPath).toBe('media/2023/01/OLD.jpg');
    // The new column defaults to NULL for every pre-existing row.
    expect(item?.restoredMediaItemId).toBeNull();
    expect(repo.tagsFor('legacy-1')).toEqual(['beach']);
    expect(repo.getMeta('created_at')).toBe('2023-01-01T00:00:00.000Z');

    // And it is writable + preserved across a later backup-style upsert.
    repo.setRestoredMediaItemId('legacy-1', 'server-media-1');
    repo.upsertItemWithDims(
      {
        mediaItemId: 'legacy-1',
        circleId: 'circle-1',
        relPath: 'media/2023/01/OLD.jpg',
        sidecarRelPath: 'media/2023/01/OLD.jpg.json',
        capturedAt: '2023-01-02T03:04:05.000Z',
        contentHash: 'oldhash',
        size: 4242,
        mimeType: 'image/jpeg',
        serverUpdatedAt: '2023-02-01T00:00:00.000Z',
        status: 'present',
        archived: false,
        downloadedAt: null,
        verifiedAt: null,
        lastError: null,
      },
      { tags: [{ name: 'beach', source: 'ai' }] },
    );
    expect(repo.getById('legacy-1')?.restoredMediaItemId).toBe('server-media-1');

    upgraded.close();
  });

  it('errors cleanly when the file is not a SQLite database', () => {
    const filePath = path.join(tmpRoot, 'backup.db');
    fs.writeFileSync(filePath, 'this is definitely not sqlite');
    expect(() => openCatalogDbFile(filePath)).toThrow(CatalogOpenError);
    expect(() => openCatalogDbFile(filePath)).toThrow(/corrupted or not a SQLite database/);
  });

  it('a seeded catalog answers SELECT count(*) FROM items via better-sqlite3', () => {
    const db = openCatalogDb(tmpRoot);
    const repo = new CatalogRepo(db);
    for (let i = 0; i < 3; i++) {
      repo.upsertItemWithDims(
        {
          mediaItemId: `item-${i}`,
          circleId: 'circle-1',
          relPath: `media/2024/03/IMG_000${i}.jpg`,
          sidecarRelPath: `media/2024/03/IMG_000${i}.jpg.json`,
          capturedAt: '2024-03-10T12:00:00.000Z',
          contentHash: `hash-${i}`,
          size: 100 + i,
          mimeType: 'image/jpeg',
          serverUpdatedAt: '2024-03-11T00:00:00.000Z',
          status: 'present',
          archived: false,
          downloadedAt: null,
          verifiedAt: null,
          lastError: null,
        },
        { tags: [{ name: 'beach', source: 'ai' }] },
      );
    }
    db.close();

    // Reopen the same file with better-sqlite3 directly — the catalog is a
    // plain SQLite file users can query with any client.
    const raw = new RawDatabase(
      path.join(tmpRoot, '.memoriahub', 'backup.db'),
    ) as BetterSqlite3.Database;
    const row = raw.prepare<[], { c: number }>('SELECT count(*) AS c FROM items').get();
    expect(row?.c).toBe(3);
    raw.close();
  });
});
