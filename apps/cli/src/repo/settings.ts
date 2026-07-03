/**
 * repo/settings.ts — Data-access repository for the `settings` table.
 *
 * Values are stored as JSON strings so any JSON-serializable type is supported.
 * All methods are synchronous (better-sqlite3 API).
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { RetryConfig } from '../http/retry.js';
import type { CooldownGateConfig } from '../http/cooldown-gate.js';

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

  // ---------------------------------------------------------------------------
  // Rate-limit / retry settings (migration 4)
  // ---------------------------------------------------------------------------

  /** Max retry attempts after the first try, per request (default: 5). */
  maxRetries(): number {
    return this.get<number>('max_retries', 5);
  }

  /** Base backoff in ms for retries (default: 500). */
  retryBaseMs(): number {
    return this.get<number>('retry_base_ms', 500);
  }

  /** Per-attempt backoff cap in ms (default: 30000). */
  retryMaxMs(): number {
    return this.get<number>('retry_max_ms', 30000);
  }

  /** Base global cooldown window in ms on a throttle trip (default: 2000). */
  rateLimitCooldownMs(): number {
    return this.get<number>('rate_limit_cooldown_ms', 2000);
  }

  /** Cooldown window ceiling in ms (default: 60000). */
  rateLimitMaxCooldownMs(): number {
    return this.get<number>('rate_limit_max_cooldown_ms', 60000);
  }

  /** Aggregate retry policy for the ApiClient. */
  retryConfig(): RetryConfig {
    return {
      maxRetries: this.maxRetries(),
      baseMs: this.retryBaseMs(),
      maxMs: this.retryMaxMs(),
    };
  }

  /** Aggregate cooldown-gate config for the ApiClient. */
  cooldownConfig(): CooldownGateConfig {
    return {
      cooldownMs: this.rateLimitCooldownMs(),
      maxCooldownMs: this.rateLimitMaxCooldownMs(),
    };
  }

  // ---------------------------------------------------------------------------
  // Update-check throttle cache (keys: update_check_last_at, update_check_latest_version)
  // ---------------------------------------------------------------------------

  /**
   * Read the cached update-check result.
   * Returns `{ lastAt: null, latestVersion: null }` when no check has been run yet.
   */
  getUpdateCheckCache(): { lastAt: string | null; latestVersion: string | null } {
    return {
      lastAt: this.get<string | null>('update_check_last_at', null),
      latestVersion: this.get<string | null>('update_check_latest_version', null),
    };
  }

  /**
   * Persist the result of a successful update check.
   * Stamps `update_check_last_at` with the current ISO 8601 timestamp.
   */
  setUpdateCheckCache(latestVersion: string): void {
    this.set('update_check_last_at', new Date().toISOString());
    this.set('update_check_latest_version', latestVersion);
  }
}
