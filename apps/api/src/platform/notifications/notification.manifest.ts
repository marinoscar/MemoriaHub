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
//
// Webhooks (RETRO-H4, #603): the webhooks slice's `webhook` channel (its sender
// comes with `WebhooksModule`), its `webhooks.endpoint_disabled` event and
// email template, and the `webhook` channel on the four MemoriaHub events a
// member may forward to their own endpoints as `notification.<eventKey>`:
// `media.upload_completed`, `memories.ready`, `workflows.run_completed` and
// `shares.expiring` (`withWebhookChannel`).
// =============================================================================

// The platform email templates (`broadcast`, `backup-failed`, `role-changed`, ...)
// and MemoriaHub's own are registered by the email slice's composition.
import '../email/email.config';

import {
  ANDROID_APP_NOTIFICATION_CHANNEL,
  BROADCAST_CRITICAL_EVENT_KEY,
  BROADCASTS_NOTIFICATIONS,
  NODES_NOTIFICATIONS,
  OPS_NOTIFICATIONS,
  isRegisteredNotificationChannel,
  notificationEventRegistry,
  registerNotificationChannels,
  registerNotifications,
  registerAndroidAppNotificationChannel,
  registerPlatformNotificationChannels,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';
import {
  WEBHOOKS_NOTIFICATIONS,
  WEBHOOK_NOTIFICATION_CHANNEL,
  registerWebhooksEmailTemplates,
  withWebhookChannel,
} from '@marinoscar/platform-api/webhooks';

import { ALERTS_NOTIFICATIONS, registerAlertsEmailTemplates } from '@marinoscar/platform-api/alerts';

// The sharing slice's two e-mail templates (RETRO-I1, #562), registered before its events.
import '../../app-registrations/sharing';
import { SHARING_NOTIFICATIONS } from '../sharing/sharing.notifications';

import { MEMORIAHUB_EMAIL_NOTIFICATIONS } from '../../notifications-registry/memoriahub-email.notifications';
import {
  MEMORIAHUB_EVENT_KEYS,
  MEMORIAHUB_NOTIFICATIONS,
} from '../../notifications-registry/memoriahub.notifications';
import {
  DB_BACKUP_NOTIFICATIONS,
  IDENTITY_NOTIFICATIONS,
} from '../../notifications-registry/platform-slice.notifications';
import { EXPORTS_NOTIFICATIONS } from '../../notifications-registry/exports.notifications';

/** The MemoriaHub events a member may forward to their own webhook endpoints (RETRO-H4, #603). */
export const WEBHOOK_FORWARDABLE_EVENT_KEYS: readonly string[] = [
  MEMORIAHUB_EVENT_KEYS.uploadCompleted,
  MEMORIAHUB_EVENT_KEYS.memoriesReady,
  MEMORIAHUB_EVENT_KEYS.workflowRunCompleted,
  MEMORIAHUB_EVENT_KEYS.shareExpiring,
];

/** MemoriaHub's in-app events, the forwardable ones carrying the `webhook` channel. */
export const MEMORIAHUB_NOTIFICATIONS_WITH_WEBHOOKS: readonly NotificationRegistration[] = MEMORIAHUB_NOTIFICATIONS.map(
  (registration) =>
    WEBHOOK_FORWARDABLE_EVENT_KEYS.includes(registration.event.key)
      ? withWebhookChannel([registration])[0]
      : registration,
);

/**
 * The events that also list the `android_app` channel (RETRO-D5, #586, Open decision 2): the four
 * review queues, new memories and the critical broadcast, where a toast on the phone helps. Not
 * `media.upload_completed` (noisy on the very device doing the upload). The channel is
 * `coveredBy: 'push'`, so a recipient with a browser and an app subscription is pushed ONCE.
 */
export const ANDROID_APP_CHANNEL_EVENT_KEYS: readonly string[] = [
  MEMORIAHUB_EVENT_KEYS.reviewBursts,
  MEMORIAHUB_EVENT_KEYS.reviewDuplicates,
  MEMORIAHUB_EVENT_KEYS.reviewLocationSuggestions,
  MEMORIAHUB_EVENT_KEYS.reviewEnhancements,
  MEMORIAHUB_EVENT_KEYS.memoriesReady,
  BROADCAST_CRITICAL_EVENT_KEY,
];

/** Adds the `android_app` channel to the opted-in events of a group (idempotent). */
export function withAndroidAppChannel(group: readonly NotificationRegistration[]): NotificationRegistration[] {
  const channel = ANDROID_APP_NOTIFICATION_CHANNEL.id as NotificationRegistration['event']['channels'][number];
  return group.map((registration) =>
    ANDROID_APP_CHANNEL_EVENT_KEYS.includes(registration.event.key) &&
    !registration.event.channels.includes(channel)
      ? { ...registration, event: { ...registration.event, channels: [...registration.event.channels, channel] } }
      : registration,
  );
}

const GROUPS: readonly (readonly NotificationRegistration[])[] = [
  withAndroidAppChannel(BROADCASTS_NOTIFICATIONS),
  OPS_NOTIFICATIONS,
  NODES_NOTIFICATIONS,
  IDENTITY_NOTIFICATIONS,
  DB_BACKUP_NOTIFICATIONS,
  withAndroidAppChannel(MEMORIAHUB_NOTIFICATIONS_WITH_WEBHOOKS),
  MEMORIAHUB_EMAIL_NOTIFICATIONS,
  // The alerts slice's two events (RETRO-H5, #609): `alerts.alert_fired` /
  // `alerts.alert_resolved`, to the holders of `alerts:read`.
  ALERTS_NOTIFICATIONS,
  // The webhooks slice's `webhooks.endpoint_disabled` (email and bell, to the endpoint's owner).
  WEBHOOKS_NOTIFICATIONS,
  // The sharing slice's two events (RETRO-I1, #562): `groups.invitation` and
  // `sharing.shared_with_you`. Neither fires until groups and grants exist (RETRO-I2..I5).
  SHARING_NOTIFICATIONS,
  // The exports slice's two events (RETRO-H2, #596): `export.ready` / `export.failed`, to the
  // user who asked for the export; bell and Web Push, linking to `/settings/data-export`.
  EXPORTS_NOTIFICATIONS,
];

// Their email templates (idempotent), bound before the events are registered.
registerAlertsEmailTemplates();

registerPlatformNotificationChannels();
// The android-app slice's `android_app` channel (RETRO-D5, #586): Web Push to the subscriptions the
// Android companion registers (`push_subscriptions.platform = 'android_app'`), `coveredBy: 'push'`.
// Its sender comes with `AndroidAppModule`. Registered before any event lists it.
registerAndroidAppNotificationChannel();
if (!isRegisteredNotificationChannel(WEBHOOK_NOTIFICATION_CHANNEL.id)) {
  registerNotificationChannels([WEBHOOK_NOTIFICATION_CHANNEL]);
}
registerWebhooksEmailTemplates();
for (const group of GROUPS) {
  registerNotifications(group.filter((registration) => !notificationEventRegistry.has(registration.event.key)));
}
