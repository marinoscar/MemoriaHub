/**
 * android/version.ts — apps/android/version.properties (issue #517).
 *
 * The committed source of truth for the APK version:
 *
 *   versionName=2.0.0
 *   versionCode=100
 *
 * versionCode must STRICTLY increase for every published APK — Android refuses
 * to install a lower code over a higher one — so EVERY bump or set moves it by
 * one, and an explicit `--code` must still move it forward.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { UsageError } from './errors.js';

/** What a checkout without the file builds as (the v2 app's first version). */
export const DEFAULT_VERSION_NAME = '2.0.0';
export const DEFAULT_VERSION_CODE = 100;
/** Google Play's ceiling; the API and the Gradle build enforce the same. */
export const MAX_VERSION_CODE = 2_100_000_000;

export type BumpPart = 'patch' | 'minor' | 'major';

export const BUMP_PARTS: readonly BumpPart[] = ['patch', 'minor', 'major'];

export interface AppVersion {
  versionName: string;
  versionCode: number;
}

export interface ReadVersionResult extends AppVersion {
  /** False when the file is absent and the defaults were returned. */
  exists: boolean;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

export function parseBumpPart(value: string): BumpPart {
  if (value === 'patch' || value === 'minor' || value === 'major') return value;
  throw new UsageError(`--bump must be patch, minor or major (got ${JSON.stringify(value)}).`);
}

export function bumpSemver(version: string, part: BumpPart): string {
  const match = SEMVER.exec(version);
  if (match === null) {
    throw new UsageError(`versionName "${version}" is not x.y.z, so it cannot be bumped. Use --set x.y.z.`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  switch (part) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Parse a `.properties` body into key → value. `#`/`!` comments and blanks skipped. */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const match = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(trimmed);
    if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? '').trim());
  }
  return out;
}

/** Rewrite `key=value` lines in place, keeping comments, ordering and other keys; append missing keys. */
export function updateProperties(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const updated = lines.map((line) => {
    const match = /^(\s*)([^=:\s#!]+)(\s*[=:]\s*)(.*)$/.exec(line);
    const key = match?.[2];
    if (match === null || key === undefined || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${match[1] ?? ''}${key}${match[3] ?? '='}${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  return `${updated.join('\n')}\n`;
}

function parseCode(raw: string | undefined, file: string): number {
  const code = Number(raw);
  if (raw === undefined || !Number.isInteger(code) || code < 1 || code > MAX_VERSION_CODE) {
    throw new UsageError(
      `${file}: versionCode must be a whole number from 1 to ${MAX_VERSION_CODE} (got ${JSON.stringify(raw)}).`,
    );
  }
  return code;
}

/** Read the file; a missing file yields the defaults with `exists: false`. */
export function readVersion(file: string): ReadVersionResult {
  if (!existsSync(file)) {
    return { versionName: DEFAULT_VERSION_NAME, versionCode: DEFAULT_VERSION_CODE, exists: false };
  }
  const props = parseProperties(readFileSync(file, 'utf8'));
  const versionName = props.get('versionName') ?? DEFAULT_VERSION_NAME;
  const versionCode = props.has('versionCode') ? parseCode(props.get('versionCode'), file) : DEFAULT_VERSION_CODE;
  return { versionName, versionCode, exists: true };
}

export function writeVersion(file: string, version: AppVersion): void {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(
    file,
    updateProperties(current, { versionName: version.versionName, versionCode: String(version.versionCode) }),
    'utf8',
  );
}

export interface VersionChange {
  bump?: BumpPart | undefined;
  set?: string | undefined;
  code?: number | undefined;
}

/**
 * Apply a `version` command's flags; `undefined` when no change was asked
 * for. Every change moves versionCode forward by one unless `code` is given,
 * and an explicit code must still be greater than the current one.
 *
 * A missing file is created at the defaults by this change (a `--bump` on a
 * missing file yields the defaults rather than skipping the first version).
 */
export function applyVersionChange(current: ReadVersionResult, change: VersionChange): AppVersion | undefined {
  if (change.bump !== undefined && change.set !== undefined) {
    throw new UsageError('Pass --bump or --set, not both.');
  }
  if (change.bump === undefined && change.set === undefined && change.code === undefined) return undefined;

  if (change.set !== undefined && !isSemver(change.set)) {
    throw new UsageError(`--set must be x.y.z (got ${JSON.stringify(change.set)}).`);
  }
  if (change.code !== undefined && (!Number.isInteger(change.code) || change.code < 1 || change.code > MAX_VERSION_CODE)) {
    throw new UsageError(`--code must be a whole number from 1 to ${MAX_VERSION_CODE}.`);
  }

  if (!current.exists) {
    return { versionName: change.set ?? current.versionName, versionCode: change.code ?? current.versionCode };
  }

  const versionName =
    change.set ?? (change.bump !== undefined ? bumpSemver(current.versionName, change.bump) : current.versionName);

  if (change.code !== undefined && change.code <= current.versionCode) {
    throw new UsageError(
      `--code ${change.code} is not greater than the current versionCode ${current.versionCode}; ` +
        'Android refuses to install a lower or equal code over a newer one.',
    );
  }
  const versionCode = change.code ?? current.versionCode + 1;
  if (versionCode > MAX_VERSION_CODE) {
    throw new UsageError(`versionCode would exceed ${MAX_VERSION_CODE}.`);
  }
  return { versionName, versionCode };
}

export interface VersionBump {
  before: AppVersion;
  after: AppVersion;
  /** version.properties did not exist and is created by this bump. */
  created: boolean;
}

/** What `bumpVersionFile` would do, without writing — for a confirmation or a pre-check. */
export function previewBump(file: string, part: BumpPart): VersionBump {
  const current = readVersion(file);
  const after = applyVersionChange(current, { bump: part }) as AppVersion;
  return {
    before: { versionName: current.versionName, versionCode: current.versionCode },
    after,
    created: !current.exists,
  };
}

/** Bump version.properties (name and code). Never commits. */
export function bumpVersionFile(file: string, part: BumpPart): VersionBump {
  const bump = previewBump(file, part);
  writeVersion(file, bump.after);
  return bump;
}

export function versionLabel(version: AppVersion): string {
  return `${version.versionName} (${version.versionCode})`;
}
