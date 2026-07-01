import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { systemSettingsPatchSchema } from '../../common/schemas/settings.schema';

// Full replacement (PUT)
// NOTE: PUT intentionally keeps its own local, narrower schema (not the canonical
// systemSettingsSchema) because the canonical schema applies `.default(...)` to
// face/storage/burst/geo/jobs, which would change the exact response shape callers
// and existing tests rely on for a full replace. See update-system-settings.dto.spec.ts.
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
// Re-export the canonical partial schema (apps/api/src/common/schemas/settings.schema.ts)
// so this DTO always stays in sync with every field the service actually supports
// (ui, features, ai search/tagging/embedding, face features+video, storage, burst,
// geo, jobs). Do NOT redefine a local/narrower schema here — a prior local
// definition drifted out of sync and silently stripped valid PATCH fields
// (e.g. geo.forwardSearchEnabled) before they ever reached the service.
export const patchSystemSettingsSchema = systemSettingsPatchSchema;

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
