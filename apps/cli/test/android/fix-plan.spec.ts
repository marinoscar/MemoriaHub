import { join } from 'node:path';

import { runAndroidDoctor } from '../../src/android/doctor.js';
import {
  buildFixPlan,
  chooseAptJdkPackage,
  executableSteps,
  executeFixPlan,
  formatFixPlan,
  type ProbeRunner,
  type SudoRunner,
} from '../../src/android/fix-plan.js';
import { cleanupTemp, envFor, fakeExec, makeRepo, makeSdk, makeState, tempDir, toolchain } from './fixtures.js';

afterEach(cleanupTemp);

async function report(options: { javaVersion?: string; sdk?: 'full' | 'none' | 'no-sdkmanager'; keystore?: boolean }) {
  const home = tempDir();
  const sdk = options.sdk === 'none' ? join(home, 'missing-sdk') : makeSdk({ sdkmanager: options.sdk !== 'no-sdkmanager', platform: options.sdk !== 'no-sdkmanager' });
  return await runAndroidDoctor({
    cwd: makeRepo(),
    env: envFor(makeState(options.keystore !== false), sdk),
    home,
    exec: fakeExec(toolchain({ javaVersion: options.javaVersion ?? '21.0.11' })).exec,
    platform: 'linux',
  });
}

describe('doctor --fix plan', () => {
  it('installs openjdk-17-jdk-headless through apt on Debian/Ubuntu, printing sudo', async () => {
    const plan = buildFixPlan(await report({ javaVersion: '11.0.2' }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    expect(plan.steps.map((step) => step.kind)).toEqual(['jdk-apt']);
    expect(plan.steps[0]?.commands[0]).toBe('sudo apt-get update');
    expect(plan.steps[0]?.commands[1]).toContain('sudo apt-get install -y openjdk-17-jdk-headless');
    const asRoot = buildFixPlan(await report({ javaVersion: '11.0.2' }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => true });
    expect(asRoot.steps[0]?.commands[0]).toBe('apt-get update');
  });

  it('only prints instructions for the JDK elsewhere (never executed)', async () => {
    for (const [platform, family] of [['linux', 'other'], ['darwin', 'other'], ['win32', 'other']] as const) {
      const plan = buildFixPlan(await report({ javaVersion: '11.0.2' }), { platform, linuxFamily: () => family, isRoot: () => false });
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]).toMatchObject({ kind: 'jdk-manual', manual: true });
      expect(executableSteps(plan)).toEqual([]);
    }
  });

  it('downloads cmdline-tools, accepts licences and installs the packages when there is no SDK', async () => {
    const plan = buildFixPlan(await report({ sdk: 'none' }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    expect(plan.steps.map((step) => step.kind)).toEqual(['cmdline-tools', 'licenses', 'sdk-packages']);
    expect(plan.steps[0]?.commands[0]).toBe('https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip');
    expect(plan.steps[2]?.commands[0]).toContain('platform-tools platforms;android-36 build-tools;36.0.0');
  });

  it('never plans a keystore: it points to `keystore init` as a manual step', async () => {
    const plan = buildFixPlan(await report({ keystore: false }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    expect(plan.steps).toEqual([expect.objectContaining({ kind: 'keystore-manual', manual: true })]);
    expect(formatFixPlan(plan)).toContain('[manual]');
    expect(executableSteps(plan)).toEqual([]);
  });

  it('plans nothing on a healthy machine', async () => {
    const plan = buildFixPlan(await report({}), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    expect(plan.steps).toEqual([]);
    expect(formatFixPlan(plan)).toBe('Nothing to fix.\n');
  });
});

describe('executing the plan', () => {
  it('runs apt through the announced sudo runner, falling back to JDK 21 when 17 is not packaged', async () => {
    const plan = buildFixPlan(await report({ javaVersion: '11.0.2' }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    const sudoCalls: string[][] = [];
    const sudo: SudoRunner = async (cmd, args) => {
      sudoCalls.push([cmd, ...args]);
      return { ok: true, stdout: '', stderr: '' };
    };
    const probe: ProbeRunner = async (_cmd, args) =>
      args[1] === 'openjdk-21-jdk-headless' ? { code: 0, stdout: 'Package: openjdk-21-jdk-headless\n', stderr: '' } : { code: 100, stdout: '', stderr: 'E: No packages found' };
    const { exec, calls } = fakeExec();
    const log: string[] = [];
    await executeFixPlan(plan, { exec, log: (line) => log.push(line), sudo, probe });
    expect(sudoCalls).toEqual([['apt-get', 'update'], ['apt-get', 'install', '-y', 'openjdk-21-jdk-headless']]);
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('installing openjdk-21-jdk-headless');
  });

  it('prefers openjdk-17-jdk-headless when apt knows it', async () => {
    const probe: ProbeRunner = async () => ({ code: 0, stdout: 'Package: x\n', stderr: '' });
    expect(await chooseAptJdkPackage(probe)).toBe('openjdk-17-jdk-headless');
  });

  it('a failed apt-get stops the fix with the error', async () => {
    const plan = buildFixPlan(await report({ javaVersion: '11.0.2' }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    const sudo: SudoRunner = async () => ({ ok: false, stdout: '', stderr: 'E: Could not get lock' });
    await expect(executeFixPlan(plan, { exec: fakeExec().exec, log: () => {}, sudo, probe: async () => ({ code: 0, stdout: '', stderr: '' }) })).rejects.toThrow(
      /apt-get update failed: E: Could not get lock/,
    );
  });

  it('accepts licences and installs the packages with sdkmanager (feeding "y")', async () => {
    const plan = buildFixPlan(await report({ sdk: 'no-sdkmanager' }), { platform: 'linux', linuxFamily: () => 'debian', isRoot: () => false });
    // Pretend cmdline-tools are already there: drop the download step.
    plan.steps = plan.steps.filter((step) => step.kind !== 'cmdline-tools');
    const { exec, calls } = fakeExec();
    await executeFixPlan(plan, { exec, log: () => {} });
    expect(calls.map((call) => call.args)).toEqual([
      [`--sdk_root=${plan.sdkRoot}`, '--licenses'],
      [`--sdk_root=${plan.sdkRoot}`, 'platform-tools', 'platforms;android-36', 'build-tools;36.0.0'],
    ]);
    expect(calls[0]?.options?.input).toMatch(/^(y\n)+$/);
    expect(calls[1]?.options?.env?.['ANDROID_HOME']).toBe(plan.sdkRoot);
  });
});
