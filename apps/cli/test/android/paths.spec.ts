import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT, PreconditionError } from '../../src/android/errors.js';
import {
  NO_CHECKOUT_MESSAGE,
  androidStateDir,
  extraGradleArgs,
  managedSdkDir,
  requireRepoRoot,
  resolveRepoRoot,
} from '../../src/android/paths.js';
import { cleanupTemp, makeRepo, tempDir } from './fixtures.js';

afterEach(cleanupTemp);

describe('repo checkout resolution', () => {
  it('walks up from the cwd to the nearest ancestor holding apps/android/version.properties', () => {
    const repo = makeRepo();
    const deep = join(repo, 'apps', 'cli', 'src');
    mkdirSync(deep, { recursive: true });
    expect(resolveRepoRoot({ cwd: deep, env: {} })).toEqual({ root: repo, source: 'cwd' });
  });

  it('prefers --repo over MEMORIAHUB_REPO_ROOT over the cwd walk', () => {
    const fromFlag = makeRepo();
    const fromEnv = makeRepo();
    const fromCwd = makeRepo();
    const env = { MEMORIAHUB_REPO_ROOT: fromEnv };
    expect(resolveRepoRoot({ repo: fromFlag, env, cwd: fromCwd }).root).toBe(fromFlag);
    expect(resolveRepoRoot({ env, cwd: fromCwd })).toEqual({ root: fromEnv, source: 'env' });
    expect(resolveRepoRoot({ env: {}, cwd: fromCwd }).source).toBe('cwd');
  });

  it('never falls back to the cwd walk when an explicit --repo is not a checkout', () => {
    const notARepo = tempDir();
    const fromCwd = makeRepo();
    const resolution = resolveRepoRoot({ repo: notARepo, env: {}, cwd: fromCwd });
    expect(resolution.root).toBeUndefined();
    expect(resolution.rejected).toContain('--repo');
  });

  it('a directory with apps/android but no version.properties is not a checkout', () => {
    const repo = makeRepo({ version: null });
    expect(resolveRepoRoot({ env: {}, cwd: repo }).root).toBeUndefined();
  });

  it('fails with exit code 6 and the clone-the-repo message when nothing is found', () => {
    const nowhere = tempDir();
    let caught: unknown;
    try {
      requireRepoRoot({ env: {}, cwd: nowhere });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PreconditionError);
    expect((caught as PreconditionError).exitCode).toBe(EXIT.PRECONDITION);
    expect((caught as Error).message).toBe(NO_CHECKOUT_MESSAGE);
    expect(NO_CHECKOUT_MESSAGE).toContain('git clone https://github.com/marinoscar/MemoriaHub.git');
    expect(NO_CHECKOUT_MESSAGE).toContain('--repo <path>');
  });
});

describe('state locations', () => {
  it('lives under ~/.memoriahub unless MEMORIAHUB_STATE_DIR moves it', () => {
    expect(androidStateDir({ env: {}, home: '/home/u' })).toBe('/home/u/.memoriahub/android');
    expect(managedSdkDir({ env: {}, home: '/home/u' })).toBe('/home/u/.memoriahub/android-sdk');
    expect(androidStateDir({ env: { MEMORIAHUB_STATE_DIR: '/data/mh' }, home: '/home/u' })).toBe('/data/mh/android');
  });
});

describe('MEMORIAHUB_GRADLE_ARGS', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(extraGradleArgs({})).toEqual([]);
    expect(
      extraGradleArgs({ MEMORIAHUB_GRADLE_ARGS: `--no-daemon --max-workers=1 "-Dorg.gradle.jvmargs=-Xmx2g -XX:+UseG1GC" '-I a b.kts'` }),
    ).toEqual(['--no-daemon', '--max-workers=1', '-Dorg.gradle.jvmargs=-Xmx2g -XX:+UseG1GC', '-I a b.kts']);
  });
});
