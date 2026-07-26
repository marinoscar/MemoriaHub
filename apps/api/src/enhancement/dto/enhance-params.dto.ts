import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Request parameters for POST /api/media/:id/enhance (spec §4.1). All fields are
 * optional — an empty body enhances with full `auto` defaults. These params are
 * persisted verbatim on the media_enhancements row (audit of what was asked) and
 * compiled deterministically into the prompt at row-creation time.
 */
export const enhanceParamsSchema = z.object({
  intent: z.enum(['auto', 'custom']).optional(),
  /**
   * Optional task-specific preset for the family-photo-archive cases the
   * generic template handles poorly. ORTHOGONAL to `intent` — a preset may be
   * combined with custom adjustment toggles and free-text instructions.
   */
  preset: z
    .enum(['restore_old_photo', 'low_light', 'colorize_bw', 'portrait_polish'])
    .optional(),
  adjustments: z
    .object({
      color: z.boolean().optional(),
      tone: z.boolean().optional(),
      sharpness: z.boolean().optional(),
      denoise: z.boolean().optional(),
      dehaze: z.boolean().optional(),
      straighten: z.boolean().optional(),
    })
    .optional(),
  strength: z.enum(['subtle', 'balanced', 'strong']).optional(),
  /** Optional per-run override of the pictureEnhancement.defaultQuality setting. */
  quality: z.enum(['low', 'medium', 'high']).optional(),
  preserveFaces: z.boolean().optional(),
  instructions: z.string().max(500).optional(),
  /** Optional per-call override of ai.features.enhance.model. */
  model: z.string().max(200).optional(),
});

export type EnhanceParams = z.infer<typeof enhanceParamsSchema>;

export class EnhanceParamsDto extends createZodDto(enhanceParamsSchema) {}
