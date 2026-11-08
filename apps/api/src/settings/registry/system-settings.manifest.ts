// =============================================================================
// The system settings manifest (RETRO-B3, #614)
// =============================================================================
//
// Which `system_settings` namespaces this deployment has, and in what order (append, never
// insert). The platform's own: `maintenance`, `jobs`, `retention`, `databaseBackup`, `notifications` and `storage`, registered here before the host core's
// `ensureSystemSettingsNamespaces` would register it, so the order is this one. MemoriaHub's:
// `app-registrations/settings.ts`.
// =============================================================================

import { DATABASE_BACKUP_SYSTEM_SETTINGS } from '@marinoscar/platform-api/db-backup';
// The app's retention policies must be registered before `retention` is composed
// (RETRO-C7): every entry point reaches this file, not always `jobs.config.ts` first.
import '../../app-registrations/jobs';

import { MAINTENANCE_SYSTEM_SETTINGS } from '@marinoscar/platform-api/host';
import { STORAGE_SYSTEM_SETTINGS } from '@marinoscar/platform-api/storage';
// The storage drivers must be registered before the `storage` namespace is composed (it reads the
// driver registry): MemoriaHub's `local` driver (RETRO-D1).
import '../../app-registrations/storage';
import { JOBS_SYSTEM_SETTINGS, RETENTION_SYSTEM_SETTINGS } from '@marinoscar/platform-api/jobs';
import { NOTIFICATIONS_SYSTEM_SETTINGS } from '@marinoscar/platform-api/notifications';
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
  // DbBackupModule (RETRO-D4, #580). Same key as MemoriaHub's old namespace; a stored value in the old
  // shape (`storageProvider: null`, `restoreRollbackMode: 'pre_restore_dump'`) is rewritten by
  // `scripts/migrate-db-backup-settings.ts`; until then the platform reads it field by field.
  DATABASE_BACKUP_SYSTEM_SETTINGS as SystemSettingsNamespace,
  // NotificationsModule (RETRO-D3): the deployment policy, its org layer, and dismiss-on-disable
  // (`onWrite`, inside the settings transaction).
  NOTIFICATIONS_SYSTEM_SETTINGS as SystemSettingsNamespace,
  // StorageModule (RETRO-D1, #563): `provider` and the `drivers` record, extended with MemoriaHub's
  // `insights` and `trash` (app-registrations/settings.ts). Same key as MemoriaHub's old namespace;
  // `scripts/migrate-storage-settings.ts` copies the old `activeProvider` and the legacy credential
  // rows into it.
  STORAGE_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace,
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
