import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTime } from '../../common/schemas/iso-date';

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
  updatedAt: isoDateTime,
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
