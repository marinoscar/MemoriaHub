import { useSystemSettings as usePlatformSystemSettings } from '@marinoscar/platform-web/settings/headless';

import { appPlatformApi } from '../platform/platformHost';
import type { SystemSettings } from '../types';

/**
 * The deployment-wide settings document (`/api/system-settings`): load, PATCH with `If-Match` from the
 * loaded version, PUT, refresh. The fetch contract (a mounted guard, 403 named, a 409 refetches and
 * throws) is the platform settings slice's (RETRO-B3, #614); this binds it to this app's document
 * type and HTTP client, so the admin pages read and write through the packaged hook unchanged.
 */
export function useSystemSettings() {
  return usePlatformSystemSettings<SystemSettings>({ api: appPlatformApi });
}
