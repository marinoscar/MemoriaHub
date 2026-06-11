import { jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';

/**
 * manifest.ts calls manifestsDir() from config.ts, which in turn calls
 * os.homedir(). We redirect that to a temp directory per-test so tests never
 * touch the real ~/.memoriahub.
 *
 * Under ESM with --experimental-vm-modules, jest.mock() does not intercept
 * static imports of built-in modules. We use jest.unstable_mockModule +
 * dynamic import to replace os.homedir before the modules under test load.
 */

let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => _fakeHome || actualOs.homedir()),
}));

// Dynamic imports AFTER jest.unstable_mockModule so the mock is applied
const { loadManifest, saveManifest } = await import('../src/manifest.js');
type Manifest = import('../src/manifest.js').Manifest;

describe('manifest read/write', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-manifest-test-'));
    _fakeHome = tmpHome;
  });

  afterEach(() => {
    _fakeHome = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('loadManifest', () => {
    it('returns a default empty manifest when no file exists', () => {
      const folderPath = '/photos/vacation';
      const manifest = loadManifest(folderPath);

      expect(manifest.folderPath).toBe(path.resolve(folderPath));
      expect(manifest.lastSyncAt).toBeNull();
      expect(manifest.files).toEqual({});
    });

    it('returns a default manifest even when the manifests directory is absent', () => {
      // Fresh tmpHome has no .memoriahub subdir at all
      const manifest = loadManifest('/some/folder');

      expect(manifest.files).toEqual({});
      expect(manifest.lastSyncAt).toBeNull();
    });
  });

  describe('saveManifest + loadManifest round-trip', () => {
    it('round-trips a manifest with files correctly', () => {
      const folderPath = '/photos/vacation';
      const original: Manifest = {
        folderPath: path.resolve(folderPath),
        lastSyncAt: '2026-06-10T12:00:00.000Z',
        files: {
          '/photos/vacation/img1.jpg': {
            sha256: 'aabbccdd',
            mediaItemId: 'media-001',
            uploadedAt: '2026-06-10T12:00:00.000Z',
            status: 'uploaded',
          },
          '/photos/vacation/img2.jpg': {
            sha256: 'eeff0011',
            mediaItemId: null,
            uploadedAt: null,
            status: 'failed',
          },
        },
      };

      saveManifest(folderPath, original);
      const loaded = loadManifest(folderPath);

      expect(loaded).toEqual(original);
    });

    it('round-trips an empty files map', () => {
      const folderPath = '/empty-folder';
      const original: Manifest = {
        folderPath: path.resolve(folderPath),
        lastSyncAt: null,
        files: {},
      };

      saveManifest(folderPath, original);
      const loaded = loadManifest(folderPath);

      expect(loaded).toEqual(original);
    });
  });

  describe('saveManifest atomicity', () => {
    it('writes via a .tmp file then renames, leaving no temp artifact', () => {
      const folderPath = '/photos/atomicity';
      const manifest: Manifest = {
        folderPath: path.resolve(folderPath),
        lastSyncAt: '2026-06-10T10:00:00.000Z',
        files: {},
      };

      saveManifest(folderPath, manifest);

      // Derive expected manifest path so we can check the filesystem
      const hash = crypto
        .createHash('sha256')
        .update(path.resolve(folderPath))
        .digest('hex');
      const manifestsDir = path.join(tmpHome, '.memoriahub', 'manifests');
      const finalPath = path.join(manifestsDir, `${hash}.json`);
      const tmpPath = `${finalPath}.tmp`;

      // Final file must exist and be valid JSON
      expect(fs.existsSync(finalPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(finalPath, 'utf-8')) as unknown;
      expect(parsed).toMatchObject({ folderPath: path.resolve(folderPath) });

      // Temp artifact must NOT remain
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });

  describe('saveManifest directory creation', () => {
    it('creates the manifests directory if it does not exist yet', () => {
      // The tmpHome starts clean — no .memoriahub at all
      const manifestsDir = path.join(tmpHome, '.memoriahub', 'manifests');
      expect(fs.existsSync(manifestsDir)).toBe(false);

      saveManifest('/any/folder', {
        folderPath: '/any/folder',
        lastSyncAt: null,
        files: {},
      });

      expect(fs.existsSync(manifestsDir)).toBe(true);
    });
  });

  describe('loadManifest with corrupted file', () => {
    it('returns an empty default manifest when JSON is malformed', () => {
      // Write a corrupt manifest file directly
      const folderPath = '/corrupt';
      const hash = crypto
        .createHash('sha256')
        .update(path.resolve(folderPath))
        .digest('hex');
      const manifestsDir = path.join(tmpHome, '.memoriahub', 'manifests');
      fs.mkdirSync(manifestsDir, { recursive: true });
      fs.writeFileSync(path.join(manifestsDir, `${hash}.json`), 'NOT JSON {{{}}}');

      const manifest = loadManifest(folderPath);

      expect(manifest.files).toEqual({});
      expect(manifest.lastSyncAt).toBeNull();
    });
  });
});
