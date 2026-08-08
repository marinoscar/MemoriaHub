/**
 * Guard tests for the DB-gated-suite probe (issue #288).
 *
 * Two things are worth protecting here, and neither is "does TCP work":
 *
 *  1. `resolveDbProbeTarget` must return null when NOTHING is configured, so
 *     the probe short-circuits instead of spawning a subprocess on every plain
 *     unit-test run.
 *  2. `isDatabaseReachable` must return false — never throw — for anything
 *     unreachable. A probe that throws fails the whole spec file instead of
 *     skipping it, which is the same class of dishonest result (a red that
 *     isn't a real failure) as the vacuous green this helper exists to
 *     prevent.
 *
 * There is also a static check that no spec has reintroduced the
 * `skipIfNoDb`-style per-test guard, since that pattern is what manufactured
 * the false passes in the first place and it reads as reasonable enough to be
 * copied again.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { isDatabaseReachable, resolveDbProbeTarget } from './db-probe.helper';

describe('db-probe.helper', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('resolveDbProbeTarget', () => {
    it('returns null when neither DATABASE_URL nor POSTGRES_HOST is set', () => {
      delete process.env['DATABASE_URL'];
      delete process.env['POSTGRES_HOST'];
      expect(resolveDbProbeTarget()).toBeNull();
    });

    it('prefers DATABASE_URL and parses host/port out of it', () => {
      process.env['DATABASE_URL'] = 'postgresql://u:p@db.example.test:5433/appdb';
      process.env['POSTGRES_HOST'] = 'ignored.example.test';
      expect(resolveDbProbeTarget()).toEqual({ host: 'db.example.test', port: 5433 });
    });

    it('defaults the port to 5432 when DATABASE_URL omits it', () => {
      process.env['DATABASE_URL'] = 'postgresql://u:p@db.example.test/appdb';
      expect(resolveDbProbeTarget()).toEqual({ host: 'db.example.test', port: 5432 });
    });

    it('returns null for an unparseable DATABASE_URL rather than throwing', () => {
      process.env['DATABASE_URL'] = 'not a url';
      expect(resolveDbProbeTarget()).toBeNull();
    });

    it('falls back to the discrete POSTGRES_* variables', () => {
      delete process.env['DATABASE_URL'];
      process.env['POSTGRES_HOST'] = 'pg.example.test';
      process.env['POSTGRES_PORT'] = '6543';
      expect(resolveDbProbeTarget()).toEqual({ host: 'pg.example.test', port: 6543 });
    });
  });

  describe('isDatabaseReachable', () => {
    it('returns false (does not throw) when no database is configured', () => {
      delete process.env['DATABASE_URL'];
      delete process.env['POSTGRES_HOST'];
      expect(isDatabaseReachable()).toBe(false);
    });

    it('returns false (does not throw) for a port with nothing listening', () => {
      delete process.env['DATABASE_URL'];
      process.env['POSTGRES_HOST'] = '127.0.0.1';
      // Port 1 is privileged and never serves Postgres — connect is refused.
      process.env['POSTGRES_PORT'] = '1';
      expect(isDatabaseReachable(500)).toBe(false);
    });

    it('returns false (does not throw) for an unroutable address, via the timeout path', () => {
      delete process.env['DATABASE_URL'];
      // TEST-NET-1 (RFC 5737) is reserved for documentation and never routes,
      // so this exercises the timeout branch rather than the refused branch.
      process.env['POSTGRES_HOST'] = '192.0.2.1';
      process.env['POSTGRES_PORT'] = '5432';
      expect(isDatabaseReachable(500)).toBe(false);
    });
  });

  describe('no spec reintroduces a per-test DB guard', () => {
    it('has no `skipIfNoDb`-style wrapper anywhere under test/', () => {
      // The wrapper's body was `expect(true).toBe(true); return;`, which Jest
      // reports as a genuine PASS — so a suite using it reports green while
      // asserting nothing. With a module-load `describe.skip` gate there is
      // nothing left for such a wrapper to do; its only remaining effect
      // would be to manufacture false passes again.
      //
      // Matches a CALL or DEFINITION (`skipIfNoDb(`), not the bare name, so
      // prose that explains the history — this file's header, the helper's
      // docs, migration-backfill's header — doesn't trip the guard.
      const usagePattern = /skipIfNoDb\s*\(/;
      const testRoot = join(__dirname, '..');
      const offenders: string[] = [];

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (entry === 'node_modules') continue;
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          if (!full.endsWith('.ts')) continue;
          if (full === __filename) continue; // this file names it on purpose
          if (usagePattern.test(readFileSync(full, 'utf8'))) {
            offenders.push(full.slice(testRoot.length + 1));
          }
        }
      };
      walk(testRoot);

      expect(offenders).toEqual([]);
    });
  });
});
