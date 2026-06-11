/**
 * test/migrate-manifests.spec.ts
 *
 * Tests the one-time legacy manifest importer (importLegacyManifests).
 *
 * Strategy:
 *   - Override os.homedir() via jest.unstable_mockModule (ESM-safe) to point
 *     to a tmp directory so no real ~/.memoriahub is touched.
 *   - Write fake manifest JSON files into the tmp manifests directory.
 *   - Open a raw in-memory DB (runMigrations only, no importLegacyManifests).
 *   - Call importLegacyManifests(db) directly and assert the results.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Override os.homedir so paths.ts → configDir() points to our tmp dir.
// Must be done BEFORE any dynamic import of the src modules.
// ---------------------------------------------------------------------------
let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => _fakeHome || actualOs.homedir()),
}));

// Dynamic imports after mock registration
const { runMigrations } = await import('../src/db/migrations.js');
const { importLegacyManifests } = await import('../src/migrate-manifests.js');
const { FolderRepo } = await import('../src/repo/folders.js');
const { FileRepo } = await import('../src/repo/files.js');
const { SettingsRepo } = await import('../src/repo/settings.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Open a raw in-memory DB (no importLegacyManifests side-effect).
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RawDatabase = require('better-sqlite3') as typeof BetterSqlite3;

function openRawDb(): BetterSqlite3.Database {
  const db = new RawDatabase(':memory:') as BetterSqlite3.Database;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** sha256 of a path (mirrors the manifest filename convention) */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Write a manifest JSON file into the given manifests directory. */
