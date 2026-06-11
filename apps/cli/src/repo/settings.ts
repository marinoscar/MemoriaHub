/**
 * repo/settings.ts — Data-access repository for the `settings` table.
 *
 * Values are stored as JSON strings so any JSON-serializable type is supported.
 * All methods are synchronous (better-sqlite3 API).
 */

import type BetterSqlite3 from 'better-sqlite3';

interface SettingsRow {
  key: string;
  value: string;
}

export class SettingsRepo {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Get a settings value, decoded from JSON.
   * Returns `fallback` if the key does not exist or the value cannot be parsed.
   */
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare<[string], SettingsRow>('SELECT value FROM settings WHERE key = ?')
      .get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Set a settings value (JSON-encoded).
   * Inserts a new row or replaces the existing one.
   */
  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  // ---------------------------------------------------------------------------
  // Typed convenience accessors
  // ---------------------------------------------------------------------------

  /** Maximum number of concurrent upload workers (default: 3). */
  concurrency(): number {
    return this.get<number>('concurrency', 3);
  }

  /** Maximum number of upload attempts before a file is considered blocked (default: 5). */
  attemptsCap(): number {
    return this.get<number>('attempts_cap', 5);
  }

  /** Whether the legacy manifest import has been completed. */
  schemaImportedManifests(): boolean {
    return this.get<boolean>('schema_imported_manifests', false);
  }
}
