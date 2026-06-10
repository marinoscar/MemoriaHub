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
