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
    useProviderImage: z.boolean(),
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
