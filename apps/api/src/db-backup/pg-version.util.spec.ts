/**
 * pg-version.util specs (issue #364, epic #339).
 *
 * Three layers, tested separately:
 *   1. Pure parsing/comparison (`parsePgVersionMajor`, `readServerMajor`,
 *      `compareClientToServer`) — plain input/output, no seams needed.
 *   2. `readPgClientMajor`'s memoised probe, driven through `pg-dump.util.ts`'s
 *      `__setSpawnForTests` seam — the same seam `pg-dump.util.spec.ts` uses,
 *      because the probe is implemented on top of that module's
 *      `spawnPgProcess`, not a second spawn wrapper.
 *
 * `__resetPgVersionCacheForTests()` runs in every `readPgClientMajor` test's
 * `beforeEach` so the memo (keyed by resolved binary path, module-global for
 * the lifetime of this file) never lets one test's answer leak into the next.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { __setSpawnForTests } from './pg-dump.util';
import {
  __resetPgVersionCacheForTests,
  compareClientToServer,
  parsePgVersionMajor,
  readPgClientMajor,
  readServerMajor,
} from './pg-version.util';

/**
 * Minimal ChildProcess stand-in, matching `pg-dump.util.spec.ts`'s helper: an
 * EventEmitter with real streams, so `readPgClientMajor`'s stdout collection
 * and close handling run for real rather than being stubbed away.
 */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: jest.Mock;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = jest.fn();
  return child;
}

describe('pg-version.util', () => {
  // ---------------------------------------------------------------------
  // parsePgVersionMajor
  // ---------------------------------------------------------------------

  describe('parsePgVersionMajor', () => {
    it('reads the major from plain pg_dump output', () => {
      expect(parsePgVersionMajor('pg_dump (PostgreSQL) 17.10')).toBe(17);
    });

    it('reads the major from pg_restore output', () => {
      expect(parsePgVersionMajor('pg_restore (PostgreSQL) 16.4')).toBe(16);
    });

    it('reads a pre-release major with no dot (18beta1)', () => {
      expect(parsePgVersionMajor('pg_dump (PostgreSQL) 18beta1')).toBe(18);
    });

    it('extracts 17 — not 13, not 1 — from PGDG packaging output; this is the highest-value case, exactly why the regex is anchored on the literal (PostgreSQL) marker rather than "first number in the string"', () => {
      const result = parsePgVersionMajor(
        'pg_dump (PostgreSQL) 17.10 (Debian 17.10-1.pgdg13+1)',
      );
      expect(result).toBe(17);
      expect(result).not.toBe(13);
      expect(result).not.toBe(1);
    });

    it('returns null for an empty string', () => {
      expect(parsePgVersionMajor('')).toBeNull();
    });

    it('returns null for garbage input', () => {
      expect(parsePgVersionMajor('garbage')).toBeNull();
    });

    it('returns null for a string with a number but no (PostgreSQL) marker', () => {
      expect(parsePgVersionMajor('pg_dump version 17.10')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // readServerMajor
  // ---------------------------------------------------------------------

  describe('readServerMajor', () => {
    it('170010 -> 17', () => {
      expect(readServerMajor(170010)).toBe(17);
    });

    it('160004 -> 16', () => {
      expect(readServerMajor(160004)).toBe(16);
    });

    it('null -> null', () => {
      expect(readServerMajor(null)).toBeNull();
    });

    it('0 -> null (a zero major is meaningless, not a real server)', () => {
      expect(readServerMajor(0)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // compareClientToServer
  // ---------------------------------------------------------------------

  describe('compareClientToServer', () => {
    it('client == server -> ok', () => {
      expect(compareClientToServer(17, 17)).toBe('ok');
    });

    it('client newer than server -> ok', () => {
      expect(compareClientToServer(18, 17)).toBe('ok');
    });

    it('client older than server -> client_older', () => {
      expect(compareClientToServer(16, 17)).toBe('client_older');
    });

    it('client unknown -> unknown', () => {
      expect(compareClientToServer(null, 17)).toBe('unknown');
    });

    it('server unknown -> unknown', () => {
      expect(compareClientToServer(17, null)).toBe('unknown');
    });

    it('both unknown -> unknown', () => {
      expect(compareClientToServer(null, null)).toBe('unknown');
    });
  });

  // ---------------------------------------------------------------------
  // readPgClientMajor (memoised probe over pg-dump.util's spawn seam)
  // ---------------------------------------------------------------------

  describe('readPgClientMajor', () => {
    beforeEach(() => {
      __resetPgVersionCacheForTests();
    });

    afterEach(() => {
      __setSpawnForTests(null);
      __resetPgVersionCacheForTests();
      delete process.env.PG_DUMP_PATH;
    });

    it('happy path: a fake child emitting version text on stdout then closing 0 resolves the major', async () => {
      __setSpawnForTests((() => {
        const child = makeFakeChild();
        setImmediate(() => {
          child.stdout.write('pg_dump (PostgreSQL) 17.10');
          child.emit('close', 0, null);
        });
        return child;
      }) as never);

      await expect(readPgClientMajor()).resolves.toBe(17);
    });

    it('resolves null on a non-zero exit', async () => {
      __setSpawnForTests((() => {
        const child = makeFakeChild();
        setImmediate(() => {
          child.emit('close', 1, null);
        });
        return child;
      }) as never);

      await expect(readPgClientMajor()).resolves.toBeNull();
    });

    it('resolves null — and never throws — when spawn fails synchronously (stdout is undefined in that case)', async () => {
      __setSpawnForTests((() => {
        throw new Error('spawn pg_dump ENOENT');
      }) as never);

      await expect(readPgClientMajor()).resolves.toBeNull();
    });

    it('resolves null for unparseable stdout', async () => {
      __setSpawnForTests((() => {
        const child = makeFakeChild();
        setImmediate(() => {
          child.stdout.write('not a version string');
          child.emit('close', 0, null);
        });
        return child;
      }) as never);

      await expect(readPgClientMajor()).resolves.toBeNull();
    });

    it('memoises: two calls for the same (default) binary spawn exactly once', async () => {
      const spawnMock = jest.fn(() => {
        const child = makeFakeChild();
        setImmediate(() => {
          child.stdout.write('pg_dump (PostgreSQL) 17.2');
          child.emit('close', 0, null);
        });
        return child;
      });
      __setSpawnForTests(spawnMock as never);

      const first = await readPgClientMajor();
      const second = await readPgClientMajor();

      expect(first).toBe(17);
      expect(second).toBe(17);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('a different `binary` argument is a separate cache key and spawns again', async () => {
      const spawnMock = jest.fn(() => {
        const child = makeFakeChild();
        setImmediate(() => {
          child.stdout.write('pg_dump (PostgreSQL) 17.2');
          child.emit('close', 0, null);
        });
        return child;
      });
      __setSpawnForTests(spawnMock as never);

      await readPgClientMajor();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await readPgClientMajor('/opt/pg17/bin/pg_dump');
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('probes with argv exactly [\'--version\']', async () => {
      const spawnMock = jest.fn((_cmd: string, _args: readonly string[]) => {
        const child = makeFakeChild();
        setImmediate(() => {
          child.stdout.write('pg_dump (PostgreSQL) 17.10');
          child.emit('close', 0, null);
        });
        return child;
      });
      __setSpawnForTests(spawnMock as never);

      await readPgClientMajor();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, args] = spawnMock.mock.calls[0];
      expect(args).toEqual(['--version']);
    });
  });
});
