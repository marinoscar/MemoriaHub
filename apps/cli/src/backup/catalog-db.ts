/**
 * backup/catalog-db.ts — Per-root SQLite backup catalog (issue #314, epic #308).
 *
 * Each backup root carries its OWN catalog at <root>/.memoriahub/backup.db —
 * deliberately NOT the central ~/.memoriahub/memoriahub.db — so the catalog
 * travels with the folder (an external drive plugged into another machine
 * brings its full backup state along). It is a plain SQLite file users can
 * query directly with any sqlite3 client.
 *
 * Own PRAGMA user_version migration runner, copied from the pattern in
 * src/db/migrations.ts: each migration is a synchronous function; all pending
 * migrations apply in one transaction, then user_version is bumped. A catalog
 * written by a NEWER CLI (user_version above what this build knows) errors
 * cleanly instead of being half-understood.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { CATALOG_DB_REL_PATH, absPathFor } from './layout.js';

// better-sqlite3 is a CommonJS module; use createRequire for ESM compatibility.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof BetterSqlite3;

/** Highest catalog schema version this build understands. */
export const CATALOG_SCHEMA_VERSION = 1;

/** Thrown when the catalog was written by a newer CLI, or is not a SQLite file. */
export class CatalogOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogOpenError';
  }
}

// ---------------------------------------------------------------------------
// v1 DDL
// ---------------------------------------------------------------------------

const DDL_V1 = `
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
`;

interface CatalogMigration {
  version: number;
  up: (db: BetterSqlite3.Database) => void;
}

const MIGRATIONS: CatalogMigration[] = [
  {
    version: 1,
    up(db: BetterSqlite3.Database): void {
      db.exec(DDL_V1);
    },
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply pending catalog migrations. Errors cleanly (CatalogOpenError) when the
 * stored user_version exceeds what this build understands.
 */
export function runCatalogMigrations(db: BetterSqlite3.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current > CATALOG_SCHEMA_VERSION) {
    throw new CatalogOpenError(
      `This backup catalog uses schema version ${current}, but this CLI only ` +
        `understands up to version ${CATALOG_SCHEMA_VERSION}. Upgrade the CLI ` +
        '(npm i -g @memoriahub/cli) to use this backup root.',
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
    }
    const next = pending[pending.length - 1]!.version;
    // PRAGMA user_version cannot be parameterized — literal value required.
    db.exec(`PRAGMA user_version = ${next}`);
  });

  applyAll();
}

// ---------------------------------------------------------------------------
// Open helpers
// ---------------------------------------------------------------------------

/**
 * Open (or create) a catalog database at an explicit file path (or ':memory:'
 * for tests): WAL mode, foreign keys ON, migrations applied. A file that is
 * not a SQLite database (corrupted / foreign) fails with CatalogOpenError.
 */
export function openCatalogDbFile(filePath: string): BetterSqlite3.Database {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath) as BetterSqlite3.Database;
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runCatalogMigrations(db);
  } catch (err) {
    db.close();
    if (err instanceof CatalogOpenError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CatalogOpenError(
      `Could not open backup catalog at ${filePath}: ${msg}. ` +
        'The file may be corrupted or not a SQLite database.',
    );
  }
  return db;
}

/** Open (or create) the catalog for a backup root (<root>/.memoriahub/backup.db). */
export function openCatalogDb(root: string): BetterSqlite3.Database {
  return openCatalogDbFile(absPathFor(root, CATALOG_DB_REL_PATH));
}
