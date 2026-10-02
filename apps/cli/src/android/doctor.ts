/**
 * android/doctor.ts — `memoriahub android doctor` (issue #517).
 *
 * Every check runs whatever the others found — a doctor that stops at the
 * first failure makes you run it once per problem — and each non-passing row
 * carries its own fix. `fail` rows are REQUIRED (the command exits 6);
 * `warn` rows are advice:
 *
 *   repo, gradlew, version, jdk, sdk, platform-tools, platform, build-tools,
 *   apksigner                                  → fail when broken
 *   keystore                                   → warn when absent (debug builds
 *                                                need none, and `--fix` never
 *                                                creates one); fail when present
 *                                                but unreadable
 *   fingerprint                                → fail when keytool rejects it
 *   cmdline-tools, licenses                    → warn (only `--fix` needs them)
 *   login                                      → warn: a hint, never required
 */

import { existsSync } from 'node:fs';

import { errorMessage } from './errors.js';
import { exec as defaultExec, type ExecFn } from './exec.js';
import { gradlewPath } from './gradle.js';
import { MIN_JAVA_MAJOR, jdkBinary, jdkInstallHint, parseJavaVersion, type JavaVersion } from './java.js';
import { keystorePath, readCertificateSha256, readSigningConfig, type SigningConfig } from './keystore.js';
import { androidProjectDir, NO_CHECKOUT_MESSAGE, resolveRepoRoot, versionPropertiesPath } from './paths.js';
import {
  BUILD_TOOLS_PACKAGE,
  PLATFORM_TOOLS_PACKAGE,
  SDK_PLATFORM_PACKAGE,
  resolveSdk,
  sdkLayout,
  type SdkLocation,
} from './sdk.js';
import { readVersion } from './version.js';

export type AndroidCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type AndroidCheckId =
  | 'repo'
  | 'gradlew'
  | 'version'
  | 'jdk'
  | 'sdk'
  | 'cmdline-tools'
  | 'platform-tools'
  | 'platform'
  | 'build-tools'
  | 'apksigner'
  | 'licenses'
  | 'keystore'
  | 'fingerprint'
  | 'login';

export interface AndroidCheck {
  id: AndroidCheckId;
  label: string;
  status: AndroidCheckStatus;
  detail: string;
  fix?: string | undefined;
}

export interface AndroidDoctorReport {
  ok: boolean;
  checks: AndroidCheck[];
  /** Not part of `--json`'s contract; used by `--fix` and the TUI. */
  sdk: SdkLocation;
  repoRoot: string | undefined;
  java: JavaVersion | undefined;
}

/** The login hint: computed by the caller (it reads config and may call the server). */
export interface LoginHint {
  loggedIn: boolean;
  detail: string;
}

export interface AndroidDoctorContext {
  repo?: string | undefined;
  exec?: ExecFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  exists?: ((path: string) => boolean) | undefined;
  /** Omitted → the login row is skipped. */
  login?: (() => Promise<LoginHint>) | undefined;
}

const SDK_FIX = 'Run `memoriahub android doctor --fix`.';
const KEYSTORE_FIX = 'Run `memoriahub android keystore init` (or `keystore import <file>`). `--fix` never creates one.';

