import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  dataTablesSchema,
  dataTablesPatchSchema,
  notificationPreferencesSchema,
  notificationPreferencesPatchSchema,
  memoriesPreferencesSchema,
  memoriesPreferencesPatchSchema,
  navigationPreferencesSchema,
  navigationPreferencesPatchSchema,
  userTimeZoneSchema,
} from '../../common/schemas/settings.schema';

// Full replacement (PUT)
export const updateUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    /**
     * @deprecated (issue #354) No-op. Avatar selection moved to the user row
     * (`User.avatarSource` / `avatarStorageKey` / `linkedPersonId`), written
     * only by UserAvatarService. Kept on the wire so older clients that still
     * send these keys are not rejected — nothing reads them.
     */
    useProviderImage: z.boolean(),
    /** @deprecated (issue #354) No-op — see useProviderImage above. */
    customImageUrl: z.string().url().nullable().optional(),
  }),
  search: z.object({
    visibleFields: z.array(z.string()).default([]),
  }).optional(),
  // Per-user, per-table DataTable layout (issue #255). Optional with NO
  // default: an absent namespace / entry / field means "use the column
  // contract's defaults". See settings.schema.ts for the absent-key rule.
  dataTables: dataTablesSchema.optional(),
  // Per-user notification preferences (issue #251). Optional with NO default:
  // an absent namespace / field / type key means ENABLED. See
  // settings.schema.ts for the absent-key rule.
  notifications: notificationPreferencesSchema.optional(),
  // Per-user Memories preferences (issue #307). Optional with NO default: an
  // absent namespace / field means "no preference". See settings.schema.ts.
  memories: memoriesPreferencesSchema.optional(),
  // Per-user navigation preferences (issue #392). Optional with NO default: an
  // absent namespace / field means "use the built-in defaults" (nothing
  // pinned, rail expanded). See settings.schema.ts for the absent-key rule.
  navigation: navigationPreferencesSchema.optional(),
  // Per-user IANA time zone (issue #444). MUST be declared here as well as in
  // the canonical schema: this DTO is what nestjs-zod validates the request
  // body against, and it STRIPS unknown keys — a field present only in
  // settings.schema.ts validates in unit tests and merges correctly in the
  // service while every real request silently drops it. See CLAUDE.md's
  // "three hand-maintained copies" gotcha (the system-settings analog).
  timezone: userTimeZoneSchema.optional(),
});

export class UpdateUserSettingsDto extends createZodDto(
  updateUserSettingsSchema,
) {}

// Partial update (PATCH) - JSON Merge Patch style
// .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
export const patchUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  profile: z
    .object({
      displayName: z.string().max(100).optional(),
      /** @deprecated (issue #354) No-op — see updateUserSettingsSchema above. */
      useProviderImage: z.boolean().optional(),
      /** @deprecated (issue #354) No-op — see updateUserSettingsSchema above. */
      customImageUrl: z.string().url().nullable().optional(),
    })
    .optional(),
  search: z
    .object({
      visibleFields: z.array(z.string()).default([]),
    })
    .optional(),
  // Merged per table id (see UserSettingsService.mergeDataTables): patching one
  // table's entry never clobbers another's; `null` deletes an entry.
  dataTables: dataTablesPatchSchema.optional(),
  // Merged field-wise, and per type key inside `types` (see
  // UserSettingsService.mergeNotifications): toggling one type never clobbers
  // another's stored value; a `null` type entry resets that type to its
  // default, and `notifications: null` clears the whole namespace.
  notifications: notificationPreferencesPatchSchema.nullable().optional(),
  // Merged field-wise (see UserSettingsService.mergeMemories): a listed field
  // replaces, an unlisted one is untouched, a `null` field clears it, and
  // `memories: null` clears the whole namespace.
  memories: memoriesPreferencesPatchSchema.nullable().optional(),
  // Merged field-wise (see UserSettingsService.mergeNavigation): a listed field
  // replaces, an unlisted one is untouched, a `null` field clears it, and
  // `navigation: null` clears the whole namespace.
  navigation: navigationPreferencesPatchSchema.nullable().optional(),
  // Scalar JSON Merge Patch: absent = untouched, a value replaces, `null`
  // clears it back to "no preference". Same strip-unknown-keys warning as the
  // PUT schema above — this declaration is load-bearing, not duplication.
  timezone: userTimeZoneSchema.nullable().optional(),
}).default({});

export class PatchUserSettingsDto extends createZodDto(
  patchUserSettingsSchema,
) {}
