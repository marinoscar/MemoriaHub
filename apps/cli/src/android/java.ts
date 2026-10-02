/**
 * android/java.ts — JDK detection (issue #517).
 *
 * The Android Gradle plugin needs JDK 17 or newer. This module finds one and
 * reads its version; installing one is `fix-plan.ts`'s job (apt on
 * Debian/Ubuntu, instructions elsewhere).
 */

import { join } from 'node:path';

export const MIN_JAVA_MAJOR = 17;

/** What `doctor --fix` installs on Debian/Ubuntu, in preference order. */
export const APT_JDK_PACKAGES = ['openjdk-17-jdk-headless', 'openjdk-21-jdk-headless'] as const;

export interface JavaVersion {
  major: number;
  /** The quoted version string as printed, e.g. `21.0.11` or `1.8.0_202`. */
  raw: string;
}

/**
 * Parse `java -version` output (STDERR, possibly preceded by a
 * `Picked up JAVA_TOOL_OPTIONS` line):
 *   openjdk version "21.0.11" 2026-04-21 → 21
 *   openjdk version "17" 2021-09-14      → 17
 *   java version "1.8.0_202"             → 8 (legacy 1.x scheme)
 *   openjdk version "22-ea"              → 22
 */
export function parseJavaVersion(output: string): JavaVersion | undefined {
  const match = /version\s+"([^"]+)"/i.exec(output);
  const raw = match?.[1];
  if (raw === undefined) return undefined;

  const parts = raw.split(/[.\-_+]/);
  const first = Number.parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(first)) return undefined;

  if (first === 1) {
    const second = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(second)) return undefined;
    return { major: second, raw };
  }
  return { major: first, raw };
}

function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * A JDK binary (`java`, `keytool`): from `JAVA_HOME/bin` when set, else bare on
 * PATH. Gradle honours JAVA_HOME too, so doctor checks the JDK the build uses.
 */
export function jdkBinary(
  name: 'java' | 'keytool',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const javaHome = env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome.trim() !== '') {
    return join(javaHome.trim(), 'bin', exe(name, platform));
  }
  return exe(name, platform);
}

/** How to install a JDK by hand, per OS. */
export function jdkInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Install JDK 17+: `winget install Microsoft.OpenJDK.17` (or Temurin from adoptium.net), then set JAVA_HOME.';
    case 'darwin':
      return 'Install JDK 17+: `brew install --cask temurin@17` (or from adoptium.net), then set JAVA_HOME.';
    default:
      return (
        'Install JDK 17+: `memoriahub android doctor --fix` does it on Debian/Ubuntu ' +
        '(`apt-get install openjdk-17-jdk-headless`); on Fedora `sudo dnf install java-17-openjdk-devel`; ' +
        'or from adoptium.net, then set JAVA_HOME.'
      );
  }
}
