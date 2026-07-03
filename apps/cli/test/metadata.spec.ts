/**
 * test/metadata.spec.ts
 *
 * Unit tests for readMediaMetadata() — the scan engine's per-file metadata
 * reader.  Verifies it never throws/rejects, correctly classifies videos
 * without invoking exifr, extracts real EXIF+GPS data from a known fixture,
 * and gracefully reports `error: null` for a photo that simply lacks EXIF.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { readMediaMetadata } from '../src/metadata.js';

// ESM test file — no __dirname available; resolve relative to the process cwd,
// which Jest sets to the package root (apps/cli) per jest.config.js rootDir.
const FIXTURE_PATH = path.join(process.cwd(), 'test', 'fixtures', 'exif-gps.jpg');

describe('readMediaMetadata', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-metadata-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('photo with real EXIF + GPS (fixture)', () => {
    it('extracts EXIF presence, GPS, camera, and coordinates', async () => {
      const meta = await readMediaMetadata(FIXTURE_PATH, 'image/jpeg');

      expect(meta.mediaKind).toBe('photo');
      expect(meta.hasExif).toBe(true);
      expect(meta.hasGps).toBe(true);
      expect(typeof meta.capturedAt).toBe('string');
      expect(meta.capturedAt).not.toBeNull();
      expect(meta.cameraMake).toBe('samsung');
      expect(typeof meta.takenLat).toBe('number');
      expect(typeof meta.takenLng).toBe('number');
      expect(meta.error).toBeNull();
    });
  });

  describe('video files', () => {
    it('returns mediaKind=video with empty metadata, never invoking exifr', async () => {
      // Path need not exist — the video branch returns before any file access.
      const meta = await readMediaMetadata('/nonexistent/clip.mp4', 'video/mp4');

      expect(meta.mediaKind).toBe('video');
      expect(meta.hasExif).toBe(false);
      expect(meta.hasGps).toBe(false);
      expect(meta.capturedAt).toBeNull();
      expect(meta.width).toBeNull();
      expect(meta.height).toBeNull();
      expect(meta.cameraMake).toBeNull();
      expect(meta.cameraModel).toBeNull();
      expect(meta.takenLat).toBeNull();
      expect(meta.takenLng).toBeNull();
      expect(meta.error).toBeNull();
    });

    it('classifies any video/* mimeType as video regardless of subtype', async () => {
      const meta = await readMediaMetadata('/nonexistent/clip.mov', 'video/quicktime');
      expect(meta.mediaKind).toBe('video');
      expect(meta.error).toBeNull();
    });
  });

  describe('photo lacking EXIF (random bytes)', () => {
    it('returns hasExif=false and error=null — not an error condition', async () => {
      const randomPath = path.join(tmpDir, 'random.jpg');
      fs.writeFileSync(randomPath, crypto.randomBytes(256));

      const meta = await readMediaMetadata(randomPath, 'image/jpeg');

      expect(meta.mediaKind).toBe('photo');
      expect(meta.hasExif).toBe(false);
      expect(meta.hasGps).toBe(false);
      expect(meta.error).toBeNull();
    });
  });

  describe('non-existent file', () => {
    // A missing/unreadable file is a genuine I/O error and must be captured in
    // the `error` field (per the module contract) rather than being collapsed
    // into the same hasExif:false/error:null branch as a readable file that
    // simply lacks EXIF. readMediaMetadata re-throws filesystem errors
    // (ENOENT/EACCES/EISDIR/…) into its outer catch and never rejects.
    it('never rejects — resolves with hasExif=false and error populated for a missing file', async () => {
      const missingPath = path.join(tmpDir, 'does-not-exist.jpg');

      await expect(readMediaMetadata(missingPath, 'image/jpeg')).resolves.toBeDefined();

      const meta = await readMediaMetadata(missingPath, 'image/jpeg');
      expect(meta.mediaKind).toBe('photo');
      expect(meta.hasExif).toBe(false);
      expect(meta.hasGps).toBe(false);
      expect(meta.error).not.toBeNull();
    });
  });
});
