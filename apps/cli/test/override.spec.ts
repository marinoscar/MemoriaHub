/**
 * test/override.spec.ts
 *
 * Unit tests for the per-folder metadata-override reader (`memoriahub.json`):
 *   - loadOverrideFile(dir): fs read + validation + normalization
 *   - normalizeCapturedAt(raw): low-level date normalization helper
 *   - pickFallback(override, basename, meta): pure per-file decision logic
 *
 * Mirrors the temp-file setup pattern used in test/metadata.spec.ts and
 * test/hash.spec.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadOverrideFile,
  pickFallback,
  normalizeCapturedAt,
  OVERRIDE_FILENAME,
  OverrideValidationError,
} from '../src/override.js';
import type { FolderOverride } from '../src/override.js';

function writeOverride(dir: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, OVERRIDE_FILENAME), JSON.stringify(data));
}

function writeRawOverride(dir: string, text: string): void {
  fs.writeFileSync(path.join(dir, OVERRIDE_FILENAME), text);
}

describe('OVERRIDE_FILENAME', () => {
  it('is memoriahub.json', () => {
    expect(OVERRIDE_FILENAME).toBe('memoriahub.json');
  });
});

describe('loadOverrideFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-override-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no memoriahub.json is present', () => {
    expect(loadOverrideFile(tmpDir)).toBeNull();
  });

  it('returns a normalized FolderOverride for a valid full file', () => {
    writeOverride(tmpDir, {
      version: 1,
      fallback: {
        capturedAt: '2019-06-15T14:30:00-06:00',
        location: { latitude: 37.7749, longitude: -122.4194, altitude: 12.5 },
      },
      files: [
        {
          name: 'IMG_0001.jpg',
          location: { latitude: 40.7128, longitude: -74.006 },
        },
      ],
    });

    const result = loadOverrideFile(tmpDir);

    const expected: FolderOverride = {
      version: 1,
      fallback: {
        capturedAt: new Date(Date.parse('2019-06-15T14:30:00-06:00')).toISOString(),
        capturedAtOffset: -360,
        location: { latitude: 37.7749, longitude: -122.4194, altitude: 12.5 },
      },
      files: [
        {
          name: 'IMG_0001.jpg',
          capturedAt: null,
          capturedAtOffset: null,
          location: { latitude: 40.7128, longitude: -74.006, altitude: null },
        },
      ],
    };

    expect(result).toEqual(expected);
  });

  it('throws OverrideValidationError with the file path in the message for invalid JSON', () => {
    writeRawOverride(tmpDir, '{ this is not json');

    let caught: unknown;
    try {
      loadOverrideFile(tmpDir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OverrideValidationError);
    const err = caught as OverrideValidationError;
    expect(err.name).toBe('OverrideValidationError');
    expect(err.filePath).toBe(path.join(tmpDir, OVERRIDE_FILENAME));
    expect(err.message).toContain(path.join(tmpDir, OVERRIDE_FILENAME));
  });

  it('throws OverrideValidationError when version is missing', () => {
    writeOverride(tmpDir, { fallback: { capturedAt: '2020-01-01' } });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when version is non-integer', () => {
    writeOverride(tmpDir, { version: 1.5 });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when version is not 1', () => {
    writeOverride(tmpDir, { version: 2 });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when fallback.location.latitude is out of range', () => {
    writeOverride(tmpDir, {
      version: 1,
      fallback: { location: { latitude: 91, longitude: 0 } },
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when fallback.location.longitude is out of range', () => {
    writeOverride(tmpDir, {
      version: 1,
      fallback: { location: { latitude: 0, longitude: -181 } },
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when location is missing latitude', () => {
    writeOverride(tmpDir, {
      version: 1,
      fallback: { location: { longitude: 10 } },
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when location is missing longitude', () => {
    writeOverride(tmpDir, {
      version: 1,
      fallback: { location: { latitude: 10 } },
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when files is not an array', () => {
    writeOverride(tmpDir, { version: 1, files: { name: 'a.jpg' } });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when a files[] entry is missing name', () => {
    writeOverride(tmpDir, {
      version: 1,
      files: [{ capturedAt: '2020-01-01' }],
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError when a files[] entry has an empty-string name', () => {
    writeOverride(tmpDir, {
      version: 1,
      files: [{ name: '', capturedAt: '2020-01-01' }],
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('throws OverrideValidationError on duplicate names across files[] entries', () => {
    writeOverride(tmpDir, {
      version: 1,
      files: [
        { name: 'IMG_0001.jpg', capturedAt: '2020-01-01' },
        { name: 'IMG_0001.jpg', capturedAt: '2020-01-02' },
      ],
    });
    expect(() => loadOverrideFile(tmpDir)).toThrow(OverrideValidationError);
  });

  it('ignores unknown top-level keys without throwing', () => {
    writeOverride(tmpDir, { version: 1, somethingUnknown: 'ignored', extra: { nested: true } });
    expect(() => loadOverrideFile(tmpDir)).not.toThrow();
    const result = loadOverrideFile(tmpDir);
    expect(result).toEqual({ version: 1, fallback: null, files: [] });
  });
});

describe('normalizeCapturedAt', () => {
  it('expands a date-only string to local noon with offsetMinutes null', () => {
    const result = normalizeCapturedAt('2019-06-16');
    const expectedIso = new Date(2019, 5, 16, 12, 0, 0).toISOString();
    expect(result.iso).toBe(expectedIso);
    expect(result.offsetMinutes).toBeNull();
  });

  it('parses a negative-offset datetime and reports offsetMinutes', () => {
    const result = normalizeCapturedAt('2019-06-15T14:30:00-06:00');
    expect(result.offsetMinutes).toBe(-360);
    expect(result.iso).toBe(new Date(Date.parse('2019-06-15T14:30:00-06:00')).toISOString());
  });

  it('parses a Z-suffixed datetime and reports offsetMinutes 0', () => {
    const result = normalizeCapturedAt('2019-06-15T14:30:00Z');
    expect(result.offsetMinutes).toBe(0);
    expect(result.iso).toBe('2019-06-15T14:30:00.000Z');
  });

  it('throws a plain Error (not OverrideValidationError) for an unparseable string', () => {
    expect(() => normalizeCapturedAt('not-a-date')).toThrow(Error);
    let caught: unknown;
    try {
      normalizeCapturedAt('not-a-date');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(OverrideValidationError);
  });
});

describe('pickFallback', () => {
  const folderOverride: FolderOverride = {
    version: 1,
    fallback: {
      capturedAt: '2020-05-01T00:00:00.000Z',
      capturedAtOffset: 0,
      location: { latitude: 10, longitude: 20, altitude: 100 },
    },
    files: [],
  };

  it('returns {} when override is null', () => {
    expect(pickFallback(null, 'anything.jpg', { hasGps: false, capturedAt: null })).toEqual({});
  });

  it('fills GPS only when the file has an EXIF date but no GPS', () => {
    const result = pickFallback(folderOverride, 'a.jpg', {
      capturedAt: '2020-01-01T00:00:00.000Z',
      hasGps: false,
    });

    expect(result.takenLat).toBe(10);
    expect(result.takenLng).toBe(20);
    expect(result).not.toHaveProperty('capturedAt');
  });

  it('fills capturedAt only when the file has GPS but no EXIF date', () => {
    const result = pickFallback(folderOverride, 'a.jpg', {
      capturedAt: null,
      hasGps: true,
    });

    expect(result.capturedAt).toBe('2020-05-01T00:00:00.000Z');
    expect(result).not.toHaveProperty('takenLat');
    expect(result).not.toHaveProperty('takenLng');
    expect(result).not.toHaveProperty('takenAltitude');
  });

  it('fills both capturedAt and location when the file has neither', () => {
    const result = pickFallback(folderOverride, 'a.jpg', {
      capturedAt: null,
      hasGps: false,
    });

    expect(result.capturedAt).toBe('2020-05-01T00:00:00.000Z');
    expect(result.takenLat).toBe(10);
    expect(result.takenLng).toBe(20);
    expect(result.takenAltitude).toBe(100);
  });

  it('returns {} when the file has both EXIF date and GPS', () => {
    const result = pickFallback(folderOverride, 'a.jpg', {
      capturedAt: '2020-01-01T00:00:00.000Z',
      hasGps: true,
    });

    expect(result).toEqual({});
  });

  it('lets a matching files[] entry override the fallback per-field, inheriting missing fields', () => {
    const overrideWithFileEntry: FolderOverride = {
      version: 1,
      fallback: {
        capturedAt: '2020-05-01T00:00:00.000Z',
        capturedAtOffset: 0,
        location: { latitude: 10, longitude: 20, altitude: 100 },
      },
      files: [
        {
          name: 'special.jpg',
          capturedAt: null,
          capturedAtOffset: null,
          location: { latitude: 55, longitude: 66, altitude: null },
        },
      ],
    };

    // File has neither EXIF date nor GPS: location comes from the files[] entry
    // (55/66), capturedAt inherits from the folder fallback since the files[]
    // entry did not supply its own.
    const result = pickFallback(overrideWithFileEntry, 'special.jpg', {
      capturedAt: null,
      hasGps: false,
    });

    expect(result.takenLat).toBe(55);
    expect(result.takenLng).toBe(66);
    expect(result.capturedAt).toBe('2020-05-01T00:00:00.000Z');
  });

  it('includes capturedAtOffset only when the chosen capturedAt source has a non-null offset', () => {
    const overrideNoOffset: FolderOverride = {
      version: 1,
      fallback: {
        capturedAt: '2020-05-01T12:00:00.000Z',
        capturedAtOffset: null,
        location: null,
      },
      files: [],
    };

    const result = pickFallback(overrideNoOffset, 'a.jpg', { capturedAt: null, hasGps: true });

    expect(result.capturedAt).toBe('2020-05-01T12:00:00.000Z');
    expect(result).not.toHaveProperty('capturedAtOffset');
  });

  it('includes takenAltitude only when the chosen location has a non-null altitude', () => {
    const overrideNoAltitude: FolderOverride = {
      version: 1,
      fallback: {
        capturedAt: null,
        capturedAtOffset: null,
        location: { latitude: 1, longitude: 2, altitude: null },
      },
      files: [],
    };

    const result = pickFallback(overrideNoAltitude, 'a.jpg', { capturedAt: '2020-01-01', hasGps: false });

    expect(result.takenLat).toBe(1);
    expect(result.takenLng).toBe(2);
    expect(result).not.toHaveProperty('takenAltitude');
  });
});
