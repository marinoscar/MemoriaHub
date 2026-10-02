import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { assertSignerMatches, parseApksignerSha256, runBuild } from '../../src/android/build.js';
import { PreconditionError } from '../../src/android/errors.js';
import type { ExecOptions } from '../../src/android/exec.js';
import { builtApkCandidates, gradleArgs, resolveBuiltApk } from '../../src/android/gradle.js';
import { cleanupTemp, envFor, fakeExec, makeRepo, makeSdk, makeState, SHA_HEX, toolchain, type Responder } from './fixtures.js';

afterEach(cleanupTemp);

describe('gradle arguments', () => {
  it('assembles release/debug with -Papp.* properties, --console=plain and the extra args last', () => {
    expect(gradleArgs({ debug: false, versionName: '2.0.1', versionCode: 101, serverUrl: 'https://p.example', extra: ['--max-workers=1'] })).toEqual([
      'assembleRelease',
      '-Papp.versionName=2.0.1',
      '-Papp.versionCode=101',
      '-Papp.serverUrl=https://p.example',
      '--console=plain',
      '--max-workers=1',
    ]);
    expect(gradleArgs({ debug: true, versionName: '2.0.1', versionCode: 101 })).toEqual([
      'assembleDebug',
      '-Papp.versionName=2.0.1',
      '-Papp.versionCode=101',
      '--console=plain',
    ]);
  });

  it('resolves the signed output first, else reports an unsigned release', () => {
    const candidates = builtApkCandidates('/p', false);
    expect(resolveBuiltApk(candidates, (path) => path.endsWith('app-release.apk'))).toEqual({ path: candidates.signed, signed: true });
    expect(resolveBuiltApk(candidates, (path) => path.endsWith('app-release-unsigned.apk'))).toEqual({ path: candidates.unsigned, signed: false });
    expect(resolveBuiltApk(candidates, () => false)).toBeUndefined();
    expect(builtApkCandidates('/p', true).signed).toBe('/p/app/build/outputs/apk/debug/app-debug.apk');
  });

  it('parses apksigner and compares signers', () => {
    expect(parseApksignerSha256(`Signer #1 certificate SHA-256 digest: ${SHA_HEX.toUpperCase()}`)).toBe(SHA_HEX);
    expect(() => assertSignerMatches('ff'.repeat(32), SHA_HEX)).toThrow(/not by the configured keystore/);
    expect(() => assertSignerMatches(undefined, SHA_HEX)).toThrow(PreconditionError);
  });
});

/** A Gradle that writes the given output file. */
function gradleWrites(file: 'app-release.apk' | 'app-release-unsigned.apk' | 'app-debug.apk', base: Responder = toolchain()): Responder {
  return (command, args, options: ExecOptions | undefined) => {
    if (command.endsWith('gradlew')) {
      const variant = file === 'app-debug.apk' ? 'debug' : 'release';
      const out = join(options?.cwd ?? '', 'app', 'build', 'outputs', 'apk', variant, file);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, 'PK\u0003\u0004apk-bytes');
      return {};
    }
    return base(command, args, options);
  };
}

