// =============================================================================
// The system settings manifest (RETRO-B3, #614)
// =============================================================================
//
// Which `system_settings` namespaces this deployment has, and in what order (append, never
// insert). The platform's own: `maintenance`, `jobs` and `retention`, registered here before the host core's
// `ensureSystemSettingsNamespaces` would register it, so the order is this one. MemoriaHub's:
// `app-registrations/settings.ts`.
// =============================================================================

import { MAINTENANCE_SYSTEM_SETTINGS } from '@marinoscar/platform-api/host';
import { JOBS_SYSTEM_SETTINGS, RETENTION_SYSTEM_SETTINGS } from '@marinoscar/platform-api/jobs';
import {
  assembleSystemSettingsNamespaces,
  registerSystemSettingsNamespaces,
  type SystemSettingsNamespace,
} from '@marinoscar/platform-api/settings';

import {
  APP_SYSTEM_SETTINGS_DEFAULTS,
  APP_SYSTEM_SETTINGS_EXTENSIONS,
  APP_SYSTEM_SETTINGS_NAMESPACES,
} from '../../app-registrations/settings';

/** The platform's system namespaces this deployment uses. */
export const PLATFORM_SYSTEM_SETTINGS_NAMESPACES: readonly SystemSettingsNamespace[] = [
  MAINTENANCE_SYSTEM_SETTINGS as SystemSettingsNamespace, // PlatformHostCoreModule
  JOBS_SYSTEM_SETTINGS as SystemSettingsNamespace, // JobsModule (RETRO-C1): same stored shape as the old `jobs`
  RETENTION_SYSTEM_SETTINGS as SystemSettingsNamespace, // JobsModule (RETRO-C1): the nightly retention windows
];

/** The final, ordered list this deployment registers. */
export function assembleMemoriaHubSystemNamespaces(): SystemSettingsNamespace[] {
  return assembleSystemSettingsNamespaces({
    platform: PLATFORM_SYSTEM_SETTINGS_NAMESPACES,
    app: APP_SYSTEM_SETTINGS_NAMESPACES,
    appExtensions: APP_SYSTEM_SETTINGS_EXTENSIONS,
    appDefaults: APP_SYSTEM_SETTINGS_DEFAULTS,
  });
}

let registered = false;

/**
 * Registers the system namespaces. Idempotent per process: Jest imports the manifest from several
 * specs, and registering a namespace twice is a `DUPLICATE_ID` error.
 */
export function registerMemoriaHubSystemSettings(): void {
  if (registered) return;
  registered = true;
  registerSystemSettingsNamespaces(assembleMemoriaHubSystemNamespaces());
}
