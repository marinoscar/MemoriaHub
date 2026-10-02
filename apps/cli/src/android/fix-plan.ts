/**
 * android/fix-plan.ts — what `android doctor --fix` would do, and doing it (issue #517).
 *
 * `--fix` ALWAYS prints the plan first; it executes only with `--yes` or an
 * interactive confirm, and `--dry-run` prints the plan and executes NOTHING
 * (not even a read-only probe). The plan can contain:
 *
 *   jdk-apt         Debian/Ubuntu: `apt-get update` + `apt-get install -y
 *                   openjdk-17-jdk-headless` through `runWithSudoAnnounced()`
 *                   (node/install-deps.ts), so every privileged command is
 *                   printed before it runs. When the distro no longer ships 17
 *                   (Debian 13), `openjdk-21-jdk-headless` is installed instead.
 *   jdk-manual      Any other OS: install instructions, never executed.
 *   cmdline-tools   Download commandlinetools-<os>-13114758_latest.zip.
 *   licenses        `sdkmanager --licenses`.
 *   sdk-packages    `sdkmanager platform-tools platforms;android-36 build-tools;36.0.0`.
 *   keystore-manual A pointer to `android keystore init` — the fix NEVER
 *                   creates a keystore (it is the app's identity forever).
 */

import { mkdirSync } from 'node:fs';

import { failed, type AndroidDoctorReport } from './doctor.js';
import { AndroidCliError, EXIT } from './errors.js';
import type { ExecFn } from './exec.js';
import { acceptLicenses, installCmdlineTools, installSdkPackages } from './installer.js';
import { APT_JDK_PACKAGES, jdkInstallHint } from './java.js';
import { REQUIRED_SDK_PACKAGES, cmdlineToolsUrl, sdkLayout } from './sdk.js';

export type FixStepKind = 'jdk-apt' | 'jdk-manual' | 'cmdline-tools' | 'licenses' | 'sdk-packages' | 'keystore-manual';

export interface FixStep {
  kind: FixStepKind;
  title: string;
  /** What will run, for the printed plan (privileged ones carry their `sudo`). */
  commands: string[];
  /** Printed advice only; never executed. */
  manual: boolean;
}

export interface FixPlan {
  sdkRoot: string;
  steps: FixStep[];
}

export interface PlanEnvironment {
  platform?: NodeJS.Platform | undefined;
  /** Debian/Ubuntu detection (node/install-deps.ts `detectLinuxDistro`). */
  linuxFamily?: (() => 'debian' | 'other') | undefined;
  /** node/install-deps.ts `isRoot`. */
  isRoot?: (() => boolean) | undefined;
}

function defaultIsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function buildFixPlan(report: AndroidDoctorReport, envInfo: PlanEnvironment = {}): FixPlan {
  const platform = envInfo.platform ?? process.platform;
  const sudo = (envInfo.isRoot ?? defaultIsRoot)() ? '' : 'sudo ';
  const steps: FixStep[] = [];

  if (failed(report, 'jdk')) {
    const debian = platform === 'linux' && (envInfo.linuxFamily?.() ?? 'other') === 'debian';
    steps.push(
      debian
        ? {
            kind: 'jdk-apt',
            title: `Install a JDK through apt (${APT_JDK_PACKAGES[0]})`,
            commands: [
              `${sudo}apt-get update`,
              `${sudo}apt-get install -y ${APT_JDK_PACKAGES[0]}   (${APT_JDK_PACKAGES[1]} when 17 is not packaged)`,
            ],
            manual: false,
          }
        : { kind: 'jdk-manual', title: 'Install a JDK yourself (not automated on this OS)', commands: [jdkInstallHint(platform)], manual: true },
    );
  }

  const sdkRoot = report.sdk.root;
  const layout = sdkLayout(sdkRoot, platform);
  const needsPackages =
    failed(report, 'sdk') ||
    failed(report, 'platform-tools') ||
    failed(report, 'platform') ||
    failed(report, 'build-tools') ||
    failed(report, 'apksigner');
  if (needsPackages) {
    const hasSdkmanager = report.checks.some((check) => check.id === 'cmdline-tools' && check.status === 'pass');
    if (!hasSdkmanager) {
      steps.push({
        kind: 'cmdline-tools',
        title: `Download the Android command-line tools into ${layout.cmdlineToolsDir}`,
        commands: [cmdlineToolsUrl(platform)],
        manual: false,
      });
    }
    steps.push({ kind: 'licenses', title: 'Accept the Android SDK licences', commands: [`${layout.sdkmanager} --licenses`], manual: false });
    steps.push({
      kind: 'sdk-packages',
      title: `Install ${REQUIRED_SDK_PACKAGES.join(', ')}`,
      commands: [`${layout.sdkmanager} --sdk_root=${sdkRoot} ${REQUIRED_SDK_PACKAGES.join(' ')}`],
      manual: false,
    });
  }

  const keystore = report.checks.find((check) => check.id === 'keystore');
  if (keystore !== undefined && keystore.status !== 'pass') {
    steps.push({
      kind: 'keystore-manual',
      title: 'Create or import the release keystore yourself (never automatic)',
      commands: ['memoriahub android keystore init', 'memoriahub android keystore import <file>'],
      manual: true,
    });
  }

  return { sdkRoot, steps };
}

