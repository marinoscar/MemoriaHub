import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError } from '../../src/android/errors.js';
import {
  DEFAULT_VERSION_CODE,
  DEFAULT_VERSION_NAME,
  applyVersionChange,
  bumpSemver,
  bumpVersionFile,
  parseBumpPart,
  previewBump,
  readVersion,
  updateProperties,
} from '../../src/android/version.js';
import { cleanupTemp, makeRepo, tempDir } from './fixtures.js';

afterEach(cleanupTemp);

const current = { versionName: '2.0.0', versionCode: 100, exists: true };

describe('version.properties edit rules', () => {
  it('every bump also increments versionCode by one', () => {
    expect(applyVersionChange(current, { bump: 'patch' })).toEqual({ versionName: '2.0.1', versionCode: 101 });
    expect(applyVersionChange(current, { bump: 'minor' })).toEqual({ versionName: '2.1.0', versionCode: 101 });
    expect(applyVersionChange(current, { bump: 'major' })).toEqual({ versionName: '3.0.0', versionCode: 101 });
  });

  it('--set also increments versionCode', () => {
    expect(applyVersionChange(current, { set: '2.5.0' })).toEqual({ versionName: '2.5.0', versionCode: 101 });
  });

  it('--code sets the code explicitly and must increase', () => {
    expect(applyVersionChange(current, { bump: 'patch', code: 200 })).toEqual({ versionName: '2.0.1', versionCode: 200 });
    expect(() => applyVersionChange(current, { code: 100 })).toThrow(UsageError);
    expect(() => applyVersionChange(current, { code: 99 })).toThrow(/not greater than the current versionCode 100/);
    expect(() => applyVersionChange(current, { code: 2_100_000_001 })).toThrow(UsageError);
  });

  it('no flags means no change', () => {
    expect(applyVersionChange(current, {})).toBeUndefined();
  });

  it('refuses --bump with --set, a bad --set and a bad --bump', () => {
    expect(() => applyVersionChange(current, { bump: 'patch', set: '3.0.0' })).toThrow(/not both/);
    expect(() => applyVersionChange(current, { set: 'v3' })).toThrow(/x\.y\.z/);
    expect(() => parseBumpPart('huge')).toThrow(UsageError);
    expect(() => bumpSemver('2.0', 'patch')).toThrow(/--set/);
  });

  it('a missing file defaults, and a change creates it at the defaults', () => {
    const missing = readVersion(join(tempDir(), 'nope.properties'));
    expect(missing).toEqual({ versionName: DEFAULT_VERSION_NAME, versionCode: DEFAULT_VERSION_CODE, exists: false });
    expect(applyVersionChange(missing, { bump: 'patch' })).toEqual({ versionName: DEFAULT_VERSION_NAME, versionCode: DEFAULT_VERSION_CODE });
  });

  it('rejects a versionCode outside 1..2100000000 in the file', () => {
    const repo = makeRepo({ version: 'versionName=1.0.0\nversionCode=0\n' });
    expect(() => readVersion(join(repo, 'apps', 'android', 'version.properties'))).toThrow(/versionCode/);
  });

  it('rewrites values in place, keeping comments and other keys', () => {
    const text = '# keep me\nversionName=2.0.0\nother=x\nversionCode=100\n';
    expect(updateProperties(text, { versionName: '2.0.1', versionCode: '101' })).toBe(
      '# keep me\nversionName=2.0.1\nother=x\nversionCode=101\n',
    );
    expect(updateProperties('', { versionName: '1.0.0' })).toBe('versionName=1.0.0\n');
  });

  it('bumpVersionFile writes; previewBump does not', () => {
    const repo = makeRepo();
    const file = join(repo, 'apps', 'android', 'version.properties');
    expect(previewBump(file, 'patch').after).toEqual({ versionName: '2.0.1', versionCode: 101 });
    expect(readVersion(file).versionCode).toBe(100);
    const bump = bumpVersionFile(file, 'minor');
    expect(bump.after).toEqual({ versionName: '2.1.0', versionCode: 101 });
    expect(readFileSync(file, 'utf8')).toBe('# The Android app version.\nversionName=2.1.0\nversionCode=101\n');
  });
});
