import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTime } from '../../common/schemas/iso-date';
import {
  dataTablesSchema,
  notificationPreferencesSchema,
  navigationPreferencesSchema,
  userTimeZoneSchema,
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
  // Absent when the user has never pinned a destination or collapsed the rail
  // — the normal state. Absent namespace / field means "use the built-in
  // defaults" (nothing pinned, rail expanded); the API never materializes
  // them, so the client applies the same defaults. A pin naming a destination
  // this release no longer knows is dropped on read, so what is returned here
  // is always a subset of the current pinnable set.
  navigation: navigationPreferencesSchema.optional(),
  // The RAW stored IANA zone (issue #444), absent when the user has never
  // expressed a preference — the normal state. Deliberately not resolved to
  // 'UTC' here: absent and an explicit 'UTC' are different answers, and only
  // the client can decide whether to prompt.
  timezone: userTimeZoneSchema.optional(),
  updatedAt: isoDateTime,
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
