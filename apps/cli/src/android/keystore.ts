/**
 * android/keystore.ts — release signing: keystore + passwords (issue #517).
 *
 * The keystore lives at `~/.memoriahub/android/release.jks` and its passwords
 * in `~/.memoriahub/android/signing.json` (mode 0600, directory 0700). Both are
 * OUTSIDE every checkout on purpose: losing the keystore means no installed
 * copy can ever be updated again, and committing it means anyone can ship an
 * update as you.
 *
 * PASSWORDS NEVER REACH AN ARGV. keytool reads them with `-storepass:env NAME`
 * and Gradle reads ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD from its
 * environment, so they cannot show up in `ps`, a shell history, or the
 * "command failed" message `execChecked` builds from the argv.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PreconditionError } from './errors.js';
import { execChecked, type ExecFn } from './exec.js';
import { jdkBinary, jdkInstallHint } from './java.js';
import { androidStateDir, type AndroidPathsContext } from './paths.js';

export const KEYSTORE_FILE_NAME = 'release.jks';
export const SIGNING_FILE_NAME = 'signing.json';
export const DEFAULT_KEY_ALIAS = 'memoriahub';
export const DEFAULT_DNAME = 'CN=MemoriaHub, O=MemoriaHub';

/** Env names the passwords are read from (the same names Gradle and CI use). */
export const STORE_PASSWORD_ENV = 'ANDROID_KEYSTORE_PASSWORD';
export const KEY_PASSWORD_ENV = 'ANDROID_KEY_PASSWORD';

export const BACKUP_WARNING = 'BACK UP THIS FILE. Losing it forces every user to uninstall and reinstall.';

export interface SigningConfig {
  keystorePath: string;
  keyAlias: string;
  storePassword: string;
  keyPassword: string;
  /** Uppercase colon-separated SHA-256 of the signing certificate, cached at init/import. */
  certSha256?: string | undefined;
  updatedAt?: string | undefined;
}

export function keystorePath(ctx?: AndroidPathsContext): string {
  return join(androidStateDir(ctx), KEYSTORE_FILE_NAME);
}

export function signingConfigPath(ctx?: AndroidPathsContext): string {
  return join(androidStateDir(ctx), SIGNING_FILE_NAME);
}

/** Create `~/.memoriahub/android` with mode 0700 (and tighten it if it already exists). */
export function ensureStateDir(ctx?: AndroidPathsContext): string {
  const dir = androidStateDir(ctx);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrict(dir, 0o700);
  return dir;
}

/** `undefined` when nothing is configured; PreconditionError on a corrupt file. */
export function readSigningConfig(ctx?: AndroidPathsContext): SigningConfig | undefined {
  const file = signingConfigPath(ctx);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new PreconditionError(
      `${file} is not valid JSON. Fix it or run \`memoriahub android keystore import\` again.`,
      { cause },
    );
  }
  const value = parsed as Partial<SigningConfig>;
  for (const key of ['keystorePath', 'keyAlias', 'storePassword', 'keyPassword'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') {
      throw new PreconditionError(`${file} is missing "${key}". Run \`memoriahub android keystore import\` again.`);
    }
  }
  return value as SigningConfig;
}

/** Write signing.json atomically with mode 0600. */
export function writeSigningConfig(config: SigningConfig, ctx?: AndroidPathsContext): string {
  ensureStateDir(ctx);
  const target = signingConfigPath(ctx);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, target);
  restrict(target);
  return target;
}

/** chmod; a no-op failure where POSIX modes do not exist (Windows). */
export function restrict(path: string, mode = 0o600): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows ACLs are not POSIX modes; the user profile directory is the protection there.
  }
}

/** The environment Gradle's release signing reads (apps/android/app/build.gradle.kts). */
export function signingEnv(config: SigningConfig): Record<string, string> {
  return {
    ANDROID_KEYSTORE_FILE: config.keystorePath,
    ANDROID_KEYSTORE_PASSWORD: config.storePassword,
    ANDROID_KEY_ALIAS: config.keyAlias,
    ANDROID_KEY_PASSWORD: config.keyPassword,
  };
}

/** Env names keytool reads the passwords from (`-storepass:env`). */
const STOREPASS_ENV = 'MEMORIAHUB_KS_STOREPASS';
const KEYPASS_ENV = 'MEMORIAHUB_KS_KEYPASS';

export interface KeytoolContext {
  exec: ExecFn;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
}

