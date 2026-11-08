// PLATFORM-ADOPTION-SHIM(RETRO-D3): the notifications slice swaps this for NOTIFICATIONS_USER_SETTINGS.
import { NotificationType } from '@prisma/client';
import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// Per-user notification preferences (issue #251). ABSENT MEANS ENABLED, at every level: no namespace,
// no `enabled`, no type key. That is what makes it migration-free and makes a newly added
// NotificationType opt-OUT. `workflowMicroRuns` is the one inverted default (absent means false); that
// inversion lives in resolveNotificationPreferences(), not here. Never add a `.default()`.
const typeKey = z.enum(Object.values(NotificationType) as [NotificationType, ...NotificationType[]]);
// `partialRecord`, not `record`: in zod 4 an enum-keyed `record` is exhaustive and would reject a
// body that names one type.
const typeFlags = z.partialRecord(typeKey, z.boolean());
const typeFlagsPatch = z.partialRecord(typeKey, z.boolean().nullable());

export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean().optional(),
    types: typeFlags.optional(),
    workflowMicroRuns: z.boolean().optional(),
    push: z.object({ enabled: z.boolean().optional(), types: typeFlags.optional() }).strict().optional(),
  })
  .strict();

// A per-type entry may be null to DELETE it, which resets that type to its default (enabled).
export const notificationPreferencesPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    types: typeFlagsPatch.optional(),
    workflowMicroRuns: z.boolean().optional(),
    push: z
      .object({ enabled: z.boolean().nullable().optional(), types: typeFlagsPatch.optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type NotificationPreferencesValue = z.infer<typeof notificationPreferencesSchema>;
export type NotificationPreferencesPatch = z.infer<typeof notificationPreferencesPatchSchema>;

function mergeTypes(
  current: Record<string, boolean> | undefined,
  patch: Record<string, boolean | null | undefined> | undefined,
): Record<string, boolean> {
  const types: Record<string, boolean> = { ...(current ?? {}) };
  for (const [type, value] of Object.entries(patch ?? {})) {
    if (value === null || value === undefined) delete types[type];
    else types[type] = value;
  }
  return types;
}

function mergePush(
  current: NotificationPreferencesValue['push'],
  patch: NotificationPreferencesPatch['push'],
): NotificationPreferencesValue['push'] {
  if (patch === undefined) return current;
  if (patch === null) return undefined;

  const types = mergeTypes(current?.types, patch.types);
  const merged: NonNullable<NotificationPreferencesValue['push']> = {};
  const enabled = patch.enabled === null ? undefined : patch.enabled !== undefined ? patch.enabled : current?.enabled;
  if (enabled !== undefined) merged.enabled = enabled;
  if (Object.keys(types).length > 0) merged.types = types;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Field-wise, and per type id inside `types`; `null` deletes a type; an emptied namespace is absent. */
export function mergeNotificationPreferences(
  current: NotificationPreferencesValue | undefined,
  patch: NotificationPreferencesPatch | null | undefined,
): NotificationPreferencesValue | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;

  const types = mergeTypes(current?.types, patch.types);
  const merged: NotificationPreferencesValue = {};
  const enabled = patch.enabled !== undefined ? patch.enabled : current?.enabled;
  if (enabled !== undefined) merged.enabled = enabled;
  const microRuns = patch.workflowMicroRuns !== undefined ? patch.workflowMicroRuns : current?.workflowMicroRuns;
  if (microRuns !== undefined) merged.workflowMicroRuns = microRuns;
  if (Object.keys(types).length > 0) merged.types = types;
  const push = mergePush(current?.push, patch.push);
  if (push !== undefined) merged.push = push;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const NOTIFICATIONS_USER_SETTINGS = {
  key: 'notifications',
  description: 'Per-user notification preferences. Absent means enabled.',
  schema: notificationPreferencesSchema,
  patchSchema: notificationPreferencesPatchSchema,
  merge: mergeNotificationPreferences,
} satisfies UserSettingsNamespace<'notifications', NotificationPreferencesValue, NotificationPreferencesPatch>;
