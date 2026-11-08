// =============================================================================
// Notification registrations (RETRO-D3, #576)
// =============================================================================
//
// Registers, at import time and before `NotificationsModule.forRoot` composes,
// everything the platform notifications slice dispatches for MemoriaHub: the
// platform channels (email, browser, push), the platform's own events
// (broadcasts, `jobs.job_failed`, `nodes.node_offline`), MemoriaHub's nine
// in-app events, its three emails, and the identity and db-backup slices'
// events. Imported by `notifications.config.ts` (and by the conformance spec);
// guarded so a second import in the same process registers nothing twice.
// =============================================================================

// The platform email templates (`broadcast`, `backup-failed`, `role-changed`, ...)
// and MemoriaHub's own are registered by the email slice's composition.
import '../email/email.config';

import {
  BROADCASTS_NOTIFICATIONS,
  NODES_NOTIFICATIONS,
  OPS_NOTIFICATIONS,
  notificationEventRegistry,
  registerNotifications,
  registerPlatformNotificationChannels,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

import { ALERTS_NOTIFICATIONS, registerAlertsEmailTemplates } from '@marinoscar/platform-api/alerts';

// The sharing slice's two e-mail templates (RETRO-I1, #562), registered before its events.
import '../../app-registrations/sharing';
import { SHARING_NOTIFICATIONS } from '../sharing/sharing.notifications';

import { MEMORIAHUB_EMAIL_NOTIFICATIONS } from '../../notifications-registry/memoriahub-email.notifications';
import { MEMORIAHUB_NOTIFICATIONS } from '../../notifications-registry/memoriahub.notifications';
import {
  DB_BACKUP_NOTIFICATIONS,
  IDENTITY_NOTIFICATIONS,
} from '../../notifications-registry/platform-slice.notifications';

const GROUPS: readonly (readonly NotificationRegistration[])[] = [
  BROADCASTS_NOTIFICATIONS,
  OPS_NOTIFICATIONS,
  NODES_NOTIFICATIONS,
  IDENTITY_NOTIFICATIONS,
  DB_BACKUP_NOTIFICATIONS,
  MEMORIAHUB_NOTIFICATIONS,
  MEMORIAHUB_EMAIL_NOTIFICATIONS,
  // The alerts slice's two events (RETRO-H5, #609): `alerts.alert_fired` /
  // `alerts.alert_resolved`, to the holders of `alerts:read`.
  ALERTS_NOTIFICATIONS,
  // The sharing slice's two events (RETRO-I1, #562): `groups.invitation` and
  // `sharing.shared_with_you`. Neither fires until groups and grants exist (RETRO-I2..I5).
  SHARING_NOTIFICATIONS,
];

// Their email templates (idempotent), bound before the events are registered.
registerAlertsEmailTemplates();

registerPlatformNotificationChannels();
for (const group of GROUPS) {
  registerNotifications(group.filter((registration) => !notificationEventRegistry.has(registration.event.key)));
}
