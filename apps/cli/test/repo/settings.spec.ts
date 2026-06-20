/**
 * test/repo/settings.spec.ts
 *
 * Unit tests for SettingsRepo rate-limit accessors using an in-memory DB.
 */

import { openDb } from '../../src/db/database.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

describe('SettingsRepo rate-limit settings', () => {
  let db: BetterSqlite3.Database;
  let repo: SettingsRepo;

  beforeEach(() => {
    db = makeDb();
    repo = new SettingsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the seeded defaults', () => {
    expect(repo.maxRetries()).toBe(5);
    expect(repo.retryBaseMs()).toBe(500);
    expect(repo.retryMaxMs()).toBe(30000);
    expect(repo.rateLimitCooldownMs()).toBe(2000);
    expect(repo.rateLimitMaxCooldownMs()).toBe(60000);
  });

  it('builds a RetryConfig aggregate from current values', () => {
    repo.set('max_retries', 8);
    repo.set('retry_base_ms', 250);
    repo.set('retry_max_ms', 10000);
    expect(repo.retryConfig()).toEqual({
      maxRetries: 8,
      baseMs: 250,
      maxMs: 10000,
    });
  });

  it('builds a CooldownGateConfig aggregate from current values', () => {
    repo.set('rate_limit_cooldown_ms', 1500);
    repo.set('rate_limit_max_cooldown_ms', 45000);
    expect(repo.cooldownConfig()).toEqual({
      cooldownMs: 1500,
      maxCooldownMs: 45000,
    });
  });

  it('falls back to defaults when a key is missing', () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run('max_retries');
    expect(repo.maxRetries()).toBe(5);
  });
});
