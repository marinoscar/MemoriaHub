/**
 * android/metadata.ts — the sidecar JSON written next to every built APK (issue #517).
 *
 *   dist/android/memoriahub-android-<versionName>.apk
 *   dist/android/memoriahub-android-<versionName>.json
 *
 * `android publish` reads it back so the upload carries exactly what was
 * built (no aapt parsing), and the admin page (#516) accepts it to auto-fill
 * an upload. `signingSha256` here is LOWERCASE HEX WITH NO COLONS; the server
 * normalises it to its uppercase colon form.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { PreconditionError } from './errors.js';
import type { ExecFn } from './exec.js';

export interface ApkMetadata {
  packageName: string;
  versionName: string;
  versionCode: number;
  /** Lowercase hex, no colons. */
  signingSha256: string;
  fileSha256: string;
  sizeBytes: number;
  builtAt: string;
  gitSha: string | null;
}

/** `foo.apk` → `foo.json`. */
export function metadataPathFor(apkPath: string): string {
  return join(dirname(apkPath), `${basename(apkPath).replace(/\.apk$/i, '')}.json`);
}

/** Streaming SHA-256 — an APK is never read into memory whole. */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** `git rev-parse HEAD`, or null outside a repository / without git. */
export async function readGitSha(exec: ExecFn, cwd: string): Promise<string | null> {
  try {
    const result = await exec('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = result.stdout.trim();
    return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** `AA:BB:…` or `aabb…` → `aabb…`. */
export function normalizeSha256Hex(value: string): string {
  return value.replace(/:/g, '').toLowerCase();
}

export interface BuildMetadataInput {
  apkPath: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  signingSha256: string;
  gitSha: string | null;
  now?: Date | undefined;
}

export async function buildMetadata(input: BuildMetadataInput): Promise<ApkMetadata> {
  return {
    packageName: input.packageName,
    versionName: input.versionName,
    versionCode: input.versionCode,
    signingSha256: normalizeSha256Hex(input.signingSha256),
    fileSha256: await fileSha256(input.apkPath),
    sizeBytes: statSync(input.apkPath).size,
    builtAt: (input.now ?? new Date()).toISOString(),
    gitSha: input.gitSha,
  };
}

export function writeMetadata(path: string, metadata: ApkMetadata): void {
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

export function readMetadata(path: string): ApkMetadata {
  if (!existsSync(path)) {
    throw new PreconditionError(
      `No build metadata at ${path}. Build with \`memoriahub android build\`, which writes it next to the APK.`,
    );
  }
  let value: Partial<ApkMetadata>;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ApkMetadata>;
  } catch (cause) {
    throw new PreconditionError(`${path} is not valid JSON.`, { cause });
  }
  const missing = (['packageName', 'versionName', 'versionCode', 'signingSha256'] as const).filter(
    (key) => value[key] === undefined || value[key] === '',
  );
  if (missing.length > 0) {
    throw new PreconditionError(`${path} is missing ${missing.join(', ')}.`);
  }
  return value as ApkMetadata;
}

/** The metadata `android build` wrote next to an APK. Throws when the APK is missing. */
export function readBuiltApk(apkPath: string): ApkMetadata {
  if (!existsSync(apkPath)) {
    throw new PreconditionError(`${apkPath} does not exist. Build it with \`memoriahub android build\`.`);
  }
  return readMetadata(metadataPathFor(apkPath));
}
