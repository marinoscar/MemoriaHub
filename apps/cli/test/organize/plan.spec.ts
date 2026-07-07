/**
 * test/organize/plan.spec.ts
 *
 * Unit tests for organize/plan.ts — the pure path-planning helpers used by
 * the OrganizeEngine: bucketFor, targetPathFor, resolveCollision.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { bucketFor, targetPathFor, resolveCollision, MONTH_NAMES } from '../../src/organize/plan.js';

describe('bucketFor', () => {
  it('returns [NODATE] for a null date with GPS present', () => {
    expect(bucketFor(null, true)).toEqual(['NODATE']);
  });

  it('returns [NODATE, NO-GPS] for a null date with no GPS', () => {
    expect(bucketFor(null, false)).toEqual(['NODATE', 'NO-GPS']);
  });

  it('buckets a real date + GPS present into [YEAR, "MM - Month"]', () => {
    const date = new Date(2023, 6, 15, 12, 0, 0); // July 15, 2023, local noon
    expect(bucketFor(date, true)).toEqual(['2023', '07 - July']);
  });

  it('buckets a real date + no GPS into [YEAR, "MM - Month", NO-GPS]', () => {
    const date = new Date(2023, 6, 15, 12, 0, 0); // July 15, 2023, local noon
    expect(bucketFor(date, false)).toEqual(['2023', '07 - July', 'NO-GPS']);
  });

  it('buckets January correctly (month index 0)', () => {
    const date = new Date(2023, 0, 15);
    expect(bucketFor(date, true)).toEqual(['2023', '01 - January']);
    expect(MONTH_NAMES[0]).toBe('January');
  });

  it('buckets December correctly (month index 11)', () => {
    const date = new Date(2023, 11, 15);
    expect(bucketFor(date, true)).toEqual(['2023', '12 - December']);
    expect(MONTH_NAMES[11]).toBe('December');
  });

  it('uses LOCAL date getters, not UTC — local midnight-ish on the 1st stays in that month', () => {
    // 00:30 local time on July 1st. If UTC getters were used instead of local
    // getters, a positive UTC offset (west of Greenwich) would roll this back
    // into June when converted to UTC. bucketFor must use getFullYear()/
    // getMonth() (local) so the bucket always reflects the local wall-clock
    // date the photo was taken on, regardless of the test runner's TZ.
    const date = new Date(2023, 6, 1, 0, 30, 0);
    expect(bucketFor(date, true)).toEqual(['2023', '07 - July']);
  });
});

describe('targetPathFor', () => {
  it('joins root, segments, and filename into an absolute path', () => {
    const root = '/library/photos';
    const result = targetPathFor(root, ['2023', '07 - July'], 'a.jpg');
    expect(result).toBe(path.join(root, '2023', '07 - July', 'a.jpg'));
  });

  it('joins with a single NODATE segment', () => {
    const root = '/library/photos';
    const result = targetPathFor(root, ['NODATE'], 'clip.mp4');
    expect(result).toBe(path.join(root, 'NODATE', 'clip.mp4'));
  });
});

describe('resolveCollision', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-plan-collision-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the desired path unchanged when nothing exists there', () => {
    const desired = path.join(tmpDir, 'a.jpg');
    const source = path.join(tmpDir, 'source-elsewhere.jpg');
    expect(resolveCollision(desired, source)).toBe(desired);
  });

  it('returns the desired path unchanged when the existing entry IS the source file (idempotent re-run)', () => {
    const filePath = path.join(tmpDir, 'already-here.jpg');
    fs.writeFileSync(filePath, 'x');

    // desiredPath and sourcePath both point at the same already-in-place file.
    expect(resolveCollision(filePath, filePath)).toBe(filePath);
  });

  it('appends " (1)" when a DIFFERENT file already occupies the desired path', () => {
    const existingPath = path.join(tmpDir, 'existing.jpg');
    fs.writeFileSync(existingPath, 'existing-bytes');

    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-plan-source-'));
    const sourcePath = path.join(sourceDir, 'source.jpg');
    fs.writeFileSync(sourcePath, 'source-bytes');

    try {
      const resolved = resolveCollision(existingPath, sourcePath);

      expect(resolved).toBe(path.join(tmpDir, 'existing (1).jpg'));
      expect(fs.existsSync(resolved)).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('advances to " (2)" when " (1)" is also already taken', () => {
    const foo = path.join(tmpDir, 'foo.jpg');
    const foo1 = path.join(tmpDir, 'foo (1).jpg');
    fs.writeFileSync(foo, 'foo-bytes');
    fs.writeFileSync(foo1, 'foo1-bytes');

    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-plan-source2-'));
    const sourcePath = path.join(sourceDir, 'different-source.jpg');
    fs.writeFileSync(sourcePath, 'different-bytes');

    try {
      const resolved = resolveCollision(foo, sourcePath);

      expect(resolved).toBe(path.join(tmpDir, 'foo (2).jpg'));
      expect(fs.existsSync(resolved)).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
