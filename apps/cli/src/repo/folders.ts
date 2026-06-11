/**
 * repo/folders.ts — Data-access repository for the `folders` table.
 *
 * All methods are synchronous (better-sqlite3 API).
 * No I/O or console output here — only database operations and data mapping.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import type { Folder } from '../db/types.js';

// ---------------------------------------------------------------------------
// Row type returned from the DB (integers for booleans)
// ---------------------------------------------------------------------------

interface FolderRow {
  id: number;
  path: string;
  path_hash: string;
  recursive: number;
  enabled: number;
  added_at: string;
  last_sync_at: string | null;
}

function rowToFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    path: row.path,
    path_hash: row.path_hash,
    recursive: row.recursive !== 0,
    enabled: row.enabled !== 0,
    added_at: row.added_at,
    last_sync_at: row.last_sync_at,
  };
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// FolderRepo
// ---------------------------------------------------------------------------

export class FolderRepo {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Add a new folder to the registry.
   * Resolves the path to an absolute path and rejects duplicates.
   */
  add(opts: {
    path: string;
    recursive?: boolean;
    enabled?: boolean;
  }): Folder {
    const absPath = path.resolve(opts.path);
    const pathHash = sha256Hex(absPath);
    const now = new Date().toISOString();
    const recursive = opts.recursive ?? false;
    const enabled = opts.enabled ?? true;

    // Check for duplicate before running INSERT so we can give a clear error.
    const existing = this.db
      .prepare<[string], FolderRow>('SELECT * FROM folders WHERE path = ?')
      .get(absPath);
    if (existing) {
      throw new Error(`Folder already registered: ${absPath}`);
    }

    const info = this.db
      .prepare(
        `INSERT INTO folders (path, path_hash, recursive, enabled, added_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(absPath, pathHash, recursive ? 1 : 0, enabled ? 1 : 0, now);

    const row = this.db
      .prepare<[number], FolderRow>('SELECT * FROM folders WHERE id = ?')
      .get(info.lastInsertRowid as number);

    if (!row) throw new Error('Failed to retrieve inserted folder row');
    return rowToFolder(row);
  }

  /**
   * List all folders, optionally filtering to enabled-only.
   */
  list(opts: { enabledOnly?: boolean } = {}): Folder[] {
    const rows = opts.enabledOnly
      ? (this.db
          .prepare<[], FolderRow>('SELECT * FROM folders WHERE enabled = 1 ORDER BY id')
          .all() as FolderRow[])
      : (this.db
          .prepare<[], FolderRow>('SELECT * FROM folders ORDER BY id')
          .all() as FolderRow[]);
    return rows.map(rowToFolder);
  }

  /**
   * Get a single folder by numeric ID.  Returns null if not found.
   */
  getById(id: number): Folder | null {
    const row = this.db
      .prepare<[number], FolderRow>('SELECT * FROM folders WHERE id = ?')
      .get(id);
    return row ? rowToFolder(row) : null;
  }

  /**
   * Get a single folder by its absolute path.  Returns null if not found.
   */
  getByPath(folderPath: string): Folder | null {
    const absPath = path.resolve(folderPath);
    const row = this.db
      .prepare<[string], FolderRow>('SELECT * FROM folders WHERE path = ?')
      .get(absPath);
    return row ? rowToFolder(row) : null;
  }

  /**
   * Resolve either a numeric ID (passed as a number or a numeric string)
   * or an absolute/relative path to a Folder row.  Returns null if not found.
   */
  resolve(idOrPath: number | string): Folder | null {
    if (typeof idOrPath === 'number') {
      return this.getById(idOrPath);
    }
    const asInt = parseInt(idOrPath, 10);
    if (!isNaN(asInt) && String(asInt) === idOrPath.trim()) {
      return this.getById(asInt);
    }
    return this.getByPath(idOrPath);
  }

  /**
   * Remove a folder (and cascade-delete its files) by ID or path.
   * Returns false if the folder was not found.
   */
  remove(idOrPath: number | string): boolean {
    const folder = this.resolve(idOrPath);
    if (!folder) return false;
    const info = this.db
      .prepare('DELETE FROM folders WHERE id = ?')
      .run(folder.id);
    return info.changes > 0;
  }

  /**
   * Enable or disable a folder by ID or path.
   * Returns the updated Folder, or null if not found.
   */
  setEnabled(idOrPath: number | string, enabled: boolean): Folder | null {
    const folder = this.resolve(idOrPath);
    if (!folder) return null;
    this.db
      .prepare('UPDATE folders SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, folder.id);
    return this.getById(folder.id);
  }

  /**
   * Toggle the recursive flag for a folder.
   * Returns the updated Folder, or null if not found.
   */
  setRecursive(idOrPath: number | string, recursive: boolean): Folder | null {
    const folder = this.resolve(idOrPath);
    if (!folder) return null;
    this.db
      .prepare('UPDATE folders SET recursive = ? WHERE id = ?')
      .run(recursive ? 1 : 0, folder.id);
    return this.getById(folder.id);
  }

  /**
   * Update the last_sync_at timestamp for a folder.
   * @param id   Numeric folder ID.
   * @param iso  ISO 8601 timestamp string.
   */
  touchLastSync(id: number, iso: string): void {
    this.db
      .prepare('UPDATE folders SET last_sync_at = ? WHERE id = ?')
      .run(iso, id);
  }
}
