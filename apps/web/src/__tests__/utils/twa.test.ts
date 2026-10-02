/** `utils/twa.ts` (issue #515): TWA launch capture, URL cleanup and detection. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TWA_APP_VERSION_CODE_KEY,
  TWA_APP_VERSION_KEY,
  TWA_SESSION_KEY,
  captureTwaLaunch,
  getInstalledAppVersion,
  isRunningInTwa,
} from '../../utils/twa';
import { ANDROID_PACKAGE_NAME } from '../../utils/androidIdentity';

function setReferrer(value: string) {
  Object.defineProperty(document, 'referrer', { value, configurable: true });
}

const originalHref = window.location.href;

describe('twa utils', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setReferrer('');
  });

  afterEach(() => {
    window.sessionStorage.clear();
    setReferrer('');
    (window.location as { href: string }).href = originalHref;
    vi.restoreAllMocks();
  });

  it('is false in a plain browser tab', () => {
    captureTwaLaunch('?foo=bar');
    expect(isRunningInTwa()).toBe(false);
    expect(getInstalledAppVersion()).toBeNull();
  });

  it('stores the launch under the memoriahub.* session keys', () => {
    captureTwaLaunch('?source=twa&appVersion=2.0.0&appVersionCode=100');
    expect(window.sessionStorage.getItem(TWA_SESSION_KEY)).toBe('1');
    expect(TWA_SESSION_KEY).toBe('memoriahub.twa');
    expect(window.sessionStorage.getItem(TWA_APP_VERSION_KEY)).toBe('2.0.0');
    expect(TWA_APP_VERSION_KEY).toBe('memoriahub.twa.appVersion');
    expect(window.sessionStorage.getItem(TWA_APP_VERSION_CODE_KEY)).toBe('100');
    expect(TWA_APP_VERSION_CODE_KEY).toBe('memoriahub.twa.appVersionCode');
  });

  it('remembers a ?source=twa launch after later navigations', () => {
    captureTwaLaunch('?source=twa');
    captureTwaLaunch('');
    expect(isRunningInTwa()).toBe(true);
  });

  it('ignores another source value', () => {
    captureTwaLaunch('?source=pwa');
    expect(isRunningInTwa()).toBe(false);
  });

  it('detects an android-app:// referrer without the flag', () => {
    setReferrer(`android-app://${ANDROID_PACKAGE_NAME}/`);
    expect(isRunningInTwa()).toBe(true);
  });

  it('reads the installed app version', () => {
    captureTwaLaunch('?source=twa&appVersion=2.0.0&appVersionCode=100');
    expect(getInstalledAppVersion()).toEqual({ versionName: '2.0.0', versionCode: 100 });
  });

  it('has no installed version without a valid code', () => {
    captureTwaLaunch('?source=twa&appVersion=2.0.0');
    expect(getInstalledAppVersion()).toBeNull();
    window.sessionStorage.clear();
    captureTwaLaunch('?source=twa&appVersionCode=abc');
    expect(getInstalledAppVersion()).toBeNull();
  });

  it('strips the launch parameters from the address, keeping the rest', () => {
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    (window.location as { href: string }).href =
      'http://localhost:3000/settings?source=twa&appVersion=2.0.0&appVersionCode=100&tab=x#android-app';
    captureTwaLaunch('?source=twa&appVersion=2.0.0&appVersionCode=100&tab=x');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][2]).toBe('/settings?tab=x#android-app');
  });

  it('leaves the address alone outside a TWA launch', () => {
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    captureTwaLaunch('?foo=bar');
    expect(replace).not.toHaveBeenCalled();
  });
});