describe('android build', () => {
  it('builds, verifies the signer, copies to dist/android and writes the sidecar JSON', async () => {
    const repo = makeRepo();
    const state = makeState();
    const sdk = makeSdk();
    const { exec, calls } = fakeExec(gradleWrites('app-release.apk'));
    const env = envFor(state, sdk, { GRADLE_OPTS: '-Xmx2g', MEMORIAHUB_GRADLE_ARGS: '--no-daemon --max-workers=1' });
    const result = await runBuild({ serverUrl: 'https://photos.example' }, { cwd: repo, env, exec, platform: 'linux', log: () => {} });

    const gradle = calls.find((call) => call.command.endsWith('gradlew'))!;
    expect(gradle.args).toEqual([
      'assembleRelease',
      '-Papp.versionName=2.0.0',
      '-Papp.versionCode=100',
      '-Papp.serverUrl=https://photos.example',
      '--console=plain',
      '--no-daemon',
      '--max-workers=1',
    ]);
    expect(gradle.options?.env).toMatchObject({
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      GRADLE_OPTS: '-Xmx2g',
      ANDROID_KEYSTORE_FILE: join(state, 'android', 'release.jks'),
      ANDROID_KEYSTORE_PASSWORD: 'secret-pass',
      ANDROID_KEY_ALIAS: 'memoriahub',
      ANDROID_KEY_PASSWORD: 'secret-pass',
    });
    expect(gradle.args.join(' ')).not.toContain('secret-pass');
    expect(calls.some((call) => call.command.endsWith('apksigner') && call.args[0] === 'verify')).toBe(true);

    expect(result.apkPath).toBe(join(repo, 'dist', 'android', 'memoriahub-android-2.0.0.apk'));
    expect(result.metadataPath).toBe(join(repo, 'dist', 'android', 'memoriahub-android-2.0.0.json'));
    const sidecar = JSON.parse(readFileSync(result.metadataPath, 'utf8'));
    expect(Object.keys(sidecar).sort()).toEqual(['builtAt', 'fileSha256', 'gitSha', 'packageName', 'signingSha256', 'sizeBytes', 'versionCode', 'versionName']);
    expect(sidecar).toMatchObject({ packageName: 'memoriahub.marin.cr', versionName: '2.0.0', versionCode: 100, signingSha256: SHA_HEX, sizeBytes: 13, gitSha: 'a'.repeat(40) });
    expect(sidecar.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails when apksigner reports another signer, and copies nothing', async () => {
    const repo = makeRepo();
    const { exec } = fakeExec(gradleWrites('app-release.apk', toolchain({ signer: 'ff'.repeat(32) })));
    await expect(
      runBuild({}, { cwd: repo, env: envFor(makeState(), makeSdk()), exec, platform: 'linux', log: () => {} }),
    ).rejects.toThrow(/signed by f{64}, not by the configured keystore/);
    expect(existsSync(join(repo, 'dist', 'android', 'memoriahub-android-2.0.0.apk'))).toBe(false);
  });

  it('refuses an unsigned release output', async () => {
    const { exec } = fakeExec(gradleWrites('app-release-unsigned.apk'));
    await expect(
      runBuild({}, { cwd: makeRepo(), env: envFor(makeState(), makeSdk()), exec, platform: 'linux', log: () => {} }),
    ).rejects.toThrow(/UNSIGNED release/);
  });

  it('refuses a release with no keystore before running Gradle; --debug needs none', async () => {
    const repo = makeRepo();
    const { exec, calls } = fakeExec(gradleWrites('app-debug.apk'));
    await expect(runBuild({}, { cwd: repo, env: envFor(makeState(false), makeSdk()), exec, platform: 'linux', log: () => {} })).rejects.toThrow(
      /No release keystore/,
    );
    expect(calls.some((call) => call.command.endsWith('gradlew'))).toBe(false);

    const debug = await runBuild({ debug: true }, { cwd: repo, env: envFor(makeState(false), makeSdk()), exec, platform: 'linux', log: () => {} });
    expect(debug.apkPath).toBe(join(repo, 'dist', 'android', 'memoriahub-android-2.0.0-debug.apk'));
    expect(debug.metadata.packageName).toBe('memoriahub.marin.cr.debug');
    expect(calls.find((call) => call.command.endsWith('gradlew'))?.args[0]).toBe('assembleDebug');
  });

  it('refuses a release when apksigner is missing (it cannot be verified)', async () => {
    const { exec } = fakeExec(gradleWrites('app-release.apk'));
    await expect(
      runBuild({}, { cwd: makeRepo(), env: envFor(makeState(), makeSdk({ apksigner: false })), exec, platform: 'linux', log: () => {} }),
    ).rejects.toThrow(/apksigner is missing/);
  });
});
