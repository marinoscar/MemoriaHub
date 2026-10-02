/**
 * Android app: trusted signing keys (Digital Asset Links) and APK releases.
 * Epic #498; admin surface issue #516, user download page #515.
 *
 * Types mirror the API DTOs (`apps/api/src/android-app/dto/*.dto.ts`):
 *
 *   GET  /api/admin/android-app                         system_settings:read
 *   PUT  /api/admin/android-app                         system_settings:write
 *   GET  /api/admin/android-app/releases                system_settings:read
 *   POST /api/admin/android-app/releases (multipart)    system_settings:write
 *   POST /api/admin/android-app/releases/:id/make-current
 *   DELETE /api/admin/android-app/releases/:id
 *
 * Errors: the API's `code` is derived from the HTTP status; the machine-readable
 * cause is always `details.reason` (docs/specs/android-media-sync.md §17), so
 * callers key off `errorReason(err)`, never `err.code`.
 */

import { api, ApiError } from './api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// -----------------------------------------------------------------------------
// Validation mirrored from the API (android-app.schema.ts, android-release.schema.ts)
// -----------------------------------------------------------------------------

/** The release build's applicationId (spec §2). Case-sensitive; never re-cased. */
export const ANDROID_RELEASE_PACKAGE_NAME = 'memoriahub.marin.cr';

/** At most this many trusted (packageName, sha256) pairs (`MAX_TRUSTED_ANDROID_APPS`). */
export const MAX_TRUSTED_APPS = 10;

/** An Android application id: two or more dot-separated segments, each starting with a letter. */
export const ANDROID_PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** The canonical fingerprint form: 32 colon-separated uppercase hex bytes. */
export const SHA256_FINGERPRINT_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const SHA256_BARE_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

export const VERSION_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
export const MAX_VERSION_NAME_LENGTH = 50;
export const MIN_VERSION_CODE = 1;
export const MAX_VERSION_CODE = 2_100_000_000;
export const MAX_RELEASE_NOTES_LENGTH = 2000;
/** 150 MiB, the server's `MAX_APK_BYTES`. */
export const MAX_APK_BYTES = 150 * 1024 * 1024;

/**
 * Normalises a SHA-256 certificate fingerprint exactly as the API does: either
 * case, colon-separated or 64 bare hex digits (what `apksigner` and the CLI
 * sidecar print), to the uppercase colon form. Anything else comes back trimmed
 * and uppercased, so `isValidFingerprint` still rejects it.
 */
export function normalizeSha256(value: string): string {
  const trimmed = value.trim();
  if (SHA256_BARE_HEX_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase().match(/.{2}/g)!.join(':');
  }
  return trimmed.toUpperCase();
}

export function isValidFingerprint(value: string): boolean {
  return SHA256_FINGERPRINT_PATTERN.test(normalizeSha256(value));
}

