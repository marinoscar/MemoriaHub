import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Client-visible feature flags returned by GET /api/features.
 *
 * Least-privilege carrier: readable by any authenticated user (unlike
 * GET /api/system-settings, which requires the Admin-only
 * `system_settings:read` permission). Contains feature toggles only — no
 * secrets, no credentials, no other settings namespace.
 */
export const featuresResponseSchema = z.object({
  /** Raw global feature-flag record, e.g. `{ pictureEnhancement: true }`. */
  features: z.record(z.string(), z.boolean()),
  pictureEnhancement: z.object({
    /** `features.pictureEnhancement` AND the PICTURE_ENHANCEMENT_ENABLED env kill-switch. */
    enabled: z.boolean(),
    /** When false, only "keep both" is offered on apply. */
    allowReplace: z.boolean(),
    /** When true, "replace" is blocked if the enhanced image is smaller. */
    blockReplaceOnDownscale: z.boolean(),
    /** Configured enhancement model NAME (never a credential); null when unset. */
    model: z.string().nullable(),
  }),
});

export class FeaturesResponseDto extends createZodDto(featuresResponseSchema) {}