export function keytoolBinary(ctx: Pick<KeytoolContext, 'env' | 'platform'>): string {
  return jdkBinary('keytool', ctx.env ?? process.env, ctx.platform ?? process.platform);
}

const keytoolHint = (platform?: NodeJS.Platform): string => `keytool ships with the JDK. ${jdkInstallHint(platform)}`;

/** Extract `SHA256: AA:BB:…` from `keytool -list -v` output (uppercase colon form). */
export function parseSha256Fingerprint(output: string): string | undefined {
  const match = /SHA-?256:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){31})/i.exec(output);
  return match?.[1]?.toUpperCase();
}

/** `AA:BB:…` → `aabb…`. */
export function fingerprintToHex(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toLowerCase();
}

/** `aabb…` → `AA:BB:…`. */
export function hexToFingerprint(hex: string): string {
  const clean = hex.replace(/:/g, '').toUpperCase();
  return (clean.match(/.{2}/g) ?? []).join(':');
}

/** Read the signing certificate's SHA-256 (also proves the passwords and alias are right). */
export async function readCertificateSha256(config: SigningConfig, ctx: KeytoolContext): Promise<string> {
  const result = await execChecked(
    ctx.exec,
    keytoolBinary(ctx),
    ['-list', '-v', '-keystore', config.keystorePath, '-alias', config.keyAlias, '-storepass:env', STOREPASS_ENV],
    {
      env: { ...(ctx.env ?? process.env), [STOREPASS_ENV]: config.storePassword },
      missingHint: keytoolHint(ctx.platform),
    },
  );
  const sha = parseSha256Fingerprint(result.stdout);
  if (sha === undefined) {
    throw new PreconditionError(`keytool did not report a SHA-256 fingerprint for alias "${config.keyAlias}".`);
  }
  return sha;
}

export interface GenerateKeystoreOptions {
  path: string;
  alias: string;
  storePassword: string;
  keyPassword: string;
  /** X.500 distinguished name. */
  dname: string;
}

/** `keytool -genkeypair -keyalg RSA -keysize 4096 -validity 36500` (100 years). Refuses to overwrite. */
export async function generateKeystore(options: GenerateKeystoreOptions, ctx: KeytoolContext): Promise<void> {
  if (existsSync(options.path)) {
    throw new PreconditionError(
      `${options.path} already exists. Refusing to overwrite a release keystore: ` +
        'every installed copy of the app could never be updated again.',
    );
  }
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  restrict(dirname(options.path), 0o700);
  await execChecked(
    ctx.exec,
    keytoolBinary(ctx),
    [
      '-genkeypair',
      '-keystore', options.path,
      '-storetype', 'PKCS12',
      '-alias', options.alias,
      '-keyalg', 'RSA',
      '-keysize', '4096',
      '-validity', '36500',
      '-dname', options.dname,
      '-storepass:env', STOREPASS_ENV,
      '-keypass:env', KEYPASS_ENV,
    ],
    {
      env: { ...(ctx.env ?? process.env), [STOREPASS_ENV]: options.storePassword, [KEYPASS_ENV]: options.keyPassword },
      missingHint: keytoolHint(ctx.platform),
    },
  );
  restrict(options.path);
}

/** Copy an existing keystore into the managed location (mode 0600). Returns the new path. */
export function importKeystoreFile(source: string, ctx?: AndroidPathsContext): string {
  if (!existsSync(source)) throw new PreconditionError(`${source} does not exist.`);
  const target = keystorePath(ctx);
  ensureStateDir(ctx);
  copyFileSync(source, target);
  restrict(target);
  return target;
}

/** The four GitHub Actions secrets `.github/workflows/android.yml` (#518) reads. */
export function githubSecrets(config: SigningConfig): Array<{ name: string; value: string }> {
  return [
    { name: 'ANDROID_KEYSTORE_BASE64', value: readFileSync(config.keystorePath).toString('base64') },
    { name: 'ANDROID_KEYSTORE_PASSWORD', value: config.storePassword },
    { name: 'ANDROID_KEY_ALIAS', value: config.keyAlias },
    { name: 'ANDROID_KEY_PASSWORD', value: config.keyPassword },
  ];
}

export function requireSigning(ctx?: AndroidPathsContext): SigningConfig {
  const config = readSigningConfig(ctx);
  if (config === undefined) {
    throw new PreconditionError(
      'No release keystore is configured. Run `memoriahub android keystore init` (or `keystore import <file>`).',
    );
  }
  return config;
}
