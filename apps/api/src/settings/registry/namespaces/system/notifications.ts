// PLATFORM-ADOPTION-SHIM(RETRO-D3): the notifications slice swaps this for NOTIFICATIONS_SYSTEM_SETTINGS
// plus an extension for any field the platform lacks.
import { NotificationType } from '@prisma/client';
import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const notificationTypeKey = z.enum(Object.values(NotificationType) as [NotificationType, ...NotificationType[]]);

// `retentionDays` ages out only rows the user already RESOLVED; an UNREAD notification is never deleted
// by age. The channel kill switches (epic #481) are read by NotificationPolicyService.
const schema = z.object({
  retentionDays: z.number().int().min(1).max(365),
  purgeEnabled: z.boolean(),
  browserEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  disabledTypes: z.array(notificationTypeKey).max(50),
});
export type NotificationsSettingsValue = z.infer<typeof schema>;

export const NOTIFICATIONS_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'notifications',
  description: 'Notification retention and the deployment-wide channel kill switches and suppressed types.',
  schema,
  defaults: {
    retentionDays: 30,
    purgeEnabled: true,
    browserEnabled: true,
    pushEnabled: true,
    disabledTypes: [],
  },
});
