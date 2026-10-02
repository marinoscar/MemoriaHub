/**
 * Is this page running inside the Android app's Trusted Web Activity?
 * Issue #515, epic #498 (ported from evopath's `utils/twa.ts`).
 *
 * The TWA launcher opens `${server}/?source=twa&appVersion=<name>&appVersionCode=<code>`.
 * The query string is gone after the first in-app navigation, so
 * `captureTwaLaunch()` runs once at startup (`main.tsx`), remembers it in
 * `sessionStorage` (which lives exactly as long as the TWA's browsing
 * session), and strips the parameters from the address so they never end up
 * in a bookmark or a shared link. A TWA also reports its referrer as
 * `android-app://<package>`, which covers a launch the flag missed.
 *
 * PRESENTATION ONLY, NEVER AUTHORIZATION: the answer decides whether to OFFER
 * a deep link into the native Media Sync screen, or to say an update exists.
 * It grants nothing; every API call is authorized by the server as usual.
 */

export const TWA_SESSION_KEY = 'memoriahub.twa';
export const TWA_APP_VERSION_KEY = 'memoriahub.twa.appVersion';
export const TWA_APP_VERSION_CODE_KEY = 'memoriahub.twa.appVersionCode';

export const TWA_SOURCE_PARAM = 'source';
export const TWA_SOURCE_VALUE = 'twa';
export const TWA_APP_VERSION_PARAM = 'appVersion';
export const TWA_APP_VERSION_CODE_PARAM = 'appVersionCode';

const TWA_PARAMS = [TWA_SOURCE_PARAM, TWA_APP_VERSION_PARAM, TWA_APP_VERSION_CODE_PARAM];

/** The Android app build this TWA was launched from. */
export interface InstalledAppVersion {
  versionName: string | null;
  versionCode: number;
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remove the launch parameters from the address bar without a navigation. */
function stripLaunchParams(): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const name of TWA_PARAMS) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (!changed) return;
    const search = url.searchParams.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${search ? `?${search}` : ''}${url.hash}`,
    );
  } catch {
    // An exotic location or a blocked history API: the parameters stay in the
    // address, which is cosmetic.
  }
}

/**
 * Remember a `?source=twa` launch for the rest of this session and clean the
 * URL. Safe to call more than once; a later call with no parameters keeps
 * what an earlier one stored.
 */
export function captureTwaLaunch(search: string = window.location.search): void {
  const params = new URLSearchParams(search);
  if (params.get(TWA_SOURCE_PARAM) !== TWA_SOURCE_VALUE) return;
  try {
    window.sessionStorage.setItem(TWA_SESSION_KEY, '1');
    const name = params.get(TWA_APP_VERSION_PARAM);
    const code = params.get(TWA_APP_VERSION_CODE_PARAM);
    if (name) window.sessionStorage.setItem(TWA_APP_VERSION_KEY, name.slice(0, 50));
    if (code && /^\d{1,10}$/.test(code)) {
      window.sessionStorage.setItem(TWA_APP_VERSION_CODE_KEY, code);
    }
  } catch {
    // Storage blocked: fall back to the referrer check below.
  }
  stripLaunchParams();
}

/** True inside the Android app's TWA (flag captured at launch, or an `android-app://` referrer). */
export function isRunningInTwa(): boolean {
  if (readSession(TWA_SESSION_KEY) === '1') return true;
  return typeof document !== 'undefined' && document.referrer.startsWith('android-app://');
}

/**
 * The installed app's version as its TWA launch URL reported it, or `null`
 * outside the TWA or for a launch that sent no valid `appVersionCode`.
 */
export function getInstalledAppVersion(): InstalledAppVersion | null {
  if (!isRunningInTwa()) return null;
  const code = Number(readSession(TWA_APP_VERSION_CODE_KEY));
  if (!Number.isInteger(code) || code <= 0) return null;
  return { versionName: readSession(TWA_APP_VERSION_KEY), versionCode: code };
}
