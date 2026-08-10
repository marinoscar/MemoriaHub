import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTime } from '../../common/schemas/iso-date';
import {
  dataTablesSchema,
  notificationPreferencesSchema,
} from '../../common/schemas/settings.schema';

export const userSettingsResponseSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().nullable().optional(),
    /**
     * @deprecated (issue #354) No-op. Avatar state now lives on the user row
     * and is surfaced by GET /api/users/me/profile; this key is still returned
     * only so older clients keep parsing the response.
     */
    useProviderImage: z.boolean(),
    /** @deprecated (issue #354) No-op — see useProviderImage above. */
    customImageUrl: z.string().url().nullable().optional(),
  }),
  search: z.object({
    visibleFields: z.array(z.string()),
  }).optional(),
  // Absent when the user has never persisted any table layout — which is the
  // normal state. Absent entries/fields mean "use the column contract's
  // defaults"; the API never materializes them.
  dataTables: dataTablesSchema.optional(),
  // Absent when the user has never changed a notification toggle — the normal
  // state. Absent namespace / field / type key means ENABLED (except
  // `workflowMicroRuns`, whose absent default is false); the API never
  // materializes them, so the client applies the same defaults.
  notifications: notificationPreferencesSchema.optional(),
  updatedAt: isoDateTime,
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
