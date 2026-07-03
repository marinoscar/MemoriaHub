/**
 * test/reset.spec.ts
 *
 * Unit tests for factoryReset() in src/reset.ts.
 *
 * Strategy:
 *   - Mock os.homedir() via jest.unstable_mockModule (ESM-safe, same pattern as
 *     migrate-manifests.spec.ts) to point all path helpers at a temp directory.
 *   - Create fake files/dirs under <tmpDir>/.memoriahub/ in beforeEach.
 *   - Call factoryReset() and assert filesystem state + return value.
 *   - Restore the real HOME in afterEach; delete the tmp tree.
 *
 * Note: closeDb() inside factoryReset() is a no-op when no DB is open (the
 * singleton _instance starts as null and is never opened in these tests).
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock os.homedir() — must be declared before any dynamic import of src modules.
// ---------------------------------------------------------------------------

let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => (_fakeHome !== '' ? _fakeHome : actualOs.homedir())),
}));

// Dynamic imports AFTER mock registration so all transitive imports see the mock.
const { factoryReset } = await import('../src/reset.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the fake ~/.memoriahub directory path for the current test. */
function mhDir(): string {
  return path.join(_fakeHome, '.memoriahub');
}

/** Returns the expected config.json path. */
function configJsonPath(): string {
  return path.join(mhDir(), 'config.json');
}

/** Returns the expected DB path (without suffix). */
function dbFilePath(): string {
  return path.join(mhDir(), 'memoriahub.db');
}

/** Returns the expected manifests directory path. */
function manifestsDirPath(): string {
  return path.join(mhDir(), 'manifests');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('factoryReset', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-reset-'));
    _fakeHome = tmpDir;

    // Create the .memoriahub directory and all expected files/dirs.
    const dir = mhDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configJsonPath(), JSON.stringify({ serverUrl: 'http://test', pat: 'tok' }));
    fs.writeFileSync(dbFilePath(), '');              // fake SQLite DB
    fs.writeFileSync(dbFilePath() + '-wal', '');    // WAL sidecar
    fs.writeFileSync(dbFilePath() + '-shm', '');    // SHM sidecar
    fs.mkdirSync(manifestsDirPath(), { recursive: true });
    fs.writeFileSync(path.join(manifestsDirPath(), 'legacy.json'), '{}'); // file inside manifests
  });

  afterEach(() => {
    _fakeHome = '';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // All files present
  // -------------------------------------------------------------------------

  it('removes all expected paths when they all exist', () => {
    factoryReset();

    expect(fs.existsSync(configJsonPath())).toBe(false);
    expect(fs.existsSync(dbFilePath())).toBe(false);
    expect(fs.existsSync(dbFilePath() + '-wal')).toBe(false);
    expect(fs.existsSync(dbFilePath() + '-shm')).toBe(false);
    expect(fs.existsSync(manifestsDirPath())).toBe(false);
  });

  it('returns all removed paths in the removed array', () => {
    const { removed } = factoryReset();

    // All five targets (4 files + 1 directory) must be listed
    expect(removed).toHaveLength(5);
    expect(removed).toContain(configJsonPath());
    expect(removed).toContain(dbFilePath());
    expect(removed).toContain(dbFilePath() + '-wal');
    expect(removed).toContain(dbFilePath() + '-shm');
    expect(removed).toContain(manifestsDirPath());
  });

  it('removes the manifests directory recursively (including contents)', () => {
    const nestedFile = path.join(manifestsDirPath(), 'legacy.json');
    expect(fs.existsSync(nestedFile)).toBe(true); // sanity check

    factoryReset();

    // The whole manifests tree should be gone
    expect(fs.existsSync(manifestsDirPath())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Some files absent — should not throw
  // -------------------------------------------------------------------------

  it('does not throw when the db file is absent', () => {
    fs.rmSync(dbFilePath());

    expect(() => factoryReset()).not.toThrow();
  });

  it('does not throw when the config.json is absent', () => {
    fs.rmSync(configJsonPath());

    expect(() => factoryReset()).not.toThrow();
  });

  it('does not throw when -wal and -shm sidecars are absent', () => {
    fs.rmSync(dbFilePath() + '-wal');
    fs.rmSync(dbFilePath() + '-shm');

    expect(() => factoryReset()).not.toThrow();
  });

  it('does not throw when manifests directory is absent', () => {
    fs.rmSync(manifestsDirPath(), { recursive: true });

    expect(() => factoryReset()).not.toThrow();
  });

  it('does not throw when NO files exist at all', () => {
    // Remove everything
    fs.rmSync(mhDir(), { recursive: true });

    expect(() => factoryReset()).not.toThrow();
  });

  it('only lists the paths that actually existed in removed[]', () => {
    // Remove two of the five targets before the reset
    fs.rmSync(dbFilePath() + '-wal');
    fs.rmSync(dbFilePath() + '-shm');

    const { removed } = factoryReset();

    // Only 3 paths should be listed (config.json, db, manifests dir)
    expect(removed).toHaveLength(3);
    expect(removed).not.toContain(dbFilePath() + '-wal');
    expect(removed).not.toContain(dbFilePath() + '-shm');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('second call returns empty removed array and does not throw', () => {
    factoryReset();

    // Second call — all files already gone
    const { removed: removedSecond } = factoryReset();

    expect(removedSecond).toHaveLength(0);
  });

  it('is safe to call any number of times without throwing', () => {
    expect(() => {
      factoryReset();
      factoryReset();
      factoryReset();
    }).not.toThrow();
  });
});
