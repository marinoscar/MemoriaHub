/**
 * TWA awareness (RETRO-D5, #586): the platform's helpers bound to MemoriaHub's
 * session-key prefix, replacing `utils/twa.ts`.
 *
 * PRESENTATION ONLY, never authorization (Android rule 1): a `?source=twa`
 * launch only hides install prompts and shows the update banner. The keys stay
 * `memoriahub.twa`, `memoriahub.twa.appVersion`, `memoriahub.twa.appVersionCode`.
 */
import {
  captureTwaLaunch as platformCaptureTwaLaunch,
  getInstalledAppVersion as platformGetInstalledAppVersion,
  isRunningInTwa as platformIsRunningInTwa,
  twaSessionKeys,
  type InstalledAppVersion,
} from '@marinoscar/platform-web/android-app/headless';

import { TWA_KEY_PREFIX } from './identity';

export type { InstalledAppVersion };

/** The three session keys (same names as before the platform slice). */
export const TWA_SESSION_KEYS = twaSessionKeys(TWA_KEY_PREFIX);

/** The launch parameters the TWA appends (`?source=twa&appVersion=&appVersionCode=`). */
const LAUNCH_PARAMS = ['source', 'appVersion', 'appVersionCode'] as const;

/**
 * Removes the launch parameters from the address once captured (cosmetic, as
 * MemoriaHub always did: a bookmarked or shared URL carries no `source=twa`).
 * The platform helper only records them.
 */
function stripLaunchParams(): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const name of LAUNCH_PARAMS) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (!changed) return;
    const search = url.searchParams.toString();
    window.history.replaceState(window.history.state, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
  } catch {
    // An exotic location or a blocked history API: the parameters stay, which is cosmetic.
  }
}

/** Remembers a `?source=twa` launch (call once, before the router reads the URL). */
export function captureTwaLaunch(search: string = window.location.search): void {
  if (new URLSearchParams(search).get('source') !== 'twa') return;
  platformCaptureTwaLaunch(search, TWA_KEY_PREFIX);
  stripLaunchParams();
}

/** Whether this tab was opened by the Android app's Trusted Web Activity. */
export function isRunningInTwa(): boolean {
  return platformIsRunningInTwa(TWA_KEY_PREFIX);
}

/** The installed build the TWA launch URL named, or null. */
export function getInstalledAppVersion(): InstalledAppVersion | null {
  return platformGetInstalledAppVersion(TWA_KEY_PREFIX);
}
