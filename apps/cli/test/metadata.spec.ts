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
import { readMediaMetadata, oldestFileTimestamp, resolveCapturedAt, readExifCaptureDate } from '../src/metadata.js';

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

/**
 * oldestFileTimestamp() — reads the OLDEST of birthtime/mtime/atime from disk.
 * Mirrors the temp-file setup pattern used in test/hash.spec.ts.
 */
describe('oldestFileTimestamp', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-metadata-oldest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the older of a known-old mtime and a recent atime as oldestIso', () => {
    const filePath = path.join(tmpDir, 'old-mtime.bin');
    fs.writeFileSync(filePath, Buffer.from('hello'));

    // mtime deliberately far in the past; atime deliberately recent.
    const oldMtime = new Date('2020-01-01T00:00:00.000Z');
    const recentAtime = new Date();
    fs.utimesSync(filePath, recentAtime, oldMtime);

    const { oldestIso, birthtimeIso } = oldestFileTimestamp(filePath);

    expect(oldestIso).not.toBeNull();
    // The oldest surviving stamp must be the mtime we set (older than atime).
    expect(new Date(oldestIso!).getTime()).toBeLessThanOrEqual(oldMtime.getTime() + 1000);
    // birthtimeIso is a type/relationship check only — exact value is fs-dependent.
    expect(birthtimeIso === null || typeof birthtimeIso === 'string').toBe(true);
  });

  it('returns {oldestIso:null, birthtimeIso:null} for a missing path', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.bin');

    const result = oldestFileTimestamp(missingPath);

    expect(result).toEqual({ oldestIso: null, birthtimeIso: null });
  });
});

/**
 * resolveCapturedAt() — EXIF-first capture-date resolution with a filesystem
 * fallback. Mirrors the temp-file setup pattern used in test/hash.spec.ts.
 */
describe('resolveCapturedAt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-metadata-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the supplied EXIF date when the 3rd arg is a real ISO string (source=exif)', async () => {
    const filePath = path.join(tmpDir, 'has-exif.jpg');
    fs.writeFileSync(filePath, Buffer.from('irrelevant bytes'));

    const exifIso = '2019-06-15T12:00:00.000Z';
    const result = await resolveCapturedAt(filePath, 'image/jpeg', exifIso);

    expect(result.source).toBe('exif');
    expect(result.capturedAt).toBe(exifIso);
  });

  it('falls back to the oldest file timestamp when the 3rd arg is null (source=file)', async () => {
    const filePath = path.join(tmpDir, 'no-exif.jpg');
    fs.writeFileSync(filePath, Buffer.from('irrelevant bytes'));

    const oldMtime = new Date('2018-03-10T00:00:00.000Z');
    fs.utimesSync(filePath, new Date(), oldMtime);

    const result = await resolveCapturedAt(filePath, 'image/jpeg', null);

    expect(result.source).toBe('file');
    expect(result.capturedAt).not.toBeNull();
    const { oldestIso } = oldestFileTimestamp(filePath);
    expect(result.capturedAt).toBe(oldestIso);
  });

  it('always populates originalCreatedAt (birthtime) when the file exists', async () => {
    const filePath = path.join(tmpDir, 'birthtime-check.jpg');
    fs.writeFileSync(filePath, Buffer.from('irrelevant bytes'));

    const result = await resolveCapturedAt(filePath, 'image/jpeg', '2021-01-01T00:00:00.000Z');
    const { birthtimeIso } = oldestFileTimestamp(filePath);

    // Type/relationship check only — exact value is fs-dependent.
    expect(result.originalCreatedAt).toBe(birthtimeIso);
    expect(result.originalCreatedAt === null || typeof result.originalCreatedAt === 'string').toBe(true);
  });
});

/**
 * readExifCaptureDate() — the organize command's lean EXIF-capture-date-only
 * reader.  Unlike readMediaMetadata, it has no `error` field: every failure
 * mode (missing file, unsupported/no-EXIF photo, video mimeType) collapses to
 * a plain `null` resolution and it never rejects.
 */
describe('readExifCaptureDate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-metadata-exifdate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('photo with real EXIF (fixture)', () => {
    it('resolves a valid Date for a header-only parse', async () => {
      const result = await readExifCaptureDate(FIXTURE_PATH, 'image/jpeg');

      expect(result).toBeInstanceOf(Date);
      expect(isNaN((result as Date).getTime())).toBe(false);
    });

    it('resolves a valid Date when opts.full=true forces a full-file parse', async () => {
      const result = await readExifCaptureDate(FIXTURE_PATH, 'image/jpeg', { full: true });

      expect(result).toBeInstanceOf(Date);
      expect(isNaN((result as Date).getTime())).toBe(false);
    });
  });

  describe('video mimeType', () => {
    it('resolves null immediately without touching the filesystem (path need not exist)', async () => {
      const result = await readExifCaptureDate('/nonexistent/clip.mp4', 'video/mp4');
      expect(result).toBeNull();
    });
  });

  describe('non-existent file', () => {
    it('resolves null rather than throwing or rejecting', async () => {
      const missingPath = path.join(tmpDir, 'does-not-exist.jpg');

      await expect(readExifCaptureDate(missingPath, 'image/jpeg')).resolves.toBeNull();
    });
  });

  describe('photo lacking EXIF (random bytes)', () => {
    it('resolves null', async () => {
      const randomPath = path.join(tmpDir, 'random.jpg');
      fs.writeFileSync(randomPath, crypto.randomBytes(256));

      const result = await readExifCaptureDate(randomPath, 'image/jpeg');

      expect(result).toBeNull();
    });
  });
});
