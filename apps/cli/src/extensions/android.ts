// =============================================================================
// The Android companion's CLI group: the platform's `android` command  (RETRO-D5, #586)
// =============================================================================
//
// `memoriahub android doctor|keystore|version|build|publish|releases|current|release` is
// `androidCommand` of `@marinoscar/platform-cli/android` (the group EAB harvested from this
// CLI), registered through `createCli({ extraCommands })` in `app.ts`, and the TUI's
// "Android app" screen is its `androidTuiScreen` (route `android`, the menu entry of
// `tui/menu.ts`). The keystore stays `~/.memoriahub/android`, the checkout override
// `MEMORIAHUB_REPO_ROOT`, the extra Gradle arguments `MEMORIAHUB_GRADLE_ARGS`.
//
// The identity below is used OUTSIDE a checkout (`releases`, `current` against a server);
// inside one, `packages/shared/identity.json` on disk wins, as it is what the APK is built
// with. `test/android-identity.spec.ts` fails when this copy drifts from that file.
//
// No `androidDeployStep`: a deploy never publishes an APK (Android rule 10); releases go
// through `memoriahub android release`.
//
// PLATFORM-ADOPTION-SHIM(RETRO-D5): three 1.4 flags the platform group does not declare are kept
// (zero flag loss, `test/help-parity.spec.ts`), added to the registered tree:
//   `android --repo <path>`        sets MEMORIAHUB_REPO_ROOT for the subcommand (same meaning)
//   `android doctor -y, --yes`      accepted, no effect: the platform `--fix` never asks
//   `android releases current -y`   accepted, no effect: the platform makes current without asking
// Behaviour the platform changed (documented in apps/cli/README.md): `release` without `--bump`
// now bumps the patch version (1.4 released the current version when it was newer), and
// `doctor --fix` installs only the Android SDK, never the JDK.
// =============================================================================

import { resolve } from 'node:path';

import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import { androidCommand, androidTuiScreen, type AndroidIdentitySource } from '@marinoscar/platform-cli/android';
import type { Command } from 'commander';

/** `packages/shared/identity.json`: the product and its `android` block. */
export const ANDROID_IDENTITY_SOURCE: AndroidIdentitySource = Object.freeze({
  productName: 'MemoriaHub',
  repoSlug: 'marinoscar/MemoriaHub',
  android: Object.freeze({
    applicationId: 'memoriahub.marin.cr',
    storagePrefix: 'memoriahub',
    deepLinkScheme: 'memoriahub',
    apkStem: 'memoriahub-android',
  }),
});

/** The environment variable the platform group reads for an explicit checkout. */
export const ANDROID_REPO_ROOT_ENV = 'MEMORIAHUB_REPO_ROOT';

function sub(parent: Command | undefined, name: string): Command | undefined {
  return parent?.commands.find((command) => command.name() === name);
}

/** Adds the three 1.4 flags the platform group lacks (see the header). Exported for the specs. */
export function addLegacyAndroidFlags(program: Command, env: NodeJS.ProcessEnv = process.env): void {
  const android = sub(program, 'android');
  if (!android) return;
  android.option(
    '--repo <path>',
    `MemoriaHub checkout to use (else ${ANDROID_REPO_ROOT_ENV}, else the nearest ancestor with apps/android)`,
  );
  android.hook('preAction', (thisCommand) => {
    const repo = thisCommand.opts<{ repo?: string }>().repo;
    if (typeof repo === 'string' && repo !== '') env[ANDROID_REPO_ROOT_ENV] = resolve(repo);
  });
  sub(android, 'doctor')?.option('-y, --yes', 'Accepted for compatibility: --fix never asks');
  sub(sub(android, 'releases'), 'current')?.option('-y, --yes', 'Accepted for compatibility: making a release current never asks');
}

const platformAndroidCommand = androidCommand({ identity: ANDROID_IDENTITY_SOURCE });

/** The `android` command group registration: the platform group plus the 1.4 flags. */
export const APP_ANDROID_COMMAND: CliCommandRegistration = (program) => {
  platformAndroidCommand(program);
  addLegacyAndroidFlags(program as unknown as Command);
};

/** The TUI's Android screen (route `android`). */
export const APP_ANDROID_TUI_SCREEN = androidTuiScreen;
