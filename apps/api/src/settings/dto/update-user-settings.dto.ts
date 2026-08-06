import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  dataTablesSchema,
  dataTablesPatchSchema,
  notificationPreferencesSchema,
  notificationPreferencesPatchSchema,
} from '../../common/schemas/settings.schema';

// Full replacement (PUT)
export const updateUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean(),
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
      useProviderImage: z.boolean().optional(),
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
}).default({});

export class PatchUserSettingsDto extends createZodDto(
  patchUserSettingsSchema,
) {}
