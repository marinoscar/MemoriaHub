/**
 * test/convert/plan.spec.ts — Pure unit tests for convert path-planning helpers.
 * No DB, no ffmpeg, no filesystem writes beyond a temp dir for collision tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isConvertibleVideo,
  parseFormats,
  targetPathFor,
  resolveConvertCollision,
  extOf,
} from '../../src/convert/plan.js';

describe('convert/plan', () => {
  describe('isConvertibleVideo', () => {
    it('accepts recognized non-MP4 video extensions', () => {
      for (const name of [
        'a.mov', 'b.MOV', 'c.mts', 'd.m2ts', 'e.avi', 'f.wmv', 'g.mkv',
        'h.webm', 'i.flv', 'j.3gp', 'k.mpg', 'l.qt', 'm.divx',
      ]) {
        expect(isConvertibleVideo(name)).toBe(true);
      }
    });

    it('rejects MP4 containers and non-video files', () => {
      for (const name of ['clip.mp4', 'clip.MP4', 'clip.m4v', 'photo.jpg', 'raw.cr2', 'notes.txt', 'noext']) {
        expect(isConvertibleVideo(name)).toBe(false);
      }
    });

    it('honors a --formats restriction set', () => {
      const restrict = parseFormats('mov,mts');
      expect(isConvertibleVideo('a.mov', restrict)).toBe(true);
      expect(isConvertibleVideo('a.mts', restrict)).toBe(true);
      // avi is a video but excluded by the restriction.
      expect(isConvertibleVideo('a.avi', restrict)).toBe(false);
    });
  });

  describe('parseFormats', () => {
    it('parses a comma list, trims, strips dots, lowercases', () => {
      const s = parseFormats(' .MOV, mts ,, avi ');
      expect(s).toBeDefined();
      expect([...(s ?? [])].sort()).toEqual(['avi', 'mov', 'mts']);
    });

    it('returns undefined for empty/undefined input', () => {
      expect(parseFormats(undefined)).toBeUndefined();
      expect(parseFormats('')).toBeUndefined();
      expect(parseFormats('  ,  ')).toBeUndefined();
    });
  });

  describe('extOf', () => {
    it('returns the lowercased extension without the dot', () => {
      expect(extOf('/a/b/c.MOV')).toBe('mov');
      expect(extOf('noext')).toBe('');
    });
  });

  describe('targetPathFor', () => {
    it('swaps the extension to .mp4 in the same directory', () => {
      expect(targetPathFor('/videos/holiday.MOV')).toBe(path.join('/videos', 'holiday.mp4'));
      expect(targetPathFor('/a/b/clip.mts')).toBe(path.join('/a/b', 'clip.mp4'));
    });
  });

  describe('resolveConvertCollision', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-convert-plan-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns the desired path unchanged when free', () => {
      const desired = path.join(tmpDir, 'clip.mp4');
      expect(resolveConvertCollision(desired)).toBe(desired);
    });

    it('suffixes (1), (2)… when the name is taken', () => {
      const desired = path.join(tmpDir, 'clip.mp4');
      fs.writeFileSync(desired, 'x');
      const first = resolveConvertCollision(desired);
      expect(first).toBe(path.join(tmpDir, 'clip (1).mp4'));

      fs.writeFileSync(first, 'x');
      const second = resolveConvertCollision(desired);
      expect(second).toBe(path.join(tmpDir, 'clip (2).mp4'));
    });
  });
});
