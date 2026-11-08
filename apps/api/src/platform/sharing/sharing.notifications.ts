// =============================================================================
// The sharing slice's two notifications (RETRO-I1, #562)
// =============================================================================
//
// `groups.invitation` and `sharing.shared_with_you`, both on channels `email`
// and `browser`, not mandatory, with the slice's own labels and defaults. The
// browser renderers are the slice's; the e-mail templates (`group-invitation`,
// `shared-with-you`) are this app's bindings of the slice's renderers to the
// MemoriaHub layout (`platform/email/templates/`, registered by
// `app-registrations/sharing.ts`). Registered by
// `platform/notifications/notification.manifest.ts`. Pure data.
//
// Neither fires in RETRO-I1 (no group or grant exists yet). The circle
// invitation keeps its own event and template until RETRO-I5.
// =============================================================================

import {
  GROUP_INVITATION_EMAIL_TEMPLATE,
  GROUPS_INVITATION_EVENT,
  SHARED_WITH_YOU_EMAIL_TEMPLATE,
  SHARED_WITH_YOU_EVENT,
  groupInvitationBrowserTemplate,
  sharedWithYouBrowserTemplate,
} from '@marinoscar/platform-api/sharing';
import type { BrowserNotificationTemplate, NotificationRegistration } from '@marinoscar/platform-api/notifications';

export const SHARING_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: GROUPS_INVITATION_EVENT.key,
      label: GROUPS_INVITATION_EVENT.label,
      description: GROUPS_INVITATION_EVENT.description,
      channels: [...GROUPS_INVITATION_EVENT.channels],
      defaultEnabled: GROUPS_INVITATION_EVENT.defaultEnabled,
    },
    emailTemplate: GROUP_INVITATION_EMAIL_TEMPLATE,
    browserTemplate: groupInvitationBrowserTemplate as BrowserNotificationTemplate,
  },
  {
    event: {
      key: SHARED_WITH_YOU_EVENT.key,
      label: SHARED_WITH_YOU_EVENT.label,
      description: SHARED_WITH_YOU_EVENT.description,
      channels: [...SHARED_WITH_YOU_EVENT.channels],
      defaultEnabled: SHARED_WITH_YOU_EVENT.defaultEnabled,
    },
    emailTemplate: SHARED_WITH_YOU_EMAIL_TEMPLATE,
    browserTemplate: sharedWithYouBrowserTemplate as BrowserNotificationTemplate,
  },
];