export async function runAndroidDoctor(ctx: AndroidDoctorContext = {}): Promise<AndroidDoctorReport> {
  const exec = ctx.exec ?? defaultExec;
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const exists = ctx.exists ?? existsSync;
  const paths = { repo: ctx.repo, env, home: ctx.home, cwd: ctx.cwd };
  const checks: AndroidCheck[] = [];

  // ---- The checkout -----------------------------------------------------------
  const resolution = resolveRepoRoot(paths);
  const repoRoot = resolution.root;
  if (repoRoot === undefined) {
    checks.push({
      id: 'repo',
      label: 'MemoriaHub checkout',
      status: 'fail',
      detail: resolution.rejected ?? 'Not found in this directory or any parent',
      fix: NO_CHECKOUT_MESSAGE,
    });
    checks.push({ id: 'gradlew', label: 'Gradle wrapper', status: 'skip', detail: 'No checkout' });
    checks.push({ id: 'version', label: 'version.properties', status: 'skip', detail: 'No checkout' });
  } else {
    checks.push({ id: 'repo', label: 'MemoriaHub checkout', status: 'pass', detail: repoRoot });
    const wrapper = gradlewPath(androidProjectDir(repoRoot), platform);
    checks.push(
      exists(wrapper)
        ? { id: 'gradlew', label: 'Gradle wrapper', status: 'pass', detail: wrapper }
        : {
            id: 'gradlew',
            label: 'Gradle wrapper',
            status: 'fail',
            detail: `${wrapper} is missing`,
            fix: 'Restore it from git (`git checkout -- apps/android/gradlew`).',
          },
    );
    try {
      const version = readVersion(versionPropertiesPath(repoRoot));
      checks.push(
        version.exists
          ? { id: 'version', label: 'version.properties', status: 'pass', detail: `${version.versionName} (${version.versionCode})` }
          : {
              id: 'version',
              label: 'version.properties',
              status: 'fail',
              detail: `${versionPropertiesPath(repoRoot)} is missing`,
              fix: 'Restore it from git, or create it with `memoriahub android version --set 2.0.0`.',
            },
      );
    } catch (error) {
      checks.push({
        id: 'version',
        label: 'version.properties',
        status: 'fail',
        detail: errorMessage(error),
        fix: 'Fix the file: versionName=x.y.z and versionCode=<1..2100000000>.',
      });
    }
  }

  // ---- The JDK -------------------------------------------------------------------
  const java = jdkBinary('java', env, platform);
  const jdkLabel = `JDK ${MIN_JAVA_MAJOR}+`;
  let javaVersion: JavaVersion | undefined;
  try {
    const result = await exec(java, ['-version'], { env });
    javaVersion = parseJavaVersion(`${result.stderr}\n${result.stdout}`);
    if (javaVersion === undefined) {
      checks.push({ id: 'jdk', label: jdkLabel, status: 'fail', detail: `Could not read the version from \`${java} -version\``, fix: jdkInstallHint(platform) });
    } else if (javaVersion.major < MIN_JAVA_MAJOR) {
      checks.push({ id: 'jdk', label: jdkLabel, status: 'fail', detail: `Found Java ${javaVersion.major} (${javaVersion.raw})`, fix: jdkInstallHint(platform) });
    } else {
      checks.push({ id: 'jdk', label: jdkLabel, status: 'pass', detail: `Java ${javaVersion.major} (${javaVersion.raw})` });
    }
  } catch {
    checks.push({ id: 'jdk', label: jdkLabel, status: 'fail', detail: `\`${java}\` was not found`, fix: jdkInstallHint(platform) });
  }

  // ---- The SDK ---------------------------------------------------------------------
  const sdk = resolveSdk({ env, platform, exists, ...(ctx.home !== undefined ? { home: ctx.home } : {}) });
  const layout = sdkLayout(sdk.root, platform);
  const parts: Array<[AndroidCheckId, string, string, AndroidCheckStatus]> = [
    ['cmdline-tools', 'cmdline-tools (sdkmanager)', layout.sdkmanager, 'warn'],
    ['platform-tools', PLATFORM_TOOLS_PACKAGE, layout.platformToolsDir, 'fail'],
    ['platform', SDK_PLATFORM_PACKAGE, layout.platformDir, 'fail'],
    ['build-tools', BUILD_TOOLS_PACKAGE, layout.buildToolsDir, 'fail'],
    ['apksigner', 'apksigner', layout.apksigner, 'fail'],
    ['licenses', 'SDK licences accepted', layout.licenseFile, 'warn'],
  ];
  if (!sdk.exists) {
    checks.push({ id: 'sdk', label: 'Android SDK', status: 'fail', detail: `No SDK found (would install to ${sdk.root})`, fix: SDK_FIX });
    for (const [id, label] of parts) checks.push({ id, label, status: 'skip', detail: 'No SDK' });
  } else {
    checks.push({ id: 'sdk', label: 'Android SDK', status: 'pass', detail: `${sdk.root} (${sdk.source})` });
    for (const [id, label, path, missing] of parts) {
      checks.push(
        exists(path)
          ? { id, label, status: 'pass', detail: path }
          : { id, label, status: missing, detail: `${path} is missing`, fix: SDK_FIX },
      );
    }
  }

  // ---- Signing ---------------------------------------------------------------------
  let signing: SigningConfig | undefined;
  let signingError: string | undefined;
  try {
    signing = readSigningConfig(paths);
  } catch (error) {
    signingError = errorMessage(error);
  }
  if (signingError !== undefined) {
    checks.push({ id: 'keystore', label: 'Release keystore', status: 'fail', detail: signingError, fix: 'Re-run `memoriahub android keystore import <file>`.' });
    checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'skip', detail: 'No keystore' });
  } else if (signing === undefined) {
    checks.push({ id: 'keystore', label: 'Release keystore', status: 'warn', detail: `Not configured (expected ${keystorePath(paths)})`, fix: KEYSTORE_FIX });
    checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'skip', detail: 'No keystore' });
  } else if (!exists(signing.keystorePath)) {
    checks.push({
      id: 'keystore',
      label: 'Release keystore',
      status: 'fail',
      detail: `${signing.keystorePath} is missing`,
      fix: 'Restore it from your backup and run `memoriahub android keystore import <file>`.',
    });
    checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'skip', detail: 'No keystore' });
  } else {
    checks.push({ id: 'keystore', label: 'Release keystore', status: 'pass', detail: `${signing.keystorePath} (alias ${signing.keyAlias})` });
    try {
      const sha = await readCertificateSha256(signing, { exec, env, platform });
      checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'pass', detail: sha });
    } catch (error) {
      checks.push({
        id: 'fingerprint',
        label: 'Signing fingerprint',
        status: 'fail',
        detail: errorMessage(error).split('\n')[0] ?? 'keytool failed',
        fix: 'Check the alias and passwords: re-run `memoriahub android keystore import <file>` with the right ones.',
      });
    }
  }

  // ---- Login (a hint) ----------------------------------------------------------------
  if (ctx.login !== undefined) {
    try {
      const hint = await ctx.login();
      checks.push(
        hint.loggedIn
          ? { id: 'login', label: 'Server login', status: 'pass', detail: hint.detail }
          : { id: 'login', label: 'Server login', status: 'warn', detail: hint.detail, fix: 'Run `memoriahub login` (needed to publish, not to build).' },
      );
    } catch (error) {
      checks.push({ id: 'login', label: 'Server login', status: 'warn', detail: errorMessage(error), fix: 'Run `memoriahub login`.' });
    }
  }

  return { ok: checks.every((check) => check.status !== 'fail'), checks, sdk, repoRoot, java: javaVersion };
}

