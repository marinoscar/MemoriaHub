// =============================================================================
// Events of other platform slices, raised through NotificationsService (RETRO-D3, #576)
// =============================================================================
//
// IDENTITY (`IDENTITY_NOTIFIER`): `user.welcome`, `allowlist.invitation` and
// `security.role_changed`. MemoriaHub never sent any of them before the
// cutover (its identity notifier logged and dropped), so all three are
// declared `defaultEnabled: false`: nothing changes for an existing user, and
// a user who wants them turns them on in their preferences. Keys and template
// names follow the platform's reference app, so a future default flip is data.
//
// DATABASE BACKUP (`DB_BACKUP_NOTIFIER`): the db-backup slice raises
// `db_backup.backup_failed` and `db_backup.restore_completed` to the holders of
// `db_backup:read`. New for MemoriaHub (nothing notified on a backup before):
// a failed backup is exactly what an administrator must hear about. The
// restore is mandatory, as the platform recommends for a change of this size.
// =============================================================================

import { DB_BACKUP_EMAIL_TEMPLATES, DB_BACKUP_NOTIFICATION_EVENTS } from '@marinoscar/platform-api/db-backup';
import {
  backupFailedBrowserTemplate,
  restoreCompletedBrowserTemplate,
  roleChangedBrowserTemplate,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

export const IDENTITY_EVENT_KEYS = {
  welcome: 'user.welcome',
  allowlistInvitation: 'allowlist.invitation',
  roleChanged: 'security.role_changed',
} as const;

export const IDENTITY_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: IDENTITY_EVENT_KEYS.welcome,
      label: 'Welcome',
      description: 'Sent once, the first time you sign in.',
      channels: ['email'],
      defaultEnabled: false,
    },
    emailTemplate: 'user-welcome',
  },
  {
    event: {
      key: IDENTITY_EVENT_KEYS.allowlistInvitation,
      label: 'Invitation to sign in',
      description: 'Sent when an administrator adds an email address to the allowlist.',
      channels: ['email'],
      defaultEnabled: false,
    },
    emailTemplate: 'allowlist-invitation',
  },
  {
    event: {
      key: IDENTITY_EVENT_KEYS.roleChanged,
      label: 'Your roles changed',
      description: 'Sent when an administrator changes the roles of your account.',
      channels: ['email', 'browser'],
      defaultEnabled: false,
    },
    emailTemplate: 'role-changed',
    browserTemplate: roleChangedBrowserTemplate,
  },
];

export const DB_BACKUP_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: DB_BACKUP_NOTIFICATION_EVENTS.BACKUP_FAILED,
      label: 'Database backup failed',
      description: 'A database backup run failed or stopped heartbeating (administrators).',
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: DB_BACKUP_EMAIL_TEMPLATES.BACKUP_FAILED,
    browserTemplate: backupFailedBrowserTemplate,
  },
  {
    event: {
      key: DB_BACKUP_NOTIFICATION_EVENTS.RESTORE_COMPLETED,
      label: 'Database restored',
      description: 'A database restore finished and the restored copy is live (administrators).',
      channels: ['email', 'browser'],
      defaultEnabled: true,
      mandatory: true,
    },
    emailTemplate: DB_BACKUP_EMAIL_TEMPLATES.RESTORE_COMPLETED,
    browserTemplate: restoreCompletedBrowserTemplate,
  },
];
