// =============================================================================
// MemoriaHub's email-only notifications (RETRO-D3, #576)
// =============================================================================
//
// The emails MemoriaHub sent through `AppEmailSender` (RETRO-D2) are
// events of the platform notifications slice now, each bound to the template
// it always used (`src/email-templates/`, names PERMANENT):
//
//   circles.membership_confirmed  -> `membership-confirmation`  (notifyAddress: the address the invite named)
//   memories.digest               -> `memory-digest`            (notifyNow from the `memory_digest` job)
//
// `circles.invitation` (`circle-invitation`) is retired (RETRO-I5, #583): a
// circle invite is a group invite, and the sharing slice sends its own
// `groups.invitation`. The membership confirmation is sent when an invite is
// auto-accepted at sign-in (`circles/group-member-mirror.listener.ts`) and
// when a member is added through `/api/circles/:id/members`.
//
// Email only, default on, never mandatory. A user can now mute each one in
// their notification preferences; the digest keeps its own one-click
// unsubscribe (`user_settings.memories.emailDigestOptOut`) as well.
// =============================================================================

import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';

/** PERMANENT event keys. */
export const MEMORIAHUB_EMAIL_EVENT_KEYS = {
  membershipConfirmed: 'circles.membership_confirmed',
  memoriesDigest: 'memories.digest',
} as const;

export const MEMORIAHUB_EMAIL_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: MEMORIAHUB_EMAIL_EVENT_KEYS.membershipConfirmed,
      label: 'Circle membership',
      description: 'Sent when you are added to a circle, or your invitation is accepted when you sign in.',
      channels: ['email'],
      defaultEnabled: true,
    },
    emailTemplate: 'membership-confirmation',
  },
  {
    event: {
      key: MEMORIAHUB_EMAIL_EVENT_KEYS.memoriesDigest,
      label: 'Memories digest',
      description: 'A periodic email with the memories created in your circles.',
      channels: ['email'],
      defaultEnabled: true,
    },
    emailTemplate: 'memory-digest',
  },
];
