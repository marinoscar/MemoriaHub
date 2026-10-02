/**
 * test/android/fixtures.ts — throwaway checkouts, SDKs, state dirs and a fake
 * `exec` for the `memoriahub android` specs (issue #517). No real JDK, SDK,
 * Gradle or network is ever used by these specs.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecFn, ExecOptions, ExecResult } from '../../src/android/exec.js';

export const SHA_COLON = Array.from({ length: 32 }, (_, i) => (i + 0xa0).toString(16).toUpperCase().padStart(2, '0')).join(':');
export const SHA_HEX = SHA_COLON.replace(/:/g, '').toLowerCase();

const created: string[] = [];

export function tempDir(prefix = 'mh-android-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface RepoOptions {
  version?: string | null;
  gradlew?: boolean;
  identity?: boolean;
}

/** A minimal checkout: apps/android/{version.properties, identity.properties, gradlew}. */
export function makeRepo(options: RepoOptions = {}): string {
  const root = tempDir('mh-repo-');
  const app = join(root, 'apps', 'android');
  mkdirSync(app, { recursive: true });
  if (options.version !== null) {
    writeFileSync(
      join(app, 'version.properties'),
      options.version ?? '# The Android app version.\nversionName=2.0.0\nversionCode=100\n',
    );
  }
  if (options.identity !== false) {
    writeFileSync(join(app, 'identity.properties'), 'productName=MemoriaHub\napplicationId=memoriahub.marin.cr\napkStem=memoriahub-android\n');
  }
  if (options.gradlew !== false) {
    writeFileSync(join(app, 'gradlew'), '#!/bin/sh\n');
    chmodSync(join(app, 'gradlew'), 0o755);
  }
  return root;
}

/** A complete SDK layout (empty marker files). */
export function makeSdk(parts: { apksigner?: boolean; sdkmanager?: boolean; platform?: boolean } = {}): string {
  const root = tempDir('mh-sdk-');
  mkdirSync(join(root, 'platform-tools'), { recursive: true });
  if (parts.platform !== false) mkdirSync(join(root, 'platforms', 'android-36'), { recursive: true });
  mkdirSync(join(root, 'build-tools', '36.0.0'), { recursive: true });
  if (parts.apksigner !== false) writeFileSync(join(root, 'build-tools', '36.0.0', 'apksigner'), '');
  if (parts.sdkmanager !== false) {
    mkdirSync(join(root, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
    writeFileSync(join(root, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), '');
  }
  mkdirSync(join(root, 'licenses'), { recursive: true });
  writeFileSync(join(root, 'licenses', 'android-sdk-license'), 'x');
  return root;
}

/** A state dir holding a configured keystore (`signing.json` + a dummy `release.jks`). */
export function makeState(withKeystore = true): string {
  const state = tempDir('mh-state-');
  if (withKeystore) {
    const dir = join(state, 'android');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release.jks'), 'keystore');
    writeFileSync(
      join(dir, 'signing.json'),
      JSON.stringify({
        keystorePath: join(dir, 'release.jks'),
        keyAlias: 'memoriahub',
        storePassword: 'secret-pass',
        keyPassword: 'secret-pass',
        certSha256: SHA_COLON,
      }),
    );
  }
  return state;
}

export interface Call {
  command: string;
  args: readonly string[];
  options: ExecOptions | undefined;
}

export type Responder = (command: string, args: readonly string[], options: ExecOptions | undefined) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

/** A fake `exec` recording every call; the responder decides each result. */
export function fakeExec(responder: Responder = () => ({})): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, options });
    const result = await responder(command, args, options);
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

/** Typical toolchain answers: Java 21, keytool's fingerprint, apksigner's signer. */
export const toolchain =
  (overrides: { javaVersion?: string; signer?: string } = {}): Responder =>
  (command, args) => {
    if (command.endsWith('java') && args[0] === '-version') {
      return { stderr: `openjdk version "${overrides.javaVersion ?? '21.0.11'}" 2026-04-21\n` };
    }
    if (command.endsWith('keytool') && args[0] === '-list') {
      return { stdout: `Alias name: memoriahub\nCertificate fingerprints:\n\t SHA256: ${SHA_COLON}\n` };
    }
    if (command.endsWith('apksigner')) {
      return { stdout: `Signer #1 certificate DN: CN=MemoriaHub\nSigner #1 certificate SHA-256 digest: ${overrides.signer ?? SHA_HEX}\n` };
    }
    if (command === 'git') return { stdout: 'a'.repeat(40) };
    return {};
  };

export function envFor(state: string, sdk?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    MEMORIAHUB_STATE_DIR: state,
    ...(sdk === undefined ? {} : { ANDROID_HOME: sdk }),
    ...extra,
  };
}
