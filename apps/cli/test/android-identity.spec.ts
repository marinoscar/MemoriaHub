import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCli } from '@marinoscar/platform-cli';
import { readAndroidIdentity } from '@marinoscar/platform-cli/android';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';

import { APP_CLI_OPTIONS } from '../src/app.js';
import { ANDROID_IDENTITY_SOURCE, ANDROID_REPO_ROOT_ENV, addLegacyAndroidFlags } from '../src/extensions/android.js';
import { Command } from 'commander';
import { APP_TUI_SCREENS } from '../src/tui/screens.js';

// =============================================================================
// The `android` group is the platform's (RETRO-D5, #586)
// =============================================================================

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the android group (RETRO-D5)', () => {
  beforeEach(() => resetCliForTests());

  it('carries the identity of packages/shared/identity.json for use outside a checkout', () => {
    const json = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'shared', 'identity.json'), 'utf8')) as {
      productName: string;
      repoSlug: string;
      android: Record<string, string>;
    };
    expect(ANDROID_IDENTITY_SOURCE.productName).toBe(json.productName);
    expect(ANDROID_IDENTITY_SOURCE.repoSlug).toBe(json.repoSlug);
    expect({ ...ANDROID_IDENTITY_SOURCE.android }).toEqual(json.android);
  });

  it('resolves the same identity from the checkout as from the configured source', () => {
    createCli(APP_CLI_OPTIONS);
    const fromCheckout = readAndroidIdentity(REPO_ROOT);
    const configured = readAndroidIdentity(undefined);
    expect(fromCheckout).toEqual(configured);
    expect(configured).toMatchObject({
      applicationId: 'memoriahub.marin.cr',
      storagePrefix: 'memoriahub',
      deepLinkScheme: 'memoriahub',
      apkStem: 'memoriahub-android',
    });
  });

  it('keeps every 1.4 subcommand and the release flags the docs name', () => {
    const { program } = createCli(APP_CLI_OPTIONS);
    const android = program.commands.find((c) => c.name() === 'android')!;
    expect(android.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['doctor', 'keystore', 'version', 'build', 'publish', 'releases', 'release']),
    );
    const releases = android.commands.find((c) => c.name() === 'releases')!;
    expect(releases.commands.map((c) => c.name())).toContain('current');
    const release = android.commands.find((c) => c.name() === 'release')!;
    const flags = release.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--bump', '--notes', '--server-url', '--no-commit']));
  });

  it('registers the platform Android screen at the route the menu entry opens', () => {
    const android = APP_TUI_SCREENS.filter((s) => s.route === 'android');
    expect(android).toHaveLength(1);
    expect(android[0].label).toBe('Android app (build, publish, releases)');
  });

  it('maps the 1.4 `android --repo` flag onto MEMORIAHUB_REPO_ROOT before the subcommand runs', async () => {
    const program = new Command().exitOverride();
    const android = program.command('android');
    let seen: string | undefined;
    android.command('version').action(() => {
      seen = env[ANDROID_REPO_ROOT_ENV];
    });
    const env: NodeJS.ProcessEnv = {};
    addLegacyAndroidFlags(program, env);

    await program.parseAsync(['node', 'memoriahub', 'android', '--repo', '/tmp/checkout-a', 'version']);

    expect(ANDROID_REPO_ROOT_ENV).toBe('MEMORIAHUB_REPO_ROOT');
    expect(seen).toBe('/tmp/checkout-a');
  });
});
