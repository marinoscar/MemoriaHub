// =============================================================================
// The user settings manifest (RETRO-B3, #614)
// =============================================================================
//
// Which optional `user_settings` namespaces exist, in order (append, never insert).
// `theme` and `profile` are core fields the platform composes ahead of these.
// =============================================================================

import { NOTIFICATIONS_USER_SETTINGS } from '@marinoscar/platform-api/notifications';
import {
  DATA_TABLES_USER_SETTINGS,
  NAVIGATION_USER_SETTINGS,
  assembleUserSettingsNamespaces,
  registerUserSettingsNamespaces,
  type UserSettingsNamespace,
} from '@marinoscar/platform-api/settings';

import {
  APP_USER_SETTINGS_EXTENSIONS,
  APP_USER_SETTINGS_NAMESPACES,
} from '../../app-registrations/settings';

/** The platform's user namespaces this deployment uses. */
export const PLATFORM_USER_SETTINGS_NAMESPACES: readonly UserSettingsNamespace[] = [
  DATA_TABLES_USER_SETTINGS as UserSettingsNamespace,
  NAVIGATION_USER_SETTINGS as UserSettingsNamespace,
  // NotificationsModule (RETRO-D3): per-channel, per-event preferences; `onWrite` dismisses the
  // live rows of an event the user turned off, inside the settings transaction.
  NOTIFICATIONS_USER_SETTINGS as UserSettingsNamespace,
];

/** The final, ordered list this deployment registers. */
export function assembleMemoriaHubUserNamespaces(): UserSettingsNamespace[] {
  return assembleUserSettingsNamespaces({
    platform: PLATFORM_USER_SETTINGS_NAMESPACES,
    app: APP_USER_SETTINGS_NAMESPACES,
    appExtensions: APP_USER_SETTINGS_EXTENSIONS,
  });
}

let registered = false;

/** Registers the user namespaces. Idempotent per process (see the system manifest). */
export function registerMemoriaHubUserSettings(): void {
  if (registered) return;
  registered = true;
  registerUserSettingsNamespaces(assembleMemoriaHubUserNamespaces());
}