/** True when a check with this id failed. */
export function failed(report: AndroidDoctorReport, id: AndroidCheckId): boolean {
  return report.checks.some((check) => check.id === id && check.status === 'fail');
}

/** The `--json` payload: exactly `{ ok, checks }`. */
export function doctorJson(report: AndroidDoctorReport): { ok: boolean; checks: AndroidCheck[] } {
  return { ok: report.ok, checks: report.checks };
}

const SYMBOL: Record<AndroidCheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗', skip: '·' };
const COLOUR: Record<AndroidCheckStatus, string> = {
  pass: '\u001B[32m',
  warn: '\u001B[33m',
  fail: '\u001B[31m',
  skip: '\u001B[90m',
};
const RESET = '\u001B[0m';

/** The report as a table (human output). */
export function formatAndroidDoctorReport(report: AndroidDoctorReport, options: { colour: boolean }): string {
  const width = Math.max(...report.checks.map((check) => check.label.length));
  const paint = (status: AndroidCheckStatus, text: string) => (options.colour ? `${COLOUR[status]}${text}${RESET}` : text);
  const lines: string[] = [''];
  for (const check of report.checks) {
    lines.push(`  ${paint(check.status, SYMBOL[check.status])} ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.fix !== undefined && check.status !== 'pass') lines.push(`  ${' '.repeat(width + 4)}→ ${check.fix}`);
  }
  lines.push('', report.ok ? 'Ready to build Android releases.' : 'At least one required check failed.');
  return `${lines.join('\n')}\n`;
}
