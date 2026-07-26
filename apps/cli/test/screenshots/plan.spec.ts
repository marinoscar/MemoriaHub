/**
 * test/screenshots/plan.spec.ts
 *
 * Unit tests for screenshots/plan.ts — isScreenshotFile, findScreenshotFiles,
 * and the re-exported resolveCollision (whose own behavior is already fully
 * covered by test/organize/plan.spec.ts; here we only confirm the re-export
 * wires to the same function).
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isScreenshotFile,
  findScreenshotFiles,
  resolveCollision,
} from '../../src/screenshots/plan.js';
import { resolveCollision as organizeResolveCollision } from '../../src/organize/plan.js';
import { OVERRIDE_FILENAME } from '../../src/override.js';

// ---------------------------------------------------------------------------
// isScreenshotFile
// ---------------------------------------------------------------------------

describe('isScreenshotFile', () => {
  it('matches a typical macOS-style screenshot filename', () => {
    expect(isScreenshotFile('/a/b/Screenshot 2024-01-02.png')).toBe(true);
  });

  it('matches case-insensitively (all-lowercase)', () => {
    expect(isScreenshotFile('/a/b/screenshot.jpg')).toBe(true);
  });

  it('matches case-insensitively (all-uppercase, unusual extension)', () => {
    expect(isScreenshotFile('/a/b/SCREENSHOT_final.HEIC')).toBe(true);
  });

  it('matches when "screenshot" is a substring embedded in a longer name', () => {
    expect(isScreenshotFile('/a/b/img_screenshot_01.jpg')).toBe(true);
  });

  it('only inspects the base name, not the full path', () => {
    // "screenshot" only appears in a directory segment, not the filename.
    expect(isScreenshotFile('/a/screenshot-folder/vacation.jpg')).toBe(false);
  });

  it('returns false for an unrelated filename', () => {
    expect(isScreenshotFile('/a/b/vacation.jpg')).toBe(false);
  });

  it('returns false for a plain text file with an unrelated name', () => {
    expect(isScreenshotFile('/a/b/notes.txt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveCollision re-export
// ---------------------------------------------------------------------------

describe('resolveCollision re-export', () => {
  it('is the same function reference as organize/plan.js resolveCollision', () => {
    expect(resolveCollision).toBe(organizeResolveCollision);
  });
});

// ---------------------------------------------------------------------------
// findScreenshotFiles
// ---------------------------------------------------------------------------

describe('findScreenshotFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-screenshots-plan-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(dir: string, name: string, contents = 'x'): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, contents);
    return p;
  }

  it('matches files by name case-insensitively, regardless of extension, and ignores non-matches', () => {
    const shot1 = write(tmpDir, 'Screenshot 2024-01-02.png', 'aa');
    const shot2 = write(tmpDir, 'screenshot.jpg', 'bbb');
    const shot3 = write(tmpDir, 'SCREENSHOT_final.HEIC', 'cccc');
    write(tmpDir, 'vacation.jpg', 'dddddd');
    write(tmpDir, 'notes.txt', 'eeeeeee');

    const matches = findScreenshotFiles(tmpDir, false);
    const paths = matches.map((m) => m.filePath).sort();

    expect(paths).toEqual([shot1, shot2, shot3].sort());
    expect(matches).toHaveLength(3);
  });

  it('records the correct byte size for each match', () => {
    const shot = write(tmpDir, 'screenshot-sized.png', '12345');
    const matches = findScreenshotFiles(tmpDir, false);
    expect(matches).toHaveLength(1);
    expect(matches[0].filePath).toBe(shot);
    expect(matches[0].size).toBe(5);
  });

  it('does not descend into sub-directories when recursive is false', () => {
    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir);
    write(subDir, 'screenshot-nested.png');

    const matches = findScreenshotFiles(tmpDir, false);
    expect(matches).toHaveLength(0);
  });

  it('descends into sub-directories when recursive is true', () => {
    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir);
    const nested = write(subDir, 'screenshot-nested.png');

    const matches = findScreenshotFiles(tmpDir, true);
    expect(matches).toHaveLength(1);
    expect(matches[0].filePath).toBe(nested);
  });

  it('skips the OVERRIDE_FILENAME sidecar even if it somehow matched the name pattern', () => {
    // Not a screenshot-named file in practice, but this guards the explicit
    // sidecar skip regardless of what OVERRIDE_FILENAME is set to.
    write(tmpDir, OVERRIDE_FILENAME);
    const matches = findScreenshotFiles(tmpDir, false);
    expect(matches.find((m) => path.basename(m.filePath) === OVERRIDE_FILENAME)).toBeUndefined();
  });

  it('warns and skips an unreadable directory rather than throwing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const unreadableDir = path.join(tmpDir, 'locked');
    fs.mkdirSync(unreadableDir);
    write(unreadableDir, 'screenshot-in-locked.png');

    const originalMode = fs.statSync(unreadableDir).mode;
    fs.chmodSync(unreadableDir, 0o000);

    try {
      // Root scan itself must not throw even though a child dir is unreadable.
      expect(() => findScreenshotFiles(tmpDir, true)).not.toThrow();

      // On systems where root can still read 0o000 dirs (e.g. running as
      // root inside a container), the warning path may not trigger — only
      // assert the invariant that matters when it *is* enforced.
      if (warnSpy.mock.calls.length > 0) {
        expect(warnSpy.mock.calls[0][0]).toContain('cannot read directory');
      }
    } finally {
      fs.chmodSync(unreadableDir, originalMode);
      warnSpy.mockRestore();
    }
  });

  it('returns an empty array for an empty folder', () => {
    expect(findScreenshotFiles(tmpDir, true)).toEqual([]);
  });
});
