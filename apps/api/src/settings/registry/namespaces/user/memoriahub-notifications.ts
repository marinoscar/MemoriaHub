// =============================================================================
// `memoriahubNotifications` user namespace (RETRO-D3, #576)
// =============================================================================
//
// The one notification preference the platform slice has no equivalent for:
// `workflowMicroRuns` (epic #240, issue #251), the opt-IN that re-enables the
// rolling `on_media_enriched` workflow micro-run notifications. Every other
// per-event, per-channel preference is the platform `notifications` namespace.
//
// ABSENT MEANS FALSE (the inverted default), read by
// the workflows slice's `WorkflowRunNotificationService` (through `readUser`). No
// `.default()`: a stored `false` and "never chose" must stay distinguishable.
// PATCH: `workflowMicroRuns: null` removes the key; the namespace as `null`
// clears it. The carry-over (`npm run notifications:migrate-legacy`) moves the
// old `notifications.workflowMicroRuns` here.
// =============================================================================

import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

export const memoriahubNotificationsSchema = z.object({ workflowMicroRuns: z.boolean().optional() }).strict();
export type MemoriaHubNotificationsValue = z.infer<typeof memoriahubNotificationsSchema>;

const patchSchema = z.object({ workflowMicroRuns: z.boolean().nullable().optional() }).strict().nullable();
type MemoriaHubNotificationsPatch = z.infer<typeof patchSchema>;

export const MEMORIAHUB_NOTIFICATIONS_USER_SETTINGS = {
  key: 'memoriahubNotifications',
  description: 'MemoriaHub-only notification preferences: workflowMicroRuns (absent means false).',
  schema: memoriahubNotificationsSchema,
  patchSchema,
  merge(current: MemoriaHubNotificationsValue | undefined, patch: MemoriaHubNotificationsPatch | undefined) {
    if (patch === undefined) return current;
    if (patch === null) return undefined;
    const next: MemoriaHubNotificationsValue = { ...(current ?? {}) };
    if (patch.workflowMicroRuns === null) delete next.workflowMicroRuns;
    else if (patch.workflowMicroRuns !== undefined) next.workflowMicroRuns = patch.workflowMicroRuns;
    return Object.keys(next).length > 0 ? next : undefined;
  },
} satisfies UserSettingsNamespace<'memoriahubNotifications', MemoriaHubNotificationsValue, MemoriaHubNotificationsPatch>;
