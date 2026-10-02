/**
 * android/publish.ts — the server's release API (issue #517; API #504).
 *
 *   POST /api/admin/android-app/releases                   system_settings:write
 *   GET  /api/admin/android-app/releases                   system_settings:read
 *   POST /api/admin/android-app/releases/:id/make-current  system_settings:write
 *   GET  /api/android-app/releases/latest                  any signed-in user (404 NO_RELEASE)
 *   GET  /api/auth/me                                      the permission pre-check
 *
 * The upload is multipart with the TEXT FIELDS FIRST (the server refuses a
 * field that arrives after the file) and the APK last in field `apk`,
 * streamed from disk via `fs.openAsBlob` — never read into memory — with a
 * 15-minute timeout. It deliberately bypasses `ApiClient`'s retry wrapper: a
 * multi-minute upload must not be silently re-sent.
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

import { ApiClient, ApiError } from '../api.js';
import { loadConfig } from '../config.js';
import { DEFAULT_RETRY_CONFIG } from '../http/retry.js';
import { PreconditionError } from './errors.js';
import type { ApkMetadata } from './metadata.js';

export const RELEASES_PATH = '/api/admin/android-app/releases';
export const LATEST_RELEASE_PATH = '/api/android-app/releases/latest';
export const ME_PATH = '/api/auth/me';

/** The permission the upload and make-current endpoints enforce. */
export const PUBLISH_PERMISSION = 'system_settings:write';

/** Uploads get far longer than any normal request. */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export const APK_MIME = 'application/vnd.android.package-archive';

export const BUMP_HINT = 'run `memoriahub android version --bump patch`';

/** `AdminRelease` as #504 serialises it (`sizeBytes` is a decimal string). */
export interface AndroidRelease {
  id: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  signingSha256?: string;
  fileSha256: string;
  sizeBytes: string | number;
  notes?: string | null;
  isCurrent?: boolean;
  createdAt: string;
  uploadedBy?: { id: string; email: string; displayName?: string | null } | null;
}

export interface ServerCredentials {
  serverUrl: string;
  token: string;
}

/** The stored login (`~/.memoriahub/config.json` or MEMORIAHUB_URL + MEMORIAHUB_TOKEN). */
export function storedCredentials(): ServerCredentials | undefined {
  const config = loadConfig();
  if (config === null || !config.serverUrl || !config.pat) return undefined;
  return { serverUrl: config.serverUrl.replace(/\/+$/, ''), token: config.pat };
}

export function requireCredentials(): ServerCredentials {
  const credentials = storedCredentials();
  if (credentials === undefined) {
    throw new PreconditionError('Not logged in. Run `memoriahub login` first (or set MEMORIAHUB_URL and MEMORIAHUB_TOKEN).');
  }
  return credentials;
}

/** The two JSON calls the release commands make; `ApiClient` satisfies it (tests pass fakes). */
export interface JsonApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/**
 * A JSON client for the stored login. `quick` disables the transport retries
 * (5 with backoff by default) for status probes — doctor's login hint and
 * the TUI's status panel must answer promptly when the server is down.
 */
export function apiClientFor(credentials: ServerCredentials, options: { quick?: boolean } = {}): JsonApi {
  return new ApiClient({
    serverUrl: credentials.serverUrl,
    pat: credentials.token,
    ...(options.quick === true ? { retry: { ...DEFAULT_RETRY_CONFIG, maxRetries: 0 } } : {}),
  });
}

/** The machine-readable refusal: `details.reason` (MemoriaHub's convention), else the top-level `code`. */
export function apiErrorReason(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.body as { code?: unknown; details?: { reason?: unknown } } | undefined;
  const reason = body?.details?.reason;
  if (typeof reason === 'string') return reason;
  return typeof body?.code === 'string' ? body.code : undefined;
}

export interface CurrentUser {
  id?: string;
  email?: string;
  permissions?: string[];
}

/** `GET /api/auth/me`; a clear PreconditionError (exit 6) for a dead login or a missing permission. */
export async function requirePublishPermission(client: JsonApi, serverUrl: string): Promise<CurrentUser> {
  let user: CurrentUser;
  try {
    user = await client.get<CurrentUser>(ME_PATH);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new PreconditionError(`The stored login for ${serverUrl} was rejected (expired or revoked). Run \`memoriahub login\`.`);
    }
    throw error;
  }
  if (!Array.isArray(user.permissions) || !user.permissions.includes(PUBLISH_PERMISSION)) {
    throw new PreconditionError(
      `${user.email ?? 'This account'} lacks ${PUBLISH_PERMISSION} on ${serverUrl}; publishing an Android release needs an administrator. ` +
        'Ask one, or `memoriahub login` as another user.',
    );
  }
  return user;
}

/** The server's current release, or `null` when nothing is published (404 NO_RELEASE). */
export async function latestRelease(client: JsonApi): Promise<AndroidRelease | null> {
  try {
    return await client.get<AndroidRelease>(LATEST_RELEASE_PATH);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      if (apiErrorReason(error) === 'NO_RELEASE') return null;
      throw new PreconditionError(
        `The server answered 404 for ${LATEST_RELEASE_PATH}: it predates Android releases. Upgrade the server first.`,
      );
    }
    throw error;
  }
}

export interface PublishOptions {
  notes?: string | undefined;
  makeCurrent: boolean;
  force: boolean;
}

