/**
 * test/date-inference/exif-writer.spec.ts
 *
 * Unit tests for the ExifTool wrapper. `exif-writer.ts` dynamically
 * `import('exiftool-vendored')`s and memoizes both the raw module promise
 * (`_mod`) and the detect-result promise (`cachedDetect`) at module scope for
 * the process lifetime — mirrors convert/ffmpeg.ts's detectFfmpeg()
 * discipline, but since there's no exported reset hook (unlike ffmpeg.ts's
 * `_resetDetectCache`), each test that needs a fresh memoization state calls
 * `jest.resetModules()` and re-imports the module under test, re-registering
 * the `exiftool-vendored` mock via jest.unstable_mockModule beforehand (the
 * same dynamic-import mocking approach used by
 * test/node/compute/auto-tagging.spec.ts for its dynamically-imported
 * `@memoriahub/enrichment-compute/*` packages).
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Types mirroring exif-writer.ts's local ExiftoolModule shape
// ---------------------------------------------------------------------------

interface MockExiftoolModule {
  exiftool: {
    version: jest.Mock<(...args: unknown[]) => unknown>;
    write: jest.Mock<(...args: unknown[]) => unknown>;
    end: jest.Mock<(...args: unknown[]) => unknown>;
  };
}

/** Builds a fresh mock `exiftool-vendored` module + its jest.fn()s. */
function makeMockExiftoolModule(): MockExiftoolModule {
  return {
    exiftool: {
      version: jest.fn<(...args: unknown[]) => unknown>(),
      write: jest.fn<(...args: unknown[]) => unknown>(),
      end: jest.fn<(...args: unknown[]) => unknown>(),
    },
  };
}

// ---------------------------------------------------------------------------
// Fresh-module helper — resets Jest's module registry and re-mocks
// 'exiftool-vendored' before re-importing exif-writer.ts, so each test group
// below gets its own un-memoized `_mod`/`cachedDetect` state.
// ---------------------------------------------------------------------------

async function freshExifWriter(mockModule: MockExiftoolModule | 'reject') {
  jest.resetModules();

  if (mockModule === 'reject') {
    jest.unstable_mockModule('exiftool-vendored', () => {
      throw new Error('module not found');
    });
  } else {
    jest.unstable_mockModule('exiftool-vendored', () => mockModule);
  }

  return import('../../src/date-inference/exif-writer.js');
}

describe('date-inference/exif-writer', () => {
  // -------------------------------------------------------------------------
  // detectExiftool
  // -------------------------------------------------------------------------

  describe('detectExiftool', () => {
    it('resolves {available: true, version} when exiftool.version() resolves', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.version.mockResolvedValue('12.76');
      const { detectExiftool } = await freshExifWriter(mock);

      const info = await detectExiftool();

      expect(info).toEqual({ available: true, version: '12.76' });
      expect(mock.exiftool.version).toHaveBeenCalledTimes(1);
    });

    it('resolves {available: false} when the dynamic import itself rejects', async () => {
      const { detectExiftool } = await freshExifWriter('reject');

      const info = await detectExiftool();

      expect(info).toEqual({ available: false });
    });

    it('resolves {available: false} when exiftool.version() throws', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.version.mockRejectedValue(new Error('spawn perl ENOENT'));
      const { detectExiftool } = await freshExifWriter(mock);

      const info = await detectExiftool();

      expect(info).toEqual({ available: false });
    });

    it('memoizes the result: a second call does not re-invoke exiftool.version()', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.version.mockResolvedValue('12.76');
      const { detectExiftool } = await freshExifWriter(mock);

      const first = await detectExiftool();
      const second = await detectExiftool();

      expect(first).toEqual(second);
      expect(mock.exiftool.version).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // writeCapturedDate
  // -------------------------------------------------------------------------

  describe('writeCapturedDate', () => {
    const match = {
      iso: '2015-11-07T13:51:51.000Z',
      year: 2015,
      month: 11,
      day: 7,
      hour: 13,
      minute: 51,
      second: 51,
      hadTime: true,
      pattern: 'timestamp' as const,
      matchedText: '20151107_135151',
    };

    it('calls exiftool.write with the zero-padded AllDates string and -overwrite_original, resolving {ok:true}', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.write.mockResolvedValue(undefined);
      const { writeCapturedDate } = await freshExifWriter(mock);

      const result = await writeCapturedDate('/photos/20151107_135151000_iOS.jpg', match);

      expect(result).toEqual({ ok: true });
      expect(mock.exiftool.write).toHaveBeenCalledWith(
        '/photos/20151107_135151000_iOS.jpg',
        { AllDates: '2015:11:07 13:51:51' },
        { writeArgs: ['-overwrite_original'] },
      );
    });

    it('zero-pads single-digit month/day/hour/minute/second components', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.write.mockResolvedValue(undefined);
      const { writeCapturedDate } = await freshExifWriter(mock);

      const paddedMatch = {
        ...match,
        month: 1,
        day: 3,
        hour: 4,
        minute: 5,
        second: 6,
      };

      await writeCapturedDate('/photos/x.jpg', paddedMatch);

      expect(mock.exiftool.write).toHaveBeenCalledWith(
        '/photos/x.jpg',
        { AllDates: '2015:01:03 04:05:06' },
        { writeArgs: ['-overwrite_original'] },
      );
    });

    it('resolves {ok:false, error} (never throws) when exiftool.write rejects', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.write.mockRejectedValue(new Error('permission denied'));
      const { writeCapturedDate } = await freshExifWriter(mock);

      const result = await writeCapturedDate('/photos/locked.jpg', match);

      expect(result).toEqual({ ok: false, error: 'permission denied' });
    });

    it('resolves {ok:false, error: "ExifTool is not available"} when the module fails to load', async () => {
      const { writeCapturedDate } = await freshExifWriter('reject');

      const result = await writeCapturedDate('/photos/x.jpg', match);

      expect(result).toEqual({ ok: false, error: 'ExifTool is not available' });
    });
  });

  // -------------------------------------------------------------------------
  // endExiftool
  // -------------------------------------------------------------------------

  describe('endExiftool', () => {
    it('is a no-op when the module was never loaded', async () => {
      const mock = makeMockExiftoolModule();
      const { endExiftool } = await freshExifWriter(mock);

      await expect(endExiftool()).resolves.toBeUndefined();
      expect(mock.exiftool.end).not.toHaveBeenCalled();
    });

    it('calls exiftool.end() when the module was previously loaded (via detectExiftool)', async () => {
      const mock = makeMockExiftoolModule();
      mock.exiftool.version.mockResolvedValue('12.76');
      mock.exiftool.end.mockResolvedValue(undefined);
      const { detectExiftool, endExiftool } = await freshExifWriter(mock);

      await detectExiftool();
      await endExiftool();

      expect(mock.exiftool.end).toHaveBeenCalledTimes(1);
    });
  });
});

void jest;
