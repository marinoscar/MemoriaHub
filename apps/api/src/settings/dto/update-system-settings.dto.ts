import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Full replacement (PUT)
export const updateSystemSettingsSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  features: z.record(z.string(), z.boolean()),
  ai: z.object({
    features: z.object({
      search: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
    }),
    conversations: z.object({
      archiveAfterDays: z.number().int().min(1),
      deleteAfterArchiveDays: z.number().int().min(1),
    }),
  }),
});

export class UpdateSystemSettingsDto extends createZodDto(
  updateSystemSettingsSchema,
) {}

// Partial update (PATCH)
export const patchSystemSettingsSchema = z.object({
  ui: z
    .object({
      allowUserThemeOverride: z.boolean().optional(),
    })
    .optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  ai: z
    .object({
      features: z
        .object({
          search: z
            .object({
              provider: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
      conversations: z
        .object({
          archiveAfterDays: z.number().int().min(1).optional(),
          deleteAfterArchiveDays: z.number().int().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