/** The multipart body, in the order the server requires: text fields, then `apk`. */
export async function buildPublishForm(
  apkPath: string,
  metadata: ApkMetadata,
  options: PublishOptions,
  openBlob: (path: string) => Promise<Blob> = (path) => openAsBlob(path, { type: APK_MIME }),
): Promise<FormData> {
  const form = new FormData();
  form.append('packageName', metadata.packageName);
  form.append('versionName', metadata.versionName);
  form.append('versionCode', String(metadata.versionCode));
  form.append('signingSha256', metadata.signingSha256);
  if (options.notes !== undefined && options.notes !== '') form.append('notes', options.notes);
  form.append('makeCurrent', String(options.makeCurrent));
  form.append('force', String(options.force));
  form.append('apk', await openBlob(apkPath), basename(apkPath));
  return form;
}

/** Turn the API's version refusals into what to do about them. */
export function explainPublishError(error: unknown, metadata: ApkMetadata): unknown {
  if (!(error instanceof ApiError)) return error;
  const reason = apiErrorReason(error);
  let sentence: string | undefined;
  switch (reason) {
    case 'RELEASE_VERSION_EXISTS':
      sentence = `versionCode ${metadata.versionCode} is already published for ${metadata.packageName}: ${BUMP_HINT}, then build again.`;
      break;
    case 'RELEASE_VERSION_NOT_NEWER':
      sentence =
        `The current release has a versionCode at or above ${metadata.versionCode} and Android refuses downgrades: ${BUMP_HINT}, ` +
        'then build again (or pass --force, or --no-current to upload without making it current).';
      break;
    case 'RELEASE_TOO_LARGE':
      sentence = 'The APK is over the server limit (150 MB).';
      break;
    case 'STORAGE_NOT_CONFIGURED':
      sentence = 'The server has no object storage configured; an administrator must set one up first.';
      break;
    default:
      if (error.status === 403) sentence = `This account lacks ${PUBLISH_PERMISSION}.`;
  }
  if (sentence === undefined) return error;
  return new ApiError(error.status, `${error.serverMessage} — ${sentence}`, error.retryAfterMs, false, error.body);
}

export interface UploadDeps {
  fetch?: typeof globalThis.fetch | undefined;
  openBlob?: ((path: string) => Promise<Blob>) | undefined;
  timeoutMs?: number | undefined;
}

/** Upload one built APK. Never retried; a refusal throws ApiError with an actionable message. */
export async function publishRelease(
  credentials: ServerCredentials,
  apkPath: string,
  metadata: ApkMetadata,
  options: PublishOptions,
  deps: UploadDeps = {},
): Promise<AndroidRelease> {
  const body = await buildPublishForm(apkPath, metadata, options, deps.openBlob);
  const doFetch = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${credentials.serverUrl}${RELEASES_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Uploading to ${credentials.serverUrl} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const message = (parsed as { message?: unknown } | undefined)?.message;
    const error = new ApiError(
      response.status,
      typeof message === 'string' ? message : text || response.statusText,
      null,
      false,
      parsed,
    );
    throw explainPublishError(error, metadata);
  }
  const data = (parsed as { data?: unknown } | undefined)?.data ?? parsed;
  return data as AndroidRelease;
}

export async function listReleases(client: JsonApi): Promise<AndroidRelease[]> {
  const result = await client.get<unknown>(RELEASES_PATH);
  if (Array.isArray(result)) return result as AndroidRelease[];
  const nested = (result as { items?: unknown } | undefined)?.items;
  return Array.isArray(nested) ? (nested as AndroidRelease[]) : [];
}

export async function makeCurrent(client: JsonApi, id: string): Promise<AndroidRelease> {
  return await client.post<AndroidRelease>(`${RELEASES_PATH}/${encodeURIComponent(id)}/make-current`, {});
}

export function formatBytes(bytes: number | string): string {
  const value = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(value)) return String(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** The releases table; the current release is marked `*`. */
export function formatReleasesTable(releases: readonly AndroidRelease[]): string {
  if (releases.length === 0) return 'No releases have been published yet.\n';
  const rows = releases.map((release) => [
    release.isCurrent === true ? '*' : ' ',
    release.versionName,
    String(release.versionCode),
    formatBytes(release.sizeBytes),
    release.createdAt.slice(0, 16).replace('T', ' '),
    release.fileSha256.slice(0, 12),
    release.id,
  ]);
  const header = [' ', 'VERSION', 'CODE', 'SIZE', 'UPLOADED', 'SHA-256', 'ID'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return `${[render(header), ...rows.map(render)].join('\n')}\n\n* = current release\n`;
}

/**
 * The extra warning for a make-current that moves BACKWARDS: Android never
 * installs a lower versionCode over a higher one, so a rollback only reaches
 * new installs and devices still below it.
 */
export function rollbackWarning(target: AndroidRelease, current: AndroidRelease | undefined): string | undefined {
  if (current === undefined || current.id === target.id || target.versionCode >= current.versionCode) return undefined;
  return (
    `This ROLLS BACK from ${current.versionName} (${current.versionCode}) to a lower versionCode. Android refuses ` +
    `downgrades: phones that installed ${current.versionName} keep it and are not offered ${target.versionName}; ` +
    'only new installs get it.'
  );
}

/** Where users download the app in the web UI. */
export function downloadPageUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/settings/android-app`;
}
