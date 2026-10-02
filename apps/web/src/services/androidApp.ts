/**
 * Android app releases, as any signed-in user sees them (issue #515, epic #498).
 *
 * Mirrors the #504 DTOs in `apps/api/src/android-app/dto/android-release.dto.ts`:
 *   - `GET  /api/android-app/releases/latest`            → `PublicRelease`, 404 `NO_RELEASE`
 *   - `POST /api/android-app/releases/:id/download-link` → `{ url, expiresAt }`
 *
 * Both are `@Auth()` with no permission: every signed-in user may install the
 * app. The download link is a short-lived, same-origin path
 * (`/api/android-app/download/<token>`); the page NAVIGATES to it so Android
 * hands the file to the package installer.
 */
import { api, ApiError } from './api';

export const ANDROID_APP_SETTINGS_PATH = '/settings/android-app';
export const MEDIA_SYNC_SETTINGS_PATH = '/settings/media-sync';
/** The admin releases page (#516). */
export const ANDROID_APP_ADMIN_PATH = '/admin/settings/android';

/** What any signed-in user may see about a release. */
export interface PublicRelease {
  id: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  /** Lowercase hex SHA-256 of the APK. */
  fileSha256: string;
  /** Bytes as a decimal string (BigInt column). */
  sizeBytes: string;
  notes: string | null;
  createdAt: string;
}

export interface DownloadLink {
  /** Same-origin path: `/api/android-app/download/<token>`. Navigate to it. */
  url: string;
  expiresAt: string;
}

/** The `details.reason` of a 404 when no release is current. */
export const NO_RELEASE_REASON = 'NO_RELEASE';

function detailsReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { reason?: unknown } | undefined;
  return typeof details?.reason === 'string' ? details.reason : null;
}

/** True when an error is the API's "no release published" 404. */
export function isNoReleaseError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) return false;
  const reason = detailsReason(err);
  // A 404 without a reason (an older server) means the same thing here.
  return reason === null || reason === NO_RELEASE_REASON;
}

/** The current release, or `null` when none has been published. */
export async function getLatestRelease(): Promise<PublicRelease | null> {
  try {
    return await api.get<PublicRelease>('/android-app/releases/latest');
  } catch (err) {
    if (isNoReleaseError(err)) return null;
    throw err;
  }
}

/** Mint a ten-minute download link for one release. */
export function createDownloadLink(releaseId: string): Promise<DownloadLink> {
  return api.post<DownloadLink>(
    `/android-app/releases/${encodeURIComponent(releaseId)}/download-link`,
  );
}

/**
 * The navigation seam. A real navigation (not a fetch/blob) is what lets
 * Chrome and the TWA on Android download the file natively and hand it to the
 * installer. Kept as an object so tests can observe it.
 */
export const downloadNavigator = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** "48.2 MB" from a decimal byte string. */
export function formatMegabytes(sizeBytes: string | number): string {
  const n = Number(sizeBytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
