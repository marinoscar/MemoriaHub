/**
 * `services/androidApp.ts`: the user-side helpers MemoriaHub keeps since RETRO-D5 (#586). The
 * admin client (trusted keys, releases, upload) is the platform's `createAndroidAppClient`, tested
 * in its package; the latest-release and download-link calls are covered by mediaSync.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../services/api';
import {
  ANDROID_APP_ADMIN_PATH,
  ANDROID_APP_SETTINGS_PATH,
  errorReason,
  formatMegabytes,
  isNoReleaseError,
} from '../../services/androidApp';

describe('errorReason', () => {
  it('reads details.reason of an ApiError, never the code', () => {
    expect(errorReason(new ApiError('x', 409, 'CONFLICT', { reason: 'RELEASE_VERSION_EXISTS' }))).toBe(
      'RELEASE_VERSION_EXISTS',
    );
    expect(errorReason(new ApiError('x', 409, 'CONFLICT'))).toBeNull();
    expect(errorReason(new Error('x'))).toBeNull();
  });
});

describe('isNoReleaseError', () => {
  it('is a 404 NO_RELEASE, or a 404 without a reason (an older server)', () => {
    expect(isNoReleaseError(new ApiError('x', 404, 'NOT_FOUND', { reason: 'NO_RELEASE' }))).toBe(true);
    expect(isNoReleaseError(new ApiError('x', 404))).toBe(true);
    expect(isNoReleaseError(new ApiError('x', 404, 'NOT_FOUND', { reason: 'RELEASE_NOT_FOUND' }))).toBe(false);
    expect(isNoReleaseError(new ApiError('x', 500))).toBe(false);
  });
});

describe('paths and formatting', () => {
  it('keeps the user and admin routes', () => {
    expect(ANDROID_APP_SETTINGS_PATH).toBe('/settings/android-app');
    expect(ANDROID_APP_ADMIN_PATH).toBe('/admin/settings/android');
  });

  it('formats a decimal-string byte count as megabytes', () => {
    expect(formatMegabytes('10485760')).toBe('10.0 MB');
    expect(formatMegabytes('nope')).toBe('—');
  });
});
