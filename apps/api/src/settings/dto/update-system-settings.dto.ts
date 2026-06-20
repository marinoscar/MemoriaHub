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
  }),
  face: z.object({
    features: z.object({
      detection: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      }),
    }),
  }).optional(),
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
    })
    .optional(),
  face: z
    .object({
      features: z
        .object({
          detection: z
            .object({
              provider: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
