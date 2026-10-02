/**
 * android/build.ts — `memoriahub android build` (issue #517).
 *
 *   gradlew assembleRelease|assembleDebug -Papp.versionName=… -Papp.versionCode=…
 *           [-Papp.serverUrl=…] --console=plain  $MEMORIAHUB_GRADLE_ARGS
 *
 * The child environment is the caller's (so GRADLE_OPTS, JAVA_HOME, proxies
 * pass through) plus ANDROID_HOME/ANDROID_SDK_ROOT and, for a release, the
 * four signing variables from `~/.memoriahub/android/signing.json`.
 *
 * A release APK must be SIGNED BY THE CONFIGURED KEYSTORE: `apksigner verify
 * --print-certs` is required, and a signer that differs from the keystore's
 * fingerprint (or an `app-release-unsigned.apk`) fails the build — publishing
 * such an APK would make every installed copy refuse the update.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { PreconditionError } from './errors.js';
import { exec as defaultExec, execChecked, type ExecFn } from './exec.js';
import { builtApkCandidates, gradleArgs, gradlewPath, resolveBuiltApk } from './gradle.js';
import { apkFileName, readIdentity } from './identity.js';
import { fingerprintToHex, readCertificateSha256, readSigningConfig, signingEnv } from './keystore.js';
import { buildMetadata, metadataPathFor, readGitSha, writeMetadata, type ApkMetadata } from './metadata.js';
import { androidProjectDir, distDir, extraGradleArgs, requireRepoRoot, versionPropertiesPath } from './paths.js';
import { resolveSdk, sdkEnv, sdkLayout } from './sdk.js';
import { readVersion } from './version.js';

export interface BuildOptions {
  serverUrl?: string | undefined;
  debug?: boolean | undefined;
}

export interface BuildContext {
  repo?: string | undefined;
  exec?: ExecFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  exists?: ((path: string) => boolean) | undefined;
  log: (line: string) => void;
}

export interface BuildResult {
  apkPath: string;
  metadataPath: string;
  metadata: ApkMetadata;
  /** apksigner verified the signature (always true for a release). */
  verified: boolean;
  gradleArgs: string[];
}

/** `Signer #1 certificate SHA-256 digest: <hex>` from `apksigner verify --print-certs`. */
export function parseApksignerSha256(output: string): string | undefined {
  const match = /Signer #1 certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(output);
  return match?.[1]?.toLowerCase();
}

/** The signer must equal the keystore's certificate. */
export function assertSignerMatches(actual: string | undefined, expected: string): void {
  if (actual === undefined) {
    throw new PreconditionError('apksigner did not report a signer certificate: the APK is not signed.');
  }
  if (actual !== expected) {
    throw new PreconditionError(
      `The APK is signed by ${actual}, not by the configured keystore (${expected}). ` +
        'Was it built unsigned or with another key? Nothing was copied to dist/android.',
    );
  }
}

export async function runBuild(options: BuildOptions, ctx: BuildContext): Promise<BuildResult> {
  const exec = ctx.exec ?? defaultExec;
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const exists = ctx.exists ?? existsSync;
  const paths = { repo: ctx.repo, env, home: ctx.home, cwd: ctx.cwd };
  const debug = options.debug === true;

  const repoRoot = requireRepoRoot(paths);
  const projectDir = androidProjectDir(repoRoot);
  const versionFile = versionPropertiesPath(repoRoot);
  const version = readVersion(versionFile);
  if (!version.exists) throw new PreconditionError(`${versionFile} is missing. Restore it from git.`);
  const identity = readIdentity(repoRoot);

  const sdk = resolveSdk({ env, platform, exists, ...(ctx.home !== undefined ? { home: ctx.home } : {}) });
  if (!sdk.exists) {
    throw new PreconditionError('No Android SDK found. Run `memoriahub android doctor --fix`.');
  }

  const signing = debug ? undefined : readSigningConfig(paths);
  if (!debug && signing === undefined) {
    throw new PreconditionError(
      'No release keystore is configured. Run `memoriahub android keystore init` (or `keystore import <file>`), or build with --debug.',
    );
  }
  const apksigner = sdkLayout(sdk.root, platform).apksigner;
  if (!debug && !exists(apksigner)) {
    throw new PreconditionError(`apksigner is missing (${apksigner}); a release cannot be verified. Run \`memoriahub android doctor --fix\`.`);
  }

  const wrapper = gradlewPath(projectDir, platform);
  if (!exists(wrapper)) throw new PreconditionError(`${wrapper} is missing. Restore it from git.`);

  // The certificate the APK must carry, read BEFORE minutes of Gradle (also proves the passwords).
  const expected =
    signing === undefined ? undefined : fingerprintToHex(await readCertificateSha256(signing, { exec, env, platform }));

  const childEnv: NodeJS.ProcessEnv = {
    ...sdkEnv(sdk.root, env),
    ...(signing === undefined ? {} : signingEnv(signing)),
  };

  // Never pick up a stale APK from an earlier build.
  const candidates = builtApkCandidates(projectDir, debug);
  for (const path of [candidates.signed, candidates.unsigned]) {
    if (path !== undefined) rmSync(path, { force: true });
  }

  const args = gradleArgs({
    debug,
    versionName: version.versionName,
    versionCode: version.versionCode,
    serverUrl: options.serverUrl,
    extra: extraGradleArgs(env),
  });
  ctx.log(`Building ${debug ? 'debug' : 'release'} ${version.versionName} (${version.versionCode}) with Gradle…`);
  await execChecked(exec, wrapper, args, {
    cwd: projectDir,
    env: childEnv,
    platform,
    missingHint: 'Restore apps/android/gradlew from git (and make it executable).',
    onLine: (line) => ctx.log(`  ${line}`),
  });

  const output = resolveBuiltApk(candidates, exists);
  if (output === undefined) {
    throw new PreconditionError(`Gradle finished but no APK was found at ${candidates.signed}.`);
  }
  if (!debug && !output.signed) {
    throw new PreconditionError(
      `Gradle produced an UNSIGNED release (${output.path}): the signing variables did not reach it. Check \`memoriahub android keystore show\`.`,
    );
  }

  let actual: string | undefined;
  if (exists(apksigner)) {
    const verify = await execChecked(exec, apksigner, ['verify', '--print-certs', output.path], { env: childEnv, platform });
    actual = parseApksignerSha256(verify.stdout);
    if (expected !== undefined) assertSignerMatches(actual, expected);
    ctx.log(`apksigner: signature verified (${actual ?? 'unknown signer'}).`);
  } else {
    ctx.log(`apksigner not found at ${apksigner}; the debug APK's signature was not verified.`);
  }

  const signingSha256 = actual ?? expected;
  if (signingSha256 === undefined) {
    throw new PreconditionError('Could not determine the signing certificate. Install build-tools (`android doctor --fix`).');
  }

  const dist = distDir(repoRoot);
  mkdirSync(dist, { recursive: true });
  const apkPath = join(dist, apkFileName(identity, version.versionName, debug));
  copyFileSync(output.path, apkPath);

  const metadata = await buildMetadata({
    apkPath,
    packageName: debug ? `${identity.applicationId}.debug` : identity.applicationId,
    versionName: version.versionName,
    versionCode: version.versionCode,
    signingSha256,
    gitSha: await readGitSha(exec, repoRoot),
  });
  const metadataPath = metadataPathFor(apkPath);
  writeMetadata(metadataPath, metadata);

  return { apkPath, metadataPath, metadata, verified: actual !== undefined, gradleArgs: args };
}
