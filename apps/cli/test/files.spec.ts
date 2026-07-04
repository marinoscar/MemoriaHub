/**
 * test/files.spec.ts — enumerateFiles + MIME_BY_EXT coverage.
 *
 * Verifies the walker picks up the broad modern + legacy media format set,
 * classifies photo vs video correctly (image/* vs video/*), skips unsupported
 * files, and honors the recursive flag.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { enumerateFiles, MIME_BY_EXT } from '../src/files.js';

describe('MIME_BY_EXT', () => {
  it('classifies every entry as either image/* or video/*', () => {
    const bad = Object.entries(MIME_BY_EXT).filter(
      ([, mime]) => !/^(image|video)\//.test(mime),
    );
    expect(bad).toEqual([]);
  });

  it('covers the legacy formats an old device would have', () => {
    // videos
    for (const ext of ['avi', 'mov', 'vob', 'mpeg', 'mpg', 'wmv', '3gp', 'mts', 'm2ts', 'mkv', 'flv', 'divx']) {
      expect(MIME_BY_EXT[ext]?.startsWith('video/')).toBe(true);
    }
    // images (incl. RAW + legacy raster)
    for (const ext of ['jpg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'cr2', 'nef', 'arw', 'dng', 'orf']) {
      expect(MIME_BY_EXT[ext]?.startsWith('image/')).toBe(true);
    }
  });
});

describe('enumerateFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-files-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function touch(rel: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }

  it('picks up modern + legacy media and skips unsupported files', () => {
    touch('photo.jpg');
    touch('image.TIFF'); // uppercase extension
    touch('anim.gif');
    touch('raw.CR2');
    touch('clip.mov');
    touch('old.mpeg');
    touch('dvd.vob');
    touch('phone.3gp');
    touch('cam.m2ts');
    touch('notes.txt'); // unsupported
    touch('README'); // no extension

    const { supported, skipped } = enumerateFiles(tmpDir, false);

    const byName = new Map(supported.map((s) => [path.basename(s.filePath), s.mimeType]));
    expect(byName.get('photo.jpg')).toBe('image/jpeg');
    expect(byName.get('image.TIFF')).toBe('image/tiff'); // case-insensitive
    expect(byName.get('anim.gif')).toBe('image/gif');
    expect(byName.get('raw.CR2')).toBe('image/x-canon-cr2');
    expect(byName.get('clip.mov')).toBe('video/quicktime');
    expect(byName.get('old.mpeg')).toBe('video/mpeg');
    expect(byName.get('dvd.vob')).toBe('video/mpeg');
    expect(byName.get('phone.3gp')).toBe('video/3gpp');
    expect(byName.get('cam.m2ts')).toBe('video/mp2t');

    const skippedNames = skipped.map((p) => path.basename(p)).sort();
    expect(skippedNames).toEqual(['README', 'notes.txt']);
  });

  it('descends into sub-directories only when recursive', () => {
    touch('top.jpg');
    touch('sub/nested.avi');

    const flat = enumerateFiles(tmpDir, false);
    expect(flat.supported.map((s) => path.basename(s.filePath))).toEqual(['top.jpg']);

    const deep = enumerateFiles(tmpDir, true);
    const names = deep.supported.map((s) => path.basename(s.filePath)).sort();
    expect(names).toEqual(['nested.avi', 'top.jpg']);
  });
});
