/**
 * Android app: the user-side helpers MemoriaHub keeps (epic #498; #515).
 *
 * Since RETRO-D5 (#586) the API routes are the platform android-app slice's and
 * the admin page, its client and its hooks are `@marinoscar/platform-web/android-app`
 * (the trusted signing keys, the releases, the upload). What stays here is what
 * the Media Sync page and the user download page still read directly:
 *
 *   GET  /api/android-app/releases/latest              PublicRelease, 404 NO_RELEASE
 *   POST /api/android-app/releases/:id/download-link   { url, expiresAt }
 *
 * Errors: the API's `code` is derived from the HTTP status; the machine-readable
 * cause is always `details.reason` (docs/specs/android-media-sync.md §17), so
 * callers key off `errorReason(err)`, never `err.code`.
 */

import type { DownloadLink, PublicRelease } from '@marinoscar/platform-web/android-app/headless';

import { api, ApiError } from './api';

export type { DownloadLink, PublicRelease };

/** The refusal a latest-release request answers when nothing is current. */
export const NO_RELEASE_REASON = 'NO_RELEASE';

/** `details.reason` of an API error, or null. */
export function errorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { reason?: unknown } | undefined;
  return details && typeof details.reason === 'string' ? details.reason : null;
}

export const ANDROID_APP_SETTINGS_PATH = '/settings/android-app';
export const MEDIA_SYNC_SETTINGS_PATH = '/settings/media-sync';
export const ANDROID_APP_ADMIN_PATH = '/admin/settings/android';

/** Whether an error is the latest-release route's "nothing published". */
export function isNoReleaseError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) return false;
  const reason = errorReason(err);
  // A 404 without a reason (an older server) means the same thing here.
  return reason === null || reason === NO_RELEASE_REASON;
}

/** The current release, or null when none is published. */
export async function getLatestRelease(): Promise<PublicRelease | null> {
  try {
    return await api.get<PublicRelease>('/android-app/releases/latest');
  } catch (err) {
    if (isNoReleaseError(err)) return null;
    throw err;
  }
}

/** A short-lived same-origin download link (`/api/android-app/download/<token>`). */
export function createDownloadLink(releaseId: string): Promise<DownloadLink> {
  return api.post<DownloadLink>(`/android-app/releases/${encodeURIComponent(releaseId)}/download-link`);
}

/** Indirection the tests replace: a real navigation lets Android hand the APK to the installer. */
export const downloadNavigator = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** Bytes (a decimal string on the wire) as megabytes. */
export function formatMegabytes(sizeBytes: string | number): string {
  const n = Number(sizeBytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
