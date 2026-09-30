/**
 * The admin-facing catalog of notification types — epic #481, issue #487.
 *
 * `NotificationPolicyPage` needs every type the API can produce so it can list
 * them in the per-type override table; `PushTestPanel` needs a human label for
 * the per-type routing rows the push test returns. The icon/tone/label that the
 * bell renders already live in `components/notifications/notificationMeta.tsx`
 * — the label is taken from there so the two surfaces can never disagree about
 * what a type is called. This module adds only what an ADMIN needs on top: the
 * closed list itself and a one-line description of when the type fires.
 *
 * The list mirrors the API's `NotificationType` enum (and the
 * `NOTIFICATION_CHANNEL_DESCRIPTORS` record, which is exhaustive over it),
 * including which types are mandatory. A
 * type missing here is still tolerated end to end: the policy page renders any
 * stored `disabledTypes` entry it does not recognise, so the list can never
 * hide a suppression it cannot lift.
 */

import { notificationMeta } from '../notifications/notificationMeta';

export interface NotificationTypeInfo {
  type: string;
  label: string;
  description: string;
  /**
   * The inbox row survives the admin kill switch. Mirrors the API descriptor;
   * only the critical broadcast type is.
   */
  mandatory: boolean;
}

const DESCRIPTIONS: Record<string, string> = {
  review_queue_bursts: 'Burst groups are waiting to be reviewed in a circle.',
  review_queue_duplicates: 'Near-duplicate groups are waiting to be reviewed in a circle.',
  review_queue_location_suggestions: 'Location suggestions are waiting to be reviewed in a circle.',
  review_queue_enhancements: 'AI picture enhancements are ready and awaiting a decision.',
  upload_completed: 'Photos or videos were added to a circle.',
  enrichment_failed: 'Background enrichment jobs failed permanently (sent to administrators).',
  workflow_run_completed: 'A workflow run finished.',
  share_expiring: 'A public share link is about to expire.',
  memories_ready: 'New memories were curated for a circle.',
  // Admin broadcasts (epic #481, issue #488).
  admin_broadcast: 'An announcement an administrator sent to every active user.',
  admin_broadcast_critical:
    'An important announcement. Its inbox row is always delivered; only its push can be switched off.',
};

/**
 * Labels for types the bell's `notificationMeta` may not know yet. The bell's
 * own label always wins when it has one.
 */
const FALLBACK_LABELS: Record<string, string> = {
  admin_broadcast: 'Announcement',
  admin_broadcast_critical: 'Important announcement',
};

/** Every notification type, in the order the API declares them. */
export const NOTIFICATION_TYPE_KEYS: readonly string[] = Object.keys(DESCRIPTIONS);

/** Types whose INBOX row survives `disabledTypes`. Kept in sync with the API descriptors. */
const MANDATORY_TYPES = new Set<string>(['admin_broadcast_critical']);

/** A human label for a type; an unrecognised type falls back to its raw key. */
export function notificationTypeLabel(type: string): string {
  const meta = notificationMeta(type);
  // `notificationMeta` returns a generic fallback for unknown types — a
  // specific label, or else the raw key, tells an admin more than the word
  // "Notification" does.
  if (meta.label !== 'Notification') return meta.label;
  return FALLBACK_LABELS[type] ?? type;
}

export function notificationTypeInfo(type: string): NotificationTypeInfo {
  return {
    type,
    label: notificationTypeLabel(type),
    description: DESCRIPTIONS[type] ?? 'A notification type this version of the app does not describe.',
    mandatory: MANDATORY_TYPES.has(type),
  };
}

export const NOTIFICATION_TYPE_CATALOG: readonly NotificationTypeInfo[] =
  NOTIFICATION_TYPE_KEYS.map(notificationTypeInfo);
