import type { RetentionPolicyDefinition } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Notification retention: a platform retention policy (RETRO-C8, #608)
// =============================================================================
//
// `retention.appNotifications` replaces `notifications.retentionDays` /
// `notifications.purgeEnabled` as the window that keeps RESOLVED in-app
// notifications (read or dismissed) and the channel delivery audit
// (`mh_legacy_notification_deliveries`). The platform's 01:00
// `RetentionPurgeTask` enqueues the purge while the policy is enabled; the old
// midnight `NotificationPurgeTask` is gone.
//
// THE KEY IS `appNotifications`, NOT `app_notifications` (the issue's name):
// the platform validates retention keys against `^[a-z][A-Za-z0-9]{1,47}$`, and
// the platform already owns `notifications` (its own inbox, `notifications.inbox
// .purge`), which this app's tables are not until RETRO-D3. D3 removes this
// policy when the platform notifications slice's purge takes over.
//
// THE PURGE KEEPS ITS PERMANENT TYPE STRING, `notification_purge` (rows of it
// exist). Handler: `notifications-retention.handler.ts`. UNREAD NOTIFICATIONS
// ARE NEVER DELETED BY AGE, whatever the window: it is read/dismissed STATE that
// makes a notification disposable (docs/specs/notifications.md).
//
// Defaults reproduce the old behaviour: 30 days, ON. A pure module (types only)
// so `app-registrations/jobs.ts` can register it at import time. Carry-over of
// the old two keys: `npm run settings:migrate-notification-retention`.
// =============================================================================

/** The `retention` key. PERMANENT: renaming it orphans the operator's setting. */
export const APP_NOTIFICATIONS_RETENTION_KEY = 'appNotifications';

/** The purge's job type: the old nightly purge's string, kept (rows of it exist). */
export const APP_NOTIFICATIONS_PURGE_TYPE = 'notification_purge';

/** The policy registered with `registerRetentionPolicy`. */
export const APP_NOTIFICATIONS_RETENTION_POLICY: RetentionPolicyDefinition = {
  key: APP_NOTIFICATIONS_RETENTION_KEY,
  label: 'Notifications (read/dismissed)',
  defaultDays: 30,
  defaultEnabled: true,
  minDays: 1,
  maxDays: 365,
  purge: { type: APP_NOTIFICATIONS_PURGE_TYPE, what: 'notification purge' },
};
