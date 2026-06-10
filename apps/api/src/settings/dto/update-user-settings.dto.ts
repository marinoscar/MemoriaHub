import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Full replacement (PUT)
export const updateUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
});

export class UpdateUserSettingsDto extends createZodDto(
  updateUserSettingsSchema,
) {}

// Partial update (PATCH) - JSON Merge Patch style
export const patchUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  profile: z
    .object({
      displayName: z.string().max(100).optional(),
      useProviderImage: z.boolean().optional(),
      customImageUrl: z.string().url().nullable().optional(),
    })
    .optional(),
});

export class PatchUserSettingsDto extends createZodDto(
  patchUserSettingsSchema,
) {}