export function isValidPackageName(value: string): boolean {
  return value.trim().length <= 255 && ANDROID_PACKAGE_PATTERN.test(value.trim());
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TrustedApp {
  /** Exactly as stored; case-sensitive. */
  packageName: string;
  /** Uppercase colon-separated. */
  sha256: string;
}

export interface ReportedApp extends TrustedApp {
  /** Active Media Sync devices reporting this exact pair. */
  deviceCount: number;
  lastSeenAt: string | null;
  /** Whether the pair is in `trustedApps`. */
  trusted: boolean;
}

export interface AssetLinkStatement {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

export interface AndroidAppConfig {
  trustedApps: TrustedApp[];
  reportedApps: ReportedApp[];
  /** Exactly the body `/.well-known/assetlinks.json` serves. */
  assetLinks: AssetLinkStatement[];
}

/** What any signed-in user may see about a release (`PublicRelease`). */
export interface Release {
  id: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  /** Lowercase hex SHA-256 of the APK bytes. */
  fileSha256: string;
  /** Bytes, as a decimal string (BigInt column). */
  sizeBytes: string;
  notes: string | null;
  createdAt: string;
}

export interface AdminRelease extends Release {
  /** Uppercase colon-separated. */
  signingSha256: string;
  isCurrent: boolean;
  uploadedBy: { id: string; email: string; displayName: string | null } | null;
}

export interface UploadReleaseInput {
  apk: File;
  packageName: string;
  versionName: string;
  versionCode: number;
  signingSha256: string;
  notes?: string;
  makeCurrent: boolean;
  force?: boolean;
}

/** `details.reason` values the trusted-apps and release endpoints answer with. */
export const ANDROID_APP_ERROR = {
  TOO_MANY_TRUSTED_APPS: 'TOO_MANY_TRUSTED_APPS',
  INVALID_PACKAGE_NAME: 'INVALID_PACKAGE_NAME',
  INVALID_FINGERPRINT: 'INVALID_FINGERPRINT',
  INVALID_TRUSTED_APPS: 'INVALID_TRUSTED_APPS',
  RELEASE_VERSION_EXISTS: 'RELEASE_VERSION_EXISTS',
  RELEASE_VERSION_NOT_NEWER: 'RELEASE_VERSION_NOT_NEWER',
  RELEASE_IS_CURRENT: 'RELEASE_IS_CURRENT',
  RELEASE_CURRENT_CONFLICT: 'RELEASE_CURRENT_CONFLICT',
  RELEASE_NOT_FOUND: 'RELEASE_NOT_FOUND',
  RELEASE_NOT_AN_APK: 'RELEASE_NOT_AN_APK',
  RELEASE_TOO_LARGE: 'RELEASE_TOO_LARGE',
  RELEASE_INVALID_UPLOAD: 'RELEASE_INVALID_UPLOAD',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
  NO_RELEASE: 'NO_RELEASE',
} as const;

/** The API's `details.reason`, or null when the error carries none. */
export function errorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { reason?: unknown } | undefined;
  return details && typeof details.reason === 'string' ? details.reason : null;
}

// -----------------------------------------------------------------------------
// Trusted apps
// -----------------------------------------------------------------------------

/** `GET /api/admin/android-app` */
export function getAndroidAppConfig(): Promise<AndroidAppConfig> {
  return api.get<AndroidAppConfig>('/admin/android-app');
}

/** `PUT /api/admin/android-app` — replaces the whole trusted list. */
export function putAndroidAppConfig(trustedApps: TrustedApp[]): Promise<AndroidAppConfig> {
  return api.put<AndroidAppConfig>('/admin/android-app', { trustedApps });
}

// -----------------------------------------------------------------------------
// Releases
// -----------------------------------------------------------------------------

const releasePath = (id: string) => `/admin/android-app/releases/${encodeURIComponent(id)}`;

/** `GET /api/admin/android-app/releases` — newest first. */
export function listReleases(): Promise<AdminRelease[]> {
  return api.get<AdminRelease[]>('/admin/android-app/releases');
}

/** `POST /api/admin/android-app/releases/:id/make-current` — rollback to a lower code is allowed. */
export function makeReleaseCurrent(id: string): Promise<AdminRelease> {
  return api.post<AdminRelease>(`${releasePath(id)}/make-current`);
}

/** `DELETE /api/admin/android-app/releases/:id` — 409 `RELEASE_IS_CURRENT` for the current one. */
export function deleteRelease(id: string): Promise<void> {
  return api.delete<void>(releasePath(id));
}

/**
 * The multipart body `POST /api/admin/android-app/releases` reads. Text fields
 * FIRST, the file LAST: the server streams the APK straight into storage and
 * needs every field by the time the bytes arrive (a field after the file is a
 * 400 `RELEASE_INVALID_UPLOAD`).
 */
export function buildReleaseFormData(input: UploadReleaseInput): FormData {
  const form = new FormData();
  form.append('packageName', input.packageName);
  form.append('versionName', input.versionName);
  form.append('versionCode', String(input.versionCode));
  form.append('signingSha256', input.signingSha256);
  if (input.notes && input.notes.trim()) form.append('notes', input.notes.trim());
  form.append('makeCurrent', input.makeCurrent ? 'true' : 'false');
  form.append('force', input.force ? 'true' : 'false');
  form.append('apk', input.apk, input.apk.name);
  return form;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

interface XhrResult {
  status: number;
  body: unknown;
}

function sendMultipart(
  endpoint: string,
  form: FormData,
  onProgress?: (progress: UploadProgress) => void,
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${endpoint}`);
    xhr.withCredentials = true;
    const token = api.getAccessToken();
    // Deliberately NO Content-Type: the browser sets it with the multipart boundary.
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
      };
    }
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new ApiError('Network error while uploading the release', 0));
    xhr.onabort = () => reject(new ApiError('The upload was cancelled', 0));
    xhr.send(form);
  });
}

/**
 * `POST /api/admin/android-app/releases` (multipart) with upload progress.
 *
 * `XMLHttpRequest`, not `fetch`: only XHR reports request-body progress. It
 * mirrors `api.request`'s contract — bearer token, one refresh-and-retry on a
 * 401, the `{ data }` envelope unwrapped, a non-2xx thrown as `ApiError` with
 * `code` and `details` intact.
 */
export async function uploadRelease(
  input: UploadReleaseInput,
  onProgress?: (progress: UploadProgress) => void,
): Promise<AdminRelease> {
  const endpoint = '/admin/android-app/releases';
  let result = await sendMultipart(endpoint, buildReleaseFormData(input), onProgress);
  if (result.status === 401 && (await api.refreshToken())) {
    result = await sendMultipart(endpoint, buildReleaseFormData(input), onProgress);
  }

  const body = result.body as Record<string, unknown> | null;
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(
      (body && typeof body.message === 'string' && body.message) || 'Upload failed',
      result.status,
      body && typeof body.code === 'string' ? body.code : undefined,
      body ? body.details : undefined,
    );
  }
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as AdminRelease;
}

// -----------------------------------------------------------------------------
// The CLI sidecar (`memoriahub android build` → dist/android/<stem>-<ver>.json)
// -----------------------------------------------------------------------------

/**
 * The fields of the sidecar the CLI writes next to the APK
 * (`{ packageName, versionName, versionCode, signingSha256, fileSha256,
 * sizeBytes, builtAt, gitSha }`). Its `signingSha256` is lowercase hex with no
 * colons; it is normalised here to the colon form the form and the API show.
 */
export interface ReleaseSidecar {
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  signingSha256?: string;
  fileSha256?: string;
  sizeBytes?: number;
}

/** Reads the sidecar; unknown or malformed fields are ignored, non-JSON is `null`. */
export function parseReleaseSidecar(text: string): ReleaseSidecar | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ReleaseSidecar = {};
  if (typeof r.packageName === 'string') out.packageName = r.packageName.trim();
  if (typeof r.versionName === 'string') out.versionName = r.versionName.trim();
  if (typeof r.versionCode === 'number' && Number.isInteger(r.versionCode)) out.versionCode = r.versionCode;
  if (typeof r.versionCode === 'string' && /^\d+$/.test(r.versionCode.trim())) {
    out.versionCode = Number(r.versionCode.trim());
  }
  if (typeof r.signingSha256 === 'string') out.signingSha256 = normalizeSha256(r.signingSha256);
  if (typeof r.fileSha256 === 'string') out.fileSha256 = r.fileSha256.trim().toLowerCase();
  if (typeof r.sizeBytes === 'number' && Number.isFinite(r.sizeBytes)) out.sizeBytes = r.sizeBytes;
  const useful = out.packageName || out.versionName || out.versionCode !== undefined || out.signingSha256;
  return useful ? out : null;
}