/** Steps `--fix` would actually execute. */
export function executableSteps(plan: FixPlan): FixStep[] {
  return plan.steps.filter((step) => !step.manual);
}

export function formatFixPlan(plan: FixPlan): string {
  if (plan.steps.length === 0) return 'Nothing to fix.\n';
  const lines = ['Plan:'];
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.manual ? '[manual] ' : ''}${step.title}`);
    for (const command of step.commands) lines.push(`       ${step.manual ? '→' : '$'} ${command}`);
  });
  return `${lines.join('\n')}\n`;
}

export type SudoRunner = (
  cmd: string,
  args: string[],
  opts?: { dryRun?: boolean },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** An unprivileged probe; `runProcess` from node/install-deps.ts by default. */
export type ProbeRunner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface ExecuteFixDeps {
  exec: ExecFn;
  log: (line: string) => void;
  fetch?: typeof globalThis.fetch | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Default: node/install-deps.ts `runWithSudoAnnounced` (lazy-loaded). */
  sudo?: SudoRunner | undefined;
  /** Default: node/install-deps.ts `runProcess` (lazy-loaded). */
  probe?: ProbeRunner | undefined;
}

const lazySudo: SudoRunner = async (cmd, args, opts) => (await import('../node/install-deps.js')).runWithSudoAnnounced(cmd, args, opts);
const lazyProbe: ProbeRunner = async (cmd, args) => (await import('../node/install-deps.js')).runProcess(cmd, args);

/** Pick the first JDK package apt knows about (17, else 21). */
export async function chooseAptJdkPackage(probe: ProbeRunner): Promise<string> {
  for (const pkg of APT_JDK_PACKAGES) {
    const result = await probe('apt-cache', ['show', pkg]).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    if (result.code === 0 && /^Package:/m.test(result.stdout)) return pkg;
  }
  return APT_JDK_PACKAGES[0];
}

async function installJdkWithApt(deps: ExecuteFixDeps): Promise<void> {
  const sudo = deps.sudo ?? lazySudo;
  const update = await sudo('apt-get', ['update']);
  if (!update.ok) throw new AndroidCliError(`apt-get update failed: ${update.stderr || update.stdout || '(no output)'}`, EXIT.FAILURE);
  const pkg = await chooseAptJdkPackage(deps.probe ?? lazyProbe);
  if (pkg !== APT_JDK_PACKAGES[0]) deps.log(`${APT_JDK_PACKAGES[0]} is not packaged here; installing ${pkg}.`);
  const install = await sudo('apt-get', ['install', '-y', pkg]);
  if (!install.ok) throw new AndroidCliError(`apt-get install ${pkg} failed: ${install.stderr || install.stdout || '(no output)'}`, EXIT.FAILURE);
  deps.log(`Installed ${pkg}.`);
}

/**
 * Run every executable step, in order. Never called for `--dry-run` (the
 * command prints the plan and returns), so a dry run spawns nothing at all.
 */
export async function executeFixPlan(plan: FixPlan, deps: ExecuteFixDeps): Promise<void> {
  const ctx = { exec: deps.exec, log: deps.log, fetch: deps.fetch, env: deps.env, platform: deps.platform };
  for (const step of executableSteps(plan)) {
    deps.log(`→ ${step.title}`);
    switch (step.kind) {
      case 'jdk-apt':
        await installJdkWithApt(deps);
        break;
      case 'cmdline-tools':
        mkdirSync(plan.sdkRoot, { recursive: true });
        await installCmdlineTools(plan.sdkRoot, ctx);
        break;
      case 'licenses':
        mkdirSync(plan.sdkRoot, { recursive: true });
        await acceptLicenses(plan.sdkRoot, ctx);
        break;
      case 'sdk-packages':
        await installSdkPackages(plan.sdkRoot, ctx);
        break;
      default:
        break;
    }
  }
}
