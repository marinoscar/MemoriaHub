/**
 * test/backup/catalog-db.spec.ts — Per-root catalog migration runner.
 *
 * Covers: fresh create reaches user_version 1 with the full v1 schema; a
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
  it('fresh create reaches user_version 1 with the v1 tables', () => {
    const db = openCatalogDb(tmpRoot);
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(1);
    expect(CATALOG_SCHEMA_VERSION).toBe(1);

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
    expect(db2.pragma('user_version', { simple: true })).toBe(1);
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
    expect(() => openCatalogDb(tmpRoot)).toThrow(/schema version 2/);
    expect(() => openCatalogDb(tmpRoot)).toThrow(/Upgrade the CLI/);
  });

  it('newer-version guard also fires on a bare runCatalogMigrations call', () => {
    const raw = new RawDatabase(':memory:') as BetterSqlite3.Database;
    raw.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION + 5}`);
    expect(() => runCatalogMigrations(raw)).toThrow(CatalogOpenError);
    raw.close();
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
