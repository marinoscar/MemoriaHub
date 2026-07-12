import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTime } from '../../common/schemas/iso-date';

export const systemSettingsResponseSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  security: z.object({
    jwtAccessTtlMinutes: z.number(),
    refreshTtlDays: z.number(),
  }),
  features: z.record(z.string(), z.boolean()),
  face: z
    .object({
      features: z.object({
        detection: z.object({
          provider: z.string().nullable(),
          model: z.string().nullable(),
        }),
      }),
      autoArchive: z
        .object({
          matchThreshold: z.number(),
        })
        .optional(),
    })
    .optional(),
  updatedAt: isoDateTime,
  updatedBy: z
    .object({
      id: z.string().uuid(),
      email: z.string().email(),
    })
    .nullable(),
  version: z.number(),
});

export class SystemSettingsResponseDto extends createZodDto(
  systemSettingsResponseSchema,
) {}
