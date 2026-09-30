import { NotificationType } from '@prisma/client';

// =============================================================================
// Notification channels (epic #481, issue #484)
// =============================================================================
//
// MemoriaHub's notification MODEL is unchanged — NotificationType, the
// STATE/EVENT split, and the three NotificationsService write primitives. This
// file adds the CHANNEL layer on top of it: which delivery channels each type
// may travel over.
//
//   inbox — the `notifications` row itself (the bell and /notifications). It is
//           written by the existing primitives, exactly as before.
//   push  — Web Push to the user's registered browsers, dispatched AFTER the
//           inbox row is written (NotificationDispatchService).
//
// `mandatory` exempts a type's INBOX row from the admin `disabledTypes` kill
// switch (the row IS the guarantee the user is told). It never exempts push or
// the in-page toast. None of the current types are mandatory; the field exists
// so a future critical broadcast type can opt in without a structural change.
//
// Declared as an exhaustive Record so adding a NotificationType value is a
// compile error here until someone decides its channels.
// =============================================================================

export const NOTIFICATION_CHANNEL_NAMES = ['inbox', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL_NAMES)[number];

export interface NotificationChannelDescriptor {
  /** Channels this type may be delivered over. `inbox` is always first. */
  readonly channels: readonly NotificationChannel[];
  /** Inbox row survives the admin `disabledTypes` kill switch. */
  readonly mandatory: boolean;
}

const INBOX_AND_PUSH: NotificationChannelDescriptor = {
  channels: ['inbox', 'push'],
  mandatory: false,
};

export const NOTIFICATION_CHANNEL_DESCRIPTORS: Readonly<
  Record<NotificationType, NotificationChannelDescriptor>
> = {
  review_queue_bursts: INBOX_AND_PUSH,
  review_queue_duplicates: INBOX_AND_PUSH,
  review_queue_location_suggestions: INBOX_AND_PUSH,
  review_queue_enhancements: INBOX_AND_PUSH,
  upload_completed: INBOX_AND_PUSH,
  enrichment_failed: INBOX_AND_PUSH,
  workflow_run_completed: INBOX_AND_PUSH,
  share_expiring: INBOX_AND_PUSH,
  memories_ready: INBOX_AND_PUSH,
};

/** The descriptor for a type. An unknown value degrades to inbox-only. */
export function channelDescriptor(type: NotificationType): NotificationChannelDescriptor {
  return NOTIFICATION_CHANNEL_DESCRIPTORS[type] ?? { channels: ['inbox'], mandatory: false };
}

export function supportsChannel(type: NotificationType, channel: NotificationChannel): boolean {
  return channelDescriptor(type).channels.includes(channel);
}

export function isMandatoryType(type: NotificationType): boolean {
  return channelDescriptor(type).mandatory;
}

/** Every type that declares the push channel. */
export function pushCapableTypes(): NotificationType[] {
  return (Object.keys(NOTIFICATION_CHANNEL_DESCRIPTORS) as NotificationType[]).filter((t) =>
    supportsChannel(t, 'push'),
  );
}
