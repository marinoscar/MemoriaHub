/**
 * db/database.ts — Open, configure, and manage the SQLite database singleton.
 *
 * Usage:
 *   import { getDb, closeDb } from './db/database.js';
 *   const db = getDb();          // returns the singleton, opening it on first call
 *   closeDb();                   // close (e.g. on process exit)
 *
 * For tests pass an explicit path / ':memory:' to openDb() and use the returned
 * instance directly — the singleton is bypassed.
 */

import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { dbPath } from '../paths.js';
import { runMigrations } from './migrations.js';
import { importLegacyManifests } from '../migrate-manifests.js';

// better-sqlite3 is a CommonJS module; use createRequire for ESM compatibility.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// Singleton instance (null until first getDb() call).
let _instance: BetterSqlite3.Database | null = null;

/**
 * Open (or create) the SQLite database at `dbFilePath`.
 * - Sets WAL journal mode and enables foreign keys.
 * - Runs pending migrations.
 * - Runs the legacy manifest importer (once, guarded by settings flag).
 *
 * @param dbFilePath  Override path — defaults to `~/.memoriahub/memoriahub.db`.
 *                    Pass `':memory:'` for in-memory test databases.
 */
export function openDb(dbFilePath?: string): BetterSqlite3.Database {
  const filePath = dbFilePath ?? dbPath();

  if (filePath !== ':memory:') {
    // Ensure the parent directory exists before opening.
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(filePath) as BetterSqlite3.Database;

  // Performance and integrity settings.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply schema migrations.
  runMigrations(db);

  // Run legacy manifest import exactly once (guarded inside the importer).
  importLegacyManifests(db);

  return db;
}

/**
 * Return the application-wide singleton database, opening it on first call.
 * Subsequent calls return the same instance.
 */
export function getDb(): BetterSqlite3.Database {
  if (!_instance) {
    _instance = openDb();
  }
  return _instance;
}

/**
 * Close the singleton database.  Subsequent calls to getDb() will re-open it.
 * Safe to call even if the database was never opened.
 */
export function closeDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

/**
 * Replace the singleton with an already-open database instance.
 * Intended for tests that need to inject a ':memory:' database.
 */
export function _setDbForTesting(db: BetterSqlite3.Database): void {
  if (_instance) {
    _instance.close();
  }
  _instance = db;
}
