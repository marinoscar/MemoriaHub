/**
 * android/gradle.ts — Gradle invocation for apps/android (issue #517).
 *
 * The version is passed as `-Papp.versionName/-Papp.versionCode` explicitly so
 * the build carries version.properties' values as the CLI read them.
 * `MEMORIAHUB_GRADLE_ARGS` is appended (e.g. `--no-daemon --max-workers=1
 * -Dorg.gradle.jvmargs=-Xmx2g` on a small machine); `GRADLE_OPTS` and every
 * other variable reach Gradle unchanged through the inherited environment.
 */

import { join } from 'node:path';

export function gradlewPath(projectDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(projectDir, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

export interface GradleArgsInput {
  debug: boolean;
  versionName: string;
  versionCode: number;
  serverUrl?: string | undefined;
  extra?: readonly string[] | undefined;
}

export function gradleArgs(input: GradleArgsInput): string[] {
  return [
    input.debug ? 'assembleDebug' : 'assembleRelease',
    `-Papp.versionName=${input.versionName}`,
    `-Papp.versionCode=${input.versionCode}`,
    ...(input.serverUrl !== undefined && input.serverUrl !== '' ? [`-Papp.serverUrl=${input.serverUrl}`] : []),
    '--console=plain',
    ...(input.extra ?? []),
  ];
}

export interface BuiltApkCandidates {
  /** Signed output (debug always is: debug-signed). */
  signed: string;
  /** What AGP writes for a release with no signing config. */
  unsigned?: string | undefined;
}

/** Where AGP writes the APK. */
export function builtApkCandidates(projectDir: string, debug: boolean): BuiltApkCandidates {
  const outputs = join(projectDir, 'app', 'build', 'outputs', 'apk');
  return debug
    ? { signed: join(outputs, 'debug', 'app-debug.apk') }
    : {
        signed: join(outputs, 'release', 'app-release.apk'),
        unsigned: join(outputs, 'release', 'app-release-unsigned.apk'),
      };
}

export type ResolvedApk = { path: string; signed: boolean } | undefined;

/**
 * The APK a build produced. A signed output wins; a release build that only
 * produced `app-release-unsigned.apk` is reported as unsigned so the caller
 * can refuse to publish it.
 */
export function resolveBuiltApk(
  candidates: BuiltApkCandidates,
  exists: (path: string) => boolean,
): ResolvedApk {
  if (exists(candidates.signed)) return { path: candidates.signed, signed: true };
  if (candidates.unsigned !== undefined && exists(candidates.unsigned)) return { path: candidates.unsigned, signed: false };
  return undefined;
}
