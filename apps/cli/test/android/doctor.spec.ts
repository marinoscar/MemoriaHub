import { join } from 'node:path';

import { doctorJson, formatAndroidDoctorReport, runAndroidDoctor, type AndroidCheck } from '../../src/android/doctor.js';
import { ToolMissingError } from '../../src/android/exec.js';
import { cleanupTemp, envFor, fakeExec, makeRepo, makeSdk, makeState, tempDir, toolchain, SHA_COLON } from './fixtures.js';

afterEach(cleanupTemp);

function byId(checks: AndroidCheck[]): Record<string, AndroidCheck> {
  return Object.fromEntries(checks.map((check) => [check.id, check]));
}

describe('android doctor verdicts', () => {
  it('passes on a complete toolchain', async () => {
    const repo = makeRepo();
    const sdk = makeSdk();
    const state = makeState();
    const { exec } = fakeExec(toolchain());
    const report = await runAndroidDoctor({ cwd: repo, env: envFor(state, sdk), home: tempDir(), exec, platform: 'linux' });
    const checks = byId(report.checks);
    expect(report.ok).toBe(true);
    expect(checks['repo']?.status).toBe('pass');
    expect(checks['version']?.detail).toBe('2.0.0 (100)');
    expect(checks['jdk']?.detail).toBe('Java 21 (21.0.11)');
    expect(checks['sdk']?.detail).toContain('ANDROID_HOME');
    for (const id of ['platform-tools', 'platform', 'build-tools', 'apksigner', 'keystore']) {
      expect(checks[id]?.status).toBe('pass');
    }
    expect(checks['fingerprint']?.detail).toBe(SHA_COLON);
  });

  it('fails the repo check outside a checkout and skips what depends on it', async () => {
    const { exec } = fakeExec(toolchain());
    const report = await runAndroidDoctor({ cwd: tempDir(), env: envFor(makeState(), makeSdk()), home: tempDir(), exec, platform: 'linux' });
    const checks = byId(report.checks);
    expect(report.ok).toBe(false);
    expect(checks['repo']?.status).toBe('fail');
    expect(checks['repo']?.fix).toContain('git clone');
    expect(checks['gradlew']?.status).toBe('skip');
  });

  it('fails a JDK older than 17, a missing java, and a missing gradlew', async () => {
    const repo = makeRepo({ gradlew: false });
    const old = await runAndroidDoctor({
      cwd: repo,
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(toolchain({ javaVersion: '1.8.0_202' })).exec,
      platform: 'linux',
    });
    expect(byId(old.checks)['jdk']).toMatchObject({ status: 'fail', detail: 'Found Java 8 (1.8.0_202)' });
    expect(byId(old.checks)['gradlew']?.status).toBe('fail');

    const missing = await runAndroidDoctor({
      cwd: repo,
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec((command) => {
        if (command === 'java') throw new ToolMissingError('`java` was not found.');
        return toolchain()(command, ['-list'], undefined);
      }).exec,
      platform: 'linux',
    });
    expect(byId(missing.checks)['jdk']?.status).toBe('fail');
    expect(byId(missing.checks)['jdk']?.fix).toContain('doctor --fix');
  });

  it('fails and skips the SDK parts when there is no SDK', async () => {
    const home = tempDir();
    const report = await runAndroidDoctor({
      cwd: makeRepo(),
      env: envFor(makeState(), join(home, 'no-sdk')),
      home,
      exec: fakeExec(toolchain()).exec,
      platform: 'linux',
    });
    const checks = byId(report.checks);
    expect(checks['sdk']).toMatchObject({ status: 'fail', fix: 'Run `memoriahub android doctor --fix`.' });
    expect(checks['apksigner']?.status).toBe('skip');
    expect(report.ok).toBe(false);
  });

  it('a missing apksigner/platform is required; missing cmdline-tools is only a warning', async () => {
    const sdk = makeSdk({ apksigner: false, sdkmanager: false, platform: false });
    const report = await runAndroidDoctor({ cwd: makeRepo(), env: envFor(makeState(), sdk), home: tempDir(), exec: fakeExec(toolchain()).exec, platform: 'linux' });
    const checks = byId(report.checks);
    expect(checks['apksigner']?.status).toBe('fail');
    expect(checks['platform']?.status).toBe('fail');
    expect(checks['cmdline-tools']?.status).toBe('warn');
  });

  it('an absent keystore is a warning (never created by --fix); a broken signing.json fails', async () => {
    const absent = await runAndroidDoctor({ cwd: makeRepo(), env: envFor(makeState(false), makeSdk()), home: tempDir(), exec: fakeExec(toolchain()).exec, platform: 'linux' });
    expect(byId(absent.checks)['keystore']).toMatchObject({ status: 'warn' });
    expect(byId(absent.checks)['keystore']?.fix).toContain('keystore init');
    expect(absent.ok).toBe(true);

    const wrongPassword = await runAndroidDoctor({
      cwd: makeRepo(),
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec((command, args, options) =>
        command === 'keytool' ? { code: 1, stderr: 'keytool error: password was incorrect' } : toolchain()(command, args, options),
      ).exec,
      platform: 'linux',
    });
    expect(byId(wrongPassword.checks)['fingerprint']?.status).toBe('fail');
    expect(wrongPassword.ok).toBe(false);
  });

  it('the login row is a hint: a warning when logged out, never a failure', async () => {
    const report = await runAndroidDoctor({
      cwd: makeRepo(),
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(toolchain()).exec,
      platform: 'linux',
      login: async () => ({ loggedIn: false, detail: 'Not logged in' }),
    });
    expect(byId(report.checks)['login']).toMatchObject({ status: 'warn', detail: 'Not logged in' });
    expect(report.ok).toBe(true);
  });

  it('--json is exactly { ok, checks: [{ id, label, status, detail, fix? }] }', async () => {
    const report = await runAndroidDoctor({ cwd: makeRepo(), env: envFor(makeState(false), makeSdk()), home: tempDir(), exec: fakeExec(toolchain()).exec, platform: 'linux' });
    const json = doctorJson(report);
    expect(Object.keys(json).sort()).toEqual(['checks', 'ok']);
    for (const check of json.checks) {
      expect(Object.keys(check).every((key) => ['id', 'label', 'status', 'detail', 'fix'].includes(key))).toBe(true);
    }
    expect(formatAndroidDoctorReport(report, { colour: false })).toContain('Ready to build Android releases.');
  });
});