function writeManifest(
  manifestsDir: string,
  folderPath: string,
  data: object,
): void {
  const hash = sha256Hex(path.resolve(folderPath));
  const dest = path.join(manifestsDir, `${hash}.json`);
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('importLegacyManifests', () => {
  let tmpHome: string;
  let manifestsDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-import-'));
    _fakeHome = tmpHome;

    // Create the manifests directory that config.manifestsDir() will return.
    manifestsDir = path.join(tmpHome, '.memoriahub', 'manifests');
    fs.mkdirSync(manifestsDir, { recursive: true });
  });

  afterEach(() => {
    _fakeHome = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // basic import
  // -------------------------------------------------------------------------

  it('imports folders and files from a single manifest', () => {
    const folderPath = '/tmp/legacy-photos';
    writeManifest(manifestsDir, folderPath, {
      folderPath,
      lastSyncAt: '2024-01-01T00:00:00.000Z',
      files: {
        '/tmp/legacy-photos/a.jpg': {
          sha256: 'aaa111',
          mediaItemId: 'media-aaa',
          uploadedAt: '2024-01-01T00:00:00.000Z',
          status: 'uploaded',
        },
        '/tmp/legacy-photos/b.jpg': {
          sha256: 'bbb222',
          mediaItemId: null,
          uploadedAt: null,
          status: 'pending',
        },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const folders = new FolderRepo(db).list();
    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe(path.resolve(folderPath));

    const files = new FileRepo(db).listByFolder(folders[0].id);
    expect(files).toHaveLength(2);

    db.close();
  });

  it('maps uploaded → uploaded status', () => {
    const folderPath = '/tmp/lm-map-uploaded';
    writeManifest(manifestsDir, folderPath, {
      folderPath,
      lastSyncAt: null,
      files: {
        '/tmp/lm-map-uploaded/photo.jpg': {
          sha256: 'abc',
          mediaItemId: 'media-1',
          uploadedAt: '2024-01-01T00:00:00.000Z',
          status: 'uploaded',
        },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const folders = new FolderRepo(db).list();
    const files = new FileRepo(db).listByFolder(folders[0].id);
    expect(files[0].status).toBe('uploaded');
    expect(files[0].sha256).toBe('abc');
    expect(files[0].media_item_id).toBe('media-1');

    db.close();
  });

  it('maps pending → queued status', () => {
    const folderPath = '/tmp/lm-map-pending';
    writeManifest(manifestsDir, folderPath, {
      folderPath,
      lastSyncAt: null,
      files: {
        '/tmp/lm-map-pending/photo.jpg': {
          sha256: 'ppp',
          mediaItemId: null,
          uploadedAt: null,
          status: 'pending',
        },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const folders = new FolderRepo(db).list();
    const files = new FileRepo(db).listByFolder(folders[0].id);
    expect(files[0].status).toBe('queued');

    db.close();
  });

  it('maps failed → failed status', () => {
    const folderPath = '/tmp/lm-map-failed';
    writeManifest(manifestsDir, folderPath, {
      folderPath,
      lastSyncAt: null,
      files: {
        '/tmp/lm-map-failed/photo.jpg': {
          sha256: 'fff',
          mediaItemId: null,
          uploadedAt: null,
          status: 'failed',
        },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const folders = new FolderRepo(db).list();
    const files = new FileRepo(db).listByFolder(folders[0].id);
    expect(files[0].status).toBe('failed');

    db.close();
  });

  it('carries sha256 and media_item_id from the manifest', () => {
    const folderPath = '/tmp/lm-carry';
    writeManifest(manifestsDir, folderPath, {
      folderPath,
      lastSyncAt: null,
      files: {
        '/tmp/lm-carry/photo.jpg': {
          sha256: 'sha256value',
          mediaItemId: 'media-xyz',
          uploadedAt: '2024-06-01T12:00:00.000Z',
          status: 'uploaded',
        },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const folders = new FolderRepo(db).list();
    const files = new FileRepo(db).listByFolder(folders[0].id);
    expect(files[0].sha256).toBe('sha256value');
    expect(files[0].media_item_id).toBe('media-xyz');
    expect(files[0].uploaded_at).toBe('2024-06-01T12:00:00.000Z');

    db.close();
  });

  it('imports multiple manifests', () => {
    writeManifest(manifestsDir, '/tmp/folder-a', {
      folderPath: '/tmp/folder-a',
      lastSyncAt: null,
      files: {
        '/tmp/folder-a/a1.jpg': { sha256: 's1', mediaItemId: null, uploadedAt: null, status: 'pending' },
      },
    });
    writeManifest(manifestsDir, '/tmp/folder-b', {
      folderPath: '/tmp/folder-b',
      lastSyncAt: null,
      files: {
        '/tmp/folder-b/b1.jpg': { sha256: 's2', mediaItemId: 'mid', uploadedAt: null, status: 'uploaded' },
        '/tmp/folder-b/b2.jpg': { sha256: 's3', mediaItemId: null, uploadedAt: null, status: 'failed' },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const folders = new FolderRepo(db).list();
    expect(folders).toHaveLength(2);

    const totalFiles = new FileRepo(db).counts().total;
    expect(totalFiles).toBe(3);

    db.close();
  });

  // -------------------------------------------------------------------------
  // guard flag
  // -------------------------------------------------------------------------

  it('sets schema_imported_manifests=true after import', () => {
    writeManifest(manifestsDir, '/tmp/lm-flag', {
      folderPath: '/tmp/lm-flag',
      lastSyncAt: null,
      files: {},
    });

    const db = openRawDb();
    importLegacyManifests(db);

    const settings = new SettingsRepo(db);
    expect(settings.schemaImportedManifests()).toBe(true);

    db.close();
  });

  it('is idempotent — second call is a no-op', () => {
    writeManifest(manifestsDir, '/tmp/lm-idem', {
      folderPath: '/tmp/lm-idem',
      lastSyncAt: null,
      files: {
        '/tmp/lm-idem/photo.jpg': {
          sha256: 'hash1',
          mediaItemId: 'media-1',
          uploadedAt: null,
          status: 'uploaded',
        },
      },
    });

    const db = openRawDb();
    importLegacyManifests(db);
    importLegacyManifests(db); // second call — should be no-op

    const folders = new FolderRepo(db).list();
    expect(folders).toHaveLength(1);
    const files = new FileRepo(db).listByFolder(folders[0].id);
    expect(files).toHaveLength(1);

    db.close();
  });

  // -------------------------------------------------------------------------
  // empty/missing manifests
  // -------------------------------------------------------------------------

  it('sets flag=true even when no manifests exist', () => {
    // manifests dir exists but is empty
    const db = openRawDb();
    importLegacyManifests(db);

    const settings = new SettingsRepo(db);
    expect(settings.schemaImportedManifests()).toBe(true);

    const folders = new FolderRepo(db).list();
    expect(folders).toHaveLength(0);

    db.close();
  });

  it('skips malformed JSON files without crashing', () => {
    // Write a bad JSON file in the manifests dir
    const badFile = path.join(manifestsDir, 'bad.json');
    fs.writeFileSync(badFile, '{ this is not json }', 'utf-8');

    const db = openRawDb();
    expect(() => importLegacyManifests(db)).not.toThrow();

    db.close();
  });
});
